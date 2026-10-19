// Container-Healthcheck (healthcheck.mjs) als eigener Prozess gegen einen
// lokalen Testserver: Exit 0 nur bei 200, gültigem Umschlag und Datenbank
// "ok"; sonst 1. Das Token geht nur an 127.0.0.1:$PORT und erscheint nie in
// der Ausgabe.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SKRIPT = fileURLToPath(new URL('../../healthcheck.mjs', import.meta.url));
const TOKEN = randomBytes(32).toString('base64url');
const ZWEITES = randomBytes(32).toString('base64url');

type Antwort = (req: IncomingMessage, res: ServerResponse) => void;
const server: ReturnType<typeof createServer>[] = [];

async function testserver(antwort: Antwort) {
  const anfragen: { methode?: string; pfad?: string; auth?: string }[] = [];
  const s = createServer((req, res) => {
    anfragen.push({ methode: req.method, pfad: req.url, auth: req.headers.authorization });
    antwort(req, res);
  });
  server.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as AddressInfo).port, anfragen };
}

function pruefe(env: Record<string, string>) {
  return new Promise<{ code: number | null; ausgabe: string }>((resolve) => {
    const kind = spawn(process.execPath, [SKRIPT], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ausgabe = '';
    kind.stdout.on('data', (d: Buffer) => (ausgabe += d.toString()));
    kind.stderr.on('data', (d: Buffer) => (ausgabe += d.toString()));
    kind.on('exit', (code) => resolve({ code, ausgabe }));
  });
}

const json =
  (status: number, body: unknown): Antwort =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
const env = (port: number, extra: Record<string, string> = {}) => ({
  TCMS_SERVICE_TOKENS: `${TOKEN},${ZWEITES}`,
  PORT: String(port),
  ...extra,
});

afterEach(() => {
  for (const s of server.splice(0)) s.close();
});

describe('healthcheck.mjs', () => {
  it('meldet gesund bei 200 und Datenbank ok, mit dem ersten Token an /v1/health', async () => {
    const t = await testserver(json(200, { ok: true, daten: { version: '1', datenbank: 'ok' } }));
    const r = await pruefe(env(t.port));
    expect(r.code).toBe(0);
    expect(r.ausgabe).toBe('');
    expect(t.anfragen).toEqual([{ methode: 'GET', pfad: '/v1/health', auth: `Bearer ${TOKEN}` }]);
  });

  it('nutzt 127.0.0.1, wenn der Dienst auf 0.0.0.0 lauscht', async () => {
    const t = await testserver(json(200, { ok: true, daten: { version: '1', datenbank: 'ok' } }));
    expect((await pruefe(env(t.port, { HOST: '0.0.0.0' }))).code).toBe(0);
  });

  const faelle: [string, Antwort][] = [
    ['Datenbank fehler', json(200, { ok: true, daten: { version: '1', datenbank: 'fehler' } })],
    ['401', json(401, { ok: false, fehler: { code: 'NICHT_AUTHENTIFIZIERT' } })],
    ['500', json(500, { ok: false, fehler: { code: 'INTERN' } })],
    ['kein JSON', (_q, res) => res.end('ok')],
    ['Umschlag ok: false', json(200, { ok: false, daten: { datenbank: 'ok' } })],
    ['zu große Antwort', (_q, res) => res.end('x'.repeat(200 * 1024))],
  ];
  for (const [name, antwort] of faelle) {
    it(`meldet ungesund: ${name}`, async () => {
      const t = await testserver(antwort);
      const r = await pruefe(env(t.port));
      expect(r.code).toBe(1);
      expect(r.ausgabe).not.toContain(TOKEN);
      expect(r.ausgabe).toMatch(/^tcms-healthcheck: /);
    });
  }

  it('meldet ungesund ohne Token, mit ungültigem Port und ohne Dienst', async () => {
    expect((await pruefe({ PORT: '3200' })).code).toBe(1);
    expect((await pruefe({ TCMS_SERVICE_TOKENS: TOKEN, PORT: '99999' })).code).toBe(1);
    const t = await testserver(json(200, {}));
    const frei = t.port;
    server.splice(0).forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 50));
    const r = await pruefe(env(frei));
    expect(r.code).toBe(1);
    expect(r.ausgabe).toContain('nicht erreichbar');
    expect(r.ausgabe).not.toContain(TOKEN);
  });

  it('bricht nach dem Zeitlimit ab, wenn der Dienst nicht antwortet', async () => {
    const t = await testserver(() => undefined);
    const beginn = Date.now();
    const r = await pruefe(env(t.port));
    expect(r.code).toBe(1);
    expect(Date.now() - beginn).toBeLessThan(6000);
    expect(r.ausgabe).toContain('Zeitlimit');
  }, 10_000);
});
