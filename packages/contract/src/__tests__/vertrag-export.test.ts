// scripts/vertrag-export.mjs: Format wie VENDOR.json der kanzleikonsole
// (Regeln aus deren scripts/tcms/vendor-lib.mjs, hier nachgebildet), nur bei
// sauberem Baum, ohne Testdateien, SHA-256 je Datei, sortiert.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SKRIPT = fileURLToPath(new URL('../../../../scripts/vertrag-export.mjs', import.meta.url));
const verzeichnisse: string[] = [];

function repo(dateien: Record<string, string>): string {
  const wurzel = mkdtempSync(join(tmpdir(), 'vertrag-export-'));
  verzeichnisse.push(wurzel);
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    mkdirSync(dirname(join(wurzel, pfad)), { recursive: true });
    writeFileSync(join(wurzel, pfad), inhalt);
  }
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', wurzel, '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'x');
  return wurzel;
}

function exportiere(wurzel: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [SKRIPT, '--wurzel', wurzel, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Regeln von pruefeVendorDaten (kanzleikonsole, scripts/tcms/vendor-lib.mjs). */
function vendorBefunde(daten: Record<string, unknown>): string[] {
  const befunde: string[] = [];
  if (Object.keys(daten).sort().join(',') !== 'beschreibung,dateien,quelle') befunde.push('felder');
  const q = daten['quelle'] as Record<string, string>;
  if (Object.keys(q).sort().join(',') !== 'commit,pfad,repo') befunde.push('quelle');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(q['repo']!)) befunde.push('repo');
  if (q['pfad'] !== 'packages/contract/src') befunde.push('pfad');
  if (!/^[0-9a-f]{40}$/.test(q['commit']!)) befunde.push('commit');
  let vorher = '';
  for (const e of daten['dateien'] as Record<string, string>[]) {
    if (Object.keys(e).sort().join(',') !== 'pfad,sha256') befunde.push('eintrag');
    if (!/^[0-9a-f]{64}$/.test(e['sha256']!)) befunde.push('sha256');
    if (e['pfad']! <= vorher) befunde.push('sortierung');
    vorher = e['pfad']!;
  }
  return befunde;
}

afterEach(() => {
  for (const d of verzeichnisse.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DATEIEN = {
  'packages/contract/src/index.ts': "export * from './akteur';\n",
  'packages/contract/src/akteur.ts': 'export const A = 1;\n',
  'packages/contract/src/bereiche/b.ts': 'export const B = 2;\n',
  'packages/contract/src/bereiche/b.test.ts': 'test\n',
  'packages/contract/src/__tests__/x.ts': 'test\n',
  'packages/contract/src/c.spec.mjs': 'test\n',
  'README.md': 'x\n',
};

describe('vertrag-export.mjs', () => {
  it('gibt Commit und SHA-256 je Vertragsdatei im VENDOR.json-Format aus', () => {
    const wurzel = repo(DATEIEN);
    const r = exportiere(wurzel);
    expect(r.code, r.stderr).toBe(0);
    const daten = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(vendorBefunde(daten)).toEqual([]);
    const commit = execFileSync('git', ['-C', wurzel, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect(daten['quelle']).toEqual({
      repo: 'tcms',
      pfad: 'packages/contract/src',
      commit: commit.trim(),
    });
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(daten['dateien']).toEqual([
      { pfad: 'akteur.ts', sha256: sha(DATEIEN['packages/contract/src/akteur.ts']) },
      { pfad: 'bereiche/b.ts', sha256: sha(DATEIEN['packages/contract/src/bereiche/b.ts']) },
      { pfad: 'index.ts', sha256: sha(DATEIEN['packages/contract/src/index.ts']) },
    ]);
    expect(String(daten['beschreibung'])).toMatch(/^Exakte Kopie von packages\/contract\/src/);
    expect(r.stdout.endsWith('}\n')).toBe(true);
  });

  it('verweigert bei geänderten, vorgemerkten oder nicht versionierten Dateien', () => {
    const wurzel = repo(DATEIEN);
    writeFileSync(join(wurzel, 'neu.txt'), 'x');
    expect(exportiere(wurzel).code).toBe(1);
    rmSync(join(wurzel, 'neu.txt'));
    writeFileSync(join(wurzel, 'packages/contract/src/akteur.ts'), 'export const A = 2;\n');
    const r = exportiere(wurzel);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ungesicherte Änderungen/);
    expect(r.stdout).toBe('');
  });

  it('nimmt --repo an und weist unzulässige Argumente ab', () => {
    const wurzel = repo(DATEIEN);
    const r = exportiere(wurzel, '--repo', 'tcms-intern');
    expect((JSON.parse(r.stdout) as { quelle: { repo: string } }).quelle.repo).toBe('tcms-intern');
    expect(exportiere(wurzel, '--repo', 'a b').code).toBe(1);
    expect(exportiere(wurzel, '--unbekannt', 'x').code).toBe(1);
  });
});
