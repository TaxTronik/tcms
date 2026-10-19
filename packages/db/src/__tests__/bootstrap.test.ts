// Rollen-Bootstrap: eine Quelle für Entwicklung (prisma/init/01_bootstrap.sql)
// und Betrieb (betrieb/bootstrap.sql, Image tcms-migrate). Statisch, ohne
// Datenbank; dass beide dieselben Rechte ergeben, prüft migrate.db.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB = fileURLToPath(new URL('../..', import.meta.url));
const ENTWICKLUNG = join(DB, 'prisma', 'init', '01_bootstrap.sql');
const BETRIEB = join(DB, 'betrieb', 'bootstrap.sql');
const ROLLEN = join(DB, 'prisma', 'init', 'rollen.psql');
const MIGRATE = join(DB, 'betrieb', 'migrate.sh');

const lies = (p: string) => readFileSync(p, 'utf8');
/** Inhalt ohne SQL-Kommentarzeilen. */
const anweisungen = (p: string) =>
  lies(p)
    .split('\n')
    .filter((z) => !z.trimStart().startsWith('--'))
    .join('\n');
/** Ziele der `\ir`-Einbindungen, aufgelöst relativ zur Datei. */
const einbindungen = (p: string) =>
  [...lies(p).matchAll(/^\\ir\s+(\S+)\s*$/gm)].map((m) => resolve(dirname(p), m[1]!));

const ROLLEN_DDL = /\b(CREATE|ALTER|DROP)\s+ROLE\b|\bGRANT\b|\bREVOKE\b|\bPASSWORD\b/i;

describe('Rollen-Bootstrap', () => {
  it('Entwicklung und Betrieb binden genau dieselbe Rollendatei ein', () => {
    expect(einbindungen(ENTWICKLUNG)).toEqual([ROLLEN]);
    expect(einbindungen(BETRIEB)).toEqual([ROLLEN]);
  });

  it('Rollenattribute, Rechte und Passwörter stehen nur in rollen.psql', () => {
    expect(anweisungen(ENTWICKLUNG)).not.toMatch(ROLLEN_DDL);
    expect(anweisungen(BETRIEB)).not.toMatch(ROLLEN_DDL);
    const rollen = anweisungen(ROLLEN);
    expect(rollen).toMatch(
      /ALTER ROLE tcms_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION\s+NOBYPASSRLS INHERIT;/,
    );
    expect(rollen).toMatch(
      /ALTER ROLE tcms_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION\s+NOBYPASSRLS NOINHERIT;/,
    );
  });

  it('der Betrieb liest die Passwörter aus der Umgebung, nie als Literal', () => {
    const b = anweisungen(BETRIEB);
    expect(b).toMatch(/^\\getenv tcms_owner_passwort TCMS_DB_OWNER_PASSWORD$/m);
    expect(b).toMatch(/^\\getenv tcms_app_passwort TCMS_DB_APP_PASSWORD$/m);
    expect(b).not.toMatch(/\\set\s+tcms_(owner|app)_passwort/);
  });

  it('Passwörter nur per format(%L) und \\gexec, nach dem Abschalten von Log und Statistik', () => {
    const zeilen = anweisungen(ROLLEN).split('\n');
    const verwendung = zeilen
      .map((z, i) => ({ z, i }))
      .filter(({ z }) => /:'tcms_(owner|app)_passwort'/.test(z));
    expect(verwendung).toHaveLength(2);
    for (const { z } of verwendung) {
      expect(z).toMatch(
        /^SELECT pg_catalog\.format\('ALTER ROLE tcms_(owner|app) PASSWORD %L', :'tcms_\1_passwort'\) \\gexec$/,
      );
    }
    const ersteVerwendung = Math.min(...verwendung.map((v) => v.i));
    for (const pflicht of [
      "SET LOCAL log_statement = 'none';",
      "SET LOCAL log_min_error_statement = 'panic';",
      "SET LOCAL pg_stat_statements.track = 'none';",
      'SET LOCAL pg_stat_statements.track_utility = off;',
    ]) {
      const i = zeilen.indexOf(pflicht);
      expect(i, pflicht).toBeGreaterThan(-1);
      expect(i, pflicht).toBeLessThan(ersteVerwendung);
    }
    expect(zeilen).toContain('\\set VERBOSITY terse');
  });

  it('der Läufer ruft psql nur ohne Verbindungsangaben in der Kommandozeile auf', () => {
    const aufrufe = lies(MIGRATE)
      .split('\n')
      .filter((z) => /\bpsql\b/.test(z) && !z.trimStart().startsWith('#'));
    const exec = aufrufe.filter((z) => /exec psql/.test(z));
    expect(exec).toEqual(['    exec psql -X -q -v ON_ERROR_STOP=1 "$@"']);
    for (const z of aufrufe.filter((x) => /psql_als (SU|OW)/.test(x))) {
      expect(z).toMatch(/psql_als (SU|OW) -f ("\$(BOOTSTRAP|PRUEFUNG)"|-)( |$)/);
    }
  });
});
