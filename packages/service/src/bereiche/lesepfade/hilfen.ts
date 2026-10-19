// =============================================================================
// Hilfen des Bereichs „lesepfade": Eingaben prüfen (die Demo ruft ohne HTTP),
// Antworten gegen den Vertrag prüfen (fail closed) und interne Lesestände in
// JSON-Werte abbilden (ISO-Strings statt `Date`, ADR 0001 §7).
// =============================================================================

import { DienstFehler, type Akteur, type MandantBezug } from '@tcms/contract';

/**
 * Strukturelle Sicht auf ein zod-Schema aus `@tcms/contract` (der Service
 * hängt nicht selbst von zod ab).
 */
export interface Schema<T> {
  safeParse(wert: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

/** Prüft eine Eingabe mit dem Vertragsschema; Feldfehler als `UNGUELTIG`. */
export function pruefeEingabe<T>(schema: Schema<T>, eingabe: unknown): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = {};
  for (const i of p.error.issues.slice(0, 50)) {
    (felder[i.path.map(String).join('.') || 'eingabe'] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', 'Eingabe ungültig.', felder);
}

/** Interner Fehler: die eigene Antwort verletzt den Vertrag (nie als 400 an den Aufrufer). */
export class VertragsFehler extends Error {
  constructor(bereich: string) {
    super(`[service] Antwort von ${bereich} verletzt den Vertrag`);
    this.name = 'VertragsFehler';
  }
}

/**
 * Prüft die eigene Antwort streng gegen den Vertrag, bevor sie den Dienst
 * verlässt: unbekannte Felder oder falsche Typen ergeben einen internen Fehler
 * (500) statt einer ungeplanten Herausgabe von Daten.
 */
export function antwortNach<T>(schema: Schema<T>, bereich: string, wert: unknown): T {
  const p = schema.safeParse(wert);
  if (!p.success) throw new VertragsFehler(bereich);
  return p.data;
}

/** `Date` → ISO-8601 (UTC); `null` bleibt `null`. */
export function iso(d: Date): string;
export function iso(d: Date | null): string | null;
export function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Bildet einen intern bereits explizit aufgebauten Lesestand in JSON-Werte ab:
 * `Date` → ISO-String, Felder mit `undefined` entfallen. Alles, was kein
 * schlichter JSON-Wert ist (Map, Set, Klassen, Funktionen, BigInt), ist ein
 * Programmierfehler und wird abgewiesen.
 */
export function alsJson(wert: unknown): unknown {
  if (wert === null || typeof wert === 'string' || typeof wert === 'boolean') return wert;
  if (typeof wert === 'number') {
    if (!Number.isFinite(wert)) throw new VertragsFehler('alsJson');
    return wert;
  }
  if (wert instanceof Date) return wert.toISOString();
  if (Array.isArray(wert)) return wert.map(alsJson);
  if (typeof wert === 'object' && Object.getPrototypeOf(wert) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wert)) if (v !== undefined) out[k] = alsJson(v);
    return out;
  }
  throw new VertragsFehler('alsJson');
}

/** Nur Kanzleipersonen (mandantenübergreifende Lesepfade, ADR 0001 §3.3). */
export function nurKanzlei(a: Akteur): Extract<Akteur, { art: 'KANZLEI' }> {
  if (a.art !== 'KANZLEI') {
    throw new DienstFehler('NICHT_BERECHTIGT', 'Nur für Personen der Kanzlei.');
  }
  return a;
}

/**
 * Akteur mit Bezug auf einen Mandanten aus der von der kanzleikonsole
 * bestätigten Liste (Body, gebunden über `req.b`, ADR 0001 §3.3). Wirkt wie
 * `cli` für genau diesen Mandanten; der Bezug aus der Bestätigung selbst wird
 * dabei ersetzt, nie ergänzt.
 */
export function mitListenBezug(
  a: Extract<Akteur, { art: 'KANZLEI' }>,
  bezug: MandantBezug,
): Extract<Akteur, { art: 'KANZLEI' }> {
  return Object.freeze({
    ...a,
    mandant: Object.freeze({
      id: bezug.id.toLowerCase(),
      zustaendigBerufstraeger: bezug.zustaendigBerufstraeger === true,
      hauptbearbeitung: bezug.hauptbearbeitung === true,
    }),
  });
}
