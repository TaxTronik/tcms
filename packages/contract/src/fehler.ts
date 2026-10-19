// =============================================================================
// Antwortumschlag und Fehlercodes des HTTP-Vertrags (ADR 0001, Abschnitt 7).
// =============================================================================

import { z } from 'zod';

export const FEHLER_STATUS = {
  UNGUELTIG: 400,
  NICHT_AUTHENTIFIZIERT: 401,
  NICHT_BERECHTIGT: 403,
  NICHT_GEFUNDEN: 404,
  KONFLIKT: 409,
  ZU_GROSS: 413,
  INTERN: 500,
} as const;

export type FehlerCode = keyof typeof FEHLER_STATUS;

export const FehlerSchema = z
  .object({
    code: z.enum(Object.keys(FEHLER_STATUS) as [FehlerCode, ...FehlerCode[]]),
    meldung: z.string().max(500).optional(),
    felder: z.record(z.string(), z.array(z.string().max(300)).max(20)).optional(),
  })
  .strict();

export type Fehler = z.infer<typeof FehlerSchema>;

export type Antwort<T> = { ok: true; daten: T } | { ok: false; fehler: Fehler };

export function antwortSchema<T extends z.ZodType>(daten: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), daten }).strict(),
    z.object({ ok: z.literal(false), fehler: FehlerSchema }).strict(),
  ]);
}

/** Höchste Größe eines Anfrage-Bodys in Bytes. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Höchste Zahl Mandanten-IDs in mandantenübergreifenden Lesepfaden. */
export const MAX_MANDANTEN_JE_ANFRAGE = 5000;
