// Langsame Clients (Befund 43): Node prüft `headersTimeout`/`requestTimeout` nur
// im Raster von `connectionsCheckingInterval` (Standard 30 s). Der Test startet
// den Adapter mit den Optionen des Dienstes und nur verkürzten Fristen (das
// Raster bleibt das des Dienstes): Unvollständige Header müssen kurz nach der
// Frist mit 408 enden. Ohne das kurze Raster dauerte es bis zu 30 s.

import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VERBINDUNGEN, SERVER_OPTIONEN } from '../verbindung';

const offen: { server: Server; sockets: Socket[] }[] = [];

afterEach(() => {
  for (const o of offen.splice(0)) {
    for (const s of o.sockets) s.destroy();
    o.server.closeAllConnections();
    o.server.close();
  }
});

async function starte(fristen: { headersTimeout: number; requestTimeout: number }) {
  const app = new Hono();
  app.post('/', async (c) => c.json({ laenge: (await c.req.text()).length }));
  const server = createAdaptorServer({
    fetch: app.fetch,
    serverOptions: { ...SERVER_OPTIONEN, ...fristen },
  }) as Server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const eintrag = { server, sockets: [] as Socket[] };
  offen.push(eintrag);
  return { port: (server.address() as AddressInfo).port, eintrag };
}

/** Sendet `text` und wartet, bis der Server antwortet oder schließt; liefert Antwort und Dauer. */
function langsamerClient(port: number, text: string, sockets: Socket[]) {
  return new Promise<{ antwort: string; ms: number }>((resolve, reject) => {
    const beginn = Date.now();
    let antwort = '';
    const s = connect(port, '127.0.0.1', () => s.write(text));
    sockets.push(s);
    s.setEncoding('utf8');
    s.on('data', (d: string) => (antwort += d));
    s.on('close', () => resolve({ antwort, ms: Date.now() - beginn }));
    s.on('error', reject);
  });
}

describe('Verbindungsgrenzen des Dienstes', () => {
  it('Fristen und Prüfraster: Header 10 s, Anfrage 30 s, Raster höchstens 1 s', () => {
    expect(SERVER_OPTIONEN.headersTimeout).toBe(10_000);
    expect(SERVER_OPTIONEN.requestTimeout).toBe(30_000);
    expect(SERVER_OPTIONEN.connectionsCheckingInterval).toBeLessThanOrEqual(1_000);
    expect(MAX_VERBINDUNGEN).toBeGreaterThan(0);
  });

  it('unvollständige Header enden kurz nach der Frist mit 408, nicht erst im 30-s-Raster', async () => {
    const { port, eintrag } = await starte({ headersTimeout: 500, requestTimeout: 1_000 });
    const r = await langsamerClient(port, 'POST / HTTP/1.1\r\nHost: x\r\n', eintrag.sockets);
    expect(r.antwort).toMatch(/^HTTP\/1\.1 408/);
    expect(r.ms).toBeLessThan(500 + 2 * SERVER_OPTIONEN.connectionsCheckingInterval + 500);
  });

  it('unvollständiger Body endet kurz nach der Anfragefrist mit 408', async () => {
    const { port, eintrag } = await starte({ headersTimeout: 500, requestTimeout: 1_000 });
    const r = await langsamerClient(
      port,
      'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"a":',
      eintrag.sockets,
    );
    expect(r.antwort).toMatch(/^HTTP\/1\.1 408/);
    expect(r.ms).toBeLessThan(1_000 + 2 * SERVER_OPTIONEN.connectionsCheckingInterval + 500);
  });
});
