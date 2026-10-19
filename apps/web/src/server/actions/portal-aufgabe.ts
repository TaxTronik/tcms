'use server';

import {
  bestaetigenAls,
  entfernenAls,
  hochladenAls,
  portalHandlung,
  speichernAls,
  zurueckweisenAls,
} from '../durchfuehrung-daten';
import type { Ergebnis } from '../ergebnis';

// =============================================================================
// Server Actions der Kontrollaufgabe im Portal (P2): dünne Hüllen um
// @tcms/service im Dienstkontext der angemeldeten Portal-Person. Sichtbarkeit
// (nur Aufgaben der eigenen Seite, zugewiesen oder GV/TCB), Vier-Augen und
// Status prüft der Service; nicht sichtbare Aufgaben ergeben dieselbe Meldung.
// =============================================================================

/** „Entwurf speichern" bzw. „An Kanzlei übermitteln" (absicht=einreichen). */
export async function speichereAufgabe(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return speichernAls(await portalHandlung(), fd);
}

export async function ladeAnlageHoch(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return hochladenAls(await portalHandlung(), fd);
}

export async function entferneAnlage(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return entfernenAls(await portalHandlung(), fd);
}

/** Zweite Person beim Mandanten gibt die Aufgabe mit Begründung zur Überarbeitung zurück. */
export async function gibAufgabeZurueck(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return zurueckweisenAls(await portalHandlung(), fd);
}

/**
 * Bestätigung durch eine zweite Person beim Mandanten (Kontrollstand mit
 * Gegenzeichnung beim Mandanten). Danach schließt die Kanzlei mit der Gegenzeichnung ab.
 */
export async function bestaetigeAufgabe(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return bestaetigenAls(await portalHandlung(), fd);
}
