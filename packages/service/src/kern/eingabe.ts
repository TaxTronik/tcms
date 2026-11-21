import { DienstFehler } from '@tcms/contract';

export const EINGABE_UNGUELTIG = 'Eingabe ungültig.';

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

/** Gruppiert die Feldfehler des Vertragsschemas in ihrer ursprünglichen Reihenfolge. */
export function pruefeEingabe<T>(schema: Schema<T>, eingabe: unknown, fehlergrenze = 50): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = Object.create(null);
  for (const i of p.error.issues.slice(0, fehlergrenze)) {
    const pfad = i.path.map(String).join('.') || 'eingabe';
    (felder[pfad] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', EINGABE_UNGUELTIG, { ...felder });
}
