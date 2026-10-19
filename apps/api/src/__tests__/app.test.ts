import { AKTEUR_HEADER, DienstFehler, MAX_BODY_BYTES, bodySha256 } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PING_TENANT } from '../app';
import { SpeicherJti } from '../jti';
import type { Routen } from '../routen';
import {
  JETZT_S,
  MANDANT,
  MANDANT_FREMD,
  NAME,
  PERSON,
  SCHLUESSEL_B,
  TENANT,
  TOKEN_ALT,
  TOKEN_NEU,
  aufbau,
  bestaetigtSenden,
  bestaetigung,
  claims,
  json,
  mandantClaims,
  senden,
  zaehlStrom,
} from './hilfen';

const testRouten = (r: Routen<unknown>) => {
  r.route({
    methode: 'POST',
    pfad: '/v1/mandanten/:mandantId/test',
    body: z.object({ titel: z.string().min(1).max(50) }).strict(),
    handler: async ({ body, params, akteur }) => ({
      titel: body.titel,
      mandantId: params.mandantId,
      akteurId: akteur.id,
    }),
  });
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/test',
    query: z.object({ stand: z.iso.date().optional(), art: z.string().optional() }).strict(),
    handler: async ({ query, params }) => ({
      stand: query.stand ?? null,
      mandantId: params.mandantId,
    }),
  });
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/portal',
    portal: true,
    handler: async ({ akteur }) => ({ art: akteur.art }),
  });
  r.route({ methode: 'GET', pfad: '/v1/kanzlei', handler: async () => ({ bereich: 'kanzlei' }) });
  r.route({
    methode: 'POST',
    pfad: '/v1/fehler/:art',
    handler: async ({ params }) => {
      if (params.art === 'konflikt')
        throw new DienstFehler('KONFLIKT', 'Status hat sich geändert.');
      if (params.art === 'felder') {
        throw new DienstFehler('UNGUELTIG', 'Bitte prüfen.', { titel: ['zu kurz'] });
      }
      if (params.art === 'zod') return z.object({ a: z.string() }).parse({});
      throw new Error('SELECT geheim FROM mandant WHERE name = Talwind');
    },
  });
};

const routenAufbau = (over: Parameters<typeof aufbau>[0] = {}) =>
  aufbau({ routen: testRouten, ...over });

const AUTH_401 = { ok: false, fehler: { code: 'NICHT_AUTHENTIFIZIERT' } };

function erwarteGrundHeader(r: Response) {
  expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  for (const [name] of r.headers) expect(name.startsWith('access-control-')).toBe(false);
}

describe('Grundablauf', () => {
  it('liefert /v1/ich mit Dienst-Token und Akteursbestätigung, in der Tenant-Transaktion', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, { ziel: '/v1/ich' });
    expect(r.status).toBe(200);
    erwarteGrundHeader(r);
    expect(await json(r)).toEqual({
      ok: true,
      daten: {
        art: 'KANZLEI',
        tenantId: TENANT,
        id: PERSON,
        name: NAME,
        istAdmin: false,
        istBerufstraeger: true,
        mandant: { id: MANDANT, zustaendigBerufstraeger: true, hauptbearbeitung: false },
      },
    });
    expect(t.tenants).toEqual([TENANT]);
  });

  it('setzt die Grund-Header auch auf Fehlerantworten und nie CORS-Header', async () => {
    const t = routenAufbau();
    const origin = { origin: 'https://boese.example', 'access-control-request-method': 'POST' };
    for (const s of [
      { ziel: '/v1/unbekannt' },
      { ziel: '/v1/ich', methode: 'OPTIONS', headers: origin },
      { ziel: '/v1/ich', headers: origin },
    ]) {
      const r = await senden(t.app, s);
      erwarteGrundHeader(r);
    }
  });

  it('erzeugt die Request-ID selbst und übernimmt keine des Aufrufers', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      ziel: '/v1/ich',
      headers: { 'x-request-id': 'injiziert-123' },
    });
    expect(r.headers.get('x-request-id')).not.toBe('injiziert-123');
    expect(t.log.at(-1)?.requestId).toBe(r.headers.get('x-request-id'));
  });

  it('weist ohne Node-Binding (rohe Anfrage unbekannt) mit 500 ab – fail closed', async () => {
    const t = routenAufbau();
    const { headers } = bestaetigung({ ziel: '/v1/ich' });
    const r = await senden(t.app, { ziel: '/v1/ich', headers, ohneRoh: true });
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'INTERN' } });
    expect(t.tenants).toEqual([]);
  });
});

describe('Schritt 2: Methode und Pfad bekannt (vor Body und Authentifizierung)', () => {
  it('404 für unbekannte Pfade ohne Token, ohne den Body zu lesen', async () => {
    const t = routenAufbau();
    const { strom, zaehler } = zaehlStrom(10, 1024);
    const r = await senden(t.app, { methode: 'POST', ziel: '/v1/gibt-es-nicht', body: strom });
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    expect(zaehler.gelesen).toBe(0);
  });

  it('405 mit Allow für bekannte Pfade mit anderer Methode, auch OPTIONS und HEAD', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, { methode: 'DELETE', ziel: `/v1/mandanten/${MANDANT}/test` });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST, GET');
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'METHODE_NICHT_ERLAUBT' } });
    for (const methode of ['OPTIONS', 'HEAD']) {
      const o = await senden(t.app, { methode, ziel: '/v1/health' });
      expect(o.status, methode).toBe(405);
      expect(o.headers.get('allow')).toBe('GET');
    }
  });

  it('unterscheidet Groß-/Kleinschreibung und abschließenden Schrägstrich nicht weg', async () => {
    const t = routenAufbau();
    for (const ziel of ['/V1/ICH', '/v1/ich/', '/v1/Ich', '/v1', '/']) {
      const { headers } = bestaetigung({ ziel });
      expect((await senden(t.app, { ziel, headers })).status, ziel).toBe(404);
    }
  });

  describe('roher Pfad: keine Normalisierung, die eine andere Route trifft', () => {
    // Jede Variante ist korrekt für genau dieses rohe Target signiert und an
    // MANDANT gebunden. Der WHATWG-Parser des Adapters würde sie auf
    // /v1/mandanten/MANDANT/portal normalisieren – die Route darf trotzdem nie laufen.
    const varianten = [
      `/v1/mandanten/${MANDANT}/x/../portal`,
      `/v1/mandanten/${MANDANT}/x/%2e%2e/portal`,
      `/v1/mandanten/${MANDANT}/x/%2E%2E/portal`,
      `/v1/mandanten/${MANDANT}/./portal`,
      `/v1/mandanten/${MANDANT}/%2e/portal`,
      `/v1/mandanten/${MANDANT}/x\\..\\portal`,
      `/v1/mandanten/${MANDANT}//portal`,
      `/v1//mandanten/${MANDANT}/portal`,
      `/v1/mandanten/${MANDANT}%2Fportal`,
      `/v1/mandanten/${MANDANT}%2fportal`,
      `/v1/mandanten/${MANDANT}/portal%2F`,
      `/v1/mandanten/${MANDANT}/port%61l`,
      `/v1/mandanten/${MANDANT_FREMD}/../${MANDANT}/portal`,
      `/v1/mandanten/${MANDANT}/portal#x`,
      `/v1/mandanten/${MANDANT}/portal?`,
      `/v1/mandanten/${MANDANT}/portal?a=%zz`,
      `http://tcms.intern/v1/mandanten/${MANDANT}/portal`,
    ];
    for (const ziel of varianten) {
      it(`404 für ${ziel}`, async () => {
        const t = routenAufbau();
        const { headers } = bestaetigung({ ziel });
        const r = await senden(t.app, { ziel, headers });
        expect(r.status).toBe(404);
        expect(t.tenants).toEqual([]);
        expect(t.jtiAufrufe).toEqual([]);
      });
    }

    it('Gegenprobe: das kanonische Target erreicht die Route', async () => {
      const t = routenAufbau();
      const r = await bestaetigtSenden(t.app, { ziel: `/v1/mandanten/${MANDANT}/portal` });
      expect(r.status).toBe(200);
    });

    it('übergibt Pfadparameter nur aus [A-Za-z0-9_~-] (kein %, kein Punkt)', async () => {
      const gesehen: string[] = [];
      const t = aufbau({
        routen: (r) =>
          r.route({
            methode: 'GET',
            pfad: '/v1/objekte/:objektId',
            handler: async ({ params }) => gesehen.push(params.objektId!),
          }),
      });
      for (const id of ['abc%2F..%2Fxyz', 'a.b', 'abc%00', '%2e%2e', 'a%20b', 'ä']) {
        const ziel = `/v1/objekte/${id}`;
        const { headers } = bestaetigung({ ziel });
        expect((await senden(t.app, { ziel, headers })).status, id).toBe(404);
      }
      expect(gesehen).toEqual([]);
      expect((await bestaetigtSenden(t.app, { ziel: '/v1/objekte/abc-123_X~' })).status).toBe(200);
      expect(gesehen).toEqual(['abc-123_X~']);
    });

    it('weist eine Query ab, die der Adapter anders kodiert als empfangen', async () => {
      const t = routenAufbau();
      const ziel = `/v1/mandanten/${MANDANT}/test?art='offen'`;
      expect(new URL(`http://x${ziel}`).search).not.toBe("?art='offen'");
      const { headers } = bestaetigung({ ziel });
      expect((await senden(t.app, { ziel, headers })).status).toBe(404);
      const kodiert = `/v1/mandanten/${MANDANT}/test?art=%27offen%27`;
      expect((await bestaetigtSenden(t.app, { ziel: kodiert })).status).toBe(200);
    });

    it('weist ein Target über 2048 Zeichen ab', async () => {
      const t = routenAufbau();
      const ziel = `/v1/mandanten/${MANDANT}/test?art=${'x'.repeat(2048)}`;
      expect((await senden(t.app, { ziel })).status).toBe(404);
    });
  });
});

describe('Schritt 3: Body-Limit (Content-Length und gestreamt)', () => {
  it('413 bei zu großem Body vor der Authentifizierung, mit Connection: close', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${MANDANT}/test`,
      body: new Uint8Array(MAX_BODY_BYTES + 1),
    });
    expect(r.status).toBe(413);
    expect(r.headers.get('connection')).toBe('close');
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'ZU_GROSS' } });
    expect(t.jtiAufrufe).toEqual([]);
  });

  it('413 allein aus Content-Length, ohne den Strom zu lesen', async () => {
    const t = routenAufbau();
    const { strom, zaehler } = zaehlStrom(1, 10);
    const r = await senden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${MANDANT}/test`,
      body: strom,
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    });
    expect(r.status).toBe(413);
    expect(zaehler.gelesen).toBe(0);
  });

  it('413 bei gelogener (zu kleiner) Content-Length; Rest wird nicht gelesen', async () => {
    const t = routenAufbau();
    const { strom, zaehler } = zaehlStrom(1000, 1024);
    const r = await senden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${MANDANT}/test`,
      body: strom,
      headers: { 'content-length': '10' },
    });
    expect(r.status).toBe(413);
    expect(zaehler.gelesen).toBeLessThanOrEqual(MAX_BODY_BYTES / 1024 + 2);
    expect(zaehler.abgebrochen).toBe(true);
  });

  it('413 bei gestreamtem Body ohne Content-Length', async () => {
    const t = routenAufbau();
    const { strom, zaehler } = zaehlStrom(1000, 1024);
    const r = await senden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${MANDANT}/test`,
      body: strom,
    });
    expect(r.status).toBe(413);
    expect(zaehler.gelesen).toBeLessThan(1000);
  });

  it('400 bei Content-Length, die nicht zur gelesenen Länge passt oder ungültig ist', async () => {
    const t = routenAufbau();
    for (const cl of ['5', '+20', '20, 20', '-1', '0x14', '']) {
      const { strom } = zaehlStrom(1, 20);
      const r = await senden(t.app, {
        methode: 'POST',
        ziel: `/v1/mandanten/${MANDANT}/test`,
        body: strom,
        headers: { 'content-length': cl },
      });
      expect(r.status, cl).toBe(400);
    }
  });

  it('nimmt genau MAX_BODY_BYTES an (dann scheitert erst die Authentifizierung)', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      methode: 'POST',
      ziel: `/v1/mandanten/${MANDANT}/test`,
      body: new Uint8Array(MAX_BODY_BYTES),
    });
    expect(r.status).toBe(401);
  });
});

describe('Schritt 4: Dienst-Token', () => {
  it('akzeptiert beide Tokens während der Rotation', async () => {
    const t = routenAufbau();
    for (const token of [TOKEN_ALT, TOKEN_NEU]) {
      expect((await bestaetigtSenden(t.app, { ziel: '/v1/ich', token })).status).toBe(200);
    }
  });

  it('weist fehlende, falsche und falsch geschriebene Bearer-Header gleich ab', async () => {
    const t = routenAufbau();
    const varianten = [
      undefined,
      '',
      `bearer ${TOKEN_ALT}`,
      `BEARER ${TOKEN_ALT}`,
      `Basic ${Buffer.from(`x:${TOKEN_ALT}`).toString('base64')}`,
      `Token ${TOKEN_ALT}`,
      `Bearer  ${TOKEN_ALT}`,
      `Bearer\t${TOKEN_ALT}`,
      `Bearer ${TOKEN_ALT}\t\t${TOKEN_ALT}`,
      `Bearer`,
      `Bearer `,
      TOKEN_ALT,
      `Bearer ${TOKEN_ALT}, Bearer ${TOKEN_NEU}`,
      `Bearer ${TOKEN_ALT.slice(0, -1)}`,
      `Bearer ${TOKEN_ALT}x`,
      `Bearer ${TOKEN_ALT}${TOKEN_NEU}`,
      `Bearer ${'A'.repeat(43)}`,
    ];
    for (const authorization of varianten) {
      const { headers } = bestaetigung({ ziel: '/v1/ich' });
      if (authorization === undefined) delete headers.authorization;
      else headers.authorization = authorization;
      const r = await senden(t.app, { ziel: '/v1/ich', headers });
      expect(r.status, String(authorization)).toBe(401);
      expect(await json(r)).toEqual(AUTH_401);
    }
    expect(t.log.every((z) => z.status !== 401 || z.grund === 'DIENST_TOKEN')).toBe(true);
    expect(t.jtiAufrufe).toEqual([]);
    expect(t.tenants).toEqual([]);
  });

  it('verlangt das Token auch für /v1/health', async () => {
    const t = routenAufbau();
    expect((await senden(t.app, { ziel: '/v1/health' })).status).toBe(401);
    const r = await senden(t.app, {
      ziel: '/v1/health',
      headers: { authorization: `Bearer ${TOKEN_ALT}x` },
    });
    expect(r.status).toBe(401);
  });
});

describe('Schritt 5: Akteursbestätigung', () => {
  it('weist eine fehlende Bestätigung ab, ohne jti zu verbrauchen', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      ziel: '/v1/ich',
      headers: { authorization: `Bearer ${TOKEN_ALT}` },
    });
    expect(r.status).toBe(401);
    expect(t.log.at(-1)?.grund).toBe('AKTEUR_FEHLT');
    expect(t.jtiAufrufe).toEqual([]);
  });

  it('weist jede ungültige Bestätigung mit derselben Antwort ab; Grund nur im Log', async () => {
    const t = routenAufbau();
    const fremd = bestaetigung({ ziel: '/v1/ich', privateKey: SCHLUESSEL_B.privateKey }).headers;
    const abgelaufen = bestaetigung({
      ziel: '/v1/ich',
      claims: { iat: JETZT_S - 100, exp: JETZT_S - 1 },
    }).headers;
    const doppelt = bestaetigung({ ziel: '/v1/ich' }).headers;
    doppelt[AKTEUR_HEADER] = `${doppelt[AKTEUR_HEADER]}, ${doppelt[AKTEUR_HEADER]}`;
    const faelle: [Record<string, string>, string][] = [
      [fremd, 'SIGNATUR'],
      [abgelaufen, 'ABGELAUFEN'],
      [doppelt, 'STRUKTUR'],
      [{ ...fremd, [AKTEUR_HEADER]: 'a.b.c' }, 'STRUKTUR'],
      [{ ...fremd, [AKTEUR_HEADER]: 'x'.repeat(5000) }, 'GROESSE'],
    ];
    const bodys = new Set<string>();
    for (const [headers, grund] of faelle) {
      const r = await senden(t.app, { ziel: '/v1/ich', headers });
      expect(r.status).toBe(401);
      bodys.add(await r.text());
      expect(t.log.at(-1)?.grund).toBe(grund);
    }
    expect([...bodys]).toEqual([JSON.stringify(AUTH_401)]);
    expect(t.jtiAufrufe).toEqual([]);
  });

  it('prüft gegen die injizierte Uhr', async () => {
    const t = routenAufbau({ uhr: { jetzt: () => new Date((JETZT_S + 60) * 1000) } });
    const r = await bestaetigtSenden(t.app, { ziel: '/v1/ich' });
    expect(r.status).toBe(401);
    expect(t.log.at(-1)?.grund).toBe('ABGELAUFEN');
  });

  it('weist einen nach der Signatur veränderten Body ab', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const { headers } = bestaetigung({ methode: 'POST', ziel, body: '{"titel":"A"}' });
    const r = await senden(t.app, { methode: 'POST', ziel, body: '{"titel":"B"}', headers });
    expect(r.status).toBe(401);
    expect(t.log.at(-1)?.grund).toBe('REQ_BODY');
    const leer = await senden(t.app, { methode: 'POST', ziel, headers });
    expect(leer.status).toBe(401);
  });

  it('weist eine vertauschte, veränderte oder entfernte Query ab', async () => {
    const t = routenAufbau();
    const basis = `/v1/mandanten/${MANDANT}/test`;
    const { headers } = bestaetigung({ ziel: `${basis}?stand=2026-10-16&art=offen` });
    for (const ziel of [
      `${basis}?art=offen&stand=2026-10-16`,
      `${basis}?stand=2026-10-15&art=offen`,
      basis,
    ]) {
      const r = await senden(t.app, { ziel, headers });
      expect(r.status, ziel).toBe(401);
      expect(t.log.at(-1)?.grund).toBe('REQ_PFAD');
    }
    const ok = await senden(t.app, { ziel: `${basis}?stand=2026-10-16&art=offen`, headers });
    expect(ok.status).toBe(200);
  });

  it('weist eine Bestätigung für eine andere Methode oder einen anderen Pfad ab', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const fuerGet = bestaetigung({ ziel }).headers;
    const r = await senden(t.app, { methode: 'POST', ziel, body: '', headers: fuerGet });
    expect(r.status).toBe(401);
    expect(t.log.at(-1)?.grund).toBe('REQ_METHODE');
    const fuerIch = bestaetigung({ ziel: '/v1/ich' }).headers;
    const p = await senden(t.app, { ziel: `/v1/mandanten/${MANDANT}/portal`, headers: fuerIch });
    expect(p.status).toBe(401);
    expect(t.log.at(-1)?.grund).toBe('REQ_PFAD');
  });

  it('parst JSON erst nach der Authentifizierung (401 statt 400)', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const r = await senden(t.app, {
      methode: 'POST',
      ziel,
      body: '{kaputt',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
    const authentisch = await bestaetigtSenden(t.app, { methode: 'POST', ziel, body: '{kaputt' });
    expect(authentisch.status).toBe(400);
  });
});

describe('Schritt 6: jti einmalig', () => {
  it('weist die Wiederholung derselben Anfrage ab', async () => {
    const t = routenAufbau();
    const { headers } = bestaetigung({ ziel: '/v1/ich' });
    expect((await senden(t.app, { ziel: '/v1/ich', headers })).status).toBe(200);
    const zweite = await senden(t.app, { ziel: '/v1/ich', headers });
    expect(zweite.status).toBe(401);
    expect(await json(zweite)).toEqual(AUTH_401);
    expect(t.log.at(-1)?.grund).toBe('JTI_WIEDERHOLT');
    expect(t.tenants).toHaveLength(1);
  });

  it('lässt von zwei gleichzeitigen Wiederholungen genau eine durch', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const { headers } = bestaetigung({ methode: 'POST', ziel, body: '{"titel":"A"}' });
    const antworten = await Promise.all(
      Array.from({ length: 20 }, () =>
        senden(t.app, { methode: 'POST', ziel, body: '{"titel":"A"}', headers }),
      ),
    );
    const status = antworten.map((r) => r.status).sort();
    expect(status.filter((s) => s === 200)).toHaveLength(1);
    expect(status.filter((s) => s === 401)).toHaveLength(19);
    expect(t.tenants).toHaveLength(1);
  });

  it('weist eine Wiederholung mit kaputtem Body als Authentifizierungsfehler ab', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const { headers } = bestaetigung({ methode: 'POST', ziel, body: '{kaputt' });
    expect((await senden(t.app, { methode: 'POST', ziel, body: '{kaputt', headers })).status).toBe(
      400,
    );
    expect((await senden(t.app, { methode: 'POST', ziel, body: '{kaputt', headers })).status).toBe(
      401,
    );
  });

  it('lässt nichts durch, wenn der jti-Speicher ausfällt', async () => {
    const t = routenAufbau({
      jti: {
        einmalig: async () => {
          throw new Error('Verbindung verloren');
        },
      },
    });
    const r = await bestaetigtSenden(t.app, { ziel: '/v1/ich' });
    expect(r.status).toBe(500);
    expect(t.tenants).toEqual([]);
  });

  it('trägt die jti mit exp aus den Claims ein', async () => {
    const eingetragen: [string, Date][] = [];
    const speicher = new SpeicherJti();
    const t = routenAufbau({
      jti: { einmalig: (j, exp) => (eingetragen.push([j, exp]), speicher.einmalig(j, exp)) },
    });
    const c = claims({ req: { m: 'GET', p: '/v1/ich', b: bodySha256(new Uint8Array()) } });
    await bestaetigtSenden(t.app, { ziel: '/v1/ich', roheClaims: c });
    expect(eingetragen).toEqual([[c.jti, new Date(c.exp * 1000)]]);
  });
});

describe('Schritt 7: Mandantenbindung (ADR §3.3)', () => {
  const ziel = (m: string, rest = 'test') => `/v1/mandanten/${m}/${rest}`;

  it('lässt die Kanzlei nur an den bestätigten Mandanten', async () => {
    const t = routenAufbau();
    expect((await bestaetigtSenden(t.app, { ziel: ziel(MANDANT) })).status).toBe(200);
    const fremd = await bestaetigtSenden(t.app, { ziel: ziel(MANDANT_FREMD) });
    expect(fremd.status).toBe(404);
    expect(await json(fremd)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    const ohneCli = claims({ cli: undefined });
    delete ohneCli.cli;
    const o = await bestaetigtSenden(t.app, {
      ziel: ziel(MANDANT),
      roheClaims: {
        ...ohneCli,
        req: { m: 'GET', p: ziel(MANDANT), b: bodySha256(new Uint8Array()) },
      },
    });
    expect(o.status).toBe(404);
    expect(t.tenants).toEqual([TENANT]);
  });

  it('auch Admins brauchen cli für Mandantenpfade', async () => {
    const t = routenAufbau();
    const c = claims({ rol: { adm: true, bt: true } });
    delete c.cli;
    const r = await bestaetigtSenden(t.app, {
      ziel: ziel(MANDANT),
      roheClaims: { ...c, req: { m: 'GET', p: ziel(MANDANT), b: bodySha256(new Uint8Array()) } },
    });
    expect(r.status).toBe(404);
  });

  it('vergleicht ohne Umwandlung der Schreibweise', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, { ziel: ziel(MANDANT.toUpperCase()) });
    expect(r.status).toBe(404);
  });

  it('lässt Mandantenpersonen nur auf Portal-Routen des eigenen Mandanten', async () => {
    const t = routenAufbau();
    const als = (z: string, m = MANDANT) =>
      bestaetigtSenden(t.app, {
        ziel: z,
        roheClaims: mandantClaims(m, { req: { m: 'GET', p: z, b: bodySha256(new Uint8Array()) } }),
      });
    expect((await als(ziel(MANDANT, 'portal'))).status).toBe(200);
    expect((await als(ziel(MANDANT, 'test'))).status).toBe(404);
    expect((await als(ziel(MANDANT_FREMD, 'portal'))).status).toBe(404);
    expect((await als('/v1/kanzlei')).status).toBe(404);
    expect((await als('/v1/ich')).status).toBe(200);
  });

  it('prüft die Bindung vor dem Body (404 statt 400 für fremde Mandanten)', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: ziel(MANDANT_FREMD),
      body: '{kaputt',
    });
    expect(r.status).toBe(404);
  });
});

describe('Schritt 8: Query und JSON', () => {
  const z1 = `/v1/mandanten/${MANDANT}/test`;

  it('validiert den Body strikt und meldet Felder', async () => {
    const t = routenAufbau();
    const ok = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: z1,
      body: '{"titel":"Lieferschwelle"}',
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({
      ok: true,
      daten: { titel: 'Lieferschwelle', mandantId: MANDANT, akteurId: PERSON },
    });
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: z1,
      body: '{"titel":"","x":1}',
    });
    expect(r.status).toBe(400);
    const b = await json(r);
    expect(b).toMatchObject({ ok: false, fehler: { code: 'UNGUELTIG' } });
    expect(Object.keys((b.fehler as { felder: object }).felder).sort()).toEqual(['_', 'titel']);
  });

  it('weist doppelte Schlüssel, __proto__, falschen Content-Type und ungültiges UTF-8 ab', async () => {
    const t = routenAufbau();
    for (const body of ['{"titel":"A","titel":"B"}', '{"titel":"A","__proto__":{"x":1}}']) {
      const r = await bestaetigtSenden(t.app, { methode: 'POST', ziel: z1, body });
      expect(r.status, body).toBe(400);
    }
    const typ = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: z1,
      body: '{"titel":"A"}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(typ.status).toBe(400);
  });

  it('weist einen Body auf Routen ohne Body-Schema ab', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: '/v1/fehler/konflikt',
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('validiert die Query strikt', async () => {
    const t = routenAufbau();
    const ok = await bestaetigtSenden(t.app, { ziel: `${z1}?stand=2026-10-16` });
    expect(await json(ok)).toEqual({
      ok: true,
      daten: { stand: '2026-10-16', mandantId: MANDANT },
    });
    for (const q of [
      'stand=2026-13-01',
      'stand=2026-10-16&stand=2026-10-15',
      'admin=1',
      '__proto__=1',
    ]) {
      const r = await bestaetigtSenden(t.app, { ziel: `${z1}?${q}` });
      expect(r.status, q).toBe(400);
    }
    const ohneSchema = await bestaetigtSenden(t.app, { ziel: '/v1/ich?x=1' });
    expect(ohneSchema.status).toBe(400);
  });
});

describe('Fehlerabbildung', () => {
  it('DienstFehler → Status und Umschlag mit Meldung und Feldern', async () => {
    const t = routenAufbau();
    const k = await bestaetigtSenden(t.app, { methode: 'POST', ziel: '/v1/fehler/konflikt' });
    expect(k.status).toBe(409);
    expect(await json(k)).toEqual({
      ok: false,
      fehler: { code: 'KONFLIKT', meldung: 'Status hat sich geändert.' },
    });
    const f = await bestaetigtSenden(t.app, { methode: 'POST', ziel: '/v1/fehler/felder' });
    expect(await json(f)).toEqual({
      ok: false,
      fehler: { code: 'UNGUELTIG', meldung: 'Bitte prüfen.', felder: { titel: ['zu kurz'] } },
    });
  });

  it('zod-Fehler → 400 UNGUELTIG mit felder', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, { methode: 'POST', ziel: '/v1/fehler/zod' });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({
      fehler: { code: 'UNGUELTIG', felder: { a: [expect.any(String)] } },
    });
  });

  it('alles andere → 500 INTERN ohne Details; Stack nur im Log', async () => {
    const t = routenAufbau();
    const r = await bestaetigtSenden(t.app, { methode: 'POST', ziel: '/v1/fehler/intern' });
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).toBe(JSON.stringify({ ok: false, fehler: { code: 'INTERN' } }));
    expect(String(t.log.at(-1)?.stack)).toContain('SELECT geheim');
  });
});

describe('Health', () => {
  it('liefert Version und Datenbankstatus nur mit Dienst-Token, ohne Akteursbestätigung', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      ziel: '/v1/health',
      headers: { authorization: `Bearer ${TOKEN_NEU}` },
    });
    expect(r.status).toBe(200);
    erwarteGrundHeader(r);
    expect(await json(r)).toEqual({ ok: true, daten: { version: '0.1.0', datenbank: 'ok' } });
    expect(t.tenants).toEqual([PING_TENANT]);
    expect(t.jtiAufrufe).toEqual([]);
  });

  it('meldet fehler bei Ausfall und bei Zeitüberschreitung', async () => {
    const kaputt = routenAufbau({
      daten: {
        mitTenant: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const auth = { authorization: `Bearer ${TOKEN_ALT}` };
    const r = await senden(kaputt.app, { ziel: '/v1/health', headers: auth });
    expect(await json(r)).toEqual({ ok: true, daten: { version: '0.1.0', datenbank: 'fehler' } });
    const haengt = routenAufbau({
      konfiguration: {
        dienstTokens: [TOKEN_ALT],
        akteurSchluessel: new Map([['kk-a', SCHLUESSEL_B.publicKey]]),
        version: '0.1.0',
        healthZeitlimitMs: 50,
      },
      daten: { mitTenant: () => new Promise(() => undefined) },
    });
    const beginn = Date.now();
    const h = await senden(haengt.app, { ziel: '/v1/health', headers: auth });
    expect(await json(h)).toMatchObject({ daten: { datenbank: 'fehler' } });
    expect(Date.now() - beginn).toBeLessThan(2000);
  });

  it('nimmt weder Query noch Body an', async () => {
    const t = routenAufbau();
    const r = await senden(t.app, {
      ziel: '/v1/health?x=1',
      headers: { authorization: `Bearer ${TOKEN_ALT}` },
    });
    expect(r.status).toBe(400);
  });
});

describe('Logging', () => {
  it('schreibt weder Tokens noch Bestätigung, Body, Namen oder rohe Pfade ins Log', async () => {
    const t = routenAufbau();
    const ziel = `/v1/mandanten/${MANDANT}/test`;
    const body = '{"titel":"Vertraulicher Titel"}';
    const { headers, akteur } = bestaetigung({ methode: 'POST', ziel, body });
    await senden(t.app, { methode: 'POST', ziel, body, headers });
    await senden(t.app, { methode: 'POST', ziel, body, headers }); // Wiederholung → 401
    await senden(t.app, { ziel: '/v1/geheim-pfad?suche=Talwind', headers });
    await bestaetigtSenden(t.app, { ziel: `${ziel}?art=Vertraulich-Query` });
    await bestaetigtSenden(t.app, { methode: 'POST', ziel: '/v1/fehler/konflikt' });
    const log = t.logRoh.join('\n');
    for (const geheim of [
      TOKEN_ALT,
      TOKEN_NEU,
      akteur,
      akteur.split('.')[2]!,
      'Vertraulich',
      NAME,
      'Talwind',
      'geheim-pfad',
      'Status hat sich',
    ]) {
      expect(log).not.toContain(geheim);
    }
    expect(t.log.map((z) => z.status)).toEqual([200, 401, 404, 200, 409]);
    expect(t.log[0]).toMatchObject({
      route: '/v1/mandanten/:mandantId/test',
      mandantId: MANDANT,
      tenantId: TENANT,
      akteurId: PERSON,
    });
  });
});

describe('Routenregistrierung', () => {
  const r0 = (fn: (r: Routen<unknown>) => void) => () => aufbau({ routen: fn });
  const h = async () => null;

  it('weist mehrdeutige, falsch gebundene und fremde Muster beim Start ab', () => {
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/ich', handler: h }))).toThrow(
      /mehrdeutig/,
    );
    expect(
      r0((r) => {
        r.route({ methode: 'GET', pfad: '/v1/x/:id', handler: h });
        r.route({ methode: 'GET', pfad: '/v1/x/neu', handler: h });
      }),
    ).toThrow(/mehrdeutig/);
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/mandanten/:id/x', handler: h }))).toThrow(
      /mandantId/,
    );
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/x/:mandantId', handler: h }))).toThrow(
      /mandantId/,
    );
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v2/x', handler: h }))).toThrow(/v1/);
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/x/', handler: h }))).toThrow(/Segment/);
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/X', handler: h }))).toThrow(/Segment/);
    expect(r0((r) => r.route({ methode: 'GET', pfad: '/v1/a/:b/:b', handler: h }))).toThrow(
      /doppelt/,
    );
    expect(r0((r) => r.route({ methode: 'OPTIONS' as 'GET', pfad: '/v1/x', handler: h }))).toThrow(
      /Methode/,
    );
  });

  it('erlaubt keine Registrierung nach dem Start', async () => {
    let spaeter: Routen<unknown> | undefined;
    aufbau({ routen: (r) => (spaeter = r) });
    expect(() => spaeter!.route({ methode: 'GET', pfad: '/v1/spaet', handler: h })).toThrow(
      /eingefroren/,
    );
  });
});
