// Next.js-Konfiguration des Tax-CMS.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Eine .env im Repo-Root als einzige Quelle; gesetzte Prozessvariablen haben Vorrang.
dotenv.config({ path: path.join(__dirname, '../../.env'), override: false, quiet: true });

/**
 * Content-Security-Policy der Seiten (zweite Verteidigungslinie). Next.js
 * schreibt die RSC-Nutzlast als Inline-Skripte in jede Seite, dazu kommt das
 * Theme-Skript im Root-Layout; ohne Nonce (die bräuchte einen Proxy und
 * dynamisches Rendern jeder Seite) bleibt `script-src` daher bei
 * 'unsafe-inline'. Wirksam bleiben: nur eigene Quellen, keine Plugins, kein
 * fremdes `<base>`, Formulare nur an die Demo selbst, kein Einbetten in fremde
 * Seiten. `next dev` braucht zusätzlich 'unsafe-eval' (React-Fehleranzeige).
 * Downloads setzen eine eigene Sandbox-CSP (`src/server/dateien.ts`).
 *
 * @param {boolean} entwicklung
 */
export function csp(entwicklung) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${entwicklung ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Sicherheitskopfzeilen jeder Antwort. HSTS gehört an den TLS-terminierenden
 * Proxy; die Demo selbst läuft nur über http://127.0.0.1.
 */
export const SICHERHEITS_KOPFZEILEN = [
  { key: 'Content-Security-Policy', value: csp(process.env.NODE_ENV !== 'production') },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/**
 * Download-Routen liefern fremde Dateien aus: dort gilt statt der Seiten-CSP eine
 * Sandbox-CSP (wie `DOWNLOAD_KOPF` in src/server/dateien.ts). Kopfzeilen aus
 * `headers()` überschreiben die der Route; bei mehreren passenden Regeln gilt
 * die letzte.
 */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox";
export const DOWNLOAD_PFADE = ['/api/nachweise/:id', '/staff/clients/:id/tcms/ereignisse/anlage'];

/** Body-Limit der Server Actions; Dateien je Upload höchstens 20 MiB (`MAX_DATEI_BYTES`). */
export const BODY_LIMIT = '21mb';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Workspace-Pakete exportieren TypeScript-Quellen.
  transpilePackages: ['@tcms/domain', '@tcms/db', '@tcms/contract', '@tcms/service'],
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
  experimental: {
    serverActions: {
      // Uploads (Nachweise, Portal-Anlagen; zusammen bis 20 MiB je Anfrage)
      // laufen über Server Actions. Next liest den Body vor jeder Action ein,
      // auch ohne Sitzung: das Limit nicht ohne Grund anheben.
      bodySizeLimit: BODY_LIMIT,
    },
  },
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:pfad*', headers: SICHERHEITS_KOPFZEILEN },
      ...DOWNLOAD_PFADE.map((source) => ({
        source,
        headers: [{ key: 'Content-Security-Policy', value: DOWNLOAD_CSP }],
      })),
    ];
  },
  // Projektregeln stehen in der AGENTS.md im Repo-Root.
  agentRules: false,
};

export default nextConfig;
