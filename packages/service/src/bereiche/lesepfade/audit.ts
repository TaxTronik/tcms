// =============================================================================
// Audit des Tenants (ADR 0001 §4): Einträge seitenweise lesen
// (`GET /v1/audit`) und die Hashkette prüfen (`POST /v1/audit/pruefen`).
// Nur Admins/Partner der Kanzlei (`kannVerwalten`); der Tenant kommt aus dem
// Akteur (RLS), nie aus der Eingabe.
//
// Position (RT-03): Einträge, Cursor, Kettenkopf und Fortsetzungspunkt nennen
// `pos`, die laufende Position je Tenant. Der globale Schlüssel `seq` wird nie
// gelesen oder ausgegeben – Lücken darin verrieten fremde Audit-Aktivität.
//
// Kosten: Lesen höchstens `MAX_AUDIT_JE_SEITE` Einträge je Aufruf (Cursor
// über `pos`, Index (tenant_id, pos) bzw. (tenant_id, programmId, pos)). Die
// Kettenprüfung liest in Seiten zu `PRUEF_SEITE` Einträgen (Speicher
// begrenzt) und bricht nach `PRUEF_ZEITBUDGET_MS` mit Fortsetzungspunkt ab,
// unter dem Transaktionslimit von 30 s.
//
// Vertraulichkeit (Fachkonzept §13, RT-01, tcms-s11): Einträge zu einer
// vertraulichen Feststellung und ihren Maßnahmen zeigt die Liste nur Personen,
// die die Feststellung lesen dürfen (`kannVertraulichLesen` mit dem
// Mandantenbezug der Anfrage – dieselbe Regel wie der Lesepfad der
// Feststellung). Alle anderen, auch Admins/Partner ohne Bezug zu diesem
// Mandanten, erhalten eine maskierte Variante (Positivliste: Position,
// Zeitpunkt, Ereignisart, Objekt, Mandant, Akteursart, „vertraulich“) und ab
// der ersten für sie maskierten Position keine Hashes mehr: Jeder spätere
// Hash hängt vom maskierten Inhalt ab, und Inhalte mit wenigen möglichen
// Werten (§-153-Entscheidung, Auswirkung, Schwere) ließen sich damit offline
// bestätigen. Hashes entstehen unverändert über die vollständigen Einträge;
// die Kettenprüfung liest sie vollständig und gibt keine Inhalte aus (Status,
// Zahlen, Positionen, feste Gründe).
// =============================================================================

import {
  AuditListeAntwortSchema,
  AuditListeEingabeSchema,
  AuditPruefenAntwortSchema,
  AuditPruefenEingabeSchema,
  DienstFehler,
  nichtBerechtigt,
  type AkteurArt,
  type AuditListeAntwort,
  type AuditListeEingabe,
  type AuditPruefenAntwort,
  type AuditPruefenEingabe,
} from '@tcms/contract';
import { aktuellerTenant, type Prisma } from '@tcms/db';
import { KETTEN_ANFANG, pruefeKette, type KettenStand } from '@tcms/domain/audit';
import type { DienstKontext } from '../../kontext';
import { beteiligteVon, kannVerwalten, kannVertraulichLesen } from '../../rechte';
import { alsJson, antwortNach, pruefeEingabe } from './hilfen';

/** Einträge je Seite der Kettenprüfung. */
export const PRUEF_SEITE = 1000;
/** Zeitbudget einer Kettenprüfung (unter dem Transaktionslimit von 30 s). */
export const PRUEF_ZEITBUDGET_MS = 20_000;

function nurAdmin(ctx: DienstKontext): void {
  if (!kannVerwalten(ctx.akteur)) {
    throw nichtBerechtigt('VERWALTUNG', 'Das Audit ist Admins/Partnern vorbehalten.');
  }
}

/** Objekte, deren Audit-Einträge der Akteur nur maskiert sieht (tcms-s11). */
interface Verborgen {
  feststellungen: ReadonlySet<string>;
  massnahmen: ReadonlySet<string>;
  /** Erste Position eines maskierten Eintrags im Tenant; ab hier keine Hashes (`null`: keine). */
  ersteMaskiert: number | null;
}

/**
 * Vertrauliche Feststellungen des Tenants, die der Akteur nicht lesen darf
 * (`kannVertraulichLesen` mit seinem Mandantenbezug, Beteiligte aus
 * `beteiligteVon`), samt ihrer Maßnahmen. Maßgeblich ist die Vertraulichkeit
 * heute: Wird eine Feststellung vertraulich, sind auch ihre früheren Einträge
 * maskiert (wie im Lesepfad der Feststellung).
 */
async function verborgeneObjekte(ctx: DienstKontext): Promise<Verborgen> {
  const vertraulich = await ctx.tx.feststellung.findMany({
    where: { vertraulich: true },
    select: {
      id: true,
      erfasstVon: true,
      p153EntschiedenVon: true,
      verwerfenBeantragtVon: true,
      programm: { select: { mandantId: true } },
      massnahmen: {
        select: { id: true, verantwortlich: true },
        orderBy: [{ wiedervorlageNr: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: { id: 'asc' },
  });
  const feststellungen = new Set<string>();
  const massnahmen = new Set<string>();
  for (const f of vertraulich) {
    if (kannVertraulichLesen(ctx.akteur, f.programm.mandantId, beteiligteVon(f))) continue;
    feststellungen.add(f.id);
    for (const m of f.massnahmen) massnahmen.add(m.id);
  }
  if (feststellungen.size === 0) return { feststellungen, massnahmen, ersteMaskiert: null };
  const erste = await ctx.tx.auditEvent.findFirst({
    where: {
      OR: [
        { objektTyp: 'Feststellung', objektId: { in: [...feststellungen] } },
        { objektTyp: 'Massnahme', objektId: { in: [...massnahmen] } },
      ],
    },
    orderBy: { pos: 'asc' },
    select: { pos: true },
  });
  return { feststellungen, massnahmen, ersteMaskiert: erste?.pos ?? null };
}

function istVerborgen(v: Verborgen, z: { objektTyp: string; objektId: string }): boolean {
  return (
    (z.objektTyp === 'Feststellung' && v.feststellungen.has(z.objektId)) ||
    (z.objektTyp === 'Massnahme' && v.massnahmen.has(z.objektId))
  );
}

/**
 * Akteursart eines maskierten Eintrags ohne Namen und ID: `SYSTEM` nach der
 * Kennzeichnung durch `mitAudit` (`detail.systemakteur`, im Hash), `MANDANT`
 * bei einer Kontakt-ID mit Rolle im Tenant (Rollen werden nie gelöscht),
 * sonst `KANZLEI`; ohne Akteur-ID `null`.
 */
function akteurArt(
  z: { actorId: string | null; detail: unknown },
  kontakte: ReadonlySet<string>,
): AkteurArt | null {
  const d = z.detail;
  if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
    if ((d as Record<string, unknown>)['systemakteur'] === true) return 'SYSTEM';
  }
  if (!z.actorId) return null;
  return kontakte.has(z.actorId.toLowerCase()) ? 'MANDANT' : 'KANZLEI';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Kontakt-IDs (klein) unter den Akteuren, nur für maskierte Einträge abgefragt.
 * `kontaktId` ist eine UUID-Spalte: Eine Akteur-ID in anderer Form (Altbestand,
 * Seed) kann kein Kontakt sein und darf die Abfrage nicht scheitern lassen
 * (22P02 hätte die ganze Seite verhindert).
 */
async function kontaktIds(ctx: DienstKontext, ids: readonly string[]): Promise<Set<string>> {
  const gesucht = [...new Set(ids.map((id) => id.toLowerCase()).filter((id) => UUID.test(id)))];
  if (gesucht.length === 0) return new Set();
  const rollen = await ctx.tx.mandantKontaktRolle.findMany({
    where: { kontaktId: { in: gesucht } },
    select: { id: true, kontaktId: true },
    orderBy: { id: 'asc' },
  });
  return new Set(rollen.map((r) => r.kontaktId.toLowerCase()));
}

/**
 * Eine Seite des Audits; aufsteigend (`nach`) oder absteigend (`vor`).
 * Einträge zu vertraulichen Feststellungen, die der Akteur nicht lesen darf,
 * maskiert; Hashes erst ab der ersten maskierten Position verborgen (Kopf).
 */
export async function ladeAudit(
  ctx: DienstKontext,
  eingabe: AuditListeEingabe,
): Promise<AuditListeAntwort> {
  nurAdmin(ctx);
  const e = pruefeEingabe(AuditListeEingabeSchema, eingabe);
  const limit = e.limit ?? 100;
  const absteigend = e.vor !== undefined;
  const where: Prisma.AuditEventWhereInput = {};
  if (e.programmId) where.programmId = e.programmId;
  if (e.mandantId) {
    const programme = await ctx.tx.tcmsProgramm.findMany({
      where: { mandantId: e.mandantId.toLowerCase() },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    where.programmId = { in: programme.map((p) => p.id) };
  }
  if (e.aktion) where.aktion = { startsWith: e.aktion };
  if (absteigend) where.pos = { lt: e.vor };
  else if (e.nach !== undefined) where.pos = { gt: e.nach };

  const zeilen = await ctx.tx.auditEvent.findMany({
    where,
    orderBy: { pos: absteigend ? 'desc' : 'asc' },
    take: limit + 1,
    select: {
      pos: true,
      at: true,
      actorId: true,
      actorName: true,
      aktion: true,
      objektTyp: true,
      objektId: true,
      programmId: true,
      detail: true,
      prevHash: true,
      hash: true,
    },
  });
  const seite = zeilen.slice(0, limit);
  const programmIds = [...new Set(seite.map((z) => z.programmId).filter((x) => x !== null))];
  const mandantJe = new Map(
    (programmIds.length
      ? await ctx.tx.tcmsProgramm.findMany({
          where: { id: { in: programmIds } },
          select: { id: true, mandantId: true },
          orderBy: { id: 'asc' },
        })
      : []
    ).map((p) => [p.id, p.mandantId]),
  );
  const kopf = await ctx.tx.auditEvent.findFirst({
    orderBy: { pos: 'desc' },
    select: { pos: true, hash: true, at: true },
  });
  const verborgen = await verborgeneObjekte(ctx);
  const kontakte = await kontaktIds(
    ctx,
    seite.filter((z) => istVerborgen(verborgen, z) && z.actorId).map((z) => z.actorId!),
  );
  // Hashes nur vor der ersten für den Akteur maskierten Position (siehe Kopf).
  const hashSichtbar = (pos: number) =>
    verborgen.ersteMaskiert === null || pos < verborgen.ersteMaskiert;
  return antwortNach(
    AuditListeAntwortSchema,
    'ladeAudit',
    alsJson({
      eintraege: seite.map((z) => {
        // Felder, die jede Variante trägt (keine Inhalte, keine Personen).
        const rahmen = {
          pos: z.pos,
          at: z.at,
          aktion: z.aktion,
          objektTyp: z.objektTyp,
          objektId: z.objektId,
          programmId: z.programmId,
          mandantId: z.programmId ? (mandantJe.get(z.programmId) ?? null) : null,
        };
        if (istVerborgen(verborgen, z)) {
          // Positivliste (AGENTS.md: eigene Variante, nie durch Überschreiben).
          return {
            maskiert: true,
            ...rahmen,
            akteurArt: akteurArt(z, kontakte),
            vertraulich: true,
          };
        }
        const sichtbar = hashSichtbar(z.pos);
        return {
          maskiert: false,
          ...rahmen,
          actorId: z.actorId,
          actorName: z.actorName,
          detail: z.detail,
          prevHash: sichtbar ? z.prevHash : null,
          hash: sichtbar ? z.hash : null,
        };
      }),
      weiter: zeilen.length > limit ? seite[seite.length - 1]!.pos : null,
      kopf: kopf
        ? { pos: kopf.pos, hash: hashSichtbar(kopf.pos) ? kopf.hash : null, at: kopf.at }
        : null,
    }),
  );
}

/**
 * Prüft die Hashkette des Tenants seitenweise mit `pruefeKette` aus
 * `@tcms/domain/audit` (einzige Implementierung der Kettenregeln), jede Seite
 * ab dem Stand der vorherigen. Nach Ablauf des Zeitbudgets `ABGEBROCHEN` mit
 * `weiterAb`; die Fortsetzung verkettet mit dem gespeicherten Hash an dieser
 * Position. Geprüft wird über die vollständigen Einträge, auch vertrauliche
 * (tcms-s11); die Antwort nennt nur Status, Zahlen, Positionen und einen
 * festen Grund aus `pruefeKette` – keine Inhalte, Namen oder Hashes.
 */
export async function pruefeAudit(
  ctx: DienstKontext,
  eingabe: AuditPruefenEingabe,
  opts: { zeitbudgetMs?: number; seite?: number } = {},
): Promise<AuditPruefenAntwort> {
  nurAdmin(ctx);
  const e = pruefeEingabe(AuditPruefenEingabeSchema, eingabe);
  const budget = Math.min(opts.zeitbudgetMs ?? PRUEF_ZEITBUDGET_MS, PRUEF_ZEITBUDGET_MS);
  const seiteGroesse = Math.max(1, Math.min(opts.seite ?? PRUEF_SEITE, PRUEF_SEITE));
  const ende = Date.now() + budget;
  const tenantId = await aktuellerTenant(ctx.tx);

  let stand: KettenStand = KETTEN_ANFANG;
  if (e.ab !== undefined && e.ab > 0) {
    const start = await ctx.tx.auditEvent.findFirst({
      where: { tenantId, pos: e.ab },
      select: { pos: true, hash: true },
    });
    if (!start)
      throw new DienstFehler('UNGUELTIG', 'Fortsetzungspunkt unbekannt.', { ab: ['unbekannt'] });
    stand = { prevHash: start.hash, pos: start.pos };
  }

  let geprueft = 0;
  const ergebnis = (
    status: AuditPruefenAntwort['status'],
    bruchBei: number | null = null,
    grund: string | null = null,
  ) =>
    antwortNach(AuditPruefenAntwortSchema, 'pruefeAudit', {
      status,
      geprueft,
      bruchBei,
      grund,
      weiterAb: status === 'ABGEBROCHEN' ? stand.pos : null,
    });

  // Je Aufruf mindestens eine Seite (Fortschritt garantiert), dann höchstens bis zum Zeitbudget.
  for (;;) {
    const seite = await ctx.tx.auditEvent.findMany({
      // Explizit der Tenant der Transaktion (wie `pruefeAuditKette`), zusätzlich zu RLS.
      where: { tenantId, pos: { gt: stand.pos } },
      orderBy: { pos: 'asc' },
      take: seiteGroesse,
      // Ohne `seq`: Er gehört nicht zur Kette (RT-03).
      select: {
        pos: true,
        kettenVersion: true,
        tenantId: true,
        at: true,
        actorId: true,
        actorName: true,
        aktion: true,
        objektTyp: true,
        objektId: true,
        programmId: true,
        detail: true,
        prevHash: true,
        hash: true,
      },
    });
    const r = pruefeKette(tenantId, seite, stand);
    geprueft += r.geprueft;
    stand = r.stand;
    if (!r.gueltig) return ergebnis('GEBROCHEN', r.bruchBei, r.grund);
    if (seite.length < seiteGroesse) return ergebnis('INTAKT');
    if (Date.now() >= ende) return ergebnis('ABGEBROCHEN');
  }
}
