// =============================================================================
// Reine Helfer der Kontrolldurchführung: Kennzahlen, Toleranzlage und die
// Prüfung vor dem Einreichen. Ohne I/O. Die Demo-Oberfläche rechnet für die
// Live-Anzeige mit derselben Logik (apps/web/src/components/durchfuehrung/
// werte.ts); maßgeblich für das Einreichen ist ausschließlich diese Prüfung
// im Service. Vorschlag: beide nach @tcms/domain verschieben (Bericht).
// =============================================================================

import { DF_MIN_BEFUND_KOMMENTAR } from '@tcms/contract';

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

/** Gespeicherte Werte je Kennzahl (Objekt ohne Prototyp, Schlüssel nur aus der Kontrolle). */
export type Werte = Readonly<Record<string, WertEintrag>>;

export type Toleranzlage = 'OK' | 'ERKLAERT' | 'AUSSERHALB';

const leer = (): WertEintrag => ({ wert: null, bemerkung: '', erklaert: false });

/** Kennzahl-Definitionen aus dem Kontrollstand (JSON) – nur bekannte Felder. */
export function leseKennzahlen(roh: unknown): KennzahlDef[] {
  if (!Array.isArray(roh)) return [];
  const out: KennzahlDef[] = [];
  for (const x of roh) {
    if (!x || typeof x !== 'object') continue;
    const k = x as Record<string, unknown>;
    if (typeof k['key'] !== 'string' || typeof k['label'] !== 'string') continue;
    const def: KennzahlDef = {
      key: k['key'],
      label: k['label'],
      sollEur: typeof k['sollEur'] === 'number' ? k['sollEur'] : null,
    };
    const d = k['differenzAus'];
    if (Array.isArray(d) && d.length === 2 && d.every((s) => typeof s === 'string')) {
      def.differenzAus = [d[0] as string, d[1] as string];
    }
    out.push(def);
  }
  return out;
}

/** Schritt-Definitionen aus dem Kontrollstand (JSON). */
export function leseSchrittDefs(roh: unknown): { titel: string; hinweis: string }[] {
  if (!Array.isArray(roh)) return [];
  return roh.map((x) => {
    const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      titel: typeof s['titel'] === 'string' ? s['titel'] : '',
      hinweis: typeof s['hinweis'] === 'string' ? s['hinweis'] : '',
    };
  });
}

/** Gespeicherte Antworten je Schritt (JSON), auf die Zahl der Schritte gekürzt bzw. aufgefüllt. */
export function leseSchrittAntworten(
  roh: unknown,
  anzahl: number,
): { erledigt: boolean; kommentar: string }[] {
  const liste = Array.isArray(roh) ? roh : [];
  return Array.from({ length: anzahl }, (_, i) => {
    const a = (liste[i] && typeof liste[i] === 'object' ? liste[i] : {}) as Record<string, unknown>;
    return {
      erledigt: a['erledigt'] === true,
      kommentar: typeof a['kommentar'] === 'string' ? a['kommentar'] : '',
    };
  });
}

/** Gespeicherte Werte robust lesen: nur Kennzahlen der Kontrolle, fehlende Einträge leer. */
export function leseWerte(roh: unknown, defs: readonly KennzahlDef[]): Werte {
  const out: Record<string, WertEintrag> = Object.create(null);
  const quelle = roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  for (const def of defs) {
    if (!Object.prototype.hasOwnProperty.call(quelle, def.key)) continue;
    const e = (quelle as Record<string, unknown>)[def.key];
    if (!e || typeof e !== 'object') continue;
    const w = e as Record<string, unknown>;
    out[def.key] = {
      wert: typeof w['wert'] === 'number' && Number.isFinite(w['wert']) ? w['wert'] : null,
      bemerkung: typeof w['bemerkung'] === 'string' ? w['bemerkung'] : '',
      erklaert: w['erklaert'] === true,
    };
  }
  return out;
}

function lage(
  abweichung: number | null,
  toleranz: number | null,
  e: WertEintrag,
): Toleranzlage | null {
  if (abweichung == null) return null;
  const grenze = toleranz ?? 0;
  if (Math.abs(abweichung) <= grenze + 0.004) return 'OK';
  return e.erklaert && e.bemerkung.trim().length > 0 ? 'ERKLAERT' : 'AUSSERHALB';
}

/** Kennzahl mit berechneten Werten (Differenz, Abweichung) und Toleranzlage. */
export interface KennzahlLage {
  def: KennzahlDef;
  /** Erfasster Wert bzw. berechnete Differenz (a − b, auf Cent gerundet). */
  wert: number | null;
  /** Abweichung gegen das Soll bzw. die Differenz selbst; null = keine Toleranzprüfung. */
  abweichung: number | null;
  lage: Toleranzlage | null;
  /** Differenzkennzahl (berechnet, nicht erfasst). */
  berechnet: boolean;
}

/** Toleranzlage je Kennzahl inkl. berechneter Differenzen (einzige Rechnung, auch für die Anzeige). */
export function toleranzLagen(
  defs: readonly KennzahlDef[],
  werte: Werte,
  toleranzEur: number | null,
): KennzahlLage[] {
  return defs.map((def) => {
    const e = werte[def.key] ?? leer();
    if (def.differenzAus) {
      const a = werte[def.differenzAus[0]]?.wert ?? null;
      const b = werte[def.differenzAus[1]]?.wert ?? null;
      const diff = a != null && b != null ? Math.round((a - b) * 100) / 100 : null;
      return {
        def,
        wert: diff,
        abweichung: diff,
        lage: lage(diff, toleranzEur, e),
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

export interface EinreichPruefung {
  schritteErledigt: number;
  schritteGesamt: number;
  werteFehlend: string[];
  ausserhalb: string[];
  /** Je Kennzahl die berechneten Werte und die Toleranzlage (Grundlage von `ausserhalb`). */
  kennzahlen: {
    key: string;
    label: string;
    wert: number | null;
    abweichung: number | null;
    lage: Toleranzlage | null;
    berechnet: boolean;
  }[];
  nachweise: number;
  mindestNachweise: number;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  kommentarFehlt: boolean;
  maengel: string[];
}

/** Voraussetzungen für das Einreichen; `maengel` leer = einreichbar. */
export function pruefeEinreichung(x: {
  schritte: readonly { erledigt: boolean }[];
  kennzahlen: readonly KennzahlDef[];
  werte: Werte;
  toleranzEur: number | null;
  nachweise: number;
  mindestNachweise: number;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
}): EinreichPruefung {
  const erledigt = x.schritte.filter((s) => s.erledigt).length;
  const werteFehlend = fehlendeWerte(x.kennzahlen, x.werte);
  const lagen = toleranzLagen(x.kennzahlen, x.werte, x.toleranzEur);
  const ausserhalb = lagen.filter((z) => z.lage === 'AUSSERHALB').map((z) => z.def.label);
  const kommentarFehlt =
    x.ergebnis === 'MIT_BEFUND' &&
    (x.ergebnisKommentar ?? '').trim().length < DF_MIN_BEFUND_KOMMENTAR;
  const maengel: string[] = [];
  if (erledigt < x.schritte.length)
    maengel.push(`${x.schritte.length - erledigt} von ${x.schritte.length} Schritten offen`);
  if (werteFehlend.length) maengel.push(`Werte fehlen: ${werteFehlend.join(', ')}`);
  if (ausserhalb.length && x.ergebnis !== 'MIT_BEFUND')
    maengel.push(`Abweichung außerhalb der Toleranz ohne Erklärung: ${ausserhalb.join(', ')}`);
  if (x.nachweise < x.mindestNachweise)
    maengel.push(`Nachweise: ${x.nachweise} von mindestens ${x.mindestNachweise}`);
  if (!x.ergebnis) maengel.push('Ergebnis nicht gewählt');
  if (kommentarFehlt)
    maengel.push(`Befund beschreiben (mindestens ${DF_MIN_BEFUND_KOMMENTAR} Zeichen)`);
  return {
    schritteErledigt: erledigt,
    schritteGesamt: x.schritte.length,
    werteFehlend,
    ausserhalb,
    kennzahlen: lagen.map((z) => ({
      key: z.def.key,
      label: z.def.label,
      wert: z.wert,
      abweichung: z.abweichung,
      lage: z.lage,
      berechnet: z.berechnet,
    })),
    nachweise: x.nachweise,
    mindestNachweise: x.mindestNachweise,
    ergebnis: x.ergebnis,
    kommentarFehlt,
    maengel,
  };
}
