import 'server-only';
import { revalidatePath } from 'next/cache';

// =============================================================================
// Gemeinsame Helfer für Server Actions der Demo. Fachliche Änderungen laufen
// ausschließlich über die Operationen aus @tcms/service (Dienstkontext,
// `mitAudit`, Rechte); die Demo hat keinen eigenen Schreibweg.
// =============================================================================

/** Revalidiert alle Seiten eines Mandanten-TCMS (inkl. Layout mit Tab-Punkten) und das Portfolio. */
export function aktualisiereMandant(mandantId: string): void {
  revalidatePath(`/staff/clients/${mandantId}/tcms`, 'layout');
  revalidatePath('/staff/tcms');
  revalidatePath('/staff/arbeitskorb');
  revalidatePath('/portal/tcms', 'layout');
}

/** Einheitlicher Text für fehlende Rechte (Konzept 6.8: klare Rollenangabe). */
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const NUR_BERUFSTRAEGER = 'Dieser Schritt ist Berufsträger:innen vorbehalten.';
