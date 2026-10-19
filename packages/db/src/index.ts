// =============================================================================
// Prisma-Client (Prisma 7 mit Treiberadapter pg) als Hot-Reload-sicherer
// Singleton.
// =============================================================================

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// Explizit statt `export *`: @prisma/client ist CommonJS (Turbopack-Warnung).
export { Prisma, PrismaClient } from '@prisma/client';
export type * from '@prisma/client';

declare global {
  // noinspection ES6ConvertVarToLetConst
  var __tcmsPrisma: PrismaClient | undefined;
}

export function createPrisma(url = process.env['DATABASE_URL']): PrismaClient {
  if (!url) throw new Error('[db] DATABASE_URL fehlt. Siehe .env.example.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

function lazy(): PrismaClient {
  if (!globalThis.__tcmsPrisma) globalThis.__tcmsPrisma = createPrisma();
  return globalThis.__tcmsPrisma;
}

/** Lazy-Proxy: erst der erste Zugriff baut die Verbindung (Build ohne DB möglich). */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const client = lazy() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
});

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export { schreibeAudit, pruefeAuditKette, type AuditInput } from './audit';
export { speichereDatei, leseDatei, speicherWurzel, type GespeicherteDatei } from './storage';
