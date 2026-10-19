// Postausgang über die App (DB_TESTS=1): nur der Systemakteur (Personen → 404,
// auch Admins), Query und ID geprüft (400), Zustellung idempotent, unbekannte
// und fremde IDs → 404, tenantweit (RLS), strukturierte Nachrichten, Abruf und
// Zustellung im Audit mit erkennbarem Systemakteur, verfallene Codes nicht
// ausgeliefert und geleert, keine Codes im Log.
import { mitTenant } from '@tcms/db';
import { legeNachrichtAn } from '@tcms/service';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { json, SYSTEM_ID } from '../__tests__/hilfen';
import { akteure, legeMandantenAn, neueApiWelt, ok, senden } from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);

describe.skipIf(!AKTIV)('Endpunkte Postausgang (App + PostgreSQL)', () => {
  let id = '';
  let code = '';
  let freigabeId = '';
  beforeAll(async () => {
    await legeMandantenAn(w);
    freigabeId = await mitTenant(w.T, async (tx) => {
      const p = await tx.tcmsProgramm.create({
        data: { mandantId: w.A, paketId: 'ecommerce', paketVersion: '1.0' },
      });
      const f = await tx.freigabe.create({
        data: {
          programmId: p.id,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: 'Risikoakzeptanz EC-UST-01',
          inhalt: 'Inhalt zur Freigabe',
          angefordertVon: w.BT,
          empfaengerId: w.GV,
        },
      });
      return f.id;
    });
    // Echter Code über das Portal (wie im Betrieb).
    await ok(
      await senden(
        w,
        'POST',
        `/v1/mandanten/${w.A}/portal/freigaben/${freigabeId}/code`,
        a.kontakt(w.GV, w.A),
      ),
    );
    const n = await mitTenant(w.T, (tx) =>
      tx.nachricht.findFirstOrThrow({ where: { zweck: 'FREIGABE_CODE' } }),
    );
    id = n.id;
    code = n.code!;
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
    ).toMatchObject({ zugestelltAm: null, verworfenAm: null, code });
  });

  it('GET /v1/nachrichten/offen und POST …/zugestellt (Erfolg, idempotent, Audit erkennbar)', async () => {
    const r = await ok(await senden(w, 'GET', '/v1/nachrichten/offen?limit=10', a.system()));
    expect(r).toEqual({
      nachrichten: [
        {
          id,
          mandantId: w.A,
          empfaengerId: w.GV,
          empfaengerArt: 'KONTAKT',
          zweck: 'FREIGABE_CODE',
          daten: {
            freigabeId,
            art: 'RISIKOAKZEPTANZ',
            titel: 'Risikoakzeptanz EC-UST-01',
            version: null,
            code,
            gueltigBis: expect.any(String),
            sha256: null,
          },
          betreff: 'Freigabe angefordert: Risikoakzeptanz EC-UST-01',
          text: expect.stringContaining(code),
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
    expect(zeile.code).toBeNull();
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
      expect(JSON.stringify(e.detail)).not.toContain(code);
    }
    // Kein Code und kein Name im Log des Dienstes.
    expect(w.t.logRoh.join('\n')).not.toContain(code);
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
    const zweite = await mitTenant(w.T, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.A,
        empfaengerId: w.TCB,
        zweck: 'FREIGABE_ANGEFORDERT',
        daten: {
          freigabeId: 'ckfreigabe0000000000000a',
          art: 'ZIELE',
          titel: 'Ziele',
          version: null,
        },
        betreff: 'B',
        text: 'T',
      }),
    );
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

  it('verfallene Code-Nachricht: nicht ausgeliefert, Klartext geleert, Audit ohne Code', async () => {
    const verfallen = await mitTenant(w.T, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.A,
        empfaengerId: w.GV,
        zweck: 'FREIGABE_CODE',
        // Freigabe unbekannt: Der Code gilt nicht (mehr).
        daten: {
          freigabeId: 'ckunbekanntefreigabe0000',
          art: 'BESCHREIBUNG',
          titel: 'CMS-Beschreibung v1.0',
          version: '1.0',
          code: '987650',
          gueltigBis: '2099-01-01T00:00:00.000Z',
          sha256: null,
        },
        betreff: 'Betreff',
        text: 'Ihr Bestätigungscode: 987650',
      }),
    );
    const r = await senden(w, 'GET', '/v1/nachrichten/offen', a.system());
    const roh = await r.text();
    expect(r.status).toBe(200);
    expect(roh).not.toContain(verfallen);
    expect(roh).not.toContain('987650');
    const zeile = await mitTenant(w.T, (tx) =>
      tx.nachricht.findUniqueOrThrow({ where: { id: verfallen } }),
    );
    expect(zeile).toMatchObject({ code: null, text: '', zugestelltAm: null });
    expect(zeile.verworfenAm).not.toBeNull();
    const audit = await mitTenant(w.T, (tx) =>
      tx.auditEvent.findMany({
        where: { aktion: 'tcms.nachricht.verworfen', objektId: verfallen },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ grund: 'FREIGABE_NICHT_OFFEN', systemakteur: true });
    expect(JSON.stringify(audit)).not.toContain('987650');
    expect(w.t.logRoh.join('\n')).not.toContain('987650');
  });
});
