// =============================================================================
// Rollen der Mandantenseite (ADR 0001 §5). Die kanzleikonsole bestätigt nur,
// dass ein Mandantenkontakt zu einem Mandanten gehört; welche Rolle er im
// Tax-CMS hat, steht in MandantKontaktRolle und wird je Anfrage geladen.
// =============================================================================

import type { Akteur } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import type { KontaktRolle } from './rechte';

/** Aktive Rollen des Akteurs beim eigenen Mandanten; für Kanzleipersonen leer. */
export async function ladeKontaktRollen(tx: Tx, akteur: Akteur): Promise<KontaktRolle[]> {
  if (akteur.art !== 'MANDANT') return [];
  return tx.mandantKontaktRolle.findMany({
    where: { mandantId: akteur.mandantId, kontaktId: akteur.id, aktiv: true },
    select: { mandantId: true, kontaktId: true, rolle: true, aktiv: true },
  });
}
