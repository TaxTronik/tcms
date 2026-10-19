// Die Demo läuft nach `pnpm env:lokal` ohne Handarbeit (tcms-s9): Die erzeugten
// Werte bestehen die Prüfungen der Demo (Sitzung TS-02, Code-Schlüssel H5), und
// ein Code-Vorgang rechnet mit dem Schlüssel aus der Datei.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { demoCodeSchluessel, pruefeCodeSchluesselListe } from './code-schluessel';
import { pruefeSessionSecret } from './sitzung-regeln';

const SKRIPT = fileURLToPath(new URL('../../../../scripts/lokale-env.mjs', import.meta.url));
const BEISPIEL = fileURLToPath(new URL('../../../../.env.example', import.meta.url));

describe('Demo nach pnpm env:lokal', () => {
  const w = mkdtempSync(join(tmpdir(), 'lokale-env-demo-'));
  afterAll(() => rmSync(w, { recursive: true, force: true }));

  it('nimmt SESSION_SECRET und TCMS_CODE_SCHLUESSEL aus der erzeugten .env an', () => {
    copyFileSync(BEISPIEL, join(w, '.env.example'));
    writeFileSync(join(w, '.gitignore'), '.env\n');
    execFileSync('git', ['-C', w, 'init', '-q'], { stdio: 'pipe' });
    const r = spawnSync(process.execPath, [SKRIPT, '--wurzel', w], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test' },
    });
    expect(r.status, r.stderr).toBe(0);
    const env: Record<string, string> = {};
    for (const z of readFileSync(join(w, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(z);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(pruefeSessionSecret(env['SESSION_SECRET'])).toBe(env['SESSION_SECRET']);
    expect(pruefeCodeSchluesselListe(env['TCMS_CODE_SCHLUESSEL'])).toEqual([
      env['TCMS_CODE_SCHLUESSEL'],
    ]);
    const bund = demoCodeSchluessel(() => env['TCMS_CODE_SCHLUESSEL']);
    expect(bund.hmac(bund.aktuelleId, 'freigabe:123456')).toMatch(/^[0-9a-f]{64}$/);
    // Die Vorlage selbst bleibt ungültig (fail closed ohne pnpm env:lokal).
    const vorlage = readFileSync(BEISPIEL, 'utf8');
    const platzhalter = /^TCMS_CODE_SCHLUESSEL=(.*)$/m.exec(vorlage)![1];
    expect(() => pruefeCodeSchluesselListe(platzhalter)).toThrow(/Platzhalter/);
    expect(() => pruefeSessionSecret(/^SESSION_SECRET=(.*)$/m.exec(vorlage)![1])).toThrow();
  });
});
