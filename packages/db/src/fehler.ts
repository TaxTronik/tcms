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

const istEingabeCode = (c: unknown): c is EingabeFehlercode =>
  typeof c === 'string' && (EINGABE_FEHLERCODES as readonly string[]).includes(c);

/**
 * Code eines Datenbankfehlers wegen ungültiger Texteingabe, sonst `null`.
 * Sucht in `code`/`originalCode` des Fehlers und seiner Ursachen
 * (`meta`, `driverAdapterError`, `cause`; höchstens fünf Ebenen).
 */
export function eingabeFehlercode(e: unknown): EingabeFehlercode | null {
  const gesehen = new Set<object>();
  const suche = (x: unknown, tiefe: number): EingabeFehlercode | null => {
    if (!x || typeof x !== 'object' || tiefe > 5 || gesehen.has(x)) return null;
    gesehen.add(x);
    const o = x as Record<string, unknown>;
    if (istEingabeCode(o['originalCode'])) return o['originalCode'];
    if (istEingabeCode(o['code'])) return o['code'];
    for (const k of ['meta', 'driverAdapterError', 'cause']) {
      const r = suche(o[k], tiefe + 1);
      if (r) return r;
    }
    return null;
  };
  return suche(e, 0);
}
