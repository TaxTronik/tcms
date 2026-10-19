// =============================================================================
// Vertrag (zod) des Bereichs „lesepfade" (Welle 2): Eingaben und Antworten.
// =============================================================================

import { z } from 'zod';

/**
 * Stichtag `YYYY-MM-DD` (nur gültige Kalendertage). Gemeinsam für alle Leser
 * mit `?stand=` (ADR 0001 §7); schreibende Operationen nehmen keinen Stichtag
 * an (TS-07).
 */
export const StandSchema = z.iso.date();

/**
 * Tax-CMS-Kontext eines Mandanten lesen. Ohne `stand` gilt „heute" der Uhr;
 * ein Stand ab heute ist der aktuelle Stand (nicht historisch).
 */
export const KontextEingabeSchema = z
  .object({
    mandantId: z.uuid(),
    stand: StandSchema.optional(),
  })
  .strict();

export type KontextEingabe = z.infer<typeof KontextEingabeSchema>;
