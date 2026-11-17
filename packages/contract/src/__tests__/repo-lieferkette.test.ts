// =============================================================================
// scripts/pruefe-lieferkette.sh: „Neue Abhängigkeiten nur mit exakter Version“
// als Positivliste (Befund 75). Das Skript läuft gegen eine Kopie des Repos mit
// veränderten package.json bzw. pnpm-workspace.yaml; jede Bereichs-, Tag-,
// Alias- und Fremdquellen-Angabe muss scheitern, exakte Versionen und
// `workspace:*` bestehen.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_WURZEL } from './repo-git';

const tmp = mkdtempSync(join(tmpdir(), 'lieferkette-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PAKET = readFileSync(join(REPO_WURZEL, 'package.json'), 'utf8');
const WORKSPACE = readFileSync(join(REPO_WURZEL, 'pnpm-workspace.yaml'), 'utf8');
let n = 0;

type Paket = Record<string, unknown> | string;

/**
 * Kopie mit Wurzel-package.json, Workspace-Datei und Paketen apps/<name>
 * (Standard: ein Paket apps/x); ein Lauf prüft alle Pakete, die Ausgabe nennt
 * jedes abgewiesene einzeln.
 */
function lauf(
  opt: { paket?: string; app?: Paket; apps?: Record<string, Paket>; workspace?: string } = {},
) {
  const w = join(tmp, String(n++));
  mkdirSync(join(w, 'scripts'), { recursive: true });
  copyFileSync(
    join(REPO_WURZEL, 'scripts', 'pruefe-lieferkette.sh'),
    join(w, 'scripts', 'pruefe-lieferkette.sh'),
  );
  writeFileSync(join(w, 'package.json'), opt.paket ?? PAKET);
  writeFileSync(join(w, 'pnpm-workspace.yaml'), opt.workspace ?? WORKSPACE);
  const apps = opt.apps ?? { x: opt.app ?? { name: 'x', dependencies: { zod: '4.6.7' } } };
  for (const [name, app] of Object.entries(apps)) {
    mkdirSync(join(w, 'apps', name), { recursive: true });
    writeFileSync(
      join(w, 'apps', name, 'package.json'),
      typeof app === 'string' ? app : `${JSON.stringify(app, null, 2)}\n`,
    );
  }
  const r = spawnSync('sh', [join(w, 'scripts', 'pruefe-lieferkette.sh')], { encoding: 'utf8' });
  return { code: r.status, ausgabe: `${r.stdout}${r.stderr}` };
}

// Jeder Lauf startet sh mit grep/awk (unter Windows langsam).
describe('scripts/pruefe-lieferkette.sh', { timeout: 180_000 }, () => {
  it('besteht mit dem echten Repo-Stand und exakten Versionen', () => {
    const r = lauf();
    expect(r.code, r.ausgabe).toBe(0);
    const a = lauf({
      app: {
        name: 'x',
        dependencies: {},
        devDependencies: { a: '4.6.7', b: '1.0.0-beta.1', c: 'workspace:*' },
      },
    });
    expect(a.code, a.ausgabe).toBe(0);
  });

  it('weist jede Angabe ohne exakte Version ab, in jedem Abhängigkeitsblock', () => {
    const werte = [
      '4',
      '4.6',
      '4.x',
      '>=4.6.7',
      '<5',
      '4.6.7 - 5.0.0',
      '4 || 5',
      '^4.6.7',
      '~4.6.7',
      '*',
      'latest',
      'next',
      'beta',
      'npm:zod@^4.0.0',
      'npm:zod@4.6.7',
      'workspace:^',
      'catalog:',
      'colinhacks/zod#main',
      'github:colinhacks/zod',
      'ssh://git@host/x.git',
      'https://x.invalid/z.tgz',
      'file:../z',
      '',
      'x',
      '4.6.7 ',
      '4a6b7',
    ];
    const bloecke = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    // Je Wert ein Paket apps/p<i> in jedem Block (Wert i im Block i mod 4 und im Folgeblock).
    const apps = Object.fromEntries(
      werte.map((wert, i) => [
        `p${i}`,
        {
          name: `p${i}`,
          [bloecke[i % 4]!]: { zod: '4.6.7', a: wert },
          [bloecke[(i + 1) % 4]!]: { b: wert },
        },
      ]),
    );
    const r = lauf({ apps });
    expect(r.code).toBe(1);
    werte.forEach((wert, i) => {
      expect(r.ausgabe, JSON.stringify(wert)).toContain(
        `apps/p${i}/package.json: Abhängigkeit ohne exakte Version`,
      );
    });
  });

  it('weist nicht prüfbare Formen ab: Block in einer Zeile, overrides in package.json', () => {
    const r = lauf({ app: '{ "name": "x", "dependencies": { "zod": "^4.0.0" } }\n' });
    expect(r.code).toBe(1);
    for (const feld of ['pnpm', 'overrides', 'resolutions']) {
      const o = lauf({ app: { name: 'x', [feld]: { overrides: { zod: '4.6.7' } } } });
      expect(o.code, feld).toBe(1);
      expect(o.ausgabe).toContain('nur in pnpm-workspace.yaml');
    }
  });

  it('prüft overrides in pnpm-workspace.yaml auf exakte Versionen', () => {
    const mit = (eintrag: string) =>
      lauf({ workspace: WORKSPACE.replace(/^overrides:\n/m, `overrides:\n${eintrag}\n`) });
    for (const ok of [
      "  zod: '4.6.7'",
      '  zod: "4.6.7"',
      '  zod: 4.6.7 # Grund',
      "  'a@<2': '1.2.3'",
    ]) {
      expect(mit(ok).code, ok).toBe(0);
    }
    for (const falsch of [
      "  zod: '^4.6.7'",
      '  zod: 4.x',
      "  zod: 'npm:zod@4.6.7'",
      '  zod: latest',
      '  zod:',
    ]) {
      const r = mit(falsch);
      expect(r.code, falsch).toBe(1);
      expect(r.ausgabe).toContain('overrides in pnpm-workspace.yaml nur mit exakter Version');
    }
    const katalog = lauf({ workspace: `${WORKSPACE}catalog:\n  zod: ^4.0.0\n` });
    expect(katalog.code).toBe(1);
  });

  it('packageManager: genau pnpm@12.14.0, optional mit sha512-Integrität', () => {
    const pm = (wert: string) =>
      lauf({ paket: PAKET.replace('"pnpm@12.14.0"', JSON.stringify(wert)) });
    expect(pm(`pnpm@12.14.0+sha512.${'a1'.repeat(64)}`).code).toBe(0);
    for (const falsch of [
      'pnpm@12.14.1',
      'pnpm@^12.14.0',
      'pnpm@12.14.0+sha512.abc',
      `pnpm@12.14.0+sha1.${'a'.repeat(40)}`,
    ]) {
      expect(pm(falsch).code, falsch).toBe(1);
    }
  });
});
