// =============================================================================
// Schreibt Audit-Ereignisse in die Hashkette des Tenants (ADR 0001 §4, TS-08,
// TS-10). Der Tenant kommt ausschließlich aus dem Transaktionskontext
// (`mitTenant`), nie aus der Eingabe. Parallele Schreiber desselben Tenants
// serialisiert eine transaktionsgebundene Advisory-Lock je Tenant; andere
// Tenants laufen ungehindert. Zusätzlich verhindern die eindeutigen Schlüssel
// (tenant_id, prevHash) und (tenant_id, pos) eine Verzweigung in der Datenbank.
//
// Position (RT-03): `pos` zählt je Tenant lückenlos (Vorgänger + 1, unter der
// Sperre vergeben). Der globale Schlüssel `seq` verlässt den Dienst nie.
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
 * immer die echte Zeit (keine Demo-Uhr, Aufgabe tcms-data 3), genommen unter
 * der Tenant-Sperre: Die Zeit folgt so der Position in der Kette.
 */
export async function schreibeAudit(tx: Tx, input: AuditInput): Promise<void> {
  await haengeFolgeAn(tx, [{ input, at: null }]);
}

/**
 * Hängt mehrere Einträge in dieser Reihenfolge an: dieselbe Kette wie ebenso
 * viele `schreibeAudit`-Aufrufe nacheinander, aber mit einer Sperre, einem
 * Lesen des letzten Glieds und einem INSERT (statt drei Abfragen je Eintrag;
 * sehr lange Folgen teilt Prisma auf mehrere INSERTs derselben Transaktion
 * auf). Für Vorgänge mit vielen Einträgen in einer Transaktion, etwa das
 * Verwerfen eines Rückstaus veralteter Codes beim Abruf der Nachrichten.
 */
export async function schreibeAuditFolge(tx: Tx, eingaben: readonly AuditInput[]): Promise<void> {
  await haengeFolgeAn(
    tx,
    eingaben.map((input) => ({ input, at: null })),
  );
}

/**
 * Wie `schreibeAudit`, mit vorgegebenem Zeitstempel. Nur für den Seed der
 * Demodaten (rückdatierte Historie); nicht über `@tcms/db` exportiert.
 */
export async function haengeAuditAn(tx: Tx, input: AuditInput, at: Date): Promise<void> {
  await haengeFolgeAn(tx, [{ input, at }]);
}

/**
 * Einziger Schreibweg der Kette: Glieder unter der Tenant-Sperre verketten.
 * `at: null` = echte Zeit, erst unter der Sperre genommen (nur der Seed gibt
 * einen Zeitpunkt vor).
 */
async function haengeFolgeAn(
  tx: Tx,
  glieder: readonly { input: AuditInput; at: Date | null }[],
): Promise<void> {
  if (glieder.length === 0) return;
  const tenantId = await tenantSperre(tx, AUDIT_SPERRE);
  const letzter = await tx.auditEvent.findFirst({
    where: { tenantId },
    orderBy: { pos: 'desc' },
    select: { hash: true, pos: true },
  });
  // Unter der Tenant-Sperre: kein anderer Schreiber dieses Tenants dazwischen.
  let prevHash = letzter?.hash ?? GENESIS_HASH;
  let pos = letzter?.pos ?? 0;
  const zeilen = glieder.map(({ input, at }) => {
    pos += 1;
    const detail = JSON.parse(JSON.stringify(input.detail ?? {})) as Record<string, unknown>;
    const inhalt = {
      tenantId,
      at: at ?? new Date(),
      actorId: input.actorId,
      actorName: input.actorName,
      aktion: input.aktion,
      objektTyp: input.objektTyp,
      objektId: input.objektId,
      programmId: input.programmId ?? null,
      detail,
    };
    const hash = auditHash(prevHash, inhalt);
    const zeile = {
      ...inhalt,
      pos,
      kettenVersion: KETTEN_VERSION,
      detail: detail as Prisma.InputJsonValue,
      prevHash,
      hash,
    };
    prevHash = hash;
    return zeile;
  });
  await tx.auditEvent.createMany({ data: zeilen });
}

/** Prüft die vollständige Kette des aktuellen Tenants (lesend). */
export async function pruefeAuditKette(tx: Tx): Promise<KettenPruefung> {
  const tenantId = await aktuellerTenant(tx);
  const alle = await tx.auditEvent.findMany({ where: { tenantId }, orderBy: { pos: 'asc' } });
  return pruefeKette(
    tenantId,
    alle.map((e) => ({
      pos: e.pos,
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
