// =============================================================================
// RT-02 über den Dienst (DB_TESTS=1): Eine Route, die den Tenant-Kontext
// `tcms.tenant_id` umsetzt (wie es eine SQL-Injection täte), wird
// zurückgerollt. Antwort `500 INTERN` ohne Detail, keine Zeile des fremden
// Tenants geändert, keine Daten des fremden Tenants in der Antwort, ein
// Log-Eintrag ohne Tenant-IDs. Die Gegenprobe ohne Umsetzen gelingt.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { KONTEXT_VERAENDERT, mitTenant, type Tx } from '@tcms/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Routen } from '../routen';
import { aufbau, bestaetigtSenden, json } from './hilfen';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT-02: Route setzt den Tenant-Kontext um', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const mandantA = randomUUID();
  const mandantB = randomUUID();
  const NAME_B = 'Mandant B (fremder Tenant)';

  beforeAll(async () => {
    await mitTenant(tenantA, (tx) =>
      tx.mandant.create({ data: { id: mandantA, name: 'Mandant A', rechtsform: 'KapG' } }),
    );
    await mitTenant(tenantB, (tx) =>
      tx.mandant.create({ data: { id: mandantB, name: NAME_B, rechtsform: 'KapG' } }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  const routen = (r: Routen<Tx>) => {
    r.route({
      methode: 'POST',
      pfad: '/v1/mandanten/:mandantId/gekapert',
      handler: async ({ tx }) => {
        await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${tenantB}, true)`;
        await tx.$executeRaw`UPDATE "Mandant" SET name = 'gekapert' WHERE id = ${mandantB}::uuid`;
        return tx.$queryRaw<{ name: string }[]>`SELECT name FROM "Mandant"`;
      },
    });
    r.route({
      methode: 'POST',
      pfad: '/v1/mandanten/:mandantId/harmlos',
      handler: async ({ tx }) => tx.$queryRaw<{ name: string }[]>`SELECT name FROM "Mandant"`,
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
  const claims = { tnt: tenantA, cli: { id: mandantA, bt: true, hb: false } };

  it('wird zurückgerollt: 500 ohne Detail, fremder Tenant unverändert, Log ohne IDs', async () => {
    const ausgabe: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      ausgabe.push(String(chunk));
      return true;
    });
    const t = app();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${mandantA}/gekapert`,
      claims,
    });
    vi.restoreAllMocks();
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: false, fehler: { code: 'INTERN' } });
    expect(text).not.toContain(NAME_B);
    const name = await mitTenant(tenantB, async (tx) =>
      tx.mandant.findFirstOrThrow({ where: { id: mandantB }, select: { name: true } }),
    );
    expect(name.name).toBe(NAME_B);
    // Dienst-Log: Anfrage mit INTERN und Ausnahmetyp; Datenbank-Log: eine Zeile ohne Details.
    const anfrage = t.log.find((z) => z['ereignis'] === 'anfrage');
    expect(anfrage).toMatchObject({ fehler: 'INTERN', ausnahme: 'TenantFehler' });
    const meldung = ausgabe.filter((z) => z.includes(KONTEXT_VERAENDERT));
    expect(meldung).toHaveLength(1);
    expect(Object.keys(JSON.parse(meldung[0]!)).sort()).toEqual(['ereignis', 'stufe', 'zeit']);
    for (const z of [...ausgabe, ...t.logRoh]) {
      expect(z).not.toContain(tenantB);
      expect(z).not.toContain(mandantB);
    }
  });

  it('Gegenprobe: ohne Umsetzen liefert dieselbe Route nur den eigenen Tenant', async () => {
    const r = await bestaetigtSenden(app().app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${mandantA}/harmlos`,
      claims,
    });
    expect(r.status).toBe(200);
    expect((await json(r))['daten']).toEqual([{ name: 'Mandant A' }]);
  });
});
