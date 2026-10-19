import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma, schreibeAudit, type Tx } from '@tcms/db';
import type { Nutzer } from './sitzung';
import { jetzt } from './zeit';

// =============================================================================
// Gemeinsame Helfer für Server Actions: jede fachliche Änderung läuft in einer
// Transaktion und schreibt im selben Zug ein Audit-Ereignis in die Hashkette.
// =============================================================================

export interface Protokoll {
  aktion: string;
  objektTyp: string;
  objektId: string;
  programmId: string | null;
  detail?: Record<string, unknown>;
}

/** Führt `fn` transaktional aus und protokolliert die zurückgegebenen Einträge. */
export async function mitAudit<T>(
  nutzer: Pick<Nutzer, 'id' | 'name'>,
  fn: (tx: Tx, zeitpunkt: Date) => Promise<{ wert: T; protokoll: Protokoll | Protokoll[] }>,
): Promise<T> {
  const zeitpunkt = jetzt();
  return prisma.$transaction(
    async (tx) => {
      const { wert, protokoll } = await fn(tx, zeitpunkt);
      for (const p of Array.isArray(protokoll) ? protokoll : [protokoll]) {
        await schreibeAudit(tx, {
          actorId: nutzer.id,
          actorName: nutzer.name,
          aktion: p.aktion,
          objektTyp: p.objektTyp,
          objektId: p.objektId,
          programmId: p.programmId,
          detail: p.detail ?? {},
          at: zeitpunkt,
        });
      }
      return wert;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** Revalidiert alle Seiten eines Mandanten-TCMS (inkl. Layout mit Tab-Punkten) und das Portfolio. */
export function aktualisiereMandant(mandantId: string): void {
  revalidatePath(`/staff/clients/${mandantId}/tcms`, 'layout');
  revalidatePath('/staff/tcms');
  revalidatePath('/staff/arbeitskorb');
  revalidatePath('/portal/tcms', 'layout');
}

/** Liefert Programm und Mandant zu einem Programm-ID (für Rechteprüfungen). */
export async function programmMitMandant(programmId: string) {
  return prisma.tcmsProgramm.findUnique({ where: { id: programmId }, include: { mandant: true } });
}

/** Einheitlicher Text für fehlende Rechte (Konzept 6.8: klare Rollenangabe). */
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const NUR_BERUFSTRAEGER = 'Dieser Schritt ist Berufsträger:innen vorbehalten.';
