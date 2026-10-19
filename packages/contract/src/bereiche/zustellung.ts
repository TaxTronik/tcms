// =============================================================================
// Vertrag (zod) der Zustellung von Nachrichten (Stufe 4): Gründe, aus denen die
// kanzleikonsole eine Nachricht nicht zustellen konnte.
//
// Eigene Datei, damit mehrere Bereiche sie ohne Importzyklus nutzen können
// (`programm-beschreibung` importiert bereits aus `risiken-kontrollen`).
// Hängt nur von zod ab.
// =============================================================================

import { z } from 'zod';

/**
 * Gründe einer Unzustellbarkeit (feste Liste, kein Freitext): Empfänger gehört
 * nicht (mehr) zum Mandanten bzw. ist unbekannt, Empfänger hat keinen
 * bestätigten Portalzugang, die Zustellfrist der kanzleikonsole ist
 * abgelaufen, sonstiger Grund.
 */
export const NACHRICHT_UNZUSTELLBAR_GRUENDE = [
  'EMPFAENGER_UNGUELTIG',
  'KEIN_PORTALZUGANG',
  'ABGELAUFEN',
  'SONSTIGES',
] as const;
export const NachrichtUnzustellbarGrundSchema = z.enum(NACHRICHT_UNZUSTELLBAR_GRUENDE);
export type NachrichtUnzustellbarGrund = z.infer<typeof NachrichtUnzustellbarGrundSchema>;
