import { defineConfig } from 'vitest/config';

// DB-Tests (*.db.test.ts) laufen nur mit DB_TESTS=1 gegen eine migrierte
// PostgreSQL-Datenbank; siehe README „Datenbank".
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
