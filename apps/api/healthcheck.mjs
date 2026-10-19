#!/usr/bin/env node
// =============================================================================
// Container-Healthcheck des Images tcms-api (Betriebsschnittstelle Stufe 2):
//
//   node /app/healthcheck.mjs
//
// Liest das Dienst-Token aus TCMS_SERVICE_TOKENS (erster Eintrag; bei einer
// Rotation stehen altes und neues Token darin), ruft GET /v1/health auf
// 127.0.0.1:$PORT (Standard 3200) und endet mit 0 genau dann, wenn der Dienst
// mit 200, gültigem Umschlag und `datenbank: "ok"` antwortet, sonst mit 1.
// Gibt nie Werte aus (kein Token, keine Antwort), höchstens einen festen Grund
// auf stderr. Nur node:http, keine Abhängigkeiten; Antwort und Zeit begrenzt.
// =============================================================================

import { request } from 'node:http';

const ZEITLIMIT_MS = 4000;
const MAX_ANTWORT_BYTES = 64 * 1024;

function ende(code, grund) {
  if (grund) process.stderr.write(`tcms-healthcheck: ${grund}\n`);
  process.exit(code);
}

// Harte Obergrenze für den ganzen Prozess (Docker-Timeout der Schnittstelle: 5 s).
setTimeout(() => ende(1, 'Zeitlimit'), ZEITLIMIT_MS + 500).unref();

const token = (process.env.TCMS_SERVICE_TOKENS ?? '').split(',')[0]?.trim() ?? '';
if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) ende(1, 'kein gültiges Dienst-Token konfiguriert');

const portText = process.env.PORT ?? '3200';
const port = /^[1-9][0-9]{0,4}$/.test(portText) ? Number(portText) : NaN;
if (!(port <= 65_535)) ende(1, 'PORT ungültig');

// Der Dienst lauscht auf HOST (Standard 0.0.0.0); geprüft wird lokal.
const hostEnv = process.env.HOST ?? '';
const host =
  hostEnv === '' || hostEnv === '0.0.0.0' ? '127.0.0.1' : hostEnv === '::' ? '::1' : hostEnv;

const anfrage = request(
  {
    host,
    port,
    method: 'GET',
    path: '/v1/health',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    timeout: ZEITLIMIT_MS,
  },
  (antwort) => {
    const teile = [];
    let laenge = 0;
    antwort.on('data', (teil) => {
      laenge += teil.length;
      if (laenge > MAX_ANTWORT_BYTES) {
        anfrage.destroy();
        ende(1, 'Antwort zu groß');
      }
      teile.push(teil);
    });
    antwort.on('end', () => {
      if (antwort.statusCode !== 200) ende(1, `Status ${antwort.statusCode}`);
      let body;
      try {
        body = JSON.parse(Buffer.concat(teile).toString('utf8'));
      } catch {
        ende(1, 'Antwort ist kein JSON');
      }
      if (body?.ok !== true || body?.daten?.datenbank !== 'ok') ende(1, 'Datenbank nicht ok');
      ende(0);
    });
    antwort.on('error', () => ende(1, 'Antwort abgebrochen'));
  },
);
anfrage.on('timeout', () => {
  anfrage.destroy();
  ende(1, 'Zeitlimit');
});
anfrage.on('error', () => ende(1, 'nicht erreichbar'));
anfrage.end();
