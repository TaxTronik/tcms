// Geordnetes Beenden (beenden.ts) mit echtem Socket: laufende Anfragen enden
// noch, neue Verbindungen werden abgewiesen, ruhende Keep-alive-Verbindungen
// halten das Ende nicht auf, eine hängende Anfrage endet nach der Frist mit
// Code 1. Dazu die Stufenfilterung des Logs (TCMS_LOG_LEVEL).

import { request as httpRequest, type Agent } from 'node:http';
import { Agent as HttpAgent } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { geordnetBeenden } from '../beenden';
import { jsonLogger, type LogWert } from '../log';

interface Aufbau {
  port: number;
  freigeben: () => void;
  log: { ereignis: string; felder: Record<string, LogWert> }[];
  ende: Promise<number>;
  aufgeraeumt: () => boolean;
  beende: (signal: string) => void;
  server: ReturnType<typeof createAdaptorServer>;
}

const offen: Aufbau[] = [];

async function starte(fristMs: number): Promise<Aufbau> {
  let freigeben = () => undefined as void;
  const gesperrt = new Promise<void>((r) => (freigeben = r));
  const app = new Hono();
  app.get('/langsam', async (c) => {
    await gesperrt;
    return c.json({ ok: true });
  });
  app.get('/schnell', (c) => c.json({ ok: true }));
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const log: Aufbau['log'] = [];
  let aufgeraeumt = false;
  let endeCode: (c: number) => void = () => undefined;
  const ende = new Promise<number>((r) => (endeCode = r));
  const beende = geordnetBeenden({
    server: server as unknown as Parameters<typeof geordnetBeenden>[0]['server'],
    log: {
      schreibe: (_stufe, ereignis, felder = {}) => log.push({ ereignis, felder: { ...felder } }),
    },
    aufraeumen: async () => {
      aufgeraeumt = true;
    },
    ende: (c) => endeCode(c),
    fristMs,
    intervallMs: 20,
  });
  const a = { port, freigeben, log, ende, aufgeraeumt: () => aufgeraeumt, beende, server };
  offen.push(a);
  return a;
}

function hole(port: number, pfad: string, agent?: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pfad, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(() => {
  for (const a of offen.splice(0)) {
    a.freigeben();
    (a.server as import('node:http').Server).closeAllConnections();
    a.server.close();
  }
});

describe('geordnetBeenden', () => {
  it('lässt laufende Anfragen enden, weist neue ab und endet danach mit 0', async () => {
    const a = await starte(5000);
    const laufend = hole(a.port, '/langsam');
    await new Promise((r) => setTimeout(r, 50));
    a.beende('SIGTERM');
    await expect(hole(a.port, '/schnell')).rejects.toThrow(/ECONNREFUSED/);
    let fertig = false;
    void a.ende.then(() => (fertig = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(fertig).toBe(false); // wartet auf die laufende Anfrage
    a.freigeben();
    expect(await laufend).toBe(200);
    expect(await a.ende).toBe(0);
    expect(a.aufgeraeumt()).toBe(true);
    expect(a.log.map((z) => z.ereignis)).toEqual(['beende']);
    expect(a.log[0]!.felder).toMatchObject({ signal: 'SIGTERM', fristMs: 5000 });
  });

  it('ruhende Keep-alive-Verbindungen halten das Ende nicht auf', async () => {
    const a = await starte(5000);
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    expect(await hole(a.port, '/schnell', agent)).toBe(200);
    const beginn = Date.now();
    a.beende('SIGTERM');
    expect(await a.ende).toBe(0);
    expect(Date.now() - beginn).toBeLessThan(2000);
    agent.destroy();
  });

  it('schließt eine Keep-alive-Verbindung, sobald ihre laufende Anfrage endet', async () => {
    const a = await starte(5000);
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    const laufend = hole(a.port, '/langsam', agent);
    await new Promise((r) => setTimeout(r, 50));
    a.beende('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    const beginn = Date.now();
    a.freigeben();
    expect(await laufend).toBe(200);
    expect(await a.ende).toBe(0);
    // ohne Schließen ruhender Verbindungen erst nach dem Keep-alive-Timeout (5 s)
    expect(Date.now() - beginn).toBeLessThan(2000);
    agent.destroy();
  });

  it('beendet nach der Frist hängende Anfragen und endet mit 1', async () => {
    const a = await starte(200);
    const haengt = hole(a.port, '/langsam').catch(() => 'abgebrochen');
    await new Promise((r) => setTimeout(r, 50));
    a.beende('SIGTERM');
    expect(await a.ende).toBe(1);
    expect(await haengt).toBe('abgebrochen');
    expect(a.aufgeraeumt()).toBe(true);
    expect(a.log.map((z) => z.ereignis)).toEqual(['beende', 'beende_erzwungen']);
  });

  it('reagiert nur auf das erste Signal', async () => {
    const a = await starte(5000);
    a.beende('SIGTERM');
    a.beende('SIGINT');
    expect(await a.ende).toBe(0);
    expect(a.log.filter((z) => z.ereignis === 'beende')).toHaveLength(1);
  });
});

describe('jsonLogger mit TCMS_LOG_LEVEL', () => {
  it('schreibt nur Zeilen ab der eingestellten Stufe', () => {
    const zeilen: string[] = [];
    const log = jsonLogger(
      (z) => zeilen.push(z),
      () => new Date(0),
      'warn',
    );
    log.schreibe('info', 'leise');
    log.schreibe('warn', 'laut');
    log.schreibe('error', 'lauter');
    expect(zeilen.map((z) => (JSON.parse(z) as { ereignis: string }).ereignis)).toEqual([
      'laut',
      'lauter',
    ]);
  });
});
