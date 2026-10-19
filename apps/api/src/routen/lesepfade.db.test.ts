// =============================================================================
// Endpunkte des Bereichs „lesepfade" über `erzeugeApp` mit echter Datenbank
// (DB_TESTS=1, DATABASE_URL = tcms_app, Demo-Seed) und signierten
// Akteursbestätigungen: Erfolg, Mandantenbindung (404), Mandantenperson auf
// Staff-Endpunkten (404), ungültige Eingaben (400).
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  ArbeitskorbAntwortSchema,
  bodySha256,
  KontextAntwortSchema,
  MAX_MANDANTEN_JE_ANFRAGE,
  PortfolioAntwortSchema,
  type AkteurClaims,
} from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { DEMO_IDS, DEMO_MANDANTEN, DEMO_TENANT_ID } from '@tcms/db/demo';
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

  for (const [pfad, schema] of [
    ['/v1/portfolio', PortfolioAntwortSchema],
    ['/v1/arbeitskorb', ArbeitskorbAntwortSchema],
  ] as const) {
    describe(`POST ${pfad}`, () => {
      const liste = JSON.stringify({
        mandantIds: DEMO_MANDANTEN.map((m) => m.id),
        bt: [DEMO_IDS.talwind],
        hb: [],
      });
      const post = (body: string, over: Partial<AkteurClaims> = anna({ cli: undefined })) =>
        bestaetigtSenden(app(), { methode: 'POST', ziel: pfad, body, claims: over });

      it('liefert nur Mandanten der bestätigten Liste (200, vertragsgemäß)', async () => {
        const r = await post(liste);
        expect(r.status).toBe(200);
        const daten = schema.parse((await json(r))['daten']);
        expect(daten.heute).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const nur = await post(JSON.stringify({ mandantIds: [DEMO_IDS.seestern] }));
        const b = await json(nur);
        if (pfad === '/v1/portfolio') {
          const p = PortfolioAntwortSchema.parse(b['daten']);
          expect(p.zeilen.map((z) => z.mandant.id)).toEqual([DEMO_IDS.seestern]);
        } else {
          const k = ArbeitskorbAntwortSchema.parse(b['daten']);
          const ids = [...k.durchfuehrungen, ...k.gegenzeichnungen, ...k.p153].map(
            (x) => x.mandant.id,
          );
          expect(ids.every((id) => id === DEMO_IDS.seestern)).toBe(true);
        }
      });

      it('fremder Tenant: Demo-IDs bleiben unsichtbar', async () => {
        const r = await post(liste, anna({ tnt: claims().tnt, cli: undefined }));
        expect(r.status).toBe(200);
        const b = await json(r);
        const leer =
          pfad === '/v1/portfolio'
            ? PortfolioAntwortSchema.parse(b['daten']).zeilen
            : ArbeitskorbAntwortSchema.parse(b['daten']).durchfuehrungen;
        expect(leer).toEqual([]);
      });

      it('Mandantenperson: 404 (kein Portal-Endpunkt)', async () => {
        const r = await bestaetigtSenden(app(), {
          methode: 'POST',
          ziel: pfad,
          body: liste,
          roheClaims: jana(pfad, 'POST', liste),
        });
        expect(r.status).toBe(404);
      });

      it('ungültiger Body: 400', async () => {
        for (const body of [
          JSON.stringify({ mandantIds: [DEMO_IDS.talwind, DEMO_IDS.talwind] }),
          JSON.stringify({ mandantIds: [DEMO_IDS.talwind], bt: [DEMO_IDS.seestern] }),
          JSON.stringify({ mandantIds: 'alle' }),
          JSON.stringify({
            mandantIds: Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE + 1 }, () => randomUUID()),
          }),
          '',
        ]) {
          const r = await post(body);
          expect(r.status, body.slice(0, 60)).toBe(400);
        }
      });

      it(`${MAX_MANDANTEN_JE_ANFRAGE} IDs passen in die Body-Grenze`, async () => {
        const body = JSON.stringify({
          mandantIds: Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE }, () => randomUUID()),
        });
        const r = await post(body);
        expect(r.status).toBe(200);
      });
    });
  }
});
