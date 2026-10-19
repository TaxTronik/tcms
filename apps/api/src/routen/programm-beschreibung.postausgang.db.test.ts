// Postausgang über die App (DB_TESTS=1): nur Verwaltungsrecht (sonst 404),
// Query und ID geprüft (400), Zustellung idempotent, tenantweit (RLS).
import { mitTenant } from '@tcms/db';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { akteure, legeMandantenAn, neueApiWelt, ok, senden } from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);

describe.skipIf(!AKTIV)('Endpunkte Postausgang (App + PostgreSQL)', () => {
  let id = '';
  beforeAll(async () => {
    await legeMandantenAn(w);
    id = (
      await mitTenant(w.T, (tx) =>
        tx.nachricht.create({
          data: {
            empfaengerId: w.GV,
            zweck: 'FREIGABE_CODE',
            betreff: 'Betreff',
            text: 'Code 123456',
          },
        }),
      )
    ).id;
  });

  it('GET /v1/nachrichten/offen und POST …/zugestellt (Erfolg, idempotent)', async () => {
    const r = await ok(await senden(w, 'GET', '/v1/nachrichten/offen?limit=10', a.admin()));
    expect(r).toEqual({
      nachrichten: [
        {
          id,
          empfaengerId: w.GV,
          zweck: 'FREIGABE_CODE',
          betreff: 'Betreff',
          text: 'Code 123456',
          erstelltAm: expect.any(String),
        },
      ],
    });
    const z = await ok(await senden(w, 'POST', `/v1/nachrichten/${id}/zugestellt`, a.admin()));
    expect(z).toEqual({ nachrichtId: id, zugestellt: true });
    expect(
      await ok(await senden(w, 'POST', `/v1/nachrichten/${id}/zugestellt`, a.admin())),
    ).toEqual(z);
    expect(await ok(await senden(w, 'GET', '/v1/nachrichten/offen', a.admin()))).toEqual({
      nachrichten: [],
    });
    // Zugestellt: Text (Code) geleert, Zustellung vermerkt.
    const zeile = await mitTenant(w.T, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id } }));
    expect(zeile.text).toBe('');
    expect(zeile.zugestelltAm).not.toBeNull();
  });

  it('nur Verwaltungsrecht: Kanzlei ohne Admin und Kontakte → 404', async () => {
    for (const wer of [a.bt(), a.kanzlei(w.DRITTE, null), a.kontakt(w.GV, w.A)]) {
      const ohneAdmin = wer.knd === 'KANZLEI' ? { ...wer, rol: { adm: false, bt: true } } : wer;
      expect((await senden(w, 'GET', '/v1/nachrichten/offen', ohneAdmin)).status).toBe(404);
      expect((await senden(w, 'POST', '/v1/nachrichten/n123/zugestellt', ohneAdmin)).status).toBe(
        404,
      );
    }
  });

  it('ungültige Query bzw. Body → 400; fremder Tenant sieht nichts', async () => {
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?anzahl=1', '?limit=1&limit=2']) {
      expect((await senden(w, 'GET', `/v1/nachrichten/offen${q}`, a.admin())).status, q).toBe(400);
    }
    expect(
      (await senden(w, 'POST', '/v1/nachrichten/n123/zugestellt', a.admin(), { x: 1 })).status,
    ).toBe(400);
    const fremd = await ok(
      await senden(w, 'GET', '/v1/nachrichten/offen', { ...a.admin(), tnt: randomUUID() }),
    );
    expect(fremd).toEqual({ nachrichten: [] });
  });
});
