import 'server-only';
import { revalidatePath } from 'next/cache';
import type { Akteur } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { imDienst, mitAudit as dienstMitAudit, type Protokoll } from '@tcms/service';
import { DEMO_PORTS, lies } from './demo';

// =============================================================================
// Gemeinsame Helfer für Server Actions der Demo. Jede fachliche Änderung läuft
// über `mitAudit` aus @tcms/service: eine Transaktion im Tenant des Akteurs,
// im selben Zug ein Audit-Eintrag je Protokollzeile (AGENTS.md Regel 1).
// =============================================================================

export type { Protokoll };

/**
 * Führt `fn` im Dienstkontext des Akteurs aus und protokolliert die
 * zurückgegebenen Einträge. `zeitpunkt` ist die Demo-Uhr (fachliche Zeit);
 * der Audit-Zeitstempel ist die echte Zeit.
 */
export function mitAudit<T>(
  akteur: Akteur,
  fn: (tx: Tx, zeitpunkt: Date) => Promise<{ wert: T; protokoll: Protokoll | Protokoll[] }>,
): Promise<T> {
  return imDienst(akteur, DEMO_PORTS, (ctx) => dienstMitAudit(ctx, fn), {
    timeoutMs: 30_000,
    maxWaitMs: 10_000,
  });
}

/** Revalidiert alle Seiten eines Mandanten-TCMS (inkl. Layout mit Tab-Punkten) und das Portfolio. */
export function aktualisiereMandant(mandantId: string): void {
  revalidatePath(`/staff/clients/${mandantId}/tcms`, 'layout');
  revalidatePath('/staff/tcms');
  revalidatePath('/staff/arbeitskorb');
  revalidatePath('/portal/tcms', 'layout');
}

/** Liefert Programm und Mandant zu einer Programm-ID (für Rechteprüfungen). */
export async function programmMitMandant(programmId: string) {
  return lies((tx) =>
    tx.tcmsProgramm.findUnique({ where: { id: programmId }, include: { mandant: true } }),
  );
}

/** Einheitlicher Text für fehlende Rechte (Konzept 6.8: klare Rollenangabe). */
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const NUR_BERUFSTRAEGER = 'Dieser Schritt ist Berufsträger:innen vorbehalten.';
