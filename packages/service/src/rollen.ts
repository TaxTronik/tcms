// =============================================================================
// Rollen der Mandantenseite (ADR 0001 §5). Die kanzleikonsole bestätigt nur,
// dass ein Mandantenkontakt zu einem Mandanten gehört; welche Rolle er im
// Tax-CMS hat, steht in MandantKontaktRolle und wird je Anfrage geladen.
// =============================================================================

import { DienstFehler, type Akteur } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import type { KontaktRolle } from './rechte';

// -----------------------------------------------------------------------------
// Sperren der Rollen eines Mandanten (TS-05, RT4-T-05/06)
//
// Rollen ändern sich nur unter `sperreRollenZumAendern` (Mandantenzeile FOR
// UPDATE, `setzeKontaktRollen`). Jede Operation, die eine Freigabe anlegt,
// neu adressiert, erteilt, einen Code ausstellt oder eine Kenntnisnahme
// bestätigt, prüft Rollen erst nach `halteRollenFest` (dieselbe Zeile FOR KEY
// SHARE): Die Prüfung sieht jede schon festgeschriebene Rollenänderung, und
// bis zum Commit kann keine neue dazwischenkommen. Beide Richtungen eines
// Wettlaufs laufen so nacheinander (kein Write Skew „letzte GV" gegen
// Neuadressierung, kein Freigeben mit eben entzogener Rolle).
//
// Reihenfolge der Sperren in Freigabe-Operationen: zuerst die Zeile der
// Freigabe bzw. Beschreibungsversion bzw. des Risikos/Programms, dann
// `halteRollenFest`, dann Rollen lesen. Die Rollenpflege sperrt keine dieser
// Zeilen (nur die Mandantenzeile und den Kontakt), daher entsteht kein Zyklus.
// -----------------------------------------------------------------------------

/** Sperrt die Mandantenzeile zum Ändern der Rollen (FOR UPDATE); unbekannt → NICHT_GEFUNDEN. */
export async function sperreRollenZumAendern(tx: Tx, mandantId: string): Promise<void> {
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Mandant" WHERE id = ${mandantId}::uuid FOR UPDATE`;
  if (z.length === 0) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Hält die Rollen des Mandanten bis zum Ende der Transaktion fest (FOR KEY
 * SHARE auf die Mandantenzeile, teilbar unter Freigabe-Operationen, nicht mit
 * `sperreRollenZumAendern`). Erst danach Rollen lesen; unbekannt → NICHT_GEFUNDEN.
 */
export async function halteRollenFest(tx: Tx, mandantId: string): Promise<void> {
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "Mandant" WHERE id = ${mandantId}::uuid FOR KEY SHARE`;
  if (z.length === 0) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Aktive Rollen des Akteurs beim eigenen Mandanten; für Kanzleipersonen leer. */
export async function ladeKontaktRollen(tx: Tx, akteur: Akteur): Promise<KontaktRolle[]> {
  if (akteur.art !== 'MANDANT') return [];
  return tx.mandantKontaktRolle.findMany({
    where: { mandantId: akteur.mandantId, kontaktId: akteur.id, aktiv: true },
    select: { mandantId: true, kontaktId: true, rolle: true, aktiv: true },
    orderBy: [{ rolle: 'asc' }, { id: 'asc' }],
  });
}
