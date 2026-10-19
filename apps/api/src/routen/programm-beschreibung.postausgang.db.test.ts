// Postausgang über die App (DB_TESTS=1): nur der Systemakteur (Personen → 404,
// auch Admins), Query und ID geprüft (400), Zustellung idempotent, unbekannte
// und fremde IDs → 404, tenantweit (RLS), Abruf und Zustellung im Audit mit
// erkennbarem Systemakteur, keine Codes im Log.
import { mitTenant } from '@tcms/db';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { json, SYSTEM_ID } from '../__tests__/hilfen';
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

  it('nur der Systemakteur: Personen (auch Admin/Partner) und Kontakte → 404, kein Audit', async () => {
    const vorher = await mitTenant(w.T, (tx) => tx.auditEvent.count());
    for (const wer of [
      a.admin(),
      a.bt(),
      a.hb(),
      a.kanzlei(w.DRITTE, null),
      a.kanzlei(w.ADMIN, w.A, { adm: true, bt: true, zbt: true, hb: true }),
      a.kontakt(w.GV, w.A),
    ]) {
      for (const [m, z] of [
        ['GET', '/v1/nachrichten/offen'],
        ['GET', '/v1/nachrichten/offen?limit=abc'],
        ['POST', `/v1/nachrichten/${id}/zugestellt`],
        ['POST', '/v1/nachrichten/n123/zugestellt'],
      ] as const) {
        const r = await senden(w, m, z, wer);
        expect(r.status, `${wer.knd} ${m} ${z}`).toBe(404);
        expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
      }
    }
    expect(await mitTenant(w.T, (tx) => tx.auditEvent.count())).toBe(vorher);
    expect(
      await mitTenant(w.T, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id } })),
    ).toMatchObject({ zugestelltAm: null, text: 'Code 123456' });
  });

  it('GET /v1/nachrichten/offen und POST …/zugestellt (Erfolg, idempotent, Audit erkennbar)', async () => {
    const r = await ok(await senden(w, 'GET', '/v1/nachrichten/offen?limit=10', a.system()));
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
    const z = await ok(await senden(w, 'POST', `/v1/nachrichten/${id}/zugestellt`, a.system()));
    expect(z).toEqual({ nachrichtId: id, zugestellt: true });
    expect(
      await ok(await senden(w, 'POST', `/v1/nachrichten/${id}/zugestellt`, a.system())),
    ).toEqual(z);
    expect(await ok(await senden(w, 'GET', '/v1/nachrichten/offen', a.system()))).toEqual({
      nachrichten: [],
    });
    // Zugestellt: Text (Code) geleert, Zustellung vermerkt.
    const zeile = await mitTenant(w.T, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id } }));
    expect(zeile.text).toBe('');
    expect(zeile.zugestelltAm).not.toBeNull();
    const audit = await mitTenant(w.T, (tx) =>
      tx.auditEvent.findMany({
        where: { aktion: { in: ['tcms.nachricht.abgerufen', 'tcms.nachricht.zugestellt'] } },
        orderBy: { pos: 'asc' },
      }),
    );
    expect(audit.map((e) => e.aktion)).toEqual([
      'tcms.nachricht.abgerufen',
      'tcms.nachricht.zugestellt',
    ]);
    for (const e of audit) {
      expect(e).toMatchObject({
        actorId: SYSTEM_ID,
        actorName: 'System: Zustellung kanzleikonsole',
      });
      expect(e.detail).toMatchObject({ systemakteur: true });
      expect(JSON.stringify(e.detail)).not.toContain('123456');
    }
    // Kein Code und kein Name im Log des Dienstes.
    expect(w.t.logRoh.join('\n')).not.toContain('123456');
    expect(w.t.logRoh.join('\n')).not.toContain('Zustellung kanzleikonsole');
  });

  it('unbekannte und fremde IDs → 404; ungültige Query bzw. Body → 400; fremder Tenant sieht nichts', async () => {
    for (const unbekannt of ['n123', 'ckunbekannt0000000000000']) {
      const r = await senden(w, 'POST', `/v1/nachrichten/${unbekannt}/zugestellt`, a.system());
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?anzahl=1', '?limit=1&limit=2']) {
      expect((await senden(w, 'GET', `/v1/nachrichten/offen${q}`, a.system())).status, q).toBe(400);
    }
    expect(
      (await senden(w, 'POST', '/v1/nachrichten/n123/zugestellt', a.system(), { x: 1 })).status,
    ).toBe(400);
    const zweite = (
      await mitTenant(w.T, (tx) =>
        tx.nachricht.create({
          data: { empfaengerId: w.TCB, zweck: 'FREIGABE_ANGEFORDERT', betreff: 'B', text: 'T' },
        }),
      )
    ).id;
    const fremd = a.system(randomUUID());
    expect(await ok(await senden(w, 'GET', '/v1/nachrichten/offen', fremd))).toEqual({
      nachrichten: [],
    });
    expect((await senden(w, 'POST', `/v1/nachrichten/${zweite}/zugestellt`, fremd)).status).toBe(
      404,
    );
    expect(
      await mitTenant(w.T, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: zweite } })),
    ).toMatchObject({ zugestelltAm: null, text: 'T' });
  });
});
