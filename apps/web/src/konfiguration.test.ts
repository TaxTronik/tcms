import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PORTAL_MAX_ANLAGE_BYTES, PORTAL_MAX_ANLAGEN } from '@tcms/contract';
import nextConfig, { BODY_LIMIT, csp, DOWNLOAD_CSP } from '../next.config.mjs';
import { MAX_DATEI_BYTES } from './components/durchfuehrung/werte';
import { DOWNLOAD_KOPF } from './server/dateien';
import { ANLAGEN_GRENZEN } from './server/ereignisse-daten';

// Konfiguration der Demo: Bindung nur an 127.0.0.1 (passwortlose Anmeldung,
// Befund 21), Sicherheitskopfzeilen und CSP (Befund 122), Body-Limit der Server
// Actions passend zu den Dateigrenzen (Befund 72).

const paket = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('Bindung der Demo', () => {
  it.each(['dev', 'start'])('`%s` lauscht nur auf 127.0.0.1', (skript) => {
    const befehl = paket.scripts[skript] ?? '';
    expect(befehl).toMatch(/^next (dev|start) /);
    expect(befehl.split(/\s+/)).toEqual(expect.arrayContaining(['--hostname', '127.0.0.1']));
    expect(befehl).not.toMatch(/0\.0\.0\.0|::|-H\b/);
  });
});

describe('Sicherheitskopfzeilen', () => {
  it('gelten für jeden Pfad', async () => {
    const regeln = await nextConfig.headers!();
    const [regel] = regeln;
    expect(regel!.source).toBe('/:pfad*');
    const kopf = Object.fromEntries(regel!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(kopf).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
    expect(kopf['content-security-policy']).toBe(csp(true));
  });

  it('Download-Routen: die Sandbox-CSP überschreibt die Seiten-CSP (letzte Regel gilt)', async () => {
    const regeln = await nextConfig.headers!();
    const downloads = regeln.slice(1);
    expect(downloads.map((r) => r.source).sort()).toEqual([
      '/api/nachweise/:id',
      '/staff/clients/:id/tcms/ereignisse/anlage',
    ]);
    for (const r of downloads)
      expect(r.headers).toEqual([{ key: 'Content-Security-Policy', value: DOWNLOAD_CSP }]);
    expect(DOWNLOAD_CSP).toBe(DOWNLOAD_KOPF['Content-Security-Policy']);
    // Die Routen gibt es unter genau diesen Pfaden.
    for (const datei of [
      'api/nachweise/[id]/route.ts',
      'staff/clients/[id]/tcms/ereignisse/anlage/route.ts',
    ])
      expect(readFileSync(new URL(`./app/${datei}`, import.meta.url), 'utf8')).toMatch(
        /downloadAntwort/,
      );
  });

  it.each([true, false])(
    'CSP (Entwicklung: %s) schränkt Quellen, Plugins, Base, Formulare und Einbetten ein',
    (entw) => {
      const d = Object.fromEntries(
        csp(entw)
          .split('; ')
          .map((teil) => {
            const [name, ...werte] = teil.split(' ');
            return [name!, werte];
          }),
      );
      expect(d['default-src']).toEqual(["'self'"]);
      expect(d['object-src']).toEqual(["'none'"]);
      expect(d['base-uri']).toEqual(["'self'"]);
      expect(d['form-action']).toEqual(["'self'"]);
      expect(d['frame-ancestors']).toEqual(["'none'"]);
      expect(d['connect-src']).toEqual(["'self'"]);
      // Keine fremden Hosts und keine Schemata außer data:/blob: für Bilder und Schriften.
      for (const werte of Object.values(d))
        for (const w of werte)
          expect(w).toMatch(/^('self'|'none'|'unsafe-inline'|'unsafe-eval'|data:|blob:)$/);
      // 'unsafe-eval' nur für `next dev`.
      expect(d['script-src']!.includes("'unsafe-eval'")).toBe(entw);
    },
  );
});

describe('Body-Limit der Server Actions und Dateigrenzen', () => {
  const bytes = (limit: string) => {
    const m = /^(\d+)mb$/.exec(limit);
    if (!m) throw new Error(`Unbekanntes Format: ${limit}`);
    return Number(m[1]) * 1024 * 1024;
  };

  it('das Limit der Konfiguration ist das exportierte', () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(BODY_LIMIT);
  });

  it('jeder zugesagte Upload passt mit Formularfeldern in das Limit', () => {
    const limit = bytes(BODY_LIMIT);
    // Mindestens 512 KiB Raum für Felder und Multipart-Overhead.
    expect(limit - MAX_DATEI_BYTES).toBeGreaterThanOrEqual(512 * 1024);
    // Portal-Meldung: Summe je Meldung, nicht Anzahl × Einzelgröße.
    expect(ANLAGEN_GRENZEN.zusammenBytes).toBeLessThanOrEqual(MAX_DATEI_BYTES);
    expect(ANLAGEN_GRENZEN.anzahl).toBe(PORTAL_MAX_ANLAGEN);
    expect(ANLAGEN_GRENZEN.jeDateiBytes).toBe(PORTAL_MAX_ANLAGE_BYTES);
    expect(ANLAGEN_GRENZEN.jeDateiBytes).toBeLessThanOrEqual(ANLAGEN_GRENZEN.zusammenBytes);
  });
});
