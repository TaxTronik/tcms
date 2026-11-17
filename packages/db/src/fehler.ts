// =============================================================================
// Datenbankfehler wegen ungültiger Texteingaben (RT4-T-08). PostgreSQL weist
// beim Speichern ab, was keine gültige Zeichenkette ist:
//
//   22021  character_not_in_repertoire   NUL in TEXT („invalid byte sequence 0x00")
//   22P05  untranslatable_character      `\u0000` in JSONB
//   22P02  invalid_text_representation   ungültiges JSON (einzelnes Surrogat),
//                                         ungültige UUID u. a.
//
// Der Vertrag weist solche Eingaben vorher ab (Text-Basisregel); bleibt eine
// Lücke, antwortet der Dienst `400 UNGUELTIG` statt `500 INTERN`. Gelesen
// werden nur die Codes (Prisma mit adapter-pg: `meta.driverAdapterError.cause`,
// `pg` direkt: `code`), nie Meldungen oder Details – sie enthalten Eingabewerte.
// =============================================================================

export const EINGABE_FEHLERCODES = ['22P05', '22021', '22P02'] as const;
export type EingabeFehlercode = (typeof EINGABE_FEHLERCODES)[number];

/**
 * Zeitlimits der Transaktion (`mitTenant`, Befund 33):
 *
 *   55P03  lock_not_available   `lock_timeout`: zu lange auf eine Sperre gewartet
 *   57014  query_canceled       `statement_timeout`: Anweisung zu lange gelaufen
 *
 * Dienst und Dienstkern antworten darauf `503 ZEITLIMIT` (wiederholbar) statt
 * `500 INTERN`; ins Log nur der Code.
 */
export const ZEITLIMIT_FEHLERCODES = ['55P03', '57014'] as const;
export type ZeitlimitFehlercode = (typeof ZEITLIMIT_FEHLERCODES)[number];

/**
 * Erster Code aus `codes` in `code`/`originalCode` des Fehlers und seiner
 * Ursachen (`meta`, `driverAdapterError`, `cause`; höchstens fünf Ebenen).
 */
function sucheCode<C extends string>(e: unknown, codes: readonly C[]): C | null {
  const passt = (c: unknown): c is C => typeof c === 'string' && codes.includes(c as C);
  const gesehen = new Set<object>();
  const suche = (x: unknown, tiefe: number): C | null => {
    if (!x || typeof x !== 'object' || tiefe > 5 || gesehen.has(x)) return null;
    gesehen.add(x);
    const o = x as Record<string, unknown>;
    if (passt(o['originalCode'])) return o['originalCode'];
    if (passt(o['code'])) return o['code'];
    for (const k of ['meta', 'driverAdapterError', 'cause']) {
      const r = suche(o[k], tiefe + 1);
      if (r) return r;
    }
    return null;
  };
  return suche(e, 0);
}

/** Code eines Datenbankfehlers wegen ungültiger Texteingabe, sonst `null`. */
export function eingabeFehlercode(e: unknown): EingabeFehlercode | null {
  return sucheCode(e, EINGABE_FEHLERCODES);
}

/** Code eines Zeitlimits der Datenbank (Sperre, Anweisung), sonst `null`. */
export function zeitlimitFehlercode(e: unknown): ZeitlimitFehlercode | null {
  return sucheCode(e, ZEITLIMIT_FEHLERCODES);
}

// =============================================================================
// Gleichzeitige Änderungen (TS-05, Befund 92). Die Datenbank weist ab, wenn
// zwei Transaktionen sich in die Quere kommen:
//
//   23505  unique_violation        eindeutiger Schlüssel (Prisma: P2002)
//   40001  serialization_failure   Schreibkonflikt (Prisma: P2034)
//   40P01  deadlock_detected       Verklemmung; Prisma 7 mit adapter-pg kennt
//                                   dafür keinen eigenen Code (P2039 bei
//                                   Modellabfragen, P2010 bei Raw-SQL), der
//                                   SQLSTATE steht nur in
//                                   `meta.driverAdapterError.cause.originalCode`
//
// Gelesen werden wie oben nur die Codes, mit derselben Suchstrecke.
// =============================================================================

export const KONFLIKT_FEHLERCODES = ['23505', '40001', '40P01'] as const;
export type KonfliktFehlercode = (typeof KONFLIKT_FEHLERCODES)[number];

/** Prisma-Codes, die genau einem SQLSTATE entsprechen. */
const PRISMA_KONFLIKT: Readonly<Record<string, KonfliktFehlercode>> = {
  P2002: '23505',
  P2034: '40001',
};

function alsKonfliktCode(c: unknown): KonfliktFehlercode | null {
  if (typeof c !== 'string') return null;
  if ((KONFLIKT_FEHLERCODES as readonly string[]).includes(c)) return c as KonfliktFehlercode;
  return Object.hasOwn(PRISMA_KONFLIKT, c) ? PRISMA_KONFLIKT[c]! : null;
}

/**
 * SQLSTATE einer gleichzeitigen Änderung (Eindeutigkeit, Serialisierung,
 * Verklemmung), sonst `null`. Sucht wie `eingabeFehlercode` in
 * `code`/`originalCode` des Fehlers und seiner Ursachen (`meta`,
 * `driverAdapterError`, `cause`; höchstens fünf Ebenen); Prisma-Codes P2002
 * und P2034 zählen als 23505 bzw. 40001.
 */
export function konfliktFehlercode(e: unknown): KonfliktFehlercode | null {
  const gesehen = new Set<object>();
  const suche = (x: unknown, tiefe: number): KonfliktFehlercode | null => {
    if (!x || typeof x !== 'object' || tiefe > 5 || gesehen.has(x)) return null;
    gesehen.add(x);
    const o = x as Record<string, unknown>;
    const direkt = alsKonfliktCode(o['originalCode']) ?? alsKonfliktCode(o['code']);
    if (direkt) return direkt;
    for (const k of ['meta', 'driverAdapterError', 'cause']) {
      const r = suche(o[k], tiefe + 1);
      if (r) return r;
    }
    return null;
  };
  return suche(e, 0);
}
