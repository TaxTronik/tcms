import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KonfigurationsFehler, ladeKonfiguration } from '../konfiguration';

const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
const A = generateKeyPairSync('ed25519').publicKey;
const T1 = randomBytes(32).toString('base64url');
const T2 = randomBytes(48).toString('base64');
const GUELTIG = {
  TCMS_SERVICE_TOKENS: `${T1},${T2}`,
  TCMS_ACTOR_PUBLIC_KEYS: `kk-2026-10=${spki(A)}`,
  DATABASE_URL: 'postgresql://tcms_app:Zr8fQ2vLx9@db.intern:5432/tcms',
};

function probleme(env: Record<string, string | undefined>): string[] {
  try {
    ladeKonfiguration(env);
  } catch (e) {
    expect(e).toBeInstanceOf(KonfigurationsFehler);
    // Kein Wert darf in der Meldung auftauchen.
    for (const wert of Object.values(env)) {
      if (wert && wert.length >= 8) expect((e as Error).message).not.toContain(wert);
    }
    return (e as KonfigurationsFehler).probleme;
  }
  return [];
}

function envAusDatei(pfad: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const zeile of readFileSync(pfad, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(zeile.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

describe('ladeKonfiguration', () => {
  it('liest eine gültige Konfiguration mit Standardwerten für HOST und PORT', () => {
    const k = ladeKonfiguration(GUELTIG);
    expect(k.dienstTokens).toEqual([T1, T2]);
    expect([...k.akteurSchluessel.keys()]).toEqual(['kk-2026-10']);
    expect(k.host).toBe('0.0.0.0');
    expect(k.port).toBe(3200);
    expect(ladeKonfiguration({ ...GUELTIG, HOST: '127.0.0.1', PORT: '8080' })).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
    });
  });

  it('weist jede fehlende Pflichtvariable ab', () => {
    for (const name of Object.keys(GUELTIG)) {
      const env: Record<string, string> = { ...GUELTIG };
      delete env[name];
      expect(probleme(env).join(), name).toContain(name);
    }
  });

  it('weist sämtliche Platzhalter aus apps/api/.env.example ab', () => {
    const beispiel = envAusDatei(new URL('../../.env.example', import.meta.url).pathname);
    expect(Object.keys(beispiel)).toEqual(
      expect.arrayContaining(['TCMS_SERVICE_TOKENS', 'TCMS_ACTOR_PUBLIC_KEYS', 'DATABASE_URL']),
    );
    expect(probleme(beispiel).length).toBeGreaterThanOrEqual(3);
    for (const name of ['TCMS_SERVICE_TOKENS', 'TCMS_ACTOR_PUBLIC_KEYS', 'DATABASE_URL']) {
      expect(probleme({ ...GUELTIG, [name]: beispiel[name] }).join(), name).toContain(name);
    }
  });

  it('weist Platzhalter ab, die die Längenregel erfüllen (TS-02)', () => {
    for (const platzhalter of [
      'bitte-durch-einen-langen-zufallswert-ersetzen',
      'bitte-durch-einen-zufaelligen-dienst-token-ersetzen',
      'ci-auth-secret-with-at-least-thirty-two-chars',
      'changeme-changeme-changeme-changeme',
      'example-token-example-token-example',
    ]) {
      expect(platzhalter.length).toBeGreaterThanOrEqual(32);
      expect(probleme({ ...GUELTIG, TCMS_SERVICE_TOKENS: `${T1},${platzhalter}` }).join()).toMatch(
        /Platzhalter/,
      );
    }
  });

  it('weist kurze, leere, doppelte, ungültige und einförmige Tokens ab', () => {
    const faelle: [string, RegExp][] = [
      ['a'.repeat(30) + 'B', /kürzer/],
      [`${T1},`, /leer/],
      [`,${T1}`, /leer/],
      [`${T1},${T1}`, /doppelt/],
      [`${T1} ${T1}`, /Zeichen/],
      [`${T1}"`, /Zeichen/],
      [`${T1}=x`, /Zeichen/],
      ['ab'.repeat(20), /verschiedene/],
      ['x'.repeat(513), /länger/],
      ['', /kürzer|leer/],
    ];
    for (const [tokens, muster] of faelle) {
      expect(probleme({ ...GUELTIG, TCMS_SERVICE_TOKENS: tokens }).join(), tokens).toMatch(muster);
    }
  });

  it('weist ungültige Schlüssellisten ab (RSA, leer, doppelt)', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    for (const liste of [`kk-r=${spki(rsa)}`, '', `kk-a=${spki(A)},kk-a=${spki(A)}`, 'kk-a=xyz']) {
      expect(probleme({ ...GUELTIG, TCMS_ACTOR_PUBLIC_KEYS: liste }).join()).toContain(
        'TCMS_ACTOR_PUBLIC_KEYS',
      );
    }
  });

  it('weist ungültige Datenbank-URLs und Platzhalterpasswörter ab', () => {
    for (const url of [
      'mysql://u:p@h/db',
      'postgresql://tcms_app:pw@host',
      'keine url',
      'postgresql://tcms_app:bitte-ersetzen@db/tcms',
      'postgresql://tcms_app:changeme@db/tcms',
      'postgresql://tcms_app:%E0%A4%A@db/tcms',
    ]) {
      expect(probleme({ ...GUELTIG, DATABASE_URL: url }).join(), url).toContain('DATABASE_URL');
    }
  });

  it('weist in Produktion bekannte Standardpasswörter ab, in Entwicklung nicht', () => {
    const dev = 'postgresql://tcms:tcms@localhost:5433/tcms';
    expect(ladeKonfiguration({ ...GUELTIG, DATABASE_URL: dev }).datenbankUrl).toBe(dev);
    for (const url of [dev, 'postgresql://tcms_app@db/tcms', 'postgresql://x:postgres@db/tcms']) {
      expect(
        probleme({ ...GUELTIG, DATABASE_URL: url, NODE_ENV: 'production' }).join(),
        url,
      ).toMatch(/Standardpasswort/);
    }
  });

  it('weist ungültige HOST- und PORT-Werte ab', () => {
    for (const [name, wert] of [
      ['PORT', '0'],
      ['PORT', '65536'],
      ['PORT', '80a'],
      ['PORT', '-1'],
      ['PORT', ''],
      ['HOST', ''],
      ['HOST', 'a b'],
      ['HOST', 'host/pfad'],
    ] as const) {
      expect(probleme({ ...GUELTIG, [name]: wert }).join(), `${name}=${wert}`).toContain(name);
    }
  });
});
