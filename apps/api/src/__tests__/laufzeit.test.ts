// apps/api/scripts/laufzeit.mjs (Laufzeitbaum des Images tcms-api): läuft als
// Programm auch aus einem Pfad mit Leer- und Sonderzeichen bzw. unter Windows
// (vorher: Vergleich mit dem prozentkodierten `URL.pathname`, Skript endete
// stumm mit Exit 0, ohne zu prüfen) und prüft den Baum fail closed.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SKRIPT = fileURLToPath(new URL('../../scripts/laufzeit.mjs', import.meta.url));
const verzeichnisse: string[] = [];

afterEach(() => {
  for (const v of verzeichnisse.splice(0)) rmSync(v, { recursive: true, force: true });
});

/** Kopie des Skripts in einem Verzeichnis mit Leerzeichen und Umlaut. */
function kopie(): { wurzel: string; skript: string } {
  const wurzel = mkdtempSync(join(tmpdir(), 'tcms laufzeit ä-'));
  verzeichnisse.push(wurzel);
  const skript = join(wurzel, 'laufzeit.mjs');
  copyFileSync(SKRIPT, skript);
  return { wurzel, skript };
}

function datei(pfad: string, inhalt = '{}\n') {
  mkdirSync(join(pfad, '..'), { recursive: true });
  writeFileSync(pfad, inhalt);
}

/** Deploy-Baum wie nach `pnpm deploy`, erzeugter Prisma-Client und Bundle. */
function baum(wurzel: string, extra: (nodeModules: string) => void = () => undefined) {
  const nodeModules = join(wurzel, 'deploy', 'node_modules');
  datei(join(nodeModules, 'pg', 'package.json'));
  datei(join(nodeModules, '@tcms', 'db', 'package.json'));
  mkdirSync(join(nodeModules, '.bin'));
  for (const d of ['default.js', 'index.js', 'package.json']) {
    datei(join(wurzel, 'client', d));
  }
  datei(join(wurzel, 'dist', 'externe.json'), '["pg"]\n');
  datei(join(wurzel, 'dist', 'server.mjs'), '\n');
  extra(nodeModules);
  return nodeModules;
}

function lauf(skript: string, wurzel: string, args?: string[]) {
  const r = spawnSync(
    process.execPath,
    [
      skript,
      ...(args ?? [
        join(wurzel, 'deploy'),
        '--prisma-client',
        join(wurzel, 'client'),
        '--bundle',
        join(wurzel, 'dist'),
      ]),
    ],
    { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('laufzeit.mjs als Programm', () => {
  it('läuft auch aus einem Pfad mit Leer- und Sonderzeichen (kein stummer Exit 0)', () => {
    const { wurzel, skript } = kopie();
    const ohne = lauf(skript, wurzel, []);
    expect(ohne.code).toBe(1);
    expect(ohne.stderr).toMatch(/^laufzeit: Aufruf:/);
  });

  it('stellt den Baum fertig (Prisma-Client, ohne @tcms und leeres .bin) und meldet Erfolg', () => {
    const { wurzel, skript } = kopie();
    const nodeModules = baum(wurzel);
    const r = lauf(skript, wurzel);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^laufzeit: Baum geprüft \(1 externe Pakete, keine Werkzeuge\)$/m);
    expect(existsSync(join(nodeModules, '.prisma', 'client', 'default.js'))).toBe(true);
    expect(existsSync(join(nodeModules, '@tcms'))).toBe(false);
    expect(existsSync(join(nodeModules, '.bin'))).toBe(false);
  });

  it('bricht ab bei Werkzeug, .env-Datei oder fehlender externer Abhängigkeit', () => {
    for (const [extra, befund] of [
      [(n: string) => datei(join(n, 'tsx', 'package.json')), /verbotenes Paket: tsx/],
      [
        (n: string) => datei(join(n, 'pg', '.env.production'), 'X=1\n'),
        /Umgebungsdatei: pg\/\.env\.production/,
      ],
      [(n: string) => rmSync(join(n, 'pg'), { recursive: true }), /externe Abhängigkeit fehlt: pg/],
      [(n: string) => datei(join(n, '.bin', 'prisma'), ''), /ausführbares Werkzeug: \.bin\/prisma/],
    ] as const) {
      const { wurzel, skript } = kopie();
      baum(wurzel, extra);
      const r = lauf(skript, wurzel);
      expect(r.code, String(befund)).toBe(1);
      expect(r.stderr).toMatch(befund);
      expect(r.stdout).not.toMatch(/Baum geprüft/);
    }
  });
});
