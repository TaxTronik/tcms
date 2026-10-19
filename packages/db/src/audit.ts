// =============================================================================
// Schreibt Audit-Ereignisse in die Hashkette des Tenants (ADR 0001 §4, TS-08,
// TS-10). Der Tenant kommt ausschließlich aus dem Transaktionskontext
// (`mitTenant`), nie aus der Eingabe. Parallele Schreiber desselben Tenants
// serialisiert eine transaktionsgebundene Advisory-Lock je Tenant; andere
// Tenants laufen ungehindert. Zusätzlich verhindert der eindeutige Schlüssel
// (tenant_id, prevHash) eine Verzweigung in der Datenbank.
// =============================================================================

import {
  auditHash,
  GENESIS_HASH,
  KETTEN_VERSION,
  pruefeKette,
  type KettenPruefung,
} from '@tcms/domain/audit';
import type { Prisma } from '@prisma/client';
import { aktuellerTenant, tenantSperre, type Tx } from './tenant';

export interface AuditInput {
  actorId: string | null;
  actorName: string;
  aktion: string;
  objektTyp: string;
  objektId: string;
  programmId?: string | null;
  detail?: Record<string, unknown>;
}

/** Sperrbereich der Audit-Kette (siehe `tenantSperre`). */
export const AUDIT_SPERRE = 'audit';

/**
 * Hängt einen Eintrag an die Kette des aktuellen Tenants. Der Zeitstempel ist
 * immer die echte Zeit (keine Demo-Uhr, Aufgabe tcms-data 3).
 */
export async function schreibeAudit(tx: Tx, input: AuditInput): Promise<void> {
  await haengeAuditAn(tx, input, new Date());
}

/**
 * Wie `schreibeAudit`, mit vorgegebenem Zeitstempel. Nur für den Seed der
 * Demodaten (rückdatierte Historie); nicht über `@tcms/db` exportiert.
 */
export async function haengeAuditAn(tx: Tx, input: AuditInput, at: Date): Promise<void> {
  const tenantId = await tenantSperre(tx, AUDIT_SPERRE);
  const letzter = await tx.auditEvent.findFirst({
    where: { tenantId },
    orderBy: { seq: 'desc' },
    select: { hash: true },
  });
  const prevHash = letzter?.hash ?? GENESIS_HASH;
  const detail = JSON.parse(JSON.stringify(input.detail ?? {})) as Record<string, unknown>;
  const inhalt = {
    tenantId,
    at,
    actorId: input.actorId,
    actorName: input.actorName,
    aktion: input.aktion,
    objektTyp: input.objektTyp,
    objektId: input.objektId,
    programmId: input.programmId ?? null,
    detail,
  };
  await tx.auditEvent.create({
    data: {
      ...inhalt,
      kettenVersion: KETTEN_VERSION,
      detail: detail as Prisma.InputJsonValue,
      prevHash,
      hash: auditHash(prevHash, inhalt),
    },
  });
}

/** Prüft die vollständige Kette des aktuellen Tenants (lesend). */
export async function pruefeAuditKette(tx: Tx): Promise<KettenPruefung> {
  const tenantId = await aktuellerTenant(tx);
  const alle = await tx.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
  return pruefeKette(
    tenantId,
    alle.map((e) => ({
      seq: e.seq,
      kettenVersion: e.kettenVersion,
      tenantId: e.tenantId,
      at: e.at,
      actorId: e.actorId,
      actorName: e.actorName,
      aktion: e.aktion,
      objektTyp: e.objektTyp,
      objektId: e.objektId,
      programmId: e.programmId,
      detail: e.detail,
      prevHash: e.prevHash,
      hash: e.hash,
    })),
  );
}
