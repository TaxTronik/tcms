// =============================================================================
// Datenzugriff des Dienstes über `pg` (Übergang).
//
// `mitTenant` wie in ADR §4: eine Transaktion, `set_config('tcms.tenant_id',
// …, true)` (gilt nur in dieser Transaktion), dann die Route. Sobald
// `@tcms/db` (tcms-data) `mitTenant` exportiert, verdrahtet `server.ts` jenes;
// die Fachrouten aus `packages/service` brauchen dessen Transaktionstyp.
// =============================================================================

import type pg from 'pg';
import type { Datenzugriff } from './app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pgDatenzugriff(pool: Pick<pg.Pool, 'connect'>): Datenzugriff<pg.PoolClient> {
  return {
    async mitTenant(tenantId, fn) {
      if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
        throw new Error('mitTenant: Tenant-ID ist keine UUID');
      }
      const client = await pool.connect();
      let verbindungKaputt: Error | undefined;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('tcms.tenant_id', $1, true)", [tenantId]);
        const ergebnis = await fn(client);
        await client.query('COMMIT');
        return ergebnis;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackFehler) {
          // Verbindung in unbekanntem Zustand: nicht in den Pool zurückgeben.
          verbindungKaputt =
            rollbackFehler instanceof Error ? rollbackFehler : new Error('ROLLBACK');
        }
        throw e;
      } finally {
        client.release(verbindungKaputt);
      }
    },
  };
}

/**
 * Fail closed beim Start (ADR §4): Die Laufzeitverbindung darf weder Superuser
 * sein noch RLS umgehen dürfen.
 */
export async function pruefeLaufzeitrolle(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const r = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const rolle = r.rows[0];
  if (!rolle) throw new Error('Laufzeitrolle: current_user nicht gefunden');
  if (rolle.rolsuper || rolle.rolbypassrls) {
    throw new Error('Laufzeitrolle: Superuser oder BYPASSRLS – Start verweigert (ADR §4)');
  }
}
