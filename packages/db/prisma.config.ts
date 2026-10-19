import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Eine .env im Repo-Root als einzige Quelle.
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), override: false });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --env-file-if-exists=../../.env seeds/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
