// =============================================================================
// Datenbankkonflikt → KONFLIKT (TS-05, Befund 92). Einzige Abbildung für alle
// Bereiche: Weist die Datenbank eine Änderung wegen einer gleichzeitigen
// Änderung ab – eindeutiger Schlüssel (23505, Prisma P2002), Serialisierung
// (40001, P2034) oder Verklemmung (40P01) –, antwortet der Dienst `409
// KONFLIKT` statt `500 INTERN`. Erkannt wird über die strukturierten Felder
// (`konfliktFehlercode` aus `@tcms/db`); mit Prisma 7 und adapter-pg kommt eine
// Verklemmung als P2039 bzw. P2010 mit dem SQLSTATE in
// `meta.driverAdapterError.cause` an. Die Transaktion ist danach abgebrochen
// und rollt vollständig zurück; ein erneuter Versuch ist gefahrlos.
//
// Sperrreihenfolge, die solche Verklemmungen vermeidet: AGENTS.md (TS-05) und
// der Kopf von `bereiche/risiken-kontrollen/gemeinsam.ts`.
//
// In Abläufen, deren Endpunkt im Register `konflikte` nennt (Code anfordern,
// Freigeben, Portal-Meldung), braucht ein 409 einen Grund: dort
// `istDbKonflikt` mit `konfliktMitGrund` aus `@tcms/contract` verwenden.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import { konfliktFehlercode } from '@tcms/db';

/** Standardmeldung eines Datenbankkonflikts (ohne interne Details). */
export const STAND_GEAENDERT = 'Der Stand wurde inzwischen geändert. Bitte neu laden.';

/** Gleichzeitige Änderung, die die Datenbank abgewiesen hat? Eigene Fehler nie. */
export function istDbKonflikt(e: unknown): boolean {
  return !(e instanceof DienstFehler) && konfliktFehlercode(e) !== null;
}

/** Datenbankkonflikt als `KONFLIKT` mit `meldung`; alle anderen Fehler unverändert. */
export function alsKonflikt(e: unknown, meldung: string = STAND_GEAENDERT): unknown {
  return istDbKonflikt(e) ? new DienstFehler('KONFLIKT', meldung) : e;
}

/** Führt `fn` aus und übersetzt einen Datenbankkonflikt in `KONFLIKT` (sonst unverändert). */
export async function konfliktSicher<T>(
  fn: () => Promise<T>,
  meldung: string = STAND_GEAENDERT,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw alsKonflikt(e, meldung);
  }
}
