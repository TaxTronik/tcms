// =============================================================================
// tcms-migrate (packages/db/betrieb/migrate.sh) gegen frische Datenbanken:
// Erstlauf, Zweitlauf (idempotent), manipulierte Prüfsummen, Passwörter mit
// Sonderzeichen, Abbruch der Prüfung (Rollen, RLS, Rechte), gleichzeitige
// Läufe, gleiche Rechte wie der Entwicklungs-Bootstrap, keine Passwörter in
// Ausgabe, Server-Log und pg_stat_statements.
//
// Nur mit TCMS_MIGRATE_TESTS=1 und TCMS_MIGRATE_TEST_SUPERUSER_URL (Superuser,
// Wartungsdatenbank, z. B. postgresql://postgres@127.0.0.1:55433/postgres).
// Achtung: Die Rollen tcms_owner/tcms_app sind clusterweit; der Test setzt
// ihre Passwörter und stellt am Ende TCMS_MIGRATE_TEST_OWNER_PASSWORD bzw.
// TCMS_MIGRATE_TEST_APP_PASSWORD wieder her (Standard: Entwicklungswerte).
// Optional TCMS_MIGRATE_TEST_SERVERLOG: Pfad des Server-Logs (lesbar), um zu
// prüfen, dass kein Passwort darin landet.
// psql muss im PATH liegen (wie im Image tcms-migrate).
// =============================================================================

import { spawn } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const AKTIV = process.env.TCMS_MIGRATE_TESTS === '1';
const SUPER = process.env.TCMS_MIGRATE_TEST_SUPERUSER_URL;
const OWNER_PW = process.env.TCMS_MIGRATE_TEST_OWNER_PASSWORD ?? 'tcms_owner';
const APP_PW = process.env.TCMS_MIGRATE_TEST_APP_PASSWORD ?? 'tcms_app';
const SERVERLOG = process.env.TCMS_MIGRATE_TEST_SERVERLOG;

const DB_PAKET = fileURLToPath(new URL('../..', import.meta.url));
const SKRIPT = join(DB_PAKET, 'betrieb', 'migrate.sh');
const PRUEFUNG = join(DB_PAKET, 'betrieb', 'pruefung.sql');
const ENTWICKLUNG = join(DB_PAKET, 'prisma', 'init', '01_bootstrap.sql');
const MIGRATIONEN = join(DB_PAKET, 'prisma', 'migrations');

const migrationen = () =>
  readdirSync(MIGRATIONEN)
    .filter((n) => statSync(join(MIGRATIONEN, n)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      pruefsumme: createHash('sha256')
        .update(readFileSync(join(MIGRATIONEN, name, 'migration.sql')))
        .digest('hex'),
    }));

interface Ziel {
  name: string;
  superUrl: string;
  ownerUrl: (passwort?: string) => string;
}

const angelegt: string[] = [];

function mitDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function abfrage<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  werte: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, werte)).rows;
  } finally {
    await c.end();
  }
}

async function neueDb(): Promise<Ziel> {
  const name = `tcms_migtest_${randomBytes(5).toString('hex')}`;
  await abfrage(SUPER!, `CREATE DATABASE "${name}"`);
  angelegt.push(name);
  const superUrl = mitDb(SUPER!, name);
  const ownerUrl = (passwort?: string) => {
    const u = new URL(superUrl);
    u.username = 'tcms_owner';
    u.password = passwort === undefined ? '' : encodeURIComponent(passwort);
    return u.toString();
  };
  return { name, superUrl, ownerUrl };
}

interface Lauf {
  code: number | null;
  stdout: string;
  stderr: string;
}

function starte(programm: string, args: string[], env: Record<string, string>): Promise<Lauf> {
  return new Promise((resolve) => {
    // Bewusst ohne geerbte Umgebung: nur PATH und die Testwerte.
    const kind = spawn(programm, args, {
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

function migriere(z: Ziel, pw = { owner: OWNER_PW, app: APP_PW }, skript = SKRIPT, extra = {}) {
  return starte('bash', [skript], {
    TCMS_DB_SUPERUSER_URL: z.superUrl,
    TCMS_DB_OWNER_URL: z.ownerUrl(),
    TCMS_DB_OWNER_PASSWORD: pw.owner,
    TCMS_DB_APP_PASSWORD: pw.app,
    ...extra,
  });
}

/** psql als Superuser auf der Testdatenbank; Zugang über PG*-Umgebung, nie als Argument. */
function psqlSuper(z: Ziel, args: string[], extra: Record<string, string> = {}) {
  const u = new URL(z.superUrl);
  return starte('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: z.name,
    ...extra,
  });
}

/** SCRAM-SHA-256-Verifier aus pg_authid gegen ein Klartextpasswort prüfen (RFC 5802/7677). */
function scramPasst(verifier: string, passwort: string): boolean {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) return false;
  const salted = pbkdf2Sync(passwort, Buffer.from(m[2]!, 'base64'), Number(m[1]), 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    storedKey.equals(Buffer.from(m[3]!, 'base64')) && serverKey.equals(Buffer.from(m[4]!, 'base64'))
  );
}

async function passwortGesetzt(rolle: string, passwort: string): Promise<boolean> {
  const [z] = await abfrage<{ v: string }>(
    SUPER!,
    'SELECT rolpassword AS v FROM pg_authid WHERE rolname = $1',
    [rolle],
  );
  return scramPasst(z?.v ?? '', passwort);
}

const ledger = (z: Ziel) =>
  abfrage<{ id: string; migration_name: string; checksum: string; finished_at: Date }>(
    z.superUrl,
    'SELECT id, migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY migration_name',
  );

const ausgabe = (l: Lauf) => `${l.stdout}\n${l.stderr}`;

describe.skipIf(!AKTIV || !SUPER)('tcms-migrate (packages/db/betrieb/migrate.sh)', () => {
  afterAll(async () => {
    // Clusterweite Passwörter auf die Ausgangswerte zurücksetzen (über den Läufer selbst).
    if (angelegt.length > 0) {
      const z = await neueDb();
      const r = await migriere(z);
      expect(r.code, ausgabe(r)).toBe(0);
    }
    for (const name of angelegt) {
      await abfrage(SUPER!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });

  it('Erstlauf: Rollen, alle Migrationen mit SHA-256 im Ledger, Prüfung bestanden', async () => {
    const z = await neueDb();
    const r = await migriere(z);
    expect(r.code, ausgabe(r)).toBe(0);
    const erwartet = migrationen();
    for (const m of erwartet) expect(r.stdout).toContain(`angewandt: ${m.name}`);
    expect(r.stdout).toMatch(/Prüfung bestanden/);
    const zeilen = await ledger(z);
    expect(zeilen.map((l) => [l.migration_name, l.checksum])).toEqual(
      erwartet.map((m) => [m.name, m.pruefsumme]),
    );
    expect(zeilen.every((l) => l.finished_at instanceof Date)).toBe(true);
    const rollen = await abfrage<Record<string, unknown>>(
      SUPER!,
      `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
              rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname IN ('tcms_owner', 'tcms_app') ORDER BY rolname`,
    );
    expect(rollen).toEqual([
      {
        rolname: 'tcms_app',
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
        rolreplication: false,
        rolbypassrls: false,
      },
      {
        rolname: 'tcms_owner',
        rolsuper: false,
        rolinherit: true,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
        rolreplication: false,
        rolbypassrls: false,
      },
    ]);
    expect(await passwortGesetzt('tcms_owner', OWNER_PW)).toBe(true);
    expect(await passwortGesetzt('tcms_app', APP_PW)).toBe(true);
  });

  it('Zweitlauf ist idempotent (Ledger unverändert, nichts erneut angewandt)', async () => {
    const z = await neueDb();
    expect((await migriere(z)).code).toBe(0);
    const vorher = await ledger(z);
    const r = await migriere(z);
    expect(r.code, ausgabe(r)).toBe(0);
    expect(r.stdout).not.toMatch(/^tcms-migrate: angewandt:/m);
    for (const m of migrationen()) expect(r.stdout).toContain(`bereits angewandt: ${m.name}`);
    expect(await ledger(z)).toEqual(vorher);
  });

  it('bricht bei abweichender Prüfsumme im Ledger ab und wendet nichts weiter an', async () => {
    const z = await neueDb();
    expect((await migriere(z)).code).toBe(0);
    const [erste, zweite] = migrationen();
    await abfrage(
      z.superUrl,
      `UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2`,
      ['0'.repeat(64), zweite!.name],
    );
    const vorher = await ledger(z);
    const r = await migriere(z);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`Prüfsumme weicht vom Ledger ab: ${zweite!.name}`);
    expect(r.stdout).toContain(`bereits angewandt: ${erste!.name}`);
    expect(await ledger(z)).toEqual(vorher);
  });

  it('bricht ab, wenn eine angewandte migration.sql im Image verändert wurde', async () => {
    const z = await neueDb();
    expect((await migriere(z)).code).toBe(0);
    const kopie = mkdtempSync(join(tmpdir(), 'tcms-migrate-'));
    try {
      cpSync(join(DB_PAKET, 'betrieb'), join(kopie, 'betrieb'), { recursive: true });
      cpSync(join(DB_PAKET, 'prisma'), join(kopie, 'prisma'), { recursive: true });
      const [erste] = migrationen();
      const datei = join(kopie, 'prisma', 'migrations', erste!.name, 'migration.sql');
      writeFileSync(datei, `${readFileSync(datei, 'utf8')}\n-- verändert\n`);
      const r = await migriere(z, undefined, join(kopie, 'betrieb', 'migrate.sh'));
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(`Prüfsumme weicht vom Ledger ab: ${erste!.name}`);
    } finally {
      rmSync(kopie, { recursive: true, force: true });
    }
  });

  it("setzt Passwörter mit ', \\, $ und anderen Sonderzeichen korrekt (SCRAM-Verifier)", async () => {
    const z = await neueDb();
    const pw = {
      owner: `O'w\\n$er"%@:/?#&= x\\'ü${randomBytes(4).toString('hex')}`,
      app: `A'p\\p$1$\`x\`\\\\'${randomBytes(4).toString('hex')}`,
    };
    const r = await migriere(z, pw);
    expect(r.code, ausgabe(r)).toBe(0);
    expect(await passwortGesetzt('tcms_owner', pw.owner)).toBe(true);
    expect(await passwortGesetzt('tcms_app', pw.app)).toBe(true);
    expect(await passwortGesetzt('tcms_app', pw.owner)).toBe(false);
    // Anmeldung mit genau diesen Passwörtern (wirkt, wo pg_hba Passwörter verlangt).
    for (const [rolle, passwort] of [
      ['tcms_owner', pw.owner],
      ['tcms_app', pw.app],
    ] as const) {
      const u = new URL(z.superUrl);
      u.username = rolle;
      u.password = encodeURIComponent(passwort);
      const [w] = await abfrage<{ wer: string }>(u.toString(), 'SELECT current_user AS wer');
      expect(w?.wer).toBe(rolle);
    }
    for (const geheim of [pw.owner, pw.app]) expect(ausgabe(r)).not.toContain(geheim);
    // Dieselbe URL mit eingebettetem (kodiertem) Passwort ist ebenfalls zulässig.
    const r2 = await starte('bash', [SKRIPT], {
      TCMS_DB_SUPERUSER_URL: z.superUrl,
      TCMS_DB_OWNER_URL: z.ownerUrl(pw.owner),
      TCMS_DB_OWNER_PASSWORD: pw.owner,
      TCMS_DB_APP_PASSWORD: pw.app,
    });
    expect(r2.code, ausgabe(r2)).toBe(0);
  });

  it.skipIf(!existsSync('/proc/self/cmdline'))(
    'gibt Passwörter nie als Kommandozeilenargument weiter (Stichprobe über /proc)',
    async () => {
      const z = await neueDb();
      const marke = randomBytes(12).toString('hex');
      const pw = { owner: `owner-${marke}`, app: `app-${marke}` };
      const gesehen = { psql: 0, treffer: [] as string[] };
      let aktiv = true;
      const stichprobe = (async () => {
        while (aktiv) {
          for (const pid of readdirSync('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            let zeile = '';
            try {
              zeile = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ');
            } catch {
              continue;
            }
            if (/(^|\/)psql /.test(zeile)) gesehen.psql++;
            if (zeile.includes(marke)) gesehen.treffer.push(zeile.split(' ')[0] ?? '');
          }
          await new Promise((ok) => setImmediate(ok));
        }
      })();
      const r = await migriere(z, pw, SKRIPT, { TCMS_DB_OWNER_URL: z.ownerUrl(pw.owner) });
      aktiv = false;
      await stichprobe;
      expect(r.code, ausgabe(r)).toBe(0);
      expect(gesehen.psql).toBeGreaterThan(0); // die Stichprobe hat psql-Prozesse erfasst
      expect(gesehen.treffer).toEqual([]);
    },
  );

  it('psql sieht nur die Werte seiner Rolle: keine Superuser-URL, keine fremden Passwörter (RT2-T-01)', async () => {
    // Ein psql-Stellvertreter vor dem echten psql protokolliert je Aufruf die
    // Rolle, das erste Argument und die NAMEN der geerbten Umgebungsvariablen
    // (keine Werte).
    const z = await neueDb();
    const ordner = mkdtempSync(join(tmpdir(), 'tcms-psql-env-'));
    const protokoll = join(ordner, 'umgebung.log');
    const echt = (await starte('sh', ['-c', 'command -v psql'], {})).stdout.trim();
    expect(echt).not.toBe('');
    writeFileSync(
      join(ordner, 'psql'),
      `#!/bin/sh\n{ printf 'ROLLE=%s\\nARG=%s\\n' "$PGUSER" "$1"; env | cut -d= -f1 | sort | tr '\\n' ' '; printf '\\n'; } >> '${protokoll}'\nexec '${echt}' "$@"\n`,
    );
    chmodSync(join(ordner, 'psql'), 0o755);
    try {
      const r = await migriere(z, undefined, SKRIPT, {
        PATH: `${ordner}:${process.env.PATH ?? ''}`,
        TCMS_TEST_FREMD: 'x',
      });
      expect(r.code, ausgabe(r)).toBe(0);
      const zeilen = readFileSync(protokoll, 'utf8').trim().split('\n');
      const aufrufe: { rolle: string; arg: string; namen: string[] }[] = [];
      for (let i = 0; i < zeilen.length; i += 3) {
        aufrufe.push({
          rolle: zeilen[i]!.slice('ROLLE='.length),
          arg: zeilen[i + 1]!.slice('ARG='.length),
          namen: zeilen[i + 2]!.trim().split(' '),
        });
      }
      // Versionsabfrage (psql >= 15): ohne Rolle und ohne jedes Geheimnis.
      const version = aufrufe.filter((a) => a.arg === '--version');
      const verbindungen = aufrufe.filter((a) => a.arg !== '--version');
      expect(version.length).toBe(1);
      expect(version[0]!.rolle).toBe('');
      for (const name of ['PGPASSWORD', 'TCMS_DB_OWNER_PASSWORD', 'TCMS_DB_APP_PASSWORD']) {
        expect(version[0]!.namen).not.toContain(name);
      }
      const su = verbindungen.filter((a) => a.rolle !== 'tcms_owner');
      const ow = verbindungen.filter((a) => a.rolle === 'tcms_owner');
      expect(su.length).toBe(1);
      expect(ow.length).toBeGreaterThanOrEqual(2);
      for (const a of aufrufe) {
        expect(a.namen).not.toContain('TCMS_DB_SUPERUSER_URL');
        expect(a.namen).not.toContain('TCMS_DB_OWNER_URL');
        expect(a.namen).not.toContain('TCMS_TEST_FREMD');
      }
      // Bootstrap braucht die beiden Rollenpasswörter (\getenv), sonst niemand.
      expect(su[0]!.namen).toEqual(
        expect.arrayContaining(['TCMS_DB_OWNER_PASSWORD', 'TCMS_DB_APP_PASSWORD']),
      );
      for (const a of ow) {
        expect(a.namen).not.toContain('TCMS_DB_OWNER_PASSWORD');
        expect(a.namen).not.toContain('TCMS_DB_APP_PASSWORD');
      }
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('weist jeden Backslash in einer Migration ab, auch mitten in der Zeile (RT2-T-01)', async () => {
    for (const inhalt of [
      'SELECT 1 AS x \\getenv geheim TCMS_DB_SUPERUSER_URL\n',
      "SELECT 'a\\b' AS literal;\n",
      'CREATE TABLE t (x int); -- \\! id\n',
    ]) {
      const z = await neueDb();
      const kopie = mkdtempSync(join(tmpdir(), 'tcms-mig-bs-'));
      try {
        cpSync(join(DB_PAKET, 'betrieb'), join(kopie, 'betrieb'), { recursive: true });
        cpSync(join(DB_PAKET, 'prisma'), join(kopie, 'prisma'), { recursive: true });
        const ziel = join(kopie, 'prisma', 'migrations', '29990101000000_backslash');
        cpSync(join(MIGRATIONEN, migrationen()[0]!.name), ziel, { recursive: true });
        writeFileSync(join(ziel, 'migration.sql'), inhalt);
        const r = await migriere(z, undefined, join(kopie, 'betrieb', 'migrate.sh'));
        expect(r.code, ausgabe(r)).toBe(65);
        expect(r.stderr + r.stdout).toContain('enthält einen Backslash');
      } finally {
        rmSync(kopie, { recursive: true, force: true });
      }
    }
  });

  it('schreibt keine Passwörter in Server-Log oder pg_stat_statements', async () => {
    const z = await neueDb();
    const marke = randomBytes(12).toString('hex');
    const pw = { owner: `owner-${marke}`, app: `app-${marke}` };
    // Diese Datenbank protokolliert jede Anweisung (wie ein falsch konfigurierter Server).
    await abfrage(SUPER!, `ALTER DATABASE "${z.name}" SET log_statement = 'all'`);
    const logVorher = SERVERLOG && existsSync(SERVERLOG) ? statSync(SERVERLOG).size : 0;
    const r = await migriere(z, pw);
    expect(r.code, ausgabe(r)).toBe(0);
    expect(ausgabe(r)).not.toContain(marke);
    if (SERVERLOG && existsSync(SERVERLOG)) {
      await new Promise((ok) => setTimeout(ok, 300));
      const log = readFileSync(SERVERLOG).subarray(logVorher).toString('utf8');
      expect(log.length).toBeGreaterThan(0); // log_statement = all hat protokolliert
      expect(log).not.toContain(marke);
    }
    const ext = await abfrage<{ n: string }>(
      z.superUrl,
      "SELECT count(*)::text AS n FROM pg_extension WHERE extname = 'pg_stat_statements'",
    ).catch(() => [{ n: '0' }]);
    const geladen = await abfrage<{ s: string }>(
      z.superUrl,
      "SELECT current_setting('shared_preload_libraries') AS s",
    );
    if (geladen[0]?.s.includes('pg_stat_statements')) {
      if (ext[0]?.n === '0') await abfrage(z.superUrl, 'CREATE EXTENSION pg_stat_statements');
      const treffer = await abfrage<{ n: string }>(
        z.superUrl,
        'SELECT count(*)::text AS n FROM pg_stat_statements WHERE query LIKE $1',
        [`%${marke}%`],
      );
      expect(treffer[0]?.n).toBe('0');
    }
  });

  it('Prüfung schlägt fehl bei fehlender RLS, TRUNCATE-Recht oder BYPASSRLS der Laufzeitrolle', async () => {
    const z = await neueDb();
    expect((await migriere(z)).code).toBe(0);

    await abfrage(z.superUrl, 'ALTER TABLE "TcmsProgramm" NO FORCE ROW LEVEL SECURITY');
    let r = await migriere(z);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('Tabelle "TcmsProgramm" ohne ENABLE+FORCE ROW LEVEL SECURITY');
    await abfrage(z.superUrl, 'ALTER TABLE "TcmsProgramm" FORCE ROW LEVEL SECURITY');

    await abfrage(z.superUrl, 'GRANT TRUNCATE ON "AuditEvent" TO tcms_app');
    r = await migriere(z);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('tcms_app hat TRUNCATE/REFERENCES/TRIGGER auf "AuditEvent"');
    await abfrage(z.superUrl, 'REVOKE TRUNCATE ON "AuditEvent" FROM tcms_app');

    // Rollenattribute gleicht der Bootstrap an; die Prüfung selbst erkennt sie.
    await abfrage(z.superUrl, 'ALTER ROLE tcms_app BYPASSRLS');
    try {
      const p = await psqlSuper(z, ['-f', PRUEFUNG]);
      expect(p.code).toBe(3);
      expect(p.stderr).toContain('tcms_app hat BYPASSRLS');
    } finally {
      await abfrage(z.superUrl, 'ALTER ROLE tcms_app NOBYPASSRLS');
    }
    await abfrage(z.superUrl, 'GRANT tcms_owner TO tcms_app');
    try {
      const p = await psqlSuper(z, ['-f', PRUEFUNG]);
      expect(p.code).toBe(3);
      expect(p.stderr).toContain('tcms_app ist Mitglied von tcms_owner');
      // … und der Bootstrap entfernt die Mitgliedschaft wieder.
      r = await migriere(z);
      expect(r.code, ausgabe(r)).toBe(0);
    } finally {
      await abfrage(SUPER!, 'REVOKE tcms_owner FROM tcms_app').catch(() => undefined);
    }
  });

  it('weist Konfigurationsfehler vor jeder Verbindung ab, ohne Werte zu nennen', async () => {
    const z = await neueDb();
    const geheim = `geheim-${randomBytes(8).toString('hex')}`;
    const basis = {
      TCMS_DB_SUPERUSER_URL: z.superUrl,
      TCMS_DB_OWNER_URL: z.ownerUrl(),
      TCMS_DB_OWNER_PASSWORD: geheim,
      TCMS_DB_APP_PASSWORD: `${geheim}-app`,
    };
    const faelle: [Record<string, string>, RegExp][] = [
      [{ TCMS_DB_APP_PASSWORD: '' }, /TCMS_DB_APP_PASSWORD fehlt/],
      [{ TCMS_DB_APP_PASSWORD: geheim }, /müssen verschieden sein/],
      [
        { TCMS_DB_OWNER_URL: z.ownerUrl().replace('tcms_owner', 'tcms_app') },
        /tcms_owner verwenden/,
      ],
      [{ TCMS_DB_OWNER_URL: z.ownerUrl(`${geheim}x`) }, /verschiedene Passwörter/],
      [{ TCMS_DB_OWNER_URL: mitDb(z.ownerUrl(), 'andere') }, /dieselbe Datenbank/],
      [{ TCMS_DB_SUPERUSER_URL: `${z.superUrl}?options=-c%20x` }, /nur der Parameter sslmode/],
      [{ TCMS_DB_OWNER_PASSWORD: 'zeile\numbruch' }, /Steuerzeichen/],
    ];
    for (const [aenderung, meldung] of faelle) {
      const r = await starte('bash', [SKRIPT], { ...basis, ...aenderung });
      expect(r.code, JSON.stringify(Object.keys(aenderung))).toBe(64);
      expect(r.stderr).toMatch(meldung);
      expect(ausgabe(r)).not.toContain(geheim);
    }
    const argumente = await starte('bash', [SKRIPT, '--seed'], basis);
    expect(argumente.code).toBe(64);
    // Ein Nicht-Superuser kann keinen Bootstrap ausführen.
    const kein = await starte('bash', [SKRIPT], {
      ...basis,
      TCMS_DB_OWNER_PASSWORD: OWNER_PW,
      TCMS_DB_APP_PASSWORD: APP_PW,
      TCMS_DB_SUPERUSER_URL: z.ownerUrl(OWNER_PW),
    });
    expect(kein.code).toBe(2);
    expect(kein.stderr).toContain('keinen Superuser');
  });

  it('verlangt psql >= 15 (\\getenv) und prüft das vor jeder Verbindung', async () => {
    // CI-Lauf 3884: Ubuntu 22.04 lieferte psql 14, der Bootstrap brach erst an
    // \getenv ab. Ein psql-Stellvertreter meldet die Version und protokolliert
    // jeden Aufruf; ab 15 reicht er an das echte psql weiter.
    const z = await neueDb();
    const echt = (await starte('sh', ['-c', 'command -v psql'], {})).stdout.trim();
    expect(echt).not.toBe('');
    const ordner = mkdtempSync(join(tmpdir(), 'tcms-psql-version-'));
    const protokoll = join(ordner, 'aufrufe.log');
    const stellvertreter = (version: string) =>
      writeFileSync(
        join(ordner, 'psql'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${protokoll}'\n` +
          `if [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi\n` +
          `exec '${echt}' "$@"\n`,
        { mode: 0o755 },
      );
    const pfad = `${ordner}:${process.env.PATH ?? ''}`;
    try {
      for (const [version, meldung] of [
        ['psql (PostgreSQL) 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)', /psql 14 ist zu alt/],
        ['psql (PostgreSQL) 9.6.24', /psql 9 ist zu alt/],
        ['psql (Fremd) 18.0', /psql-Version nicht erkennbar/],
      ] as const) {
        stellvertreter(version);
        rmSync(protokoll, { force: true });
        const r = await migriere(z, undefined, SKRIPT, { PATH: pfad });
        expect(r.code, ausgabe(r)).toBe(69);
        expect(r.stderr).toMatch(meldung);
        // Nur die Versionsabfrage, keine Verbindung.
        expect(readFileSync(protokoll, 'utf8')).toBe('--version\n');
      }
      expect(await ledger(z).catch(() => null)).toBeNull();
      // Grenze: psql 15 genügt.
      stellvertreter('psql (PostgreSQL) 15.0');
      const r = await migriere(z, undefined, SKRIPT, { PATH: pfad });
      expect(r.code, ausgabe(r)).toBe(0);
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('gleichzeitige Läufe wenden jede Migration genau einmal an', async () => {
    const z = await neueDb();
    const [a, b] = await Promise.all([migriere(z), migriere(z)]);
    expect(a.code, ausgabe(a)).toBe(0);
    expect(b.code, ausgabe(b)).toBe(0);
    const zeilen = await ledger(z);
    expect(zeilen.map((l) => l.migration_name)).toEqual(migrationen().map((m) => m.name));
  });

  it('Entwicklungs- und Produktions-Bootstrap ergeben dieselben Rechte', async () => {
    const entw = await neueDb();
    const prod = await neueDb();
    const e = await psqlSuper(entw, ['-f', ENTWICKLUNG]);
    expect(e.code, e.stderr).toBe(0);
    const p = await migriere(prod);
    expect(p.code, ausgabe(p)).toBe(0);
    const rechte = async (z: Ziel) => {
      const [zeile] = await abfrage<{ schema: string; db: string }>(
        z.superUrl,
        `SELECT (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS schema,
                (SELECT datacl::text FROM pg_database WHERE datname = current_database()) AS db`,
      );
      return zeile;
    };
    expect(await rechte(prod)).toEqual(await rechte(entw));
  });
});
