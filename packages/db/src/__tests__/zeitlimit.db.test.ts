// =============================================================================
// Zeitlimits in `mitTenant` (DB_TESTS=1, Befund 33): `lock_timeout` und
// `statement_timeout` gelten transaktionslokal; eine wartende oder zu lange
// Anweisung bricht die Datenbank ab (55P03 bzw. 57014), statt die
// Poolverbindung bis zum Ende des Sperrinhabers zu belegen. Erkannt werden die
// Abbrüche nur am Code (`zeitlimitFehlercode`).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eingabeFehlercode, zeitlimitFehlercode } from '../fehler';
import { erzeugeClient, mitTenant, sperrSchluessel, TenantFehler, type Tx } from '../tenant';

const AKTIV = process.env['DB_TESTS'] === '1';

const einstellungen = (tx: Tx) =>
  tx.$queryRaw<{ sperre: string; anweisung: string }[]>`
    SELECT pg_catalog.current_setting('lock_timeout') AS sperre,
           pg_catalog.current_setting('statement_timeout') AS anweisung`.then((z) => z[0]);

const fehlerVon = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe.skipIf(!AKTIV)('mitTenant: Zeitlimits der Datenbank', () => {
  let zweite: PrismaClient;
  beforeAll(() => {
    zweite = erzeugeClient(process.env['DATABASE_URL']);
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('setzt lock_timeout und statement_timeout transaktionslokal (Standard und abgeleitet)', async () => {
    expect(await mitTenant(randomUUID(), einstellungen)).toEqual({
      sperre: '5s',
      anweisung: '15s',
    });
    expect(await mitTenant(randomUUID(), einstellungen, { timeoutMs: 60_000 })).toEqual({
      sperre: '5s',
      anweisung: '30s',
    });
    expect(await mitTenant(randomUUID(), einstellungen, { timeoutMs: 4_000 })).toEqual({
      sperre: '2s',
      anweisung: '2s',
    });
    expect(
      await mitTenant(randomUUID(), einstellungen, {
        sperrWartezeitMs: 250,
        anweisungsdauerMs: 1_500,
      }),
    ).toEqual({ sperre: '250ms', anweisung: '1500ms' });
  });

  it('ungültige Zeitlimits werden vor jedem Datenbankzugriff abgewiesen', async () => {
    for (const opts of [
      { timeoutMs: 0 },
      { sperrWartezeitMs: -1 },
      { anweisungsdauerMs: 1.5 },
      { anweisungsdauerMs: Number.NaN },
    ]) {
      const e = await fehlerVon(mitTenant(randomUUID(), einstellungen, opts));
      expect(e, JSON.stringify(opts)).toBeInstanceOf(TenantFehler);
    }
  });

  it('eine zu lange Anweisung bricht ab: 57014, erkannt als Zeitlimit', async () => {
    const beginn = Date.now();
    const e = await fehlerVon(
      mitTenant(randomUUID(), (tx) => tx.$queryRaw`SELECT pg_catalog.pg_sleep(5)`, {
        anweisungsdauerMs: 200,
      }),
    );
    expect(Date.now() - beginn).toBeLessThan(4_000);
    expect(zeitlimitFehlercode(e)).toBe('57014');
    expect(eingabeFehlercode(e)).toBeNull();
  });

  it('Warten auf eine Sperre bricht ab: 55P03, die wartende Verbindung wird frei', async () => {
    const tenant = randomUUID();
    const schluessel = sperrSchluessel('zeitlimit-test', tenant);
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(
      tenant,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
        gehalten();
        await schranke;
      },
      { client: zweite, timeoutMs: 30_000 },
    );
    try {
      await haelt;
      const beginn = Date.now();
      const e = await fehlerVon(
        mitTenant(
          tenant,
          (tx) => tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`,
          { sperrWartezeitMs: 200 },
        ),
      );
      expect(Date.now() - beginn).toBeLessThan(4_000);
      expect(zeitlimitFehlercode(e)).toBe('55P03');
    } finally {
      loslassen();
      await halter;
    }
    // Gegenprobe: Ist die Sperre frei, gelingt dieselbe Abfrage mit demselben Limit.
    await mitTenant(
      tenant,
      (tx) => tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`,
      { sperrWartezeitMs: 200 },
    );
  });
});
