// Integration mit @hono/node-server über einen echten Socket auf 127.0.0.1:
// prüft die Annahmen, die `app.request` nicht abbilden kann (rohes Target,
// Absolute-Form, doppelte Header, Framing, Verbindung nach 413).

import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { AKTEUR_HEADER, MAX_BODY_BYTES } from '@tcms/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Routen } from '../routen';
import { MANDANT, TOKEN_ALT, aufbau, bestaetigung } from './hilfen';

const routen = (r: Routen<unknown>) => {
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/portal',
    portal: true,
    handler: async () => ({ erreicht: true }),
  });
  r.route({
    methode: 'POST',
    pfad: '/v1/mandanten/:mandantId/eingang',
    body: z.object({ text: z.string() }).strict(),
    handler: async ({ body }) => ({ laenge: body.text.length }),
  });
};

const t = aufbau({ routen });
// Letzte Anfrage, wie die App sie bekam: zeigt, ob ihr Body angefasst wurde.
const zuletzt: { anfrage?: Request } = {};
// Über eine Funktion gelesen, damit TypeScript nach `delete` nicht auf `never` verengt.
const letzte = (): Request | undefined => zuletzt.anfrage;
const server = createAdaptorServer({
  fetch: (anfrage: Request, env: unknown) => {
    zuletzt.anfrage = anfrage;
    return t.app.fetch(anfrage, env as never);
  },
});
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RohAntwort {
  status: number;
  kopf: string;
  geschlossen: boolean;
  dauerMs: number;
}

/** Schickt Bytes unverändert und liest bis zum Schließen (oder `warteMs`). */
function roh(anfrage: string, warteMs = 3000): Promise<RohAntwort> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let daten = '';
    let fertig = false;
    const beginn = Date.now();
    const ende = (geschlossen: boolean) => {
      if (fertig) return;
      fertig = true;
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(daten)?.[1] ?? 0);
      const kopf = daten.split('\r\n\r\n')[0] ?? '';
      resolve({ status, kopf, geschlossen, dauerMs: Date.now() - beginn });
    };
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => (daten += d));
    socket.on('end', () => ende(true));
    socket.on('close', () => ende(true));
    socket.on('error', reject);
    socket.write(anfrage);
    setTimeout(() => ende(false), warteMs).unref();
  });
}

function kopfzeilen(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([n, w]) => `${n}: ${w}\r\n`)
    .join('');
}

function get(ziel: string, headers: Record<string, string>, extra = ''): string {
  return `GET ${ziel} HTTP/1.1\r\nHost: 127.0.0.1\r\n${kopfzeilen(headers)}${extra}Connection: close\r\n\r\n`;
}

describe('über @hono/node-server', () => {
  const portal = `/v1/mandanten/${MANDANT}/portal`;

  it('erreicht die Route mit kanonischem Target', async () => {
    const { headers } = bestaetigung({ ziel: portal });
    const r = await roh(get(portal, headers));
    expect(r.status).toBe(200);
    expect(r.kopf).toMatch(/content-type: application\/json; charset=utf-8/i);
  });

  for (const ziel of [
    `/v1/mandanten/${MANDANT}/x/../portal`,
    `/v1/mandanten/${MANDANT}/x/%2e%2e/portal`,
    `/v1/mandanten/${MANDANT}/./portal`,
    `/v1/mandanten/${MANDANT}//portal`,
    `/v1/mandanten/${MANDANT}%2Fportal`,
  ]) {
    it(`404 für das rohe Target ${ziel}, obwohl dafür signiert`, async () => {
      const { headers } = bestaetigung({ ziel });
      const r = await roh(get(ziel, headers));
      expect(r.status).toBe(404);
    });
  }

  it('404 für Absolute-Form, auch wenn der Pfad signiert ist', async () => {
    const { headers } = bestaetigung({ ziel: portal });
    const r = await roh(get(`http://127.0.0.1:${port}${portal}`, headers));
    expect(r.status).toBe(404);
  });

  it('Backslash im Target erreicht die Route nie', async () => {
    const ziel = `/v1/mandanten/${MANDANT}/x\\..\\portal`;
    const { headers } = bestaetigung({ ziel });
    const r = await roh(get(ziel, headers));
    expect([400, 404]).toContain(r.status);
  });

  it('401 bei doppeltem Akteur-Header', async () => {
    const { headers, akteur } = bestaetigung({ ziel: portal });
    const r = await roh(get(portal, headers, `${AKTEUR_HEADER}: ${akteur}\r\n`));
    expect(r.status).toBe(401);
  });

  it('413 aus Content-Length, ohne auf den Body zu warten, und schließt die Verbindung', async () => {
    const r = await roh(
      `POST ${portal} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN_ALT}\r\n` +
        `Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n{"a":`,
    );
    // POST ist für diese Route nicht registriert: 405 vor dem Body, Verbindung zu.
    expect(r.status).toBe(405);
    expect(r.geschlossen).toBe(true);
    expect(r.kopf).toMatch(/connection: close/i);
    const s = await roh(
      `GET ${portal} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n{"a":`,
    );
    expect(s.status).toBe(413);
    expect(s.geschlossen).toBe(true);
    expect(s.kopf).toMatch(/connection: close/i);
  });

  describe('ohne gültiges Dienst-Token wird kein Body-Byte gelesen', () => {
    const eingang = `/v1/mandanten/${MANDANT}/eingang`;
    // Angekündigt sind 200 000 Bytes, geschickt nur 16: Wer den Body läse,
    // müsste auf den Rest warten und könnte nicht sofort antworten.
    const teilweise = (auth: string) =>
      `POST ${eingang} HTTP/1.1\r\nHost: 127.0.0.1\r\n${auth}` +
      `Content-Type: application/json\r\nContent-Length: 200000\r\n\r\n{"text":"aaaaaa`;

    for (const [fall, auth] of [
      ['ohne Token', ''],
      ['mit falschem Token', `Authorization: Bearer ${TOKEN_ALT}x\r\n`],
    ] as const) {
      it(`401 ${fall}: sofort, Verbindung geschlossen, Strom unberührt`, async () => {
        delete zuletzt.anfrage;
        const r = await roh(teilweise(auth));
        expect(r.status).toBe(401);
        expect(r.geschlossen).toBe(true);
        expect(r.dauerMs).toBeLessThan(2000);
        expect(r.kopf).toMatch(/connection: close/i);
        expect(letzte()?.bodyUsed).toBe(false);
      });
    }

    it('401 auch bei Transfer-Encoding: chunked ohne Ende', async () => {
      delete zuletzt.anfrage;
      const r = await roh(
        `POST ${eingang} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n` +
          `10000\r\n{"text":"aaaaaa`,
      );
      expect(r.status).toBe(401);
      expect(r.geschlossen).toBe(true);
      expect(r.kopf).toMatch(/connection: close/i);
      expect(letzte()?.bodyUsed).toBe(false);
    });

    it('Gegenprobe: mit gültigem Token wartet der Dienst auf den angekündigten Body', async () => {
      const r = await roh(teilweise(`Authorization: Bearer ${TOKEN_ALT}\r\n`), 800);
      expect(r.status).toBe(0);
      expect(r.geschlossen).toBe(false);
    });

    it('Gegenprobe: vollständig authentisiert wird der Body gelesen', async () => {
      const body = '{"text":"Lieferschwelle"}';
      const { headers } = bestaetigung({ methode: 'POST', ziel: eingang, body });
      const r = await roh(
        `POST ${eingang} HTTP/1.1\r\nHost: 127.0.0.1\r\n${kopfzeilen(headers)}` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      expect(r.status).toBe(200);
      expect(letzte()?.bodyUsed).toBe(true);
    });
  });

  it('Node weist Content-Length zusammen mit Transfer-Encoding ab (Request Smuggling)', async () => {
    const r = await roh(
      `GET ${portal} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\n` +
        `Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    );
    expect(r.status).toBe(400);
  });
});
