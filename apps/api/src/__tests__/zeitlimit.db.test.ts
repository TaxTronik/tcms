// =============================================================================
// Zeitlimits der Datenbank über den Dienst (DB_TESTS=1, Befund 33): Bricht
// PostgreSQL eine Route nach `lock_timeout` (55P03) bzw. `statement_timeout`
// (57014) ab – beide setzt `mitTenant` für jede Transaktion –, antwortet der
// Dienst `503 ZEITLIMIT` mit fester Meldung statt `500 INTERN`. Das Log nennt
// nur den festen Code, keine Meldung, keinen Stack und kein SQL.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mitTenant, sperrSchluessel, type Tx } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Routen } from '../routen';
import { aufbau, bestaetigtSenden, json } from './hilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const MELDUNG = 'Die Anfrage konnte nicht rechtzeitig bearbeitet werden. Bitte erneut versuchen.';

describe.skipIf(!AKTIV)('Befund 33: Zeitlimits der Datenbank → 503 ZEITLIMIT', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const schluessel = sperrSchluessel('zeitlimit-api', tenant);

  beforeAll(async () => {
    await mitTenant(tenant, (tx) =>
      tx.mandant.create({ data: { id: mandant, name: 'Mandant A', rechtsform: 'KapG' } }),
    );
  });

  const routen = (r: Routen<Tx>) => {
    const route = (pfad: string, lauf: (tx: Tx) => Promise<unknown>) =>
      r.route({
        methode: 'POST',
        pfad: `/v1/mandanten/:mandantId/${pfad}`,
        handler: async ({ tx }) => lauf(tx),
      });
    // Für den Test verkürzte Grenzen; die Standardwerte setzt mitTenant selbst.
    route('anweisung', async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '100ms'`;
      return tx.$queryRaw`SELECT pg_catalog.pg_sleep(3)`;
    });
    route('sperre', async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
      return tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
    });
  };
  const app = () =>
    aufbau({
      routen: routen as (r: Routen<unknown>) => void,
      daten: {
        mitTenant: (tenantId, fn) => mitTenant(tenantId, fn as (tx: Tx) => Promise<never>),
        ping: async () => undefined,
      },
    });
  const claims = { tnt: tenant, cli: { id: mandant, bt: true, hb: false } };

  async function pruefe(pfad: string, code: string) {
    const t = app();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${mandant}/${pfad}`,
      claims,
    });
    expect(r.status).toBe(503);
    expect((await json(r))['fehler']).toEqual({ code: 'ZEITLIMIT', meldung: MELDUNG });
    const anfrage = t.log.find((z) => z['ereignis'] === 'anfrage');
    expect(anfrage).toMatchObject({ status: 503, fehler: 'ZEITLIMIT', dbFehler: code });
    expect(anfrage).not.toHaveProperty('stack');
    expect(anfrage).not.toHaveProperty('ausnahme');
    for (const z of t.logRoh) expect(z).not.toMatch(/pg_sleep|advisory|statement timeout/i);
  }

  it('zu lange Anweisung (57014) → 503 ZEITLIMIT, Log nur mit Code', async () => {
    await pruefe('anweisung', '57014');
  });

  it('Warten auf eine Sperre (55P03) → 503 ZEITLIMIT, Log nur mit Code', async () => {
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(tenant, async (tx) => {
      await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
      gehalten();
      await schranke;
    });
    try {
      await haelt;
      await pruefe('sperre', '55P03');
    } finally {
      loslassen();
      await halter;
    }
  });
});
