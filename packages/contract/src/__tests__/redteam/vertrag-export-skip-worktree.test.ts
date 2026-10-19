// =============================================================================
// Red-Team (Angreifermodell F, Vertragsexport). Befund RT2-T-02.
//
// scripts/vertrag-export.mjs soll zu einem Commit genau den Inhalt melden, der
// in diesem Commit steht ("Exakte Kopie … Der Commit im Ergebnis soll den Stand
// exakt reproduzieren"). Die einzige Absicherung dafür ist
// `git status --porcelain`; den Inhalt liest das Skript danach aber aus dem
// ARBEITSBAUM (`readFileSync(join(wurzel, QUELL_PFAD, pfad))`), nicht aus dem
// Git-Blob.
//
// `git update-index --skip-worktree` (ebenso `--assume-unchanged`) weist Git an,
// Arbeitsbaum-Änderungen einer verfolgten Datei zu ignorieren: `git status`
// bleibt leer, obwohl der Arbeitsbaum vom committeten Blob abweicht. Das Skript
// meldet dann einen sauberen HEAD-Commit zusammen mit einer SHA-256, die zu
// einem ANDEREN Inhalt gehört als dem, der in diesem Commit steht. Die
// kanzleikonsole schreibt diese (commit, sha256)-Paare in VENDOR.json und
// vertraut ihnen – so lässt sich abweichender Vertragscode einschleusen, ohne
// dass der gemeldete Commit ihn enthält.
//
// Der Test ist rot, solange das Skript den Arbeitsbaum hasht (oder die
// skip-worktree-/assume-unchanged-Abweichung nicht erkennt), und grün, sobald es
// den Git-Blob des gemeldeten Commits hasht bzw. die Abweichung ablehnt.
// =============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SKRIPT = fileURLToPath(new URL('../../../../../scripts/vertrag-export.mjs', import.meta.url));
const verzeichnisse: string[] = [];

function git(wurzel: string, ...a: string[]): string {
  return execFileSync('git', ['-C', wurzel, '-c', 'core.hooksPath=/dev/null', ...a], {
    encoding: 'utf8',
  });
}

function repo(dateien: Record<string, string>): string {
  const wurzel = mkdtempSync(join(tmpdir(), 'rt2-vertrag-'));
  verzeichnisse.push(wurzel);
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    mkdirSync(dirname(join(wurzel, pfad)), { recursive: true });
    writeFileSync(join(wurzel, pfad), inhalt);
  }
  git(wurzel, 'init', '-q');
  git(wurzel, 'add', '-A');
  git(wurzel, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'x');
  return wurzel;
}

function exportiere(wurzel: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SKRIPT, '--wurzel', wurzel], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** SHA-256 des committeten Blobs einer verfolgten Datei (der wahre Stand des Commits). */
function blobSha256(wurzel: string, pfad: string): string {
  const roh = execFileSync(
    'git',
    ['-C', wurzel, 'cat-file', 'blob', `HEAD:${pfad}`],
    { encoding: 'buffer' },
  );
  return execFileSync('sha256sum', [], { input: roh, encoding: 'utf8' }).slice(0, 64);
}

afterEach(() => {
  for (const d of verzeichnisse.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DATEI = 'packages/contract/src/index.ts';
const ECHT = 'export const vertrag = 1;\n';
const EINGESCHLEUST = 'export const vertrag = 1; /* nicht committet, eingeschleust */\n';

describe('vertrag-export.mjs – Arbeitsbaum vs. Git-Blob (RT2-T-02)', () => {
  for (const flagge of ['--skip-worktree', '--assume-unchanged'] as const) {
    it(`meldet den committeten Blob, nicht abweichenden Arbeitsbaum (${flagge})`, () => {
      const wurzel = repo({ [DATEI]: ECHT, 'README.md': 'x\n' });
      const relativ = 'index.ts';

      // Git soll Arbeitsbaum-Änderungen dieser verfolgten Datei ignorieren …
      git(wurzel, 'update-index', flagge, DATEI);
      // … und dann wird der Arbeitsbaum-Inhalt ausgetauscht (aber nicht committet).
      writeFileSync(join(wurzel, DATEI), EINGESCHLEUST);

      // Voraussetzung des Angriffs: `git status` sieht die Abweichung nicht.
      expect(git(wurzel, 'status', '--porcelain=v1', '--untracked-files=all').trim()).toBe('');

      const r = exportiere(wurzel);

      if (r.code !== 0) {
        // Zulässige sichere Reaktion: Abweichung erkannt und abgelehnt.
        expect(r.stdout).toBe('');
        return;
      }

      const daten = JSON.parse(r.stdout) as {
        quelle: { commit: string };
        dateien: { pfad: string; sha256: string }[];
      };
      const eintrag = daten.dateien.find((d) => d.pfad === relativ);
      expect(eintrag, 'Eintrag für index.ts fehlt').toBeDefined();

      // Der gemeldete Commit ist HEAD; die gemeldete SHA-256 muss zu dem Inhalt
      // gehören, der in diesem Commit steht (dem Blob) – nicht zum Arbeitsbaum.
      const commit = git(wurzel, 'rev-parse', 'HEAD').trim();
      expect(daten.quelle.commit).toBe(commit);
      expect(eintrag!.sha256).toBe(blobSha256(wurzel, DATEI));
    });
  }
});
