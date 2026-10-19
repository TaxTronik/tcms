// =============================================================================
// Operationen der Kontrolldurchführung (bisher Server Actions in apps/web:
// actions/durchfuehrung.ts, actions/portal-aufgabe.ts und die Kernlogik in
// durchfuehrung-daten.ts). Kanzlei (S8) und Portal (P2) rufen dieselben
// Funktionen; die Rechte unterscheiden über den Akteur.
//
// Jede Operation (TS-05, AGENTS.md Regeln 1, 3, 4):
//   - prüft die Eingabe strikt (Contract) und nimmt keinen Stichtag an (TS-07);
//   - prüft Sichtbarkeit, sperrt die Zeile und liest Status, Antrag und
//     Beteiligte erst unter der Sperre (`ladeLage`); Rechte aus diesem Stand;
//   - ändert nur mit bedingtem Update (Status bzw. Antrag wie gelesen,
//     `count` geprüft) – Konflikt → KONFLIKT, nie eine Doppelentscheidung;
//   - schreibt in derselben Transaktion je fachlicher Änderung ein
//     Audit-Ereignis (`mitAudit`, Aktionsnamen wie bisher).
// =============================================================================

import {
  DF_MIN_BEGRUENDUNG,
  DienstFehler,
  DurchfuehrungBegruendungEingabeSchema,
  DurchfuehrungSpeichernEingabeSchema,
  DurchfuehrungZielSchema,
  EntfallenAblehnenEingabeSchema,
  GegenzeichnenEingabeSchema,
  NachweisAnhaengenEingabeSchema,
  NachweisEntfernenEingabeSchema,
  type DurchfuehrungBegruendungEingabe,
  type DurchfuehrungSpeichernEingabe,
  type DurchfuehrungSpeichernErgebnis,
  type DurchfuehrungUebergang,
  type DurchfuehrungZiel,
  type EntfallenAblehnenEingabe,
  type GegenzeichnenEingabe,
  type GegenzeichnenErgebnis,
  type NachtragErgebnis,
  type NachweisAnhaengenEingabe,
  type NachweisEntfernenEingabe,
  type NachweisEntfernt,
  type NachweisErgebnis,
} from '@tcms/contract';
import { tenantSperre, type Prisma, type Tx } from '@tcms/db';
import { addTage, type DurchfuehrungStatus } from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { gleicheId } from '../../rechte';
import { legeFeststellungAn } from '../feststellungen-ereignisse/gemeinsam';
import { ladeLage, pruefeEingabe, verlange, type Lage } from './lage';
import { nachweisAntwort } from './lesen';
import { BEARBEITBAR, OFFEN } from './rechte';
import {
  leseKennzahlen,
  leseSchrittAntworten,
  leseSchrittDefs,
  leseWerte,
  pruefeEinreichung,
  type WertEintrag,
} from './werte';

const GEAENDERT = 'Der Status hat sich zwischenzeitlich geändert. Bitte neu laden.';
const NACHTRAG_OFFEN: DurchfuehrungStatus[] = [
  'GEPLANT',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
];

type Arbeit<T> = (
  tx: Tx,
  zeitpunkt: Date,
) => Promise<{ wert: T; protokoll: Protokoll | Protokoll[] }>;

/** `mitAudit` mit Abbildung von Unique-Verletzungen auf KONFLIKT (TS-05). */
async function ausfuehren<T>(ctx: DienstKontext, arbeit: Arbeit<T>): Promise<T> {
  try {
    return await mitAudit(ctx, arbeit);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'P2002') {
      throw new DienstFehler('KONFLIKT', 'Gleichzeitige Änderung erkannt. Bitte neu laden.');
    }
    throw e;
  }
}

function kanal(ctx: DienstKontext): 'Portal' | 'Kanzlei' {
  return ctx.akteur.art === 'MANDANT' ? 'Portal' : 'Kanzlei';
}

function protokoll(
  lage: Lage,
  aktion: string,
  detail: Record<string, unknown> = {},
  objekt?: { typ: string; id: string },
): Protokoll {
  return {
    aktion,
    objektTyp: objekt?.typ ?? 'Durchfuehrung',
    objektId: objekt?.id ?? lage.d.id,
    programmId: lage.programmId,
    detail: { kontrolle: lage.d.kontrolle.code, periode: lage.d.periodeLabel, ...detail },
  };
}

/**
 * Bedingter Übergang: ändert nur, wenn der Status (und ggf. weitere Felder)
 * noch dem gelesenen Stand entspricht. Sonst KONFLIKT.
 */
async function uebergang(
  tx: Tx,
  id: string,
  von: readonly DurchfuehrungStatus[],
  data: Prisma.DurchfuehrungUpdateManyMutationInput,
  zusatz: Prisma.DurchfuehrungWhereInput = {},
): Promise<void> {
  const r = await tx.durchfuehrung.updateMany({
    where: { ...zusatz, id, status: { in: [...von] } },
    data,
  });
  if (r.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
}

/**
 * Bedingtes Update ohne fachliche Änderung: sperrt die Zeile ebenfalls und
 * bestätigt, dass der Status noch `status` ist (zweite Sicherung, TS-05).
 */
async function bleibt(tx: Tx, id: string, status: DurchfuehrungStatus): Promise<void> {
  if (!BEARBEITBAR.includes(status)) throw new DienstFehler('KONFLIKT', GEAENDERT);
  await uebergang(tx, id, [status], { status });
}

/** GEPLANT → IN_DURCHFUEHRUNG (explizit oder implizit beim ersten Speichern/Anhängen). */
async function beginneInTx(
  ctx: DienstKontext,
  tx: Tx,
  lage: Lage,
  zeitpunkt: Date,
): Promise<Protokoll> {
  const defs = leseSchrittDefs(lage.d.kontrolleStand.schritte);
  const antworten = leseSchrittAntworten(lage.d.schritte, defs.length);
  await uebergang(tx, lage.d.id, ['GEPLANT'], {
    status: 'IN_DURCHFUEHRUNG',
    begonnenAm: zeitpunkt,
    durchgefuehrtVon: ctx.akteur.id,
    schritte: antworten as unknown as Prisma.InputJsonValue,
  });
  return protokoll(lage, 'tcms.durchfuehrung.begonnen');
}

async function sperreNachweise(tx: Tx, durchfuehrungId: string, gesperrt: boolean) {
  return tx.nachweis.updateMany({ where: { durchfuehrungId }, data: { gesperrt } });
}

// ---------------------------------------------------------------------------
// Durchführen: beginnen, speichern, einreichen, Nachweise
// ---------------------------------------------------------------------------

/** Fällig → In Durchführung (zugewiesene Person oder Vertretung, nach Periodenende). */
export async function beginneDurchfuehrung(
  ctx: DienstKontext,
  eingabe: DurchfuehrungZiel,
): Promise<DurchfuehrungUebergang> {
  const z = pruefeEingabe(DurchfuehrungZielSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, z, { sperren: true });
    verlange(lage.rechte.beginnen);
    const p = await beginneInTx(ctx, tx, lage, zeitpunkt);
    return { wert: { durchfuehrungId: lage.d.id, status: 'IN_DURCHFUEHRUNG' }, protokoll: p };
  });
}

/**
 * Schritte, Werte und Ergebnisvorschlag speichern (vollständiger Stand, ersetzt
 * den gespeicherten). Vor Beginn: impliziter Beginn. Die Eingabe muss zur
 * Kontrollversion passen (Zahl der Schritte, bekannte Kennzahlen).
 */
export async function speichereDurchfuehrung(
  ctx: DienstKontext,
  eingabe: DurchfuehrungSpeichernEingabe,
): Promise<DurchfuehrungSpeichernErgebnis> {
  const e = pruefeEingabe(DurchfuehrungSpeichernEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.bearbeiten);
    const ks = lage.d.kontrolleStand;
    const defs = leseSchrittDefs(ks.schritte);
    const kennzahlen = leseKennzahlen(ks.kennzahlen);
    const felder: Record<string, string[]> = {};
    if (e.schritte.length !== defs.length) {
      felder['schritte'] = [`Erwartet: ${defs.length} Schritte`];
    }
    const bekannt = new Map(kennzahlen.map((k) => [k.key, k]));
    e.werte.forEach((w, i) => {
      const def = bekannt.get(w.key);
      if (!def) (felder[`werte.${i}.key`] ??= []).push('Unbekannte Kennzahl');
      else if (def.differenzAus && w.wert !== null)
        (felder[`werte.${i}.wert`] ??= []).push('Differenz wird berechnet');
    });
    if (Object.keys(felder).length > 0) {
      throw new DienstFehler('UNGUELTIG', 'Eingabe passt nicht zur Kontrolle.', felder);
    }
    const werte: Record<string, WertEintrag> = Object.fromEntries(
      e.werte.map((w) => [
        w.key,
        {
          wert: w.wert == null ? null : Math.round(w.wert * 100) / 100,
          bemerkung: w.bemerkung,
          erklaert: w.erklaert,
        },
      ]),
    );
    const ergebnisKommentar = e.ergebnisKommentar ? e.ergebnisKommentar : null;

    const protokolle: Protokoll[] = [];
    if (lage.d.status === 'GEPLANT') protokolle.push(await beginneInTx(ctx, tx, lage, zeitpunkt));
    await uebergang(tx, lage.d.id, BEARBEITBAR, {
      schritte: e.schritte as unknown as Prisma.InputJsonValue,
      werte: werte as unknown as Prisma.InputJsonValue,
      ergebnis: e.ergebnis,
      ergebnisKommentar,
    });
    protokolle.push(
      protokoll(lage, 'tcms.durchfuehrung.gespeichert', {
        erledigt: e.schritte.filter((s) => s.erledigt).length,
        gesamt: e.schritte.length,
        werte: Object.values(werte).filter((w) => w.wert != null).length,
        ergebnis: e.ergebnis,
        kanal: kanal(ctx),
      }),
    );
    const pruefung = pruefeEinreichung({
      schritte: e.schritte,
      kennzahlen,
      werte: leseWerte(werte, kennzahlen),
      toleranzEur: ks.toleranzEur == null ? null : Number(ks.toleranzEur),
      nachweise: lage.d.nachweise.length,
      mindestNachweise: ks.mindestNachweise,
      ergebnis: e.ergebnis,
      ergebnisKommentar,
    });
    const status = lage.d.status === 'GEPLANT' ? 'IN_DURCHFUEHRUNG' : lage.d.status;
    return { wert: { durchfuehrungId: lage.d.id, status, pruefung }, protokoll: protokolle };
  });
}

/**
 * Einreichen (Kanzlei) bzw. Übermitteln (Portal) des gespeicherten Stands:
 * nur ohne Mängel (Schritte, Werte, Toleranz, Mindestnachweise, Ergebnis);
 * sperrt die Nachweise. Mängel → UNGUELTIG mit `felder.maengel`.
 */
export async function reicheDurchfuehrungEin(
  ctx: DienstKontext,
  eingabe: DurchfuehrungZiel,
): Promise<DurchfuehrungUebergang> {
  const z = pruefeEingabe(DurchfuehrungZielSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, z, { sperren: true });
    verlange(lage.rechte.bearbeiten);
    const d = lage.d;
    if (d.status === 'GEPLANT')
      throw new DienstFehler('KONFLIKT', 'Durchführung noch nicht begonnen');
    const ks = d.kontrolleStand;
    const defs = leseSchrittDefs(ks.schritte);
    const kennzahlen = leseKennzahlen(ks.kennzahlen);
    const p = pruefeEinreichung({
      schritte: leseSchrittAntworten(d.schritte, defs.length),
      kennzahlen,
      werte: leseWerte(d.werte, kennzahlen),
      toleranzEur: ks.toleranzEur == null ? null : Number(ks.toleranzEur),
      nachweise: d.nachweise.length,
      mindestNachweise: ks.mindestNachweise,
      ergebnis: d.ergebnis,
      ergebnisKommentar: d.ergebnisKommentar,
    });
    if (p.maengel.length > 0) {
      throw new DienstFehler('UNGUELTIG', `Einreichen nicht möglich: ${p.maengel.join(' · ')}.`, {
        maengel: p.maengel,
      });
    }
    await uebergang(tx, d.id, BEARBEITBAR, {
      status: 'ZUR_GEGENZEICHNUNG',
      eingereichtAm: zeitpunkt,
      durchgefuehrtVon: ctx.akteur.id,
      mandantBestaetigtVon: null,
    });
    await sperreNachweise(tx, d.id, true);
    return {
      wert: { durchfuehrungId: d.id, status: 'ZUR_GEGENZEICHNUNG' },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.eingereicht', {
        ergebnis: d.ergebnis,
        kanal: kanal(ctx),
        nachweise: d.nachweise.map((n) => ({
          id: n.id,
          dokumentId: n.dokumentId,
          dateiname: n.dateiname,
          sha256: n.sha256,
        })),
      }),
    };
  });
}

/**
 * Nachweis-Verweis der kanzleikonsole anhängen (ADR 0001 §6; Dateien nimmt
 * der Dienst nicht an). Der Verweis läuft durch den Ablage-Port (Dienst:
 * `pruefeVerweis`). Eine Dokument-ID gehört zu genau einem Mandanten und
 * einem Inhalt: Wird sie unter einem anderen Mandanten oder mit anderem
 * SHA-256/Größe wiederverwendet → UNGUELTIG. Gleicher Inhalt in derselben
 * Durchführung → KONFLIKT. Vor Beginn: impliziter Beginn.
 */
export async function haengeNachweisAn(
  ctx: DienstKontext,
  eingabe: NachweisAnhaengenEingabe,
): Promise<NachweisErgebnis> {
  const e = pruefeEingabe(NachweisAnhaengenEingabeSchema, eingabe);
  const verweis = await ctx.ablage.annehmen({ art: 'VERWEIS', verweis: e.verweis });
  const dokumentId = verweis.dokumentId.toLowerCase();
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.bearbeiten);
    // Gleichzeitige Verwendung derselben Dokument-ID serialisieren (je Tenant).
    await tenantSperre(tx, `nachweis.dokument.${dokumentId}`);
    const gleiche = await tx.nachweis.findMany({
      where: { dokumentId },
      select: {
        sha256: true,
        groesse: true,
        durchfuehrung: {
          select: { kontrolle: { select: { programm: { select: { mandantId: true } } } } },
        },
      },
    });
    const fremd = gleiche.some(
      (n) =>
        !gleicheId(n.durchfuehrung.kontrolle.programm.mandantId, lage.mandantId) ||
        n.sha256 !== verweis.sha256 ||
        n.groesse !== verweis.groesse,
    );
    if (fremd) {
      throw new DienstFehler('UNGUELTIG', 'Nachweis-Verweis ungültig.', {
        'verweis.dokumentId': ['Verweis kann hier nicht verwendet werden'],
      });
    }
    const doppelt = lage.d.nachweise.find((n) => n.sha256 === verweis.sha256);
    if (doppelt) throw new DienstFehler('KONFLIKT', `Bereits vorhanden: ${doppelt.dateiname}`);

    const protokolle: Protokoll[] = [];
    if (lage.d.status === 'GEPLANT') protokolle.push(await beginneInTx(ctx, tx, lage, zeitpunkt));
    // Zweite Sicherung neben der Zeilensperre: Status unverändert bearbeitbar.
    await bleibt(tx, lage.d.id, lage.d.status === 'GEPLANT' ? 'IN_DURCHFUEHRUNG' : lage.d.status);
    const n = await tx.nachweis.create({
      data: {
        durchfuehrungId: lage.d.id,
        dokumentId,
        dateiname: verweis.dateiname,
        mime: verweis.mime,
        groesse: verweis.groesse,
        sha256: verweis.sha256,
        gesperrt: false,
        hochgeladenVon: ctx.akteur.id,
        hochgeladenAm: zeitpunkt,
      },
    });
    protokolle.push(
      protokoll(
        lage,
        'tcms.durchfuehrung.nachweis_hochgeladen',
        {
          durchfuehrungId: lage.d.id,
          dokumentId,
          dateiname: verweis.dateiname,
          mime: verweis.mime,
          sha256: verweis.sha256,
          groesse: verweis.groesse,
          kanal: kanal(ctx),
        },
        { typ: 'Nachweis', id: n.id },
      ),
    );
    return {
      wert: { durchfuehrungId: lage.d.id, nachweis: nachweisAntwort(n) },
      protokoll: protokolle,
    };
  });
}

/**
 * Nachweis entfernen, nur vor der Einreichung (nicht gesperrt). Der Tax-CMS-
 * Verweis entfällt; das Dokument in der kanzleikonsole bleibt unberührt und
 * der vollständige Verweis steht im Audit (`nachweis_entfernt`).
 */
export async function entferneNachweis(
  ctx: DienstKontext,
  eingabe: NachweisEntfernenEingabe,
): Promise<NachweisEntfernt> {
  const e = pruefeEingabe(NachweisEntfernenEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    const n = lage.d.nachweise.find((x) => x.id === e.nachweisId);
    if (!n) throw new DienstFehler('NICHT_GEFUNDEN');
    verlange(lage.rechte.bearbeiten);
    if (lage.d.status === 'GEPLANT')
      throw new DienstFehler('KONFLIKT', 'Durchführung noch nicht begonnen');
    if (n.gesperrt)
      throw new DienstFehler('KONFLIKT', 'Gesperrte Nachweise können nicht entfernt werden.');
    await bleibt(tx, lage.d.id, lage.d.status);
    const weg = await tx.nachweis.deleteMany({
      where: { id: n.id, durchfuehrungId: lage.d.id, gesperrt: false },
    });
    if (weg.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    return {
      wert: { durchfuehrungId: lage.d.id, nachweisId: n.id },
      protokoll: protokoll(
        lage,
        'tcms.durchfuehrung.nachweis_entfernt',
        {
          durchfuehrungId: lage.d.id,
          dokumentId: n.dokumentId,
          dateiname: n.dateiname,
          mime: n.mime,
          groesse: n.groesse,
          sha256: n.sha256,
          hochgeladenVon: n.hochgeladenVon,
          kanal: kanal(ctx),
        },
        { typ: 'Nachweis', id: n.id },
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Prüfen: zurückweisen, bestätigen (Mandant), gegenzeichnen
// ---------------------------------------------------------------------------

/**
 * Zurückweisen (Kanzlei-Prüfer:in) bzw. Zurückgeben (zweite Person beim
 * Mandanten, vor der Bestätigung); entsperrt die Nachweise. Vier-Augen über
 * alle Beteiligten.
 */
export async function weiseDurchfuehrungZurueck(
  ctx: DienstKontext,
  eingabe: DurchfuehrungBegruendungEingabe,
): Promise<DurchfuehrungUebergang> {
  const e = pruefeEingabe(DurchfuehrungBegruendungEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.zurueckweisen);
    await uebergang(
      tx,
      lage.d.id,
      ['ZUR_GEGENZEICHNUNG'],
      {
        status: 'ZURUECKGEWIESEN',
        zurueckgewiesenVon: ctx.akteur.id,
        zurueckweisungsgrund: e.begruendung,
        mandantBestaetigtVon: null,
      },
      ctx.akteur.art === 'MANDANT' ? { mandantBestaetigtVon: null } : {},
    );
    const ent = await sperreNachweise(tx, lage.d.id, false);
    return {
      wert: { durchfuehrungId: lage.d.id, status: 'ZURUECKGEWIESEN' },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.zurueckgewiesen', {
        begruendung: e.begruendung,
        nachweiseEntsperrt: ent.count,
        kanal: kanal(ctx),
      }),
    };
  });
}

/**
 * Bestätigung durch eine zweite Person beim Mandanten (Kontrollstand mit
 * Gegenzeichnung beim Mandanten). Danach schließt die Kanzlei ab.
 */
export async function bestaetigeDurchfuehrung(
  ctx: DienstKontext,
  eingabe: DurchfuehrungZiel,
): Promise<DurchfuehrungUebergang> {
  const z = pruefeEingabe(DurchfuehrungZielSchema, eingabe);
  return ausfuehren(ctx, async (tx) => {
    const lage = await ladeLage(ctx, z, { sperren: true });
    verlange(lage.rechte.mandantBestaetigen);
    await uebergang(
      tx,
      lage.d.id,
      ['ZUR_GEGENZEICHNUNG'],
      { mandantBestaetigtVon: ctx.akteur.id },
      { mandantBestaetigtVon: null },
    );
    return {
      wert: { durchfuehrungId: lage.d.id, status: 'ZUR_GEGENZEICHNUNG' },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.mandant_bestaetigt', {
        durchgefuehrtVon: lage.d.durchgefuehrtVon,
      }),
    };
  });
}

/**
 * Gegenzeichnen durch die Kanzlei (Vier-Augen über alle Beteiligten; bei
 * Mandanten-Gegenzeichnung erst nach der Bestätigung). Bei Befund entsteht
 * – falls noch keine verknüpft ist – im selben Zug eine Feststellung; die
 * Einstufung „NEIN" ohne Würdigungsrecht wird „UNKLAR" (TS-04).
 */
export async function gegenzeichneDurchfuehrung(
  ctx: DienstKontext,
  eingabe: GegenzeichnenEingabe,
): Promise<GegenzeichnenErgebnis> {
  const e = pruefeEingabe(GegenzeichnenEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.gegenzeichnen);
    const d = lage.d;
    const ergebnis = d.ergebnis;
    if (!ergebnis) {
      throw new DienstFehler(
        'KONFLIKT',
        'Der Ergebnisvorschlag der durchführenden Person fehlt. Bitte zurückweisen.',
      );
    }
    const protokolle: Protokoll[] = [];
    let feststellung: { id: string; nummer: string } | null = null;
    if (ergebnis === 'OHNE_BEFUND') {
      if (e.feststellung) {
        throw new DienstFehler('UNGUELTIG', 'Eine Feststellung entsteht nur bei Befund.', {
          feststellung: ['Nur bei Ergebnis „mit Befund"'],
        });
      }
    } else {
      const vorhanden = await tx.feststellung.findFirst({
        where: { durchfuehrungId: d.id },
        select: { id: true, nummer: true },
        orderBy: { nummer: 'asc' },
      });
      if (vorhanden) {
        if (e.feststellung) {
          throw new DienstFehler(
            'KONFLIKT',
            'Zu dieser Durchführung ist bereits eine Feststellung erfasst.',
          );
        }
        feststellung = vorhanden;
      } else {
        const f = e.feststellung;
        if (!f) {
          throw new DienstFehler('UNGUELTIG', 'Bei Befund ist eine Feststellung zu erfassen.', {
            feststellung: ['Pflicht bei Ergebnis „mit Befund"'],
          });
        }
        // Nur aktive, mit dieser Kontrolle verknüpfte Risiken desselben Programms.
        const links = await tx.risikoKontrolle.findMany({
          where: {
            kontrolleId: d.kontrolleId,
            risiko: { entscheidung: 'UEBERNOMMEN', programmId: lage.programmId },
          },
          select: { risiko: { select: { id: true, code: true } } },
        });
        const erlaubt = new Map(links.map((l) => [l.risiko.id, l.risiko.code]));
        if (f.risikoIds.some((id) => !erlaubt.has(id))) {
          throw new DienstFehler('UNGUELTIG', 'Feststellung unvollständig.', {
            'feststellung.risikoIds': ['Risiko ist mit dieser Kontrolle nicht verknüpft'],
          });
        }
        // Genau ein Anlagepfad für Feststellungen (Bereich feststellungen):
        // TS-04 („NEIN" nur mit Würdigungsrecht), Nummernkreis und
        // Programmzugehörigkeit von Risiken und Durchführung prüft der Helfer.
        const quelleText = `${d.kontrolle.code} ${d.periodeLabel}`;
        const neu = await legeFeststellungAn(ctx, zeitpunkt, {
          mandantId: lage.mandantId,
          programmId: lage.programmId,
          titel: f.titel,
          sachverhalt: f.sachverhalt,
          quelle: 'KONTROLLE',
          quelleText,
          durchfuehrungId: d.id,
          klasse: f.klasse,
          schwere: f.schwere,
          auswirkung: f.auswirkung,
          risikoIds: f.risikoIds,
          detail: {
            quelle: quelleText,
            durchfuehrungId: d.id,
            klasse: f.klasse,
            schwere: f.schwere,
            risiken: f.risikoIds.map((id) => erlaubt.get(id)!).sort(),
          },
        });
        protokolle.push(neu.protokoll);
        feststellung = { id: neu.id, nummer: neu.nummer };
      }
    }
    await uebergang(
      tx,
      d.id,
      ['ZUR_GEGENZEICHNUNG'],
      { status: ergebnis, gegengezeichnetVon: ctx.akteur.id, abgeschlossenAm: zeitpunkt },
      d.kontrolleStand.gegenzeichnungMandant ? { mandantBestaetigtVon: { not: null } } : {},
    );
    await sperreNachweise(tx, d.id, true);
    protokolle.push(
      protokoll(lage, 'tcms.durchfuehrung.gegengezeichnet', {
        ergebnis,
        durchgefuehrtVon: d.durchgefuehrtVon,
        mandantBestaetigtVon: d.mandantBestaetigtVon,
        feststellung: feststellung?.nummer ?? null,
      }),
    );
    return {
      wert: { durchfuehrungId: d.id, status: ergebnis, feststellung },
      protokoll: protokolle,
    };
  });
}

// ---------------------------------------------------------------------------
// Entfallen: Antrag, Freigabe durch eine zweite Person (Berufsträger:in)
// ---------------------------------------------------------------------------

export async function beantrageEntfallen(
  ctx: DienstKontext,
  eingabe: DurchfuehrungBegruendungEingabe,
): Promise<DurchfuehrungUebergang> {
  const e = pruefeEingabe(DurchfuehrungBegruendungEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.entfallenBeantragen);
    await uebergang(
      tx,
      lage.d.id,
      OFFEN,
      { entfallenBegruendung: e.begruendung, entfallenVon: ctx.akteur.id, entfallenAm: null },
      { entfallenBegruendung: null },
    );
    return {
      wert: { durchfuehrungId: lage.d.id, status: lage.d.status },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.entfallen_beantragt', {
        begruendung: e.begruendung,
      }),
    };
  });
}

/**
 * Entfallen freigeben: Berufsträger:in mit Würdigungsrecht, nie die
 * antragstellende Person (aus der gesperrten Zeile gelesen). Sperrt Nachweise.
 */
export async function gibEntfallenFrei(
  ctx: DienstKontext,
  eingabe: DurchfuehrungZiel,
): Promise<DurchfuehrungUebergang> {
  const z = pruefeEingabe(DurchfuehrungZielSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, z, { sperren: true });
    verlange(lage.rechte.entfallenFreigeben);
    const d = lage.d;
    await uebergang(
      tx,
      d.id,
      OFFEN,
      { status: 'ENTFALLEN', entfallenAm: zeitpunkt },
      { entfallenBegruendung: { not: null }, entfallenVon: d.entfallenVon },
    );
    await sperreNachweise(tx, d.id, true);
    return {
      wert: { durchfuehrungId: d.id, status: 'ENTFALLEN' },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.entfallen', {
        begruendung: d.entfallenBegruendung,
        beantragtVon: d.entfallenVon,
      }),
    };
  });
}

/**
 * Antrag ablehnen (wie Freigabe: zweite Person mit Würdigungsrecht, Begründung
 * ≥ 30 Zeichen) oder als antragstellende Person zurückziehen.
 */
export async function lehneEntfallenAb(
  ctx: DienstKontext,
  eingabe: EntfallenAblehnenEingabe,
): Promise<DurchfuehrungUebergang> {
  const e = pruefeEingabe(EntfallenAblehnenEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.entfallenAblehnen);
    const d = lage.d;
    const zurueckziehen = ctx.akteur.art === 'KANZLEI' && gleicheId(ctx.akteur.id, d.entfallenVon);
    const begruendung = e.begruendung ?? '';
    if (!zurueckziehen && begruendung.length < DF_MIN_BEGRUENDUNG) {
      throw new DienstFehler(
        'UNGUELTIG',
        `Bitte eine Begründung mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen angeben.`,
        { begruendung: [`mindestens ${DF_MIN_BEGRUENDUNG} Zeichen`] },
      );
    }
    await uebergang(
      tx,
      d.id,
      OFFEN,
      { entfallenBegruendung: null, entfallenVon: null, entfallenAm: null },
      { entfallenBegruendung: { not: null }, entfallenVon: d.entfallenVon },
    );
    return {
      wert: { durchfuehrungId: d.id, status: d.status },
      protokoll: protokoll(lage, 'tcms.durchfuehrung.entfallen_abgelehnt', {
        begruendung: zurueckziehen ? '' : begruendung,
        antrag: d.entfallenBegruendung,
        beantragtVon: d.entfallenVon,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Nachtrag zu einer abgeschlossenen Durchführung (AGENTS.md Regel 3)
// ---------------------------------------------------------------------------

/**
 * Legt einen verknüpften Nachtrag derselben Periode und Kontrollversion an;
 * die abgeschlossene Durchführung bleibt unverändert. Höchstens ein offener
 * Nachtrag je Durchführung (unter der Sperre des Originals geprüft).
 */
export async function legeNachtragAn(
  ctx: DienstKontext,
  eingabe: DurchfuehrungBegruendungEingabe,
): Promise<NachtragErgebnis> {
  const e = pruefeEingabe(DurchfuehrungBegruendungEingabeSchema, eingabe);
  return ausfuehren(ctx, async (tx, zeitpunkt) => {
    const lage = await ladeLage(ctx, e, { sperren: true });
    verlange(lage.rechte.nachtrag);
    const d = lage.d;
    const offen = await tx.durchfuehrung.findFirst({
      where: { nachtragZuId: d.id, status: { in: NACHTRAG_OFFEN } },
      select: { id: true },
    });
    if (offen) {
      throw new DienstFehler(
        'KONFLIKT',
        'Zu dieser Durchführung besteht bereits ein offener Nachtrag.',
      );
    }
    const neu = await tx.durchfuehrung.create({
      data: {
        kontrolleId: d.kontrolleId,
        kontrolleStandId: d.kontrolleStandId,
        periodeLabel: `${d.periodeLabel} · Nachtrag`,
        periodeVon: d.periodeVon,
        periodeBis: d.periodeBis,
        faelligAm: addTage(lage.heute, 14),
        status: 'GEPLANT',
        ausserplanmaessig: true,
        anlass: `Nachtrag zu ${d.kontrolle.code} ${d.periodeLabel}: ${e.begruendung}`.slice(
          0,
          2000,
        ),
        nachtragZuId: d.id,
        createdAt: zeitpunkt,
      },
      select: { id: true },
    });
    return {
      wert: { durchfuehrungId: neu.id, nachtragZuId: d.id },
      protokoll: protokoll(
        lage,
        'tcms.durchfuehrung.nachtrag_angelegt',
        { nachtragZuId: d.id, begruendung: e.begruendung },
        { typ: 'Durchfuehrung', id: neu.id },
      ),
    };
  });
}
