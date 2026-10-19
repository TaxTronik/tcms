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
// =============================================================================

import {
  AuditListeAntwortSchema,
  AuditListeEingabeSchema,
  AuditPruefenAntwortSchema,
  AuditPruefenEingabeSchema,
  DienstFehler,
  type AuditListeAntwort,
  type AuditListeEingabe,
  type AuditPruefenAntwort,
  type AuditPruefenEingabe,
} from '@tcms/contract';
import { aktuellerTenant, type Prisma } from '@tcms/db';
import { KETTEN_ANFANG, pruefeKette, type KettenStand } from '@tcms/domain/audit';
import type { DienstKontext } from '../../kontext';
import { kannVerwalten } from '../../rechte';
import { alsJson, antwortNach, pruefeEingabe } from './hilfen';

/** Einträge je Seite der Kettenprüfung. */
export const PRUEF_SEITE = 1000;
/** Zeitbudget einer Kettenprüfung (unter dem Transaktionslimit von 30 s). */
export const PRUEF_ZEITBUDGET_MS = 20_000;

function nurAdmin(ctx: DienstKontext): void {
  if (!kannVerwalten(ctx.akteur)) {
    throw new DienstFehler('NICHT_BERECHTIGT', 'Das Audit ist Admins/Partnern vorbehalten.');
  }
}

/** Eine Seite des Audits; aufsteigend (`nach`) oder absteigend (`vor`). */
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
        })
      : []
    ).map((p) => [p.id, p.mandantId]),
  );
  const kopf = await ctx.tx.auditEvent.findFirst({
    orderBy: { pos: 'desc' },
    select: { pos: true, hash: true, at: true },
  });
  return antwortNach(
    AuditListeAntwortSchema,
    'ladeAudit',
    alsJson({
      eintraege: seite.map((z) => ({
        ...z,
        mandantId: z.programmId ? (mandantJe.get(z.programmId) ?? null) : null,
      })),
      weiter: zeilen.length > limit ? seite[seite.length - 1]!.pos : null,
      kopf,
    }),
  );
}

/**
 * Prüft die Hashkette des Tenants seitenweise mit `pruefeKette` aus
 * `@tcms/domain/audit` (einzige Implementierung der Kettenregeln), jede Seite
 * ab dem Stand der vorherigen. Nach Ablauf des Zeitbudgets `ABGEBROCHEN` mit
 * `weiterAb`; die Fortsetzung verkettet mit dem gespeicherten Hash an dieser
 * Position.
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
