// =============================================================================
// Geschäftsprofil lesen (gemeinsamer Kern der Bereiche risiken-kontrollen und
// programm-beschreibung): Strukturprüfung mit dem Vertragsschema
// `ProfilAntwortenGespeichertSchema` (strikt, Zusatzfelder abgewiesen;
// gespeicherte Bezeichnungen ohne Zeichenregel, damit Profile vor RT4-T-03
// lesbar bleiben – Eingaben prüft `ProfilAntwortenSchema`), danach die
// zod-freien Profilregeln aus `@tcms/domain` (Bereinigung, Fehlertexte).
// =============================================================================

import { ProfilAntwortenGespeichertSchema, type ProfilAntworten } from '@tcms/contract';
import { bereinigeProfil, profilStrukturFehler, type Geschaeftsprofil } from '@tcms/domain';

// Typprüfung: Das Vertragsschema beschreibt genau das Geschäftsprofil der Domain.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _vertragPasst: Gleich<ProfilAntworten, Geschaeftsprofil> = true;
void _vertragPasst;

/** Strukturprüfung; liefert das bereinigte Profil oder lesbare Fehler je Profilfrage. */
export function leseProfil(roh: unknown): { profil: Geschaeftsprofil | null; fehler: string[] } {
  const p = ProfilAntwortenGespeichertSchema.safeParse(roh);
  if (!p.success) return { profil: null, fehler: profilStrukturFehler(p.error.issues) };
  return { profil: bereinigeProfil(p.data), fehler: [] };
}
