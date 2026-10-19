// =============================================================================
// Mandantenkontext (ADR 0001 §4). Jeder Datenbankzugriff der Laufzeit läuft
// in genau einer Transaktion, in der `tcms.tenant_id` transaktionslokal gesetzt
// ist; RLS filtert damit jede Tabelle auf diesen Tenant. Ohne Kontext sieht die
// Laufzeitrolle nichts.
//
// Fail closed:
//   - ungültige Tenant-IDs werden vor jedem Datenbankzugriff abgewiesen;
//   - eine Verbindung, deren Rolle Superuser ist, BYPASSRLS hat oder Tabellen
//     besitzt (und damit RLS abschalten könnte), wird nie benutzt.
// =============================================================================

import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/** Name der transaktionslokalen Einstellung, die RLS auswertet. */
export const TENANT_EINSTELLUNG = 'tcms.tenant_id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Fehler des Mandantenkontexts. Meldungen enthalten nie Eingabewerte. */
export class TenantFehler extends Error {
  constructor(meldung: string) {
    super(`[db] ${meldung}`);
    this.name = 'TenantFehler';
  }
}

/** Kanonische Tenant-ID (Kleinbuchstaben) oder `TenantFehler`. */
export function pruefeTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new TenantFehler('Ungültige Tenant-ID.');
  }
  const kanonisch = tenantId.toLowerCase();
  if (kanonisch === NIL_UUID) throw new TenantFehler('Ungültige Tenant-ID.');
  return kanonisch;
}

export function erzeugeClient(url: string | undefined): PrismaClient {
  if (!url) throw new TenantFehler('Verbindungs-URL fehlt. Siehe .env.example.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

declare global {
  // noinspection ES6ConvertVarToLetConst
  var __tcmsLaufzeit: PrismaClient | undefined;
}

/**
 * Laufzeitverbindung (`DATABASE_URL`, Rolle `tcms_app`). Hot-Reload-sicherer
 * Singleton; die Verbindung entsteht erst beim ersten Zugriff (Build ohne DB).
 */
function laufzeitClient(): PrismaClient {
  if (!globalThis.__tcmsLaufzeit) {
    globalThis.__tcmsLaufzeit = erzeugeClient(process.env['DATABASE_URL']);
  }
  return globalThis.__tcmsLaufzeit;
}

interface RollenBefund {
  rolle: string;
  umgeht: boolean;
  besitzt: boolean;
}

/**
 * Prüft, dass die Verbindung RLS nicht umgehen kann: Weder Sitzungs- noch
 * aktuelle Rolle ist Superuser oder hat BYPASSRLS, ist Mitglied einer solchen
 * Rolle (SET ROLE) oder Eigentümer einer Tabelle im Schema `public` (direkt
 * oder über eine Mitgliedschaft; Eigentümer können RLS abschalten). Wirft sonst.
 */
export async function pruefeLaufzeitRolle(client: PrismaClient | Tx): Promise<void> {
  const befunde = await client.$queryRaw<RollenBefund[]>`
    SELECT r.rolname::text AS rolle,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles s
             WHERE (s.rolsuper OR s.rolbypassrls)
               AND pg_catalog.pg_has_role(r.oid, s.oid, 'MEMBER')
           ) AS umgeht,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
               AND pg_catalog.pg_has_role(r.oid, c.relowner, 'MEMBER')
           ) AS besitzt
    FROM pg_catalog.pg_roles r
    WHERE r.rolname IN (current_user, session_user)`;
  if (befunde.length === 0) throw new TenantFehler('Laufzeitrolle nicht ermittelbar.');
  for (const b of befunde) {
    if (b.umgeht || b.besitzt) {
      // Rollenname ist kein Geheimnis und hilft beim Betrieb; keine URL, kein Passwort.
      throw new TenantFehler(
        `Laufzeitverbindung abgewiesen: Rolle „${b.rolle}" ist Superuser, hat BYPASSRLS oder besitzt Tabellen. DATABASE_URL muss die Rolle tcms_app verwenden.`,
      );
    }
  }
}

const geprueft = new WeakSet<PrismaClient>();

async function stelleLaufzeitRolleSicher(client: PrismaClient): Promise<void> {
  if (geprueft.has(client)) return;
  await pruefeLaufzeitRolle(client); // wirft bei jedem Aufruf erneut, nie zwischengespeichert
  geprueft.add(client);
}

/**
 * Prüft die Laufzeitverbindung (`DATABASE_URL`) beim Start des Dienstes, damit
 * er gar nicht erst Anfragen annimmt, wenn die Rolle RLS umgehen könnte
 * (fail closed). `mitTenant` prüft unabhängig davon vor der ersten Nutzung.
 */
export async function pruefeLaufzeitverbindung(): Promise<void> {
  await stelleLaufzeitRolleSicher(laufzeitClient());
}

export interface TenantOptionen {
  /** Höchstdauer der Transaktion in ms (Standard 30 000). */
  timeoutMs?: number;
  /** Höchste Wartezeit auf eine Verbindung in ms (Standard 10 000). */
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Nur für Tests: andere Verbindung als `DATABASE_URL` (wird ebenso geprüft). */
  client?: PrismaClient;
}

/**
 * Führt `fn` in einer Transaktion im Kontext des Tenants aus. Lesen wie
 * Schreiben einer Anfrage laufen vollständig in genau einer solchen
 * Transaktion (ADR 0001 §4). `fn` darf `tx` nicht über das Ende hinaus halten.
 */
export async function mitTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: TenantOptionen = {},
): Promise<T> {
  const tenant = pruefeTenantId(tenantId);
  const client = opts.client ?? laufzeitClient();
  await stelleLaufzeitRolleSicher(client);
  return client.$transaction(
    async (tx) => {
      // is_local = true: gilt nur bis zum Ende dieser Transaktion, nie für die
      // Poolverbindung danach.
      await tx.$executeRaw`SELECT pg_catalog.set_config(${TENANT_EINSTELLUNG}, ${tenant}, true)`;
      return fn(tx);
    },
    {
      timeout: opts.timeoutMs ?? 30_000,
      maxWait: opts.maxWaitMs ?? 10_000,
      ...(opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : {}),
    },
  );
}

/**
 * Tenant der laufenden Transaktion (kanonisch, aus der Datenbank gelesen).
 * Wirft, wenn kein gültiger Kontext gesetzt ist.
 */
export async function aktuellerTenant(tx: Tx): Promise<string> {
  const [zeile] = await tx.$queryRaw<{ tenant: string | null }[]>`
    SELECT tcms_aktueller_tenant()::text AS tenant`;
  if (!zeile?.tenant) throw new TenantFehler('Kein Tenant-Kontext gesetzt.');
  return pruefeTenantId(zeile.tenant);
}

/**
 * 64-Bit-Schlüssel für Advisory-Locks je Tenant und Bereich (ADR 0001 §4,
 * TS-08): verschiedene Tenants sperren sich nicht gegenseitig.
 */
export function sperrSchluessel(bereich: string, tenantId: string): bigint {
  const digest = createHash('sha256')
    .update(`tcms|${bereich}|${pruefeTenantId(tenantId)}`)
    .digest();
  return digest.readBigInt64BE(0);
}

/**
 * Transaktionsgebundene Sperre je Tenant und Bereich (z. B. `audit`,
 * Nummernkreise). Der Tenant kommt aus dem Kontext, nicht vom Aufrufer.
 */
export async function tenantSperre(tx: Tx, bereich: string): Promise<string> {
  const tenant = await aktuellerTenant(tx);
  const schluessel = sperrSchluessel(bereich, tenant);
  await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
  return tenant;
}
