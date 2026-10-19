// scripts/lokale-env.mjs (`pnpm env:lokal`, tcms-s9): legt die lokale `.env`
// aus `.env.example` an und erzeugt SESSION_SECRET und TCMS_CODE_SCHLUESSEL –
// gültig für die Startprüfung des Dienstes, Modus 0600, nie in der Ausgabe,
// nie versioniert, vorhandene gültige Werte unverändert.

import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ladeKonfiguration } from '../konfiguration';

const SKRIPT = fileURLToPath(new URL('../../../../scripts/lokale-env.mjs', import.meta.url));
const BEISPIEL = fileURLToPath(new URL('../../../../.env.example', import.meta.url));
const verzeichnisse: string[] = [];

/** Leerer git-Arbeitsbaum mit `.env.example` des Repos und `.gitignore` (`.env`). */
function arbeitsbaum(gitignore = '.env\n'): string {
  const w = mkdtempSync(join(tmpdir(), 'lokale-env-'));
  verzeichnisse.push(w);
  copyFileSync(BEISPIEL, join(w, '.env.example'));
  if (gitignore) writeFileSync(join(w, '.gitignore'), gitignore);
  execFileSync('git', ['-C', w, 'init', '-q'], { stdio: 'pipe' });
  return w;
}

function lauf(w: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SKRIPT, '--wurzel', w], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { code: r.status, ausgabe: `${r.stdout}${r.stderr}` };
}

function werte(w: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const z of readFileSync(join(w, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(z);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const modus = (p: string) => statSync(p).mode & 0o777;

afterEach(() => {
  for (const v of verzeichnisse.splice(0)) rmSync(v, { recursive: true, force: true });
});

describe('pnpm env:lokal', () => {
  it('legt .env mit Modus 0600 an; der Code-Schlüssel besteht die Startprüfung des Dienstes', () => {
    const w = arbeitsbaum();
    const r = lauf(w);
    expect(r.code, r.ausgabe).toBe(0);
    expect(modus(join(w, '.env'))).toBe(0o600);
    const e = werte(w);
    expect(e['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/);
    expect(e['TCMS_CODE_SCHLUESSEL']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nie in der Ausgabe.
    for (const name of ['SESSION_SECRET', 'TCMS_CODE_SCHLUESSEL']) {
      expect(r.ausgabe).not.toContain(e[name]!);
      expect(r.ausgabe).not.toContain(e[name]!.slice(0, 12));
    }
    // Startprüfung des Dienstes: nur die übrigen Platzhalter durch gültige Werte ersetzt.
    const spki = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const k = ladeKonfiguration({
      ...e,
      TCMS_SERVICE_TOKENS: randomBytes(32).toString('base64url'),
      TCMS_ACTOR_PUBLIC_KEYS: `kk-lokal=${spki}`,
    });
    expect(k.codeSchluessel).toEqual([e['TCMS_CODE_SCHLUESSEL']]);
    // Alles andere aus der Vorlage bleibt Zeile für Zeile erhalten.
    const vorlage = readFileSync(BEISPIEL, 'utf8').split('\n');
    const neu = readFileSync(join(w, '.env'), 'utf8').split('\n');
    expect(neu.length).toBe(vorlage.length);
    const anders = neu.filter((z, i) => z !== vorlage[i]).map((z) => z.split('=')[0]);
    expect(anders).toEqual(['SESSION_SECRET', 'TCMS_CODE_SCHLUESSEL']);
  });

  it('ist idempotent: vorhandene gültige Werte bleiben, nur Fehlendes und Platzhalter werden erzeugt', () => {
    const w = arbeitsbaum();
    expect(lauf(w).code).toBe(0);
    const vorher = readFileSync(join(w, '.env'), 'utf8');
    const r = lauf(w);
    expect(r.code, r.ausgabe).toBe(0);
    expect(r.ausgabe).toMatch(/TCMS_CODE_SCHLUESSEL: vorhanden, unverändert/);
    expect(readFileSync(join(w, '.env'), 'utf8')).toBe(vorher);
    // Nur SESSION_SECRET fehlt: der Code-Schlüssel bleibt, offene Codes gelten weiter.
    const code = werte(w)['TCMS_CODE_SCHLUESSEL']!;
    writeFileSync(
      join(w, '.env'),
      vorher.replace(/^SESSION_SECRET=.*$/m, 'SESSION_SECRET=').replace(/\n$/, ''),
    );
    chmodSync(join(w, '.env'), 0o644);
    expect(lauf(w).code).toBe(0);
    expect(werte(w)['TCMS_CODE_SCHLUESSEL']).toBe(code);
    expect(werte(w)['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/);
    expect(modus(join(w, '.env'))).toBe(0o600);
    // Ohne Änderung wird nur der Modus korrigiert.
    chmodSync(join(w, '.env'), 0o644);
    const m = lauf(w);
    expect(m.ausgabe).toMatch(/Modus auf 0600 gesetzt/);
    expect(modus(join(w, '.env'))).toBe(0o600);
  });

  it('ersetzt Platzhalter, ergänzt fehlende Zeilen und behält einen eigenen gültigen Schlüssel', () => {
    const w = arbeitsbaum();
    const eigen = randomBytes(32).toString('base64');
    writeFileSync(join(w, '.env'), `TCMS_CODE_SCHLUESSEL=${eigen}\nANDERES=1\n`);
    expect(lauf(w).code).toBe(0);
    expect(werte(w)).toMatchObject({ TCMS_CODE_SCHLUESSEL: eigen, ANDERES: '1' });
    expect(werte(w)['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(
      join(w, '.env'),
      'SESSION_SECRET=bitte-durch-einen-langen-zufallswert-ersetzen\n' +
        'TCMS_CODE_SCHLUESSEL=bitte-durch-einen-zufaelligen-code-schluessel-ersetzen\n',
    );
    expect(lauf(w).code).toBe(0);
    expect(werte(w)['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/);
    expect(werte(w)['TCMS_CODE_SCHLUESSEL']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('überschreibt keinen ungültigen eigenen Wert und nennt ihn nicht (Abbruch, Datei unverändert)', () => {
    const w = arbeitsbaum();
    const token = randomBytes(32).toString('base64url');
    for (const inhalt of [
      'TCMS_CODE_SCHLUESSEL=zu-kurz-und-selbst-gesetzt\n',
      `TCMS_SERVICE_TOKENS=${token}\nTCMS_CODE_SCHLUESSEL=${token}\n`,
      `TCMS_CODE_SCHLUESSEL=${token}\nTCMS_CODE_SCHLUESSEL=${token}x\n`,
      'SESSION_SECRET=abababababababababababababababababab\n',
    ]) {
      writeFileSync(join(w, '.env'), inhalt);
      const r = lauf(w);
      expect(r.code, inhalt.slice(0, 20)).toBe(1);
      expect(readFileSync(join(w, '.env'), 'utf8')).toBe(inhalt);
      expect(r.ausgabe).not.toContain(token);
      expect(r.ausgabe).not.toContain('zu-kurz');
    }
  });

  it('nie committen: Abbruch, wenn git .env nicht ignoriert oder versioniert', () => {
    const offen = arbeitsbaum('');
    expect(lauf(offen).code).toBe(1);
    expect(() => statSync(join(offen, '.env'))).toThrow();
    const versioniert = arbeitsbaum();
    writeFileSync(join(versioniert, '.env'), 'ANDERES=1\n');
    execFileSync('git', ['-C', versioniert, 'add', '-f', '.env'], { stdio: 'pipe' });
    const r = lauf(versioniert);
    expect(r.code).toBe(1);
    expect(r.ausgabe).toMatch(/git-Index/);
    expect(readFileSync(join(versioniert, '.env'), 'utf8')).toBe('ANDERES=1\n');
  });

  it('schreibt nie über einen Symlink und nie mit NODE_ENV=production', () => {
    const w = arbeitsbaum();
    const fremd = join(w, 'fremd.txt');
    writeFileSync(fremd, 'unberuehrt\n');
    symlinkSync(fremd, join(w, '.env'));
    expect(lauf(w).code).toBe(1);
    expect(readFileSync(fremd, 'utf8')).toBe('unberuehrt\n');
    const p = arbeitsbaum();
    expect(lauf(p, { NODE_ENV: 'production' }).code).toBe(1);
    expect(() => statSync(join(p, '.env'))).toThrow();
  });
});
