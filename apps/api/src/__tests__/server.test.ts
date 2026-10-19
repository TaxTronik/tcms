// Start von src/server.ts als eigener Prozess: fail closed bei ungültiger
// Konfiguration und bei einer Laufzeitverbindung als Superuser; mit der
// Laufzeitrolle (DB-Test) startet der Dienst und beantwortet /v1/health.

import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TSX = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const API = fileURLToPath(new URL('../..', import.meta.url));
const AKTIV = process.env.DB_TESTS === '1';
const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DATABASE_OWNER_URL;
const SUPER_URL = process.env.DATABASE_SUPERUSER_URL;
const TOKEN = randomBytes(32).toString('base64url');
const SPKI = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'der', type: 'spki' })
  .toString('base64');

function freierPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

interface Lauf {
  code: Promise<number | null>;
  ausgabe: () => string;
  beenden: () => void;
}

function starte(env: Record<string, string>): Lauf {
  const kind = spawn(process.execPath, [TSX, 'src/server.ts'], {
    cwd: API,
    // Bewusst ohne geerbte Umgebung: nur PATH und die Testwerte.
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ausgabe = '';
  kind.stdout.on('data', (d: Buffer) => (ausgabe += d.toString()));
  kind.stderr.on('data', (d: Buffer) => (ausgabe += d.toString()));
  const code = new Promise<number | null>((resolve) => kind.on('exit', (c) => resolve(c)));
  return { code, ausgabe: () => ausgabe, beenden: () => kind.kill('SIGTERM') };
}

const zeilen = (text: string) =>
  text
    .split('\n')
    .filter((z) => z.startsWith('{'))
    .map((z) => JSON.parse(z) as Record<string, unknown>);

describe('server.ts', () => {
  it('beendet sich bei ungültiger Konfiguration mit Code 1, ohne Werte zu nennen', async () => {
    const platzhalter = 'bitte-durch-einen-zufaelligen-dienst-token-ersetzen';
    const lauf = starte({
      TCMS_SERVICE_TOKENS: `${TOKEN},${platzhalter}`,
      TCMS_ACTOR_PUBLIC_KEYS: `kk-a=${SPKI}`,
      DATABASE_URL: 'postgresql://tcms_app:Zr8fQ2vLx9@127.0.0.1:1/tcms',
    });
    expect(await lauf.code).toBe(1);
    const ausgabe = lauf.ausgabe();
    expect(zeilen(ausgabe).at(-1)).toMatchObject({ ereignis: 'start_fehlgeschlagen' });
    expect(ausgabe).toContain('TCMS_SERVICE_TOKENS');
    for (const geheim of [TOKEN, platzhalter, 'Zr8fQ2vLx9', SPKI]) {
      expect(ausgabe).not.toContain(geheim);
    }
  }, 30_000);

  describe.skipIf(!AKTIV)('mit PostgreSQL (Bootstrap und Migration wie in Produktion)', () => {
    const basis = () => ({ TCMS_SERVICE_TOKENS: TOKEN, TCMS_ACTOR_PUBLIC_KEYS: `kk-a=${SPKI}` });
    const passwort = (url: string) => decodeURIComponent(new URL(url).password);

    // Eigentümer (besitzt Tabellen) und Superuser (umgeht RLS) dürfen nie die
    // Laufzeitverbindung sein: pruefeLaufzeitverbindung aus @tcms/db.
    for (const [rolle, url] of [
      ['Eigentümerrolle tcms_owner', OWNER_URL],
      ['Superuser', SUPER_URL],
    ] as const) {
      it.skipIf(!url)(
        `verweigert den Start als ${rolle} (ADR §4)`,
        async () => {
          const lauf = starte({ ...basis(), DATABASE_URL: url!, PORT: String(await freierPort()) });
          expect(await lauf.code).toBe(1);
          expect(lauf.ausgabe()).toMatch(/Laufzeitverbindung abgewiesen/);
          expect(lauf.ausgabe()).not.toContain(TOKEN);
          // Entwicklungspasswörter gleichen dem Rollennamen, der genannt werden darf.
          const p = passwort(url!);
          if (p.length >= 4 && p !== new URL(url!).username) {
            expect(lauf.ausgabe()).not.toContain(p);
          }
        },
        30_000,
      );
    }

    it('startet als Laufzeitrolle tcms_app, beantwortet /v1/health und endet sauber', async () => {
      const port = await freierPort();
      const lauf = starte({
        ...basis(),
        DATABASE_URL: APP_URL!,
        HOST: '127.0.0.1',
        PORT: String(port),
      });
      try {
        let antwort: Response | undefined;
        for (let i = 0; i < 100 && !antwort; i++) {
          antwort = await fetch(`http://127.0.0.1:${port}/v1/health`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          }).catch(async () => {
            await new Promise((r) => setTimeout(r, 100));
            return undefined;
          });
        }
        expect(antwort?.status).toBe(200);
        expect(await antwort!.json()).toEqual({
          ok: true,
          daten: { version: '0.1.0', datenbank: 'ok' },
        });
        const ohne = await fetch(`http://127.0.0.1:${port}/v1/health`);
        expect(ohne.status).toBe(401);
      } finally {
        lauf.beenden();
      }
      expect(await lauf.code).toBe(0);
      const log = zeilen(lauf.ausgabe());
      expect(log.map((z) => z.ereignis)).toEqual(
        expect.arrayContaining(['gestartet', 'anfrage', 'beende']),
      );
      expect(lauf.ausgabe()).not.toContain(TOKEN);
    }, 30_000);
  });
});
