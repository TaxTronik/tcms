import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['kein-datum', '2026-02-31'])('verwirft %s vor dem ersten Datenbankzugriff', (tag) => {
  const seed = fileURLToPath(new URL('../../seeds/seed.ts', import.meta.url));
  const lauf = spawnSync(process.execPath, ['--import', 'tsx', seed], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TCMS_DEMO_TODAY: tag,
      DATABASE_OWNER_URL: 'postgresql://localhost:1/test',
    },
  });
  expect(lauf.status).toBe(1);
  expect(lauf.stderr).toContain('[seed] TCMS_DEMO_TODAY muss ein gültiger Kalendertag');
});
