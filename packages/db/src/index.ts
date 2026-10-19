// =============================================================================
// Datenzugriff des Tax-CMS (Prisma 7 mit Treiberadapter pg).
//
// Zwei Verbindungen (ADR 0001 §4):
//   - Laufzeit: `DATABASE_URL` als `tcms_app` (NOBYPASSRLS, nur DML). Zugriff
//     ausschließlich über `mitTenant`; einen ungebundenen Client exportiert
//     dieses Paket bewusst nicht.
//   - Migration und Seed: `DATABASE_OWNER_URL` als `tcms_owner` (bzw. ein
//     Superuser in der Entwicklung), über `erzeugeClient`.
// =============================================================================

// Explizit statt `export *`: @prisma/client ist CommonJS (Turbopack-Warnung).
export { Prisma, PrismaClient } from '@prisma/client';
export type * from '@prisma/client';

export {
  aktuellerTenant,
  erzeugeClient,
  KONTEXT_VERAENDERT,
  mitTenant,
  pruefeLaufzeitRolle,
  pruefeLaufzeitverbindung,
  pruefeTenantId,
  sperrSchluessel,
  TENANT_EINSTELLUNG,
  TenantFehler,
  tenantSperre,
  type TenantOptionen,
  type Tx,
} from './tenant';
export { AUDIT_SPERRE, pruefeAuditKette, schreibeAudit, type AuditInput } from './audit';
