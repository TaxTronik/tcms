import 'server-only';
import { leseStand as leseStandAm } from '@tcms/service';
import { parseDezimal } from '../components/durchfuehrung/werte';
import { heute as heuteDerDemo } from './zeit';

// =============================================================================
// Gemeinsame Formularparser der Server Actions (ohne Next-Abhängigkeit, damit
// testbar). Es gibt genau einen Parser für Beträge (`parseDezimal`, auch für
// die Live-Anzeige im Browser) und genau eine Prüfung des Stichtags.
// =============================================================================

/** Abbruch einer Action mit einer Meldung an die Person (kein Dienstfehler). */
export class FormularFehler extends Error {}

/**
 * Betrag in deutscher Schreibweise („1.234,56“, „1234,56“, „1.234“, „-12,5 €“);
 * ohne Komma zählt ein Punkt nur als Dezimaltrenner, wenn er keine
 * Tausendergruppe bildet („1234.56“). Mehrdeutiges („12,345.67“), Hex- und
 * Exponentialschreibweise sind unlesbar. Leer → null, unlesbar → 'fehler'.
 */
export function betrag(roh: FormDataEntryValue | null | undefined): number | null | 'fehler' {
  if (typeof roh !== 'string') return roh == null ? null : 'fehler';
  return parseDezimal(roh);
}

/** Betrag ab 0 € bis `max` (leer → 0); sonst `FormularFehler` mit dem Feldnamen. */
export function betragAbNull(
  roh: FormDataEntryValue | null | undefined,
  feldName: string,
  max: number,
): number {
  const n = betrag(roh);
  if (n === null) return 0;
  if (n === 'fehler' || n < 0 || n > max)
    throw new FormularFehler(`${feldName}: bitte einen Betrag ab 0 € angeben.`);
  return n;
}

/**
 * true, wenn das Formular aus einem historischen Stichtag gesendet wurde
 * (Mutationen dort deaktiviert, AGENTS.md Regel 6). Formulare senden `stand`
 * nur im historischen Stand (`StaffSeite.standFeld`); die aktuelle Ansicht
 * sendet ihn nie, damit ein über Mitternacht offenes Formular nicht als
 * historisch gilt. Bedienhilfe: Der Service nimmt keinen Stichtag an und
 * ändert immer den aktuellen Stand.
 */
export function ausHistorischemStand(fd: FormData, heute: Date = heuteDerDemo()): boolean {
  const s = fd.get('stand');
  return typeof s === 'string' && s !== '' && leseStandAm(s, heute).historisch;
}
