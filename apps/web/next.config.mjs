// Next.js-Konfiguration des Tax-CMS.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Eine .env im Repo-Root als einzige Quelle; gesetzte Prozessvariablen haben Vorrang.
dotenv.config({ path: path.join(__dirname, '../../.env'), override: false, quiet: true });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Workspace-Pakete exportieren TypeScript-Quellen.
  transpilePackages: ['@tcms/domain', '@tcms/db', '@tcms/contract', '@tcms/service'],
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
  experimental: {
    serverActions: {
      // Nachweis-Uploads (Einzeldatei bis 20 MiB) laufen über Server Actions.
      bodySizeLimit: '21mb',
    },
  },
  poweredByHeader: false,
  // Projektregeln stehen in der AGENTS.md im Repo-Root.
  agentRules: false,
};

export default nextConfig;
