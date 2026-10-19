// =============================================================================
// Red-Team (Angreifermodell C, Migrationsläufer mit Superuser-Rechten).
// Befund RT2-T-01.
//
// packages/db/betrieb/migrate.sh hängt jede migration.sql ungeprüft in das
// psql-Skript (`cat "$MIGRATIONEN/.../migration.sql"`); psql führt darin
// Metabefehle aus (\!, \getenv, \copy … from program, \o …). Als Schutz prüft
// `pruefe_migration`:
//     grep -Eq '^[[:space:]]*\\'   (psql-Metabefehle)
// Dieses Muster ist an den ZEILENANFANG gebunden. psql erkennt Backslash-
// Befehle aber auch MITTEN in einer Zeile (nach einem Teil der SQL-Anweisung).
// Eine Migration wie
//     SELECT 1 \! <shell-kommando>
// rutscht an der Prüfung vorbei und psql führt das Shell-Kommando aus – im
// tcms-migrate-Container, der TCMS_DB_SUPERUSER_URL samt Passwort in der
// Umgebung hält. Das hebelt die gesamte Rollentrennung aus (ADR 0001 §10, §4):
// Shell-/Superuser-Zugriff statt nur tcms_owner-DML.
//
// Der Test ist rot, solange der mitzeilige Metabefehl ausgeführt wird, und grün,
// sobald `pruefe_migration` ihn ablehnt (die migration.sql also abgewiesen und
// das Shell-Kommando nicht ausgeführt wird).
//
// Nur mit TCMS_MIGRATE_TESTS=1 und TCMS_MIGRATE_TEST_SUPERUSER_URL (Superuser,
// Wartungsdatenbank, z. B. postgresql://postgres@127.0.0.1:55433/postgres).
// Achtung: setzt clusterweite Rollenpasswörter (tcms_owner/tcms_app) und stellt
// sie am Ende auf die Entwicklungswerte zurück (wie migrate.db.test.ts).
// =============================================================================

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const AKTIV = process.env.TCMS_MIGRATE_TESTS === '1';
const SUPER = process.env.TCMS_MIGRATE_TEST_SUPERUSER_URL;
const OWNER_PW = process.env.TCMS_MIGRATE_TEST_OWNER_PASSWORD ?? 'tcms_owner';
const APP_PW = process.env.TCMS_MIGRATE_TEST_APP_PASSWORD ?? 'tcms_app';

const DB_PAKET = fileURLToPath(new URL('../../..', import.meta.url));
const SKRIPT = join(DB_PAKET, 'betrieb', 'migrate.sh');

const angelegt: string[] = [];
const kopien: string[] = [];
const markierungen: string[] = [];

async function abfrage(url: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

function mitDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function neueDb(): Promise<{ name: string; superUrl: string; ownerUrl: string }> {
  const name = `tcms_rt2mc_${randomBytes(5).toString('hex')}`;
  await abfrage(SUPER!, `CREATE DATABASE "${name}"`);
  angelegt.push(name);
  const superUrl = mitDb(SUPER!, name);
  const u = new URL(superUrl);
  u.username = 'tcms_owner';
  u.password = '';
  return { name, superUrl, ownerUrl: u.toString() };
}

interface Lauf {
  code: number | null;
  stdout: string;
  stderr: string;
}

function starte(skript: string, env: Record<string, string>): Promise<Lauf> {
  return new Promise((resolve) => {
    const kind = spawn('bash', [skript], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    kind.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    kind.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function migriere(z: { superUrl: string; ownerUrl: string }, skript = SKRIPT): Promise<Lauf> {
  return starte(skript, {
    TCMS_DB_SUPERUSER_URL: z.superUrl,
    TCMS_DB_OWNER_URL: z.ownerUrl,
    TCMS_DB_OWNER_PASSWORD: OWNER_PW,
    TCMS_DB_APP_PASSWORD: APP_PW,
  });
}

/** Kopie des db-Pakets (betrieb + prisma), damit die echten Migrationen unberührt bleiben. */
function kopiereDbPaket(): string {
  const kopie = mkdtempSync(join(tmpdir(), 'rt2-migrate-'));
  kopien.push(kopie);
  cpSync(join(DB_PAKET, 'betrieb'), join(kopie, 'betrieb'), { recursive: true });
  cpSync(join(DB_PAKET, 'prisma'), join(kopie, 'prisma'), { recursive: true });
  return kopie;
}

describe.skipIf(!AKTIV || !SUPER)('tcms-migrate – mitzeilige psql-Metabefehle (RT2-T-01)', () => {
  afterAll(async () => {
    // Clusterweite Rollenpasswörter über den Läufer selbst auf die Standardwerte
    // zurücksetzen (wie migrate.db.test.ts), dann Testdatenbanken entfernen.
    if (angelegt.length > 0) {
      const z = await neueDb();
      await migriere(z);
    }
    for (const name of angelegt) {
      await abfrage(SUPER!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const marke of markierungen) rmSync(marke, { force: true });
    for (const k of kopien) rmSync(k, { recursive: true, force: true });
  });

  it('führt \\! mitten in einer Migration nicht aus und weist die Migration ab', async () => {
    const z = await neueDb();
    const kopie = kopiereDbPaket();

    const marke = randomBytes(8).toString('hex');
    const markerDatei = join(tmpdir(), `rt2-mc-${marke}.txt`);
    markierungen.push(markerDatei);
    rmSync(markerDatei, { force: true });

    // Gültiger Migrationsname; Backslash-Befehl NICHT am Zeilenanfang -> umgeht
    // `grep -Eq '^[[:space:]]*\\'`. psql führt `\!` dennoch aus.
    const mdir = join(kopie, 'prisma', 'migrations', '20991231235959_rt2_metabefehl');
    mkdirSync(mdir, { recursive: true });
    writeFileSync(
      join(mdir, 'migration.sql'),
      `SELECT 1 AS x \\! printf %s ${marke} > ${markerDatei}\n`,
    );

    const r = await migriere(z, join(kopie, 'betrieb', 'migrate.sh'));

    // Kernaussage: Der Shell-Metabefehl darf nicht ausgeführt worden sein.
    expect(
      existsSync(markerDatei),
      `psql-Metabefehl (\\!) in der Migration wurde ausgeführt – Lücke in pruefe_migration (migrate.sh). Läufer-Ausgabe:\n${r.stdout}\n${r.stderr}`,
    ).toBe(false);

    // Der Läufer soll die Migration mit Metabefehl ablehnen (Exit 65), nicht anwenden.
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(65);
    expect(r.stderr).toMatch(/psql-Metabefehle/);
  });
});
