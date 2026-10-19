import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Eine .env im Repo-Root als einzige Quelle.
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), override: false, quiet: true });

// Migrationen laufen als Eigentümer (`tcms_owner`), nie als Laufzeitrolle
// (ADR 0001 §4). `prisma generate` braucht keine Verbindung; fehlt die
// Variable, scheitern nur Befehle, die eine Datenbank brauchen.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --env-file-if-exists=../../.env seeds/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_OWNER_URL'] ?? '',
  },
});
