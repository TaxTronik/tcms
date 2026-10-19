// scripts/simuliere-image.sh mit eigenem Cluster (tcms-s9, scripts/sim-datenbank.sh):
// genau eine Datenbankwahl, Prüfung vor jeder Aktion, eigene Datenbank mit
// starken Einmalpasswörtern, die nie ausgegeben werden, Löschen auch nach einem
// Fehler, auf Wunsch Entwicklungspasswörter danach.
//
// Die Datenbankfälle setzen clusterweite Rollenpasswörter und laufen nur auf
// Anforderung gegen einen eigenen Test-Cluster (wie die Läufertests):
//
//   TCMS_SIM_TESTS=1 TCMS_SIM_PGHOST=127.0.0.1 TCMS_SIM_PGPORT=55433 TCMS_SIM_PGUSER=postgres \
//     pnpm --filter @tcms/api exec vitest run src/__tests__/simulation.test.ts
//
// Danach gelten dort die Entwicklungspasswörter (tcms_owner/tcms_owner, tcms_app/tcms_app).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const WURZEL = fileURLToPath(new URL('../../../../', import.meta.url));
const SKRIPT = join(WURZEL, 'scripts/simuliere-image.sh');
const BIBLIOTHEK = join(WURZEL, 'scripts/sim-datenbank.sh');
const tmp = mkdtempSync(join(tmpdir(), 'sim-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PFAD = process.env['PATH'] ?? '';
const SIM = ['TCMS_SIM_PGHOST', 'TCMS_SIM_PGPORT', 'TCMS_SIM_PGUSER', 'TCMS_SIM_PGPASSWORD'];
const simUmgebung = Object.fromEntries(
  SIM.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]!]),
);
const DB_AKTIV =
  process.env['TCMS_SIM_TESTS'] === '1' &&
  ['TCMS_SIM_PGHOST', 'TCMS_SIM_PGPORT', 'TCMS_SIM_PGUSER'].every((n) => process.env[n]);

function skript(env: Record<string, string>, arbeit = join(tmp, `a-${Math.random()}`)) {
  const r = spawnSync('bash', [SKRIPT, arbeit], {
    encoding: 'utf8',
    env: { PATH: PFAD, HOME: tmp, ...env },
  });
  return { code: r.status, ausgabe: `${r.stdout}${r.stderr}`, arbeit };
}

/** Bash mit eingebundener Bibliothek; Werte nur über die Umgebung. */
function harness(text: string, env: Record<string, string> = {}) {
  const r = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "$SIM_WURZEL/scripts/sim-datenbank.sh"\n${text}`],
    { encoding: 'utf8', env: { PATH: PFAD, HOME: tmp, SIM_WURZEL: WURZEL, ...env } },
  );
  return { code: r.status, ausgabe: `${r.stdout}${r.stderr}` };
}

/**
 * Kein Wert der Form eines Einmalpassworts (32 Bytes base64url: genau 43 Zeichen, praktisch
 * immer mit Großbuchstaben – Migrationsnamen haben keine) in einer Ausgabe.
 */
const EINMALPASSWORT =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{0,42}[A-Z])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

/** Prüft ein Passwort gegen den SCRAM-Verifier aus pg_authid (Cluster mit trust prüft nichts). */
const SCRAM = `
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
const m = /^SCRAM-SHA-256\\$(\\d+):([^$]+)\\$([^:]+):(.+)$/.exec(process.env.VERIFIER ?? '');
if (!m) { console.log('kein SCRAM'); process.exit(0); }
const salted = pbkdf2Sync(process.env.KANDIDAT ?? '', Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
const clientKey = createHmac('sha256', salted).update('Client Key').digest();
const storedKey = createHash('sha256').update(clientKey).digest('base64');
console.log(storedKey === m[3] ? 'passt' : 'passt nicht');
`;

describe('simuliere-image.sh: Wahl der Datenbank', () => {
  it('Syntax beider Skripte', () => {
    for (const d of [SKRIPT, BIBLIOTHEK]) {
      expect(spawnSync('bash', ['-n', d]).status, d).toBe(0);
    }
  });

  it('verlangt genau eine Wahl und prüft sie, bevor etwas gebaut oder angelegt wird', () => {
    const sim = { TCMS_SIM_PGHOST: '127.0.0.1', TCMS_SIM_PGPORT: '1', TCMS_SIM_PGUSER: 'postgres' };
    for (const [env, muster] of [
      [{}, /DATABASE_URL \(tcms_app\) oder TCMS_SIM_PG\* fehlt/],
      [{ ...sim, DATABASE_URL: 'postgresql://tcms_app:x@h/db' }, /nicht beides/],
      [{ TCMS_SIM_PGHOST: '127.0.0.1' }, /sind Pflicht/],
      [{ ...sim, TCMS_SIM_PGPORT: '70000' }, /TCMS_SIM_PGPORT ungültig/],
      [{ ...sim, TCMS_SIM_PGHOST: 'h;rm -rf' }, /TCMS_SIM_PGHOST ungültig/],
      [{ ...sim, TCMS_SIM_PGUSER: 'a b' }, /TCMS_SIM_PGUSER ungültig/],
      [{ ...sim, TCMS_SIM_PGDATABASE: 'x"y' }, /TCMS_SIM_PGDATABASE ungültig/],
      [{ ...sim, TCMS_SIM_PGPASSWORD: 'päss' }, /nur druckbare ASCII/],
      [{ ...sim, TCMS_SIM_PASSWOERTER_DANACH: 'ja' }, /PASSWOERTER_DANACH/],
    ] as const) {
      const r = skript(env as Record<string, string>);
      expect(r.code, JSON.stringify(env)).toBe(64);
      expect(r.ausgabe).toMatch(muster);
      // Nichts angelegt: kein Arbeitsverzeichnis, kein Build, keine Datenbank.
      expect(existsSync(r.arbeit)).toBe(false);
      expect(r.ausgabe).not.toMatch(/== /);
    }
  });

  it('kodiert das Superuser-Passwort für tcms-migrate vollständig (nur Builtins)', () => {
    const r = harness('sim_kodiere "$X"', { X: 'a:b@c/d%e f?g#h' });
    expect(r.ausgabe).toBe('a%3Ab%40c%2Fd%25e%20f%3Fg%23h');
  });
});

describe.skipIf(!DB_AKTIV)('simuliere-image.sh: eigene Datenbank (Test-Cluster)', () => {
  const env = { ...simUmgebung, TCMS_SIM_PASSWOERTER_DANACH: 'entwicklung' };
  const ALS_APP =
    'PGHOST="$TCMS_SIM_PGHOST" PGPORT="$TCMS_SIM_PGPORT" PGUSER=tcms_app PGPASSWORD="$SIM_APP_PW" ' +
    'PGDATABASE="$db" PGPASSFILE=/dev/null/x psql -X -Atq';

  it('legt an, setzt starke Einmalpasswörter, gibt sie nie aus, löscht und stellt wieder her', () => {
    const scram = join(tmp, 'scram.mjs');
    writeFileSync(scram, SCRAM);
    const r = harness(
      `
      pw() { KANDIDAT="$2" VERIFIER="$(sim_su_psql -Atc "select rolpassword from pg_authid where rolname = '$1'")" node "$SCRAM"; }
      ohne() { local t; t=$(<"$1"); [[ $t != *"$2"* && $t != *"$3"* ]] && echo ja || echo NEIN; }
      sim_db_pruefen
      sim_db_anlegen >"$T/anlegen.log" 2>&1
      db=$SIM_DB
      echo "name ok: $([[ $db =~ ^tcms_sim_[0-9a-f]{12}$ ]] && echo ja)"
      echo "ausgabe ohne passwort: $(ohne "$T/anlegen.log" "$SIM_APP_PW" "$SIM_OWNER_PW")"
      echo "app einmal: $(pw tcms_app "$SIM_APP_PW")"
      echo "owner einmal: $(pw tcms_owner "$SIM_OWNER_PW")"
      echo "app entwicklung waehrend: $(pw tcms_app tcms_app)"
      echo "app: $(${ALS_APP} -c "select current_user || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = current_user")"
      [[ $SIM_DB_URL == "postgresql://tcms_app:$SIM_APP_PW@$TCMS_SIM_PGHOST:$TCMS_SIM_PGPORT/$db" ]] && echo 'url: ok'
      echo "tabellen: $(${ALS_APP} -c "select count(*) > 10 from pg_tables where schemaname = 'public'")"
      app=$SIM_APP_PW owner=$SIM_OWNER_PW
      sim_db_entfernen >"$T/entfernen.log" 2>&1
      echo "ausgabe entfernen ohne passwort: $(ohne "$T/entfernen.log" "$app" "$owner")"
      echo "geleert: [$SIM_DB$SIM_APP_PW$SIM_OWNER_PW$SIM_DB_URL]"
      echo "vorhanden: $(sim_su_psql -Atc "select count(*) from pg_database where datname = '$db'")"
      echo "app entwicklung danach: $(pw tcms_app tcms_app)"
      echo "owner entwicklung danach: $(pw tcms_owner tcms_owner)"
      `,
      { ...env, SCRAM: scram, T: tmp },
    );
    expect(r.code, r.ausgabe.replace(/[A-Za-z0-9_-]{43}/g, '<…>')).toBe(0);
    expect(r.ausgabe).not.toMatch(EINMALPASSWORT);
    expect(r.ausgabe.trim().split('\n')).toEqual([
      'name ok: ja',
      'ausgabe ohne passwort: ja',
      'app einmal: passt',
      'owner einmal: passt',
      'app entwicklung waehrend: passt nicht',
      'app: tcms_app:false:false',
      'url: ok',
      'tabellen: t',
      'ausgabe entfernen ohne passwort: ja',
      'geleert: []',
      'vorhanden: 0',
      'app entwicklung danach: passt',
      'owner entwicklung danach: passt',
    ]);
  });

  it('löscht die Datenbank auch, wenn das Skript nach dem Anlegen scheitert', () => {
    // Ein `pnpm`, das sofort scheitert: Der Build bricht nach dem Anlegen ab.
    const bin = join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 3\n');
    chmodSync(join(bin, 'pnpm'), 0o755);
    const arbeit = join(tmp, 'fehlschlag');
    const r = spawnSync('bash', [SKRIPT, arbeit], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${PFAD}`, HOME: tmp, ...env },
    });
    const ausgabe = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(ausgabe).not.toMatch(EINMALPASSWORT);
    const db = /Datenbank (tcms_sim_[0-9a-f]{12}) auf/.exec(ausgabe)?.[1];
    expect(db, ausgabe).toBeDefined();
    expect(ausgabe).toContain(`Datenbank ${db} gelöscht`);
    expect(ausgabe).toContain(
      'Entwicklungspasswörter von tcms_owner und tcms_app wiederhergestellt',
    );
    const n = harness(
      `sim_su_psql -Atc "select count(*) from pg_database where datname = '${db}'"`,
      env,
    );
    expect(n.ausgabe.trim()).toBe('0');
  });
});
