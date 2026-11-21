import { toleranzLagen, type Kennzahl, type Toleranzlage, type Werte } from '@tcms/domain';

/** Mit Dezimalkomma: Ziffern bzw. Tausendergruppen mit Punkt, genau ein Komma. */
const MIT_KOMMA = /^-?(\d{1,3}(\.\d{3})+|\d+),\d+$/;
/** Ohne Komma, nur Tausendergruppen („1.234", „12.500.000"). */
const NUR_TAUSENDER = /^-?\d{1,3}(\.\d{3})+$/;
/** Ohne Komma, höchstens ein Punkt als Dezimaltrenner („1234.56"). */
const MIT_PUNKT = /^-?\d+(\.\d+)?$/;

/**
 * Deutsche Dezimaleingabe („412.380,15", „-12,5", „0", „1.234,56 €") → Zahl,
 * auf Cent gerundet. Ohne Komma gilt ein Punkt nur dann als Dezimaltrenner,
 * wenn er keine Tausendergruppe bildet („1234.56" → 1234,56; „1.234" → 1234).
 * Mehrdeutiges („12,345.67", „1,234,5"), Hex und Exponent sind unlesbar.
 * Leerzeichen (auch geschützte) und „€" werden ignoriert.
 * Leere Eingabe → null; unlesbare Eingabe → 'fehler'.
 */
export function parseDezimal(eingabe: string): number | null | 'fehler' {
  let s = eingabe.replace(/[\s€]/g, '');
  if (s === '') return null;
  s = s.replace(/^−/, '-');
  if (s.includes(',')) {
    if (!MIT_KOMMA.test(s)) return 'fehler';
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (NUR_TAUSENDER.test(s)) s = s.replace(/\./g, '');
  else if (!MIT_PUNKT.test(s)) return 'fehler';
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) >= 1e12) return 'fehler';
  return Math.round(n * 100) / 100;
}

/** Zahl → Eingabetext im de-DE-Format ohne Tausenderpunkte. */
export function alsEingabe(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toFixed(2).replace('.', ',');
}

/** Ergänzt die Anzeige um die beim Messwert erfasste Erläuterung. */
export function werteZeilen(
  kennzahlen: readonly Kennzahl[],
  werte: Werte,
  toleranzEur: number | null,
) {
  return toleranzLagen(kennzahlen, werte, toleranzEur).map((zeile) => ({
    ...zeile,
    bemerkung: werte[zeile.def.key]?.bemerkung ?? '',
    erklaert: werte[zeile.def.key]?.erklaert ?? false,
  }));
}

export const LAGE_TEXT: Record<Toleranzlage, string> = {
  OK: 'innerhalb Toleranz',
  ERKLAERT: 'Differenz erklärt',
  AUSSERHALB: 'außerhalb Toleranz',
};

export const LAGE_BADGE: Record<Toleranzlage, string> = {
  OK: 'badge-green',
  ERKLAERT: 'badge-yellow',
  AUSSERHALB: 'badge-red',
};

/** Dateigröße kompakt in de-DE. */
export function fmtGroesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/**
 * Höchstens 20 MiB Dateien je Upload (eine Server Action): Nachweise je Datei und
 * je Upload, Portal-Anlagen zusammen je Meldung. Das Body-Limit der Server
 * Actions (next.config.mjs, 21 MiB) lässt Raum für die übrigen Formularfelder.
 */
export const MAX_DATEI_BYTES = 20 * 1024 * 1024;
