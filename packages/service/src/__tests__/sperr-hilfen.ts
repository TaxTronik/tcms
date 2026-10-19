// =============================================================================
// Nur für Tests: Wartezustände an Sperren beobachten und eine Rollenänderung
// genau in das Fenster einer laufenden Freigabe-Operation legen (TS-05,
// RT4-T-05/06).
// =============================================================================

import { mitTenant, type PrismaClient } from '@tcms/db';
import { sperreRollenZumAendern } from '../rollen';

/**
 * Wartet, bis eine Sitzung dieser Datenbank an einer Sperre wartet, deren
 * Anweisung `muster` enthält (z. B. `FOR KEY SHARE`). So zählt nur die
 * beobachtete Operation, nicht andere Tests derselben Datenbank.
 */
export async function bisWartend(tenantId: string, muster: string): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const [z] = await mitTenant(
      tenantId,
      (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE ${`%${muster}%`}`,
    );
    if ((z?.n ?? 0) >= 1) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Keine Sitzung wartet auf eine Sperre (${muster})`);
}

/**
 * Hält die Rollen des Mandanten zum Ändern gesperrt (wie `setzeKontaktRollen`),
 * startet `operation`, wartet, bis sie an `halteRollenFest` wartet, entzieht
 * dann `kontaktId` jede aktive Rolle und schreibt fest. Ergebnis: wie die
 * Operation ausging. Eine Operation, die Rollen ohne diese Sperre prüft, wartet
 * nie – dann scheitert `bisWartend`.
 */
export async function mitRollenentzugWaehrend<T>(o: {
  tenantId: string;
  mandantId: string;
  kontaktId: string;
  client: PrismaClient;
  operation: () => Promise<T>;
}): Promise<PromiseSettledResult<T>> {
  let loslassen!: () => void;
  const schranke = new Promise<void>((r) => (loslassen = r));
  let gehalten!: () => void;
  const haelt = new Promise<void>((r) => (gehalten = r));
  const halter = mitTenant(
    o.tenantId,
    async (tx) => {
      await sperreRollenZumAendern(tx, o.mandantId);
      gehalten();
      await schranke;
      await tx.mandantKontaktRolle.updateMany({
        where: { mandantId: o.mandantId, kontaktId: o.kontaktId, aktiv: true },
        data: { aktiv: false },
      });
    },
    { timeoutMs: 30_000, client: o.client },
  );
  await haelt;
  const lauf = o.operation().then(
    (wert): PromiseSettledResult<T> => ({ status: 'fulfilled', value: wert }),
    (grund: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason: grund }),
  );
  try {
    await bisWartend(o.tenantId, 'FOR KEY SHARE');
  } finally {
    loslassen();
    await halter;
  }
  return lauf;
}
