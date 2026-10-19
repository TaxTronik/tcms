// =============================================================================
// Start des Dienstes: Konfiguration prüfen (fail closed), Laufzeitverbindung
// prüfen (`pruefeLaufzeitverbindung` aus @tcms/db), jti-Aufräumen starten,
// Node-Server auf HOST:PORT (Standard 0.0.0.0:3200), geordnetes Beenden auf
// SIGTERM/SIGINT (laufende Anfragen höchstens 20 s, `beenden.ts`).
//
// Mandantenkontext: ausschließlich `mitTenant` aus @tcms/db (eine einzige
// Implementierung). Der `pg`-Pool derselben Laufzeitverbindung dient nur dem
// nicht mandantengebundenen `akteur_jti` und dem Ping des Health-Checks.
//
// Produktion startet das Bundle `dist/server.mjs` mit `node` (scripts/build.mjs,
// ADR 0001 §8); `pnpm api` startet in der Entwicklung über tsx.
// =============================================================================

import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { mitTenant, pruefeLaufzeitverbindung, TenantFehler } from '@tcms/db';
import { erzeugeCodeSchluessel } from '@tcms/service';
import pg from 'pg';
import { geordnetBeenden } from './beenden';
import { erzeugeDienst } from './dienst';
import { PgJti, starteJtiAufraeumen } from './jti';
import { KonfigurationsFehler, ladeKonfiguration } from './konfiguration';
import { jsonLogger, type Logger } from './log';

/** Beim Bündeln gesetzt (TCMS-Version = Image-Tag); in der Entwicklung aus package.json. */
declare const __TCMS_VERSION__: string | undefined;

function dienstVersion(): string {
  if (typeof __TCMS_VERSION__ === 'string') return __TCMS_VERSION__;
  const paket = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return paket.version;
}

let log: Logger = jsonLogger();

async function starte() {
  const konfiguration = ladeKonfiguration(process.env);
  log = jsonLogger(undefined, undefined, konfiguration.logStufe);
  const version = dienstVersion();

  // Fail closed: Superuser, BYPASSRLS oder Tabelleneigentum der Laufzeitrolle
  // (DATABASE_URL, dieselbe Variable wie oben geprüft) verhindern den Start.
  await pruefeLaufzeitverbindung();

  const pool = new pg.Pool({
    connectionString: konfiguration.datenbankUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (e) => log.schreibe('error', 'db_pool_fehler', { fehler: e.name }));

  const jti = new PgJti(pool);
  const stoppeAufraeumen = starteJtiAufraeumen(jti, { log });
  const app = erzeugeDienst({
    konfiguration: {
      dienstTokens: konfiguration.dienstTokens,
      akteurSchluessel: konfiguration.akteurSchluessel,
      version,
    },
    // Echte Uhr; TCMS_DEMO_TODAY wirkt nie im Dienst (ADR §7).
    uhr: { jetzt: () => new Date() },
    // Schlüssel der Bestätigungscodes (H5): nur im Speicher, nie im Log.
    codes: erzeugeCodeSchluessel(konfiguration.codeSchluessel),
    jti,
    daten: {
      mitTenant: (tenantId, fn) => mitTenant(tenantId, fn),
      ping: async () => {
        await pool.query('SELECT 1');
      },
    },
    log,
  });

  const server = createAdaptorServer({
    fetch: app.fetch,
    hostname: konfiguration.host,
    // Langsame Clients begrenzen (Header 10 s, ganze Anfrage 30 s).
    serverOptions: { headersTimeout: 10_000, requestTimeout: 30_000 },
  });
  server.listen(konfiguration.port, konfiguration.host, () => {
    log.schreibe('info', 'gestartet', {
      host: konfiguration.host,
      port: konfiguration.port,
      version,
      schluessel: konfiguration.akteurSchluessel.size,
      tokens: konfiguration.dienstTokens.length,
      codeSchluessel: konfiguration.codeSchluessel.length,
    });
  });

  const beende = geordnetBeenden({
    // createAdaptorServer ohne eigenes createServer liefert einen http.Server.
    server: server as Server,
    log,
    aufraeumen: async () => {
      stoppeAufraeumen();
      await pool.end();
    },
    ende: (code) => process.exit(code),
  });
  process.once('SIGTERM', () => beende('SIGTERM'));
  process.once('SIGINT', () => beende('SIGINT'));
}

/** Meldung nur für eigene Fehlerklassen (ohne Werte); sonst nur Name und Code. */
function startFehler(e: unknown): Record<string, string> {
  if (e instanceof KonfigurationsFehler || e instanceof TenantFehler) {
    return { fehler: e.name, meldung: e.message };
  }
  const code = (e as { code?: unknown } | null)?.code;
  return {
    fehler: e instanceof Error ? e.name : 'unbekannt',
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}),
  };
}

starte().catch((e: unknown) => {
  log.schreibe('error', 'start_fehlgeschlagen', startFehler(e));
  process.exit(1);
});
