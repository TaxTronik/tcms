// =============================================================================
// RT4-T-08 über den Dienst (DB_TESTS=1): Scheitert eine Route an Text, den
// PostgreSQL nicht speichern kann (22021 NUL in TEXT, 22P05 NUL in JSONB,
// 22P02 ungültige Darstellung), antwortet der Dienst `400 UNGUELTIG` statt
// `500 INTERN`. Das Log nennt nur den festen Code – keine Meldung, keinen
// Stack und keinen Eingabewert. Andere Datenbankfehler bleiben `500`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mitTenant, type Tx } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Routen } from '../routen';
import { aufbau, bestaetigtSenden, json } from './hilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const WERT = 'Geheimer Eingabewert';

describe.skipIf(!AKTIV)('RT4-T-08: Datenbankfehler ungültiger Texteingaben', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();

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
    route('nul-text', (tx) => tx.$queryRaw`SELECT ${`${WERT}\u0000`}::text AS x`);
    route(
      'nul-json',
      (tx) => tx.$queryRaw`SELECT ${JSON.stringify({ a: `${WERT}\u0000` })}::jsonb`,
    );
    route('darstellung', (tx) => tx.$queryRaw`SELECT ${WERT}::uuid AS x`);
    route('division', (tx) => tx.$queryRaw`SELECT 1 / ${0}::int AS x`);
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

  it.each([
    ['nul-text', '22021'],
    ['nul-json', '22P05'],
    ['darstellung', '22P02'],
  ])('%s → 400 UNGUELTIG, Log nur mit Code %s', async (pfad, code) => {
    const t = app();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${mandant}/${pfad}`,
      claims,
    });
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body['fehler']).toEqual({
      code: 'UNGUELTIG',
      meldung: 'Die Eingabe enthält Zeichen, die nicht gespeichert werden können.',
    });
    const anfrage = t.log.find((z) => z['ereignis'] === 'anfrage');
    expect(anfrage).toMatchObject({ status: 400, fehler: 'UNGUELTIG', dbFehler: code });
    expect(anfrage).not.toHaveProperty('stack');
    expect(anfrage).not.toHaveProperty('ausnahme');
    for (const z of t.logRoh) expect(z).not.toContain(WERT);
    expect(JSON.stringify(body)).not.toContain(WERT);
  });

  it('Gegenprobe: ein anderer Datenbankfehler bleibt 500 INTERN', async () => {
    const t = app();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${mandant}/division`,
      claims,
    });
    expect(r.status).toBe(500);
    expect((await json(r))['fehler']).toEqual({ code: 'INTERN' });
  });
});
