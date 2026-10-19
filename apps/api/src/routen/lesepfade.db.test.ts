// =============================================================================
// Endpunkte des Bereichs „lesepfade" über `erzeugeApp` mit echter Datenbank
// (DB_TESTS=1, DATABASE_URL = tcms_app, Demo-Seed) und signierten
// Akteursbestätigungen: Erfolg, Mandantenbindung (404), Mandantenperson auf
// Staff-Endpunkten (404), ungültige Eingaben (400).
// =============================================================================

import { bodySha256, KontextAntwortSchema, type AkteurClaims } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { describe, expect, it } from 'vitest';
import { aufbau, bestaetigtSenden, claims, json, mandantClaims } from '../__tests__/hilfen';
import { registriereLesepfade } from './lesepfade';

const AKTIV = process.env['DB_TESTS'] === '1';

const app = () =>
  aufbau({
    routen: (r) => registriereLesepfade(r as Parameters<typeof registriereLesepfade>[0]),
    daten: {
      mitTenant: (tenantId, fn) => mitTenant(tenantId, fn as (tx: Tx) => Promise<never>),
      ping: async () => undefined,
    },
  }).app;

/** Anna (Admin, BT) mit Bezug auf Talwind, im Demo-Tenant. */
const anna = (over: Partial<AkteurClaims> = {}): Partial<AkteurClaims> => ({
  tnt: DEMO_TENANT_ID,
  sub: DEMO_IDS.anna,
  rol: { adm: true, bt: true },
  cli: { id: DEMO_IDS.talwind, bt: true, hb: false },
  ...over,
});

/** Bestätigung für Jana (Mandantenkontakt Talwind, GV) für genau diese Anfrage. */
const jana = (ziel: string, methode: AkteurClaims['req']['m'] = 'GET', body = ''): AkteurClaims =>
  mandantClaims(DEMO_IDS.talwind, {
    tnt: DEMO_TENANT_ID,
    sub: DEMO_IDS.jana,
    nam: 'Jana',
    req: { m: methode, p: ziel, b: bodySha256(new TextEncoder().encode(body)) },
  });

describe.skipIf(!AKTIV)('Endpunkte lesepfade gegen PostgreSQL', () => {
  describe('GET /v1/mandanten/:mandantId/kontext', () => {
    const pfad = `/v1/mandanten/${DEMO_IDS.talwind}/kontext`;

    it('liefert den Kontext (200, vertragsgemäß)', async () => {
      const r = await bestaetigtSenden(app(), { ziel: `${pfad}?stand=2026-03-31`, claims: anna() });
      expect(r.status).toBe(200);
      const b = await json(r);
      const daten = KontextAntwortSchema.parse(b['daten']);
      expect(daten.mandant.id).toBe(DEMO_IDS.talwind);
      expect(daten.historisch).toBe(true);
      expect(daten.rechte).toEqual({ bearbeiten: false, wuerdigen: false });
    });

    it('falscher Mandant im Pfad: 404 (Bindung an cli.id)', async () => {
      const r = await bestaetigtSenden(app(), {
        ziel: `/v1/mandanten/${DEMO_IDS.seestern}/kontext`,
        claims: anna(),
      });
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    });

    it('fremder Tenant mit passendem cli: 404 wie unbekannt', async () => {
      const r = await bestaetigtSenden(app(), {
        ziel: pfad,
        claims: anna({ tnt: claims().tnt }),
      });
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    });

    it('Mandantenperson auf dem Staff-Endpunkt: 404', async () => {
      const r = await bestaetigtSenden(app(), { ziel: pfad, roheClaims: jana(pfad) });
      expect(r.status).toBe(404);
    });

    it('ungültige Query: 400', async () => {
      for (const q of ['?stand=2026-13-01', '?stand=heute', '?x=1', '?stand=2026-01-01&stand=x']) {
        const r = await bestaetigtSenden(app(), { ziel: `${pfad}${q}`, claims: anna() });
        expect(r.status, q).toBe(400);
      }
    });
  });
});
