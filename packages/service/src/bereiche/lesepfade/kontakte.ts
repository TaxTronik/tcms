// =============================================================================
// Rollen der Mandantenseite (`GET/PUT /v1/mandanten/:mandantId/kontakte`,
// ADR 0001 §5): gesetzliche Vertretung (GV), Tax-Compliance-Beauftragte (TCB),
// Mitarbeitende (MA). Ein Mandantenkontakt ohne aktive Rolle hat keinen
// Zugriff. Lesen: Kanzleipersonen mit Leserecht; Setzen: `kannBearbeiten`.
//
// Regeln beim Setzen (auditiert, ein Ereignis je Änderung):
//   - Ein Kontakt gehört zu genau einem Mandanten des Tenants.
//   - Die letzte aktive GV kann nicht entfernt werden, solange offene
//     Freigaben an sie adressiert sind (erst neu adressieren oder Ersatz-GV
//     ernennen) → `KONFLIKT`.
// TS-05: Die Mandantenzeile wird mit FOR UPDATE gesperrt (parallele
// Rollenänderungen eines Mandanten nacheinander, Prüfung und Änderung in
// derselben Transaktion), dazu eine Sperre je Kontakt (paralleles Zuordnen
// desselben Kontakts zu zwei Mandanten).
// =============================================================================

import {
  DienstFehler,
  KontakteAntwortSchema,
  KontakteEingabeSchema,
  KontaktRollenAntwortSchema,
  KontaktRollenEingabeSchema,
  type KontakteAntwort,
  type KontakteEingabe,
  type KontaktRollenAntwort,
  type KontaktRollenEingabe,
} from '@tcms/contract';
import { tenantSperre, type Tx } from '@tcms/db';
import { mitAudit } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { kannLesen, type MandantRolle } from '../../rechte';
import { antwortNach, pruefeEingabe } from './hilfen';
import { brauchtBearbeitung } from './mandant';

const ROLLEN: readonly MandantRolle[] = [
  'GESETZLICHER_VERTRETER',
  'TAX_COMPLIANCE_BEAUFTRAGTER',
  'MITARBEITER',
];

type Zeile = { kontaktId: string; rolle: MandantRolle; aktiv: boolean; funktion: string | null };

function gruppiere(zeilen: readonly Zeile[]): KontakteAntwort['kontakte'] {
  const je = new Map<string, KontakteAntwort['kontakte'][number]>();
  for (const z of zeilen) {
    const k = je.get(z.kontaktId) ?? { kontaktId: z.kontaktId, rollen: [] };
    k.rollen.push({ rolle: z.rolle, aktiv: z.aktiv, funktion: z.funktion });
    je.set(z.kontaktId, k);
  }
  return [...je.values()];
}

const ZEILE = { kontaktId: true, rolle: true, aktiv: true, funktion: true } as const;

/** Alle Rollen (aktiv und deaktiviert) der Kontakte eines Mandanten. */
export async function ladeKontakte(
  ctx: DienstKontext,
  eingabe: KontakteEingabe,
): Promise<KontakteAntwort> {
  const e = pruefeEingabe(KontakteEingabeSchema, eingabe);
  const id = e.mandantId.toLowerCase();
  if (ctx.akteur.art !== 'KANZLEI' || !kannLesen(ctx.akteur, id)) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
  const m = await ctx.tx.mandant.findUnique({ where: { id }, select: { id: true } });
  if (!m) throw new DienstFehler('NICHT_GEFUNDEN');
  const zeilen = await ctx.tx.mandantKontaktRolle.findMany({
    where: { mandantId: id },
    orderBy: [{ kontaktId: 'asc' }, { rolle: 'asc' }],
    select: ZEILE,
  });
  return antwortNach(KontakteAntwortSchema, 'ladeKontakte', { kontakte: gruppiere(zeilen) });
}

/** Sperrt die Mandantenzeile (TS-05); unbekannt bzw. fremder Tenant → NICHT_GEFUNDEN. */
async function sperreMandant(tx: Tx, id: string): Promise<void> {
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Mandant" WHERE id = ${id}::uuid FOR UPDATE`;
  if (z.length === 0) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Setzt die aktiven Rollen eines Kontakts beim Mandanten auf genau `rollen`
 * (leer = Kontakt deaktivieren). Rollen werden nie gelöscht, nur deaktiviert.
 */
export async function setzeKontaktRollen(
  ctx: DienstKontext,
  eingabe: KontaktRollenEingabe,
): Promise<KontaktRollenAntwort> {
  const e = pruefeEingabe(KontaktRollenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const kontaktId = e.kontaktId.toLowerCase();
  brauchtBearbeitung(ctx.akteur, mandantId, 'Die Pflege der Kontaktrollen');
  const tx = ctx.tx;

  await sperreMandant(tx, mandantId);
  await tenantSperre(tx, `kontakt.${kontaktId}`);

  const anderer = await tx.mandantKontaktRolle.count({
    where: { kontaktId, mandantId: { not: mandantId } },
  });
  if (anderer > 0) {
    throw new DienstFehler(
      'KONFLIKT',
      'Der Kontakt kann diesem Mandanten nicht zugeordnet werden.',
    );
  }

  const vorher = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, kontaktId },
    select: ZEILE,
  });
  const aktivVorher = new Set(vorher.filter((z) => z.aktiv).map((z) => z.rolle));
  const soll = new Set(e.rollen);

  if (aktivVorher.has('GESETZLICHER_VERTRETER') && !soll.has('GESETZLICHER_VERTRETER')) {
    const weitereGv = await tx.mandantKontaktRolle.count({
      where: {
        mandantId,
        rolle: 'GESETZLICHER_VERTRETER',
        aktiv: true,
        kontaktId: { not: kontaktId },
      },
    });
    if (weitereGv === 0) {
      const offen = await tx.freigabe.count({
        where: {
          programm: { mandantId },
          status: 'OFFEN',
          empfaengerId: { equals: kontaktId, mode: 'insensitive' },
        },
      });
      if (offen > 0) {
        throw new DienstFehler(
          'KONFLIKT',
          'Die letzte gesetzliche Vertretung hat offene Freigaben. Bitte zuerst eine weitere gesetzliche Vertretung ernennen oder die Freigaben neu adressieren.',
        );
      }
    }
  }

  const aenderungen: { rolle: MandantRolle; aktiv: boolean; neu: boolean }[] = [];
  for (const rolle of ROLLEN) {
    const z = vorher.find((x) => x.rolle === rolle);
    const sollAktiv = soll.has(rolle);
    if (!z) {
      if (sollAktiv) aenderungen.push({ rolle, aktiv: true, neu: true });
    } else if (z.aktiv !== sollAktiv || (sollAktiv && z.funktion !== e.funktion)) {
      aenderungen.push({ rolle, aktiv: sollAktiv, neu: false });
    }
  }

  if (aenderungen.length > 0) {
    const programm = await tx.tcmsProgramm.findFirst({
      where: { mandantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await mitAudit(ctx, async (t) => {
      for (const a of aenderungen) {
        if (a.neu) {
          await t.mandantKontaktRolle.create({
            data: { mandantId, kontaktId, rolle: a.rolle, funktion: e.funktion, aktiv: true },
          });
        } else {
          await t.mandantKontaktRolle.updateMany({
            where: { mandantId, kontaktId, rolle: a.rolle },
            data: a.aktiv ? { aktiv: true, funktion: e.funktion } : { aktiv: false },
          });
        }
      }
      return {
        wert: undefined,
        protokoll: {
          aktion: 'tcms.kontakt.rollen_gesetzt',
          objektTyp: 'MandantKontaktRolle',
          objektId: kontaktId,
          programmId: programm?.id ?? null,
          detail: {
            mandantId,
            vorher: ROLLEN.filter((r) => aktivVorher.has(r)),
            nachher: ROLLEN.filter((r) => soll.has(r)),
            funktion: e.funktion,
          },
        },
      };
    });
  }

  const nachher = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, kontaktId },
    orderBy: { rolle: 'asc' },
    select: ZEILE,
  });
  return antwortNach(KontaktRollenAntwortSchema, 'setzeKontaktRollen', {
    kontaktId,
    rollen: nachher.map((z) => ({ rolle: z.rolle, aktiv: z.aktiv, funktion: z.funktion })),
    geaendert: aenderungen.length > 0,
  });
}
