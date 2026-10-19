// =============================================================================
// Start des Dienstes: Konfiguration prüfen (fail closed), Laufzeitverbindung
// prüfen (`pruefeLaufzeitverbindung` aus @tcms/db), jti-Aufräumen starten,
// Node-Server auf HOST:PORT (Standard 0.0.0.0:3200).
//
// Mandantenkontext: ausschließlich `mitTenant` aus @tcms/db (eine einzige
// Implementierung). Der `pg`-Pool derselben Laufzeitverbindung dient nur dem
// nicht mandantengebundenen `akteur_jti` und dem Ping des Health-Checks.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createAdaptorServer } from '@hono/node-server';
import { mitTenant, pruefeLaufzeitverbindung } from '@tcms/db';
import pg from 'pg';
import { erzeugeDienst } from './dienst';
import { PgJti, starteJtiAufraeumen } from './jti';
import { KonfigurationsFehler, ladeKonfiguration } from './konfiguration';
import { jsonLogger } from './log';

const log = jsonLogger();

async function starte() {
  const konfiguration = ladeKonfiguration(process.env);
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

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
  // Alle Fachrouten aus dem Endpunktregister, beim Aufbau dagegen geprüft.
  const app = erzeugeDienst({
    konfiguration: {
      dienstTokens: konfiguration.dienstTokens,
      akteurSchluessel: konfiguration.akteurSchluessel,
      version,
    },
    // Echte Uhr; TCMS_DEMO_TODAY wirkt nie im Dienst (ADR §7).
    uhr: { jetzt: () => new Date() },
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
    });
  });

  const beende = (signal: string) => {
    log.schreibe('info', 'beende', { signal });
    stoppeAufraeumen();
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => beende('SIGTERM'));
  process.once('SIGINT', () => beende('SIGINT'));
}

starte().catch((e: unknown) => {
  // KonfigurationsFehler nennt nur Variablen und Gründe, nie Werte.
  const meldung =
    e instanceof KonfigurationsFehler ? e.message : e instanceof Error ? e.message : '';
  log.schreibe('error', 'start_fehlgeschlagen', {
    fehler: e instanceof Error ? e.name : 'unbekannt',
    meldung,
  });
  process.exit(1);
});
