// =============================================================================
// Reine Helfer für Kennzahlen und Toleranzen einer Kontrolldurchführung.
// Ohne I/O, damit Server (Prüfung beim Einreichen) und Client (Live-Anzeige
// der Differenz) dieselbe Rechnung verwenden.
// =============================================================================

export interface KennzahlDef {
  key: string;
  label: string;
  /** Sollwert in Euro (z. B. 0 für Clearingkonten); null = kein Soll. */
  sollEur: number | null;
  /** Differenzkennzahl aus zwei erfassten Werten (a − b). */
  differenzAus?: [string, string];
}

export interface WertEintrag {
  wert: number | null;
  bemerkung: string;
  erklaert: boolean;
}

export type Werte = Record<string, WertEintrag>;

/** Lage einer Abweichung zur Toleranz der Kontrolle. */
export type Toleranzlage = 'OK' | 'ERKLAERT' | 'AUSSERHALB';

export interface WertZeile {
  def: KennzahlDef;
  /** Erfasster Wert bzw. berechnete Differenz. */
  wert: number | null;
  /** Abweichung gegen Soll bzw. Differenz; null = keine Toleranzprüfung. */
  abweichung: number | null;
  lage: Toleranzlage | null;
  bemerkung: string;
  erklaert: boolean;
  berechnet: boolean;
}

export function leererEintrag(): WertEintrag {
  return { wert: null, bemerkung: '', erklaert: false };
}

/** Liest die gespeicherten Werte robust (fehlende Schlüssel → leer). */
export function normalisiereWerte(roh: unknown): Werte {
  const out: Werte = {};
  if (!roh || typeof roh !== 'object') return out;
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    out[k] = {
      wert:
        typeof e['wert'] === 'number' && Number.isFinite(e['wert']) ? (e['wert'] as number) : null,
      bemerkung: typeof e['bemerkung'] === 'string' ? (e['bemerkung'] as string) : '',
      erklaert: e['erklaert'] === true,
    };
  }
  return out;
}

/**
 * Deutsche Dezimaleingabe („412.380,15", „-12,5", „0") → Zahl.
 * Leere Eingabe → null; unlesbare Eingabe → 'fehler'.
 */
export function parseDezimal(eingabe: string): number | null | 'fehler' {
  let s = eingabe.replace(/[\s €]/g, '');
  if (s === '') return null;
  s = s.replace(/^−/, '-');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'fehler';
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) >= 1e12) return 'fehler';
  return Math.round(n * 100) / 100;
}

/** Zahl → Eingabetext im de-DE-Format ohne Tausenderpunkte. */
export function alsEingabe(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toFixed(2).replace('.', ',');
}

function lage(
  abweichung: number | null,
  toleranz: number | null,
  eintrag: WertEintrag,
): Toleranzlage | null {
  if (abweichung == null) return null;
  const grenze = toleranz ?? 0;
  if (Math.abs(abweichung) <= grenze + 0.004) return 'OK';
  return eintrag.erklaert && eintrag.bemerkung.trim().length > 0 ? 'ERKLAERT' : 'AUSSERHALB';
}

/** Zeilen der Werte-Tabelle inkl. berechneter Differenzen und Toleranzlage. */
export function werteZeilen(
  defs: readonly KennzahlDef[],
  werte: Werte,
  toleranzEur: number | null,
): WertZeile[] {
  return defs.map((def) => {
    const e = werte[def.key] ?? leererEintrag();
    if (def.differenzAus) {
      const a = werte[def.differenzAus[0]]?.wert ?? null;
      const b = werte[def.differenzAus[1]]?.wert ?? null;
      const diff = a != null && b != null ? Math.round((a - b) * 100) / 100 : null;
      return {
        def,
        wert: diff,
        abweichung: diff,
        lage: lage(diff, toleranzEur, e),
        bemerkung: e.bemerkung,
        erklaert: e.erklaert,
        berechnet: true,
      };
    }
    const abw =
      def.sollEur != null && e.wert != null ? Math.round((e.wert - def.sollEur) * 100) / 100 : null;
    return {
      def,
      wert: e.wert,
      abweichung: abw,
      lage: lage(abw, toleranzEur, e),
      bemerkung: e.bemerkung,
      erklaert: e.erklaert,
      berechnet: false,
    };
  });
}

/** Bezeichnungen erfasster Kennzahlen ohne Wert. */
export function fehlendeWerte(defs: readonly KennzahlDef[], werte: Werte): string[] {
  return defs
    .filter((d) => !d.differenzAus && (werte[d.key]?.wert ?? null) == null)
    .map((d) => d.label);
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

export const MAX_DATEI_BYTES = 20 * 1024 * 1024;
