// =============================================================================
// Freigabe der Compliance-Ziele durch die gesetzliche Vertretung: Anlegen der
// Freigabe (gemeinsam für Version 1 und die spätere Anforderung) und die
// eigene, auditierte Operation „Ziele-Freigabe anfordern" (Befund 11): Wer bei
// der Einrichtung keine Freigabe angefordert hat (etwa weil noch keine
// gesetzliche Vertretung erfasst war), fordert sie danach an.
//
// Sicherheit:
//   - Kanzleiperson mit `kannBearbeiten` und bestätigtem Mandantenbezug.
//   - TS-05: Programmzeile sperren (FOR UPDATE), darunter prüfen, dass keine
//     Ziele-Freigabe offen ist (jedes Anlegen einer Ziele-Freigabe läuft unter
//     dieser Sperre: Version 1 und diese Operation); Rollen erst unter `halteRollenFest` lesen
//     (RT4-T-06): Entfernen der letzten GV und Adressieren an sie laufen
//     nacheinander.
//   - TS-06: Empfänger nur über die ID, nur eine aktive gesetzliche Vertretung
//     des Mandanten der Anfrage.
// =============================================================================

import {
  ZieleFreigabeAnfordernEingabeSchema,
  DienstFehler,
  type ZieleFreigabeAnfordernEingabe,
  type ZieleFreigabeAnfordernErgebnis,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { fmtEurGanz, KLASSE_LABEL, type Klasse } from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { halteRollenFest } from '../../rollen';
import {
  aktiveKontakte,
  eingerichtetesProgramm,
  fachlichUngueltig,
  kanzleiZugriff,
  konfliktBeiEindeutigkeit,
  pruefeEingabe,
} from './gemeinsam';
import { legeNachrichtAn } from './nachrichten';

const BEREITS_OFFEN =
  'Für die Compliance-Ziele ist bereits eine Freigabe angefordert. Sie kann neu adressiert werden.';

/**
 * Legt die Freigabe der Ziele eines Teilbereichs an (Inhalt = Zieltexte), die
 * Nachricht an die gesetzliche Vertretung und liefert den Audit-Eintrag. Die
 * Aufrufer haben Empfänger (aktive GV, unter `halteRollenFest`) und die
 * Programmsperre geprüft.
 */
export async function legeZieleFreigabeAn(
  tx: Tx,
  a: {
    programmId: string;
    mandant: { id: string; name: string };
    teilbereich: { id: string; name: string };
    ziele: readonly { text: string; wesentlichkeitEur: number; risikoappetit: Klasse }[];
    empfaengerId: string;
    von: string;
    zeitpunkt: Date;
  },
): Promise<{ freigabeId: string; protokoll: Protokoll }> {
  const empfaengerId = a.empfaengerId.toLowerCase();
  const inhalt = [
    `Compliance-Ziele für den Teilbereich „${a.teilbereich.name}"`,
    '',
    ...a.ziele.map(
      (z, i) =>
        `${i + 1}. ${z.text.trim()} (Wesentlichkeitsgrenze ${fmtEurGanz(z.wesentlichkeitEur)}, Risikoappetit ${KLASSE_LABEL[z.risikoappetit]})`,
    ),
  ].join('\n');
  const titel = `Compliance-Ziele · ${a.teilbereich.name}`;
  const fr = await konfliktBeiEindeutigkeit(BEREITS_OFFEN, () =>
    tx.freigabe.create({
      data: {
        programmId: a.programmId,
        art: 'ZIELE',
        refId: a.teilbereich.id,
        titel,
        inhalt,
        angefordertVon: a.von,
        angefordertAm: a.zeitpunkt,
        empfaengerId,
      },
      select: { id: true },
    }),
  );
  await legeNachrichtAn(tx, {
    mandantId: a.mandant.id,
    empfaengerId,
    zweck: 'FREIGABE_ANGEFORDERT',
    daten: { freigabeId: fr.id, art: 'ZIELE', titel, version: null },
    betreff: 'Freigabe angefordert: Compliance-Ziele',
    text: `Im Portal warten die Compliance-Ziele der ${a.mandant.name} auf Ihre Freigabe. Den Bestätigungscode erhalten Sie beim Freigeben.`,
  });
  return {
    freigabeId: fr.id,
    protokoll: {
      aktion: 'tcms.ziele.freigabe_angefordert',
      objektTyp: 'Teilbereich',
      objektId: a.teilbereich.id,
      programmId: a.programmId,
      detail: { freigabeId: fr.id, empfaengerId, anzahl: a.ziele.length },
    },
  };
}

/**
 * Fordert die Freigabe aller noch nicht freigegebenen Compliance-Ziele bei einer
 * aktiven gesetzlichen Vertretung an (Ziele → AUSSTEHEND, Freigabe mit Code im
 * Portal). Nur für ein eingerichtetes Programm; höchstens eine offene
 * Ziele-Freigabe je Programm.
 */
export async function fordereZieleFreigabeAn(
  ctx: DienstKontext,
  eingabe: ZieleFreigabeAnfordernEingabe,
): Promise<ZieleFreigabeAnfordernErgebnis> {
  const e = pruefeEingabe(ZieleFreigabeAnfordernEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const empfaengerId = e.empfaengerId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, true);
  // TS-05: zuerst das Programm sperren; darunter offene Freigabe und Ziele lesen.
  const programmId = await eingerichtetesProgramm(ctx.tx, mandantId, true);
  const offen = await ctx.tx.freigabe.findFirst({
    where: { programmId, art: 'ZIELE', status: 'OFFEN' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (offen) throw new DienstFehler('KONFLIKT', BEREITS_OFFEN);
  const teilbereiche = await ctx.tx.teilbereich.findMany({
    where: { programmId },
    select: {
      id: true,
      name: true,
      ziele: {
        where: { freigabe: { not: 'FREIGEGEBEN' } },
        select: { id: true, text: true, wesentlichkeitEur: true, risikoappetit: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const tb = teilbereiche.find((t) => t.ziele.length > 0);
  if (!tb) {
    throw new DienstFehler(
      'KONFLIKT',
      'Alle Compliance-Ziele sind bereits durch die gesetzliche Vertretung freigegeben.',
    );
  }
  // TS-06, RT4-T-06: Empfänger unter derselben Sperre wie die Rollenpflege prüfen.
  await halteRollenFest(ctx.tx, mandantId);
  const kontakte = await aktiveKontakte(ctx.tx, mandantId);
  if (!kontakte.some((k) => k.kontaktId === empfaengerId && k.rolle === 'GESETZLICHER_VERTRETER')) {
    fachlichUngueltig('Empfänger ungültig.', 'empfaengerId', [
      'Die Freigabe der Ziele erteilt nur eine gesetzliche Vertretung des Mandanten.',
    ]);
  }

  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const ids = tb.ziele.map((z) => z.id);
    const u = await tx.complianceZiel.updateMany({
      where: { id: { in: ids }, teilbereichId: tb.id, freigabe: { not: 'FREIGEGEBEN' } },
      data: { freigabe: 'AUSSTEHEND' },
    });
    // Unter der Programmsperre unerwartet: ein Ziel hat sich inzwischen geändert.
    if (u.count !== ids.length)
      throw new DienstFehler('KONFLIKT', 'Die Ziele wurden inzwischen geändert. Bitte neu laden.');
    const { freigabeId, protokoll } = await legeZieleFreigabeAn(tx, {
      programmId,
      mandant,
      teilbereich: { id: tb.id, name: tb.name },
      ziele: tb.ziele.map((z) => ({ ...z, risikoappetit: z.risikoappetit as Klasse })),
      empfaengerId,
      von: ctx.akteur.id,
      zeitpunkt,
    });
    return {
      wert: { freigabeId, teilbereichId: tb.id, ziele: ids.length },
      protokoll: { ...protokoll, detail: { ...protokoll.detail, ziele: ids } },
    };
  });
}
