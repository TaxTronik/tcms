// =============================================================================
// Schreibt Audit-Ereignisse in die Hashkette. Serialisiert über eine
// transaktionsgebundene Advisory-Lock, damit parallele Schreiber die Kette
// nicht verzweigen.
// =============================================================================

import { auditHash, GENESIS_HASH, pruefeKette, type KettenPruefung } from '@tcms/domain/audit';
import type { Prisma } from '@prisma/client';
import type { Tx } from './index';

const AUDIT_LOCK = 4_711_001;

export interface AuditInput {
  actorId: string | null;
  actorName: string;
  aktion: string;
  objektTyp: string;
  objektId: string;
  programmId?: string | null;
  detail?: Record<string, unknown>;
  at?: Date;
}

export async function schreibeAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`;
  const letzter = await tx.auditEvent.findFirst({
    orderBy: { seq: 'desc' },
    select: { hash: true },
  });
  const prevHash = letzter?.hash ?? GENESIS_HASH;
  const at = input.at ?? new Date();
  const detail = JSON.parse(JSON.stringify(input.detail ?? {})) as Record<string, unknown>;
  const hash = auditHash(prevHash, {
    at,
    actorId: input.actorId,
    aktion: input.aktion,
    objektTyp: input.objektTyp,
    objektId: input.objektId,
    detail,
  });
  await tx.auditEvent.create({
    data: {
      at,
      actorId: input.actorId,
      actorName: input.actorName,
      aktion: input.aktion,
      objektTyp: input.objektTyp,
      objektId: input.objektId,
      programmId: input.programmId ?? null,
      detail: detail as Prisma.InputJsonValue,
      prevHash,
      hash,
    },
  });
}

export async function pruefeAuditKette(tx: Tx): Promise<KettenPruefung> {
  const alle = await tx.auditEvent.findMany({ orderBy: { seq: 'asc' } });
  return pruefeKette(
    alle.map((e) => ({
      seq: e.seq,
      at: e.at,
      actorId: e.actorId,
      aktion: e.aktion,
      objektTyp: e.objektTyp,
      objektId: e.objektId,
      detail: e.detail,
      prevHash: e.prevHash,
      hash: e.hash,
    })),
  );
}
