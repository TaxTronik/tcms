// =============================================================================
// Durchführungsbezug der Audit-Einträge (DB_TESTS=1, Befunde 98, 110): Verlauf
// und Beteiligte einer Durchführung finden Einträge, die sie im Detail nennen,
// über einen Index je Tenant – nicht über einen Scan des ganzen Tenant-Audits.
//
// Unter RLS nutzt PostgreSQL eine Bedingung nur dann als Indexbedingung, wenn
// sie LEAKPROOF ist. `detail->>'…'` ist es nicht; deshalb vergleichen die
// Abfragen die generierten Spalten (Migration 20261117070000). Geprüft wird der
// Plan als Laufzeitrolle mit abgeschaltetem Seq Scan: Ist ein Index nutzbar,
// wählt der Planer ihn; sonst bleibt der (abgestrafte) Seq Scan.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schreibeAudit } from '../audit';
import { mitTenant, type Tx } from '../tenant';

const AKTIV = process.env['DB_TESTS'] === '1';

type Plan = { 'Node Type'?: string; 'Index Name'?: string; Plans?: Plan[] };

/** Alle Knoten eines Plans (EXPLAIN FORMAT JSON). */
function knoten(p: Plan): Plan[] {
  return [p, ...(p.Plans ?? []).flatMap(knoten)];
}

async function plan(tx: Tx, abfrage: 'spalte' | 'ausdruck' | 'nachtrag', id: string) {
  await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
  const zeilen =
    abfrage === 'spalte'
      ? await tx.$queryRaw<{ 'QUERY PLAN': [{ Plan: Plan }] }[]>`
          EXPLAIN (FORMAT JSON) SELECT pos FROM "AuditEvent"
           WHERE "detailDurchfuehrungId" = ${id}::text`
      : abfrage === 'nachtrag'
        ? await tx.$queryRaw<{ 'QUERY PLAN': [{ Plan: Plan }] }[]>`
          EXPLAIN (FORMAT JSON) SELECT pos FROM "AuditEvent"
           WHERE "detailNachtragZuId" = ${id}::text`
        : await tx.$queryRaw<{ 'QUERY PLAN': [{ Plan: Plan }] }[]>`
          EXPLAIN (FORMAT JSON) SELECT pos FROM "AuditEvent"
           WHERE detail->>'durchfuehrungId' = ${id}::text`;
  return knoten(zeilen[0]!['QUERY PLAN'][0].Plan);
}

describe.skipIf(!AKTIV)('Audit: Durchführungsbezug mit Index (generierte Spalten)', () => {
  it('die Spalten leiten sich aus detail ab und lassen sich nicht schreiben', async () => {
    const tenant = randomUUID();
    const did = `d${randomBytes(8).toString('hex')}`;
    const zeilen = await mitTenant(tenant, async (tx) => {
      await schreibeAudit(tx, {
        actorId: null,
        actorName: 'Test',
        aktion: 'tcms.test.bezug',
        objektTyp: 'Nachweis',
        objektId: 'n1',
        detail: { durchfuehrungId: did },
      });
      await schreibeAudit(tx, {
        actorId: null,
        actorName: 'Test',
        aktion: 'tcms.test.bezug',
        objektTyp: 'Durchfuehrung',
        objektId: 'n2',
        detail: { nachtragZuId: did },
      });
      await schreibeAudit(tx, {
        actorId: null,
        actorName: 'Test',
        aktion: 'tcms.test.bezug',
        objektTyp: 'Risiko',
        objektId: 'r1',
        detail: { anderes: did },
      });
      return tx.$queryRaw<{ objektId: string; d: string | null; n: string | null }[]>`
        SELECT "objektId", "detailDurchfuehrungId" AS d, "detailNachtragZuId" AS n
          FROM "AuditEvent" ORDER BY pos`;
    });
    expect(zeilen).toEqual([
      { objektId: 'n1', d: did, n: null },
      { objektId: 'n2', d: null, n: did },
      { objektId: 'r1', d: null, n: null },
    ]);
  });

  it('Vergleich über die generierten Spalten nutzt den Teilindex je Tenant (unter RLS)', async () => {
    const [spalte, nachtrag] = await mitTenant(randomUUID(), async (tx) => [
      await plan(tx, 'spalte', 'd1'),
      await plan(tx, 'nachtrag', 'd1'),
    ]);
    expect(spalte.map((k) => k['Index Name'])).toContain(
      'AuditEvent_tenant_id_detailDurchfuehrungId_idx',
    );
    expect(nachtrag.map((k) => k['Index Name'])).toContain(
      'AuditEvent_tenant_id_detailNachtragZuId_idx',
    );
  });

  it('Gegenprobe: detail->>… (nicht LEAKPROOF) kann unter RLS keinen solchen Index nutzen', async () => {
    const ausdruck = await mitTenant(randomUUID(), (tx) => plan(tx, 'ausdruck', 'd1'));
    const indizes = ausdruck.map((k) => k['Index Name']).filter((n) => n !== undefined);
    expect(indizes.filter((n) => /detail/i.test(n))).toEqual([]);
  });
});
