// =============================================================================
// Datenbankkonflikt → KONFLIKT gegen PostgreSQL (Befund 92): echte Verklemmung
// (40P01) über Advisory-Locks (Raw-SQL, Prisma P2010) und über Zeilen
// (Modellabfrage, Prisma P2039) sowie eine echte Eindeutigkeitsverletzung über
// Raw-SQL (P2010 mit 23505). Mit Prisma 7 und adapter-pg steht der SQLSTATE nur
// in `meta.driverAdapterError.cause`; die frühere Abbildung (nur `code`,
// `meta.code`, `cause`) fand ihn nicht und antwortete `500 INTERN`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DienstFehler } from '@tcms/contract';
import {
  erzeugeClient,
  konfliktFehlercode,
  mitTenant,
  tenantSperre,
  type PrismaClient,
  type Tx,
} from '@tcms/db';
import { erwarteDbFehler, regel } from '@tcms/db/testhilfe';
import { alsKonflikt, konfliktSicher } from './konflikt';

const AKTIV = process.env['DB_TESTS'] === '1';
const VERKLEMMUNG = { sqlstate: '40P01', meldung: 'deadlock detected' } as const;

describe.skipIf(!AKTIV)('Datenbankkonflikt → KONFLIKT (PostgreSQL)', () => {
  const tenant = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  let zweite: PrismaClient;

  beforeAll(async () => {
    zweite = erzeugeClient(process.env['DATABASE_URL']);
    await mitTenant(tenant, async (tx) => {
      await tx.mandant.create({ data: { id: m1, name: 'Konflikt 1', rechtsform: 'GmbH' } });
      await tx.mandant.create({ data: { id: m2, name: 'Konflikt 2', rechtsform: 'GmbH' } });
    });
  });

  afterAll(async () => {
    await zweite?.$disconnect();
  });

  /**
   * Zwei Transaktionen nehmen je eine erste Sperre, warten aufeinander und
   * nehmen dann die Sperre der anderen: PostgreSQL bricht genau eine mit 40P01
   * ab. Liefert die rohen Ergebnisse (ohne Abbildung).
   */
  async function verklemme(
    sperre: (tx: Tx, welche: 0 | 1) => Promise<unknown>,
  ): Promise<PromiseSettledResult<void>[]> {
    let bereit = 0;
    let beide!: () => void;
    const schranke = new Promise<void>((r) => (beide = r));
    const lauf = (erste: 0 | 1, client?: PrismaClient) =>
      mitTenant(
        tenant,
        async (tx) => {
          await sperre(tx, erste);
          if (++bereit === 2) beide();
          await schranke;
          await sperre(tx, erste === 0 ? 1 : 0);
        },
        { timeoutMs: 30_000, ...(client ? { client } : {}) },
      );
    return Promise.allSettled([lauf(0), lauf(1, zweite)]);
  }

  function genauEineVerklemmt(r: PromiseSettledResult<void>[]): unknown {
    const abgebrochen = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(abgebrochen).toHaveLength(1);
    const e = abgebrochen[0]!.reason;
    erwarteDbFehler(e, VERKLEMMUNG);
    return e;
  }

  it('Verklemmung über Advisory-Locks (Raw-SQL) wird KONFLIKT', async () => {
    const e = genauEineVerklemmt(
      await verklemme((tx, welche) => tenantSperre(tx, `test.konflikt.${welche}`)),
    );
    expect(konfliktFehlercode(e)).toBe('40P01');
    const k = alsKonflikt(e);
    expect(k).toBeInstanceOf(DienstFehler);
    expect((k as DienstFehler).code).toBe('KONFLIKT');
  });

  it('Verklemmung über Zeilen (Modellabfrage) wird KONFLIKT', async () => {
    const e = genauEineVerklemmt(
      await verklemme((tx, welche) =>
        tx.mandant.updateMany({
          where: { id: welche === 0 ? m1 : m2 },
          data: { datevNr: String(welche) },
        }),
      ),
    );
    expect(konfliktFehlercode(e)).toBe('40P01');
    expect((alsKonflikt(e) as DienstFehler).code).toBe('KONFLIKT');
  });

  it('Eindeutigkeitsverletzung über Raw-SQL wird KONFLIKT, andere Fehler bleiben', async () => {
    const roh = await mitTenant(
      tenant,
      (tx) => tx.$executeRaw`
        INSERT INTO "Mandant" (id, name, rechtsform) VALUES (${m1}::uuid, 'Doppelt', 'GmbH')`,
    ).catch((x: unknown) => x);
    erwarteDbFehler(roh, regel.eindeutig('Mandant_pkey'));
    expect(konfliktFehlercode(roh)).toBe('23505');
    const f = await konfliktSicher(() => Promise.reject(roh), 'Schon angelegt.').catch(
      (x: unknown) => x,
    );
    expect([(f as DienstFehler).code, (f as DienstFehler).message]).toEqual([
      'KONFLIKT',
      'Schon angelegt.',
    ]);
    // Eine NOT-NULL-Verletzung ist kein Konflikt.
    const anders = await mitTenant(
      tenant,
      (tx) => tx.$executeRaw`
        INSERT INTO "Mandant" (id, name, rechtsform) VALUES (${randomUUID()}::uuid, NULL, 'GmbH')`,
    ).catch((x: unknown) => x);
    erwarteDbFehler(anders, regel.nichtNull('Mandant', 'name'));
    expect(alsKonflikt(anders)).toBe(anders);
  });
});
