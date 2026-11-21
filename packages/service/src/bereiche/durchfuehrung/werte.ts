import { DF_MIN_BEFUND_KOMMENTAR } from '@tcms/contract';
import {
  fehlendeWerte,
  toleranzLagen,
  type Kennzahl,
  type Toleranzlage,
  type WertEintrag,
  type Werte,
} from '@tcms/domain';
import { kanonisch, sha256 } from '@tcms/domain/audit';

/** Gespeicherter Inhalt einer Durchführung (Zeile), wie er eingereicht und gegengezeichnet wird. */
export interface GespeicherterInhalt {
  kontrolleStandId: string;
  schritte: unknown;
  werte: unknown;
  ergebnis: string | null;
  ergebnisKommentar: string | null;
}

/** Kanonischer Inhalt (für das Audit beim Einreichen, Regel 1/3). */
export function inhaltKanonisch(d: GespeicherterInhalt) {
  return {
    kontrolleStandId: d.kontrolleStandId,
    schritte: d.schritte ?? [],
    werte: d.werte ?? {},
    ergebnis: d.ergebnis,
    ergebnisKommentar: d.ergebnisKommentar,
  };
}

/**
 * Merkmal des gespeicherten Inhalts (SHA-256 über die kanonische Form):
 * gesehener Stand beim Speichern und Einreichen (TS-05) und Bindung des
 * eingereichten bzw. gegengezeichneten Inhalts im Audit.
 */
export function inhaltMerkmal(d: GespeicherterInhalt): string {
  return sha256(kanonisch(inhaltKanonisch(d)));
}

/** Kennzahl-Definitionen aus dem Kontrollstand (JSON) – nur bekannte Felder. */
export function leseKennzahlen(roh: unknown): Kennzahl[] {
  if (!Array.isArray(roh)) return [];
  const out: Kennzahl[] = [];
  for (const x of roh) {
    if (!x || typeof x !== 'object') continue;
    const k = x as Record<string, unknown>;
    if (typeof k['key'] !== 'string' || typeof k['label'] !== 'string') continue;
    const def: Kennzahl = {
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
export function leseWerte(roh: unknown, defs: readonly Kennzahl[]): Werte {
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
  kennzahlen: readonly Kennzahl[];
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
