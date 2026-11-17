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
  SPERR_WARTEZEIT_MS,
  sperrSchluessel,
  TENANT_EINSTELLUNG,
  TRANSAKTION_MS,
  TenantFehler,
  tenantSperre,
  type TenantOptionen,
  type Tx,
} from './tenant';
export { AUDIT_SPERRE, schreibeAudit, schreibeAuditFolge, type AuditInput } from './audit';
export {
  EINGABE_FEHLERCODES,
  eingabeFehlercode,
  KONFLIKT_FEHLERCODES,
  konfliktFehlercode,
  ZEITLIMIT_FEHLERCODES,
  zeitlimitFehlercode,
  type EingabeFehlercode,
  type KonfliktFehlercode,
  type ZeitlimitFehlercode,
} from './fehler';
