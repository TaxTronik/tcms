import 'server-only';
import { DienstFehler } from '@tcms/contract';
import { imDienst, type DienstKontext } from '@tcms/service';
import { DEMO_PORTS } from './demo';
import { brauchtKanzleiFuer, demoAkteur } from './sitzung';
import { leseStand } from './zeit';

// =============================================================================
// Aufrufe des Bereichs „risiken-kontrollen" aus der Demo (Server Actions und
// Seiten-Lader). Die Demo spielt die kanzleikonsole: Sie bildet den Akteur der
// angemeldeten Person mit Bezug auf den Mandanten des Formulars (`cli`) und
// ruft die Service-Funktion im Dienstkontext auf. Rechte, Zustände und
// Sperren prüft ausschließlich der Service; hier werden nur Formularfelder
// gelesen und Fehler in Meldungen übersetzt.
// =============================================================================

/** Erstes Vorkommen eines Formularfelds als Text, sonst ''. */
export function feld(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
}

/** Formular aus einem historischen Stichtag (Mutationen dort deaktiviert, AGENTS.md Regel 6). */
export function historisch(fd: FormData): boolean {
  const s = feld(fd, 'stand');
  return s !== '' && leseStand(s).historisch;
}

export interface Meldungen {
  /** Text bei Eingabefehlern laut Schema (Feldfehler). */
  ungueltig: string;
  nichtGefunden?: string;
}

/** Fachliche Meldung eines DienstFehlers; Schemafehler und „nicht gefunden" mit eigenem Text. */
export function meldung(e: DienstFehler, m: Meldungen): string {
  if (e.code === 'NICHT_GEFUNDEN') return m.nichtGefunden ?? 'Nicht gefunden.';
  // Fachliche Prüfungen nennen ihren Grund; reine Schemafehler bekommen den Formulartext.
  const fachlich = e.message !== e.code && e.message !== 'Eingabe ungültig.';
  if (e.code === 'UNGUELTIG') return fachlich ? e.message : m.ungueltig;
  return fachlich ? e.message : 'Die Aktion ist nicht möglich.';
}

/**
 * Führt eine Fachoperation für die angemeldete Kanzleiperson mit Bezug auf
 * `mandantId` aus. Ohne Sitzung bzw. als Mandantenkontakt: Weiterleitung
 * (wie bisher). DienstFehler werden zur Meldung, alles andere wird geworfen.
 */
export async function fuehreAus<T>(
  mandantId: string,
  fn: (ctx: DienstKontext) => Promise<T>,
  m: Meldungen,
): Promise<{ wert: T } | { fehler: string }> {
  const akteur = await brauchtKanzleiFuer(mandantId);
  try {
    return {
      wert: await imDienst(akteur, DEMO_PORTS, fn, { timeoutMs: 30_000, maxWaitMs: 10_000 }),
    };
  } catch (e) {
    if (e instanceof DienstFehler) return { fehler: meldung(e, m) };
    throw e;
  }
}

/** Lesen im Dienstkontext der angemeldeten Person; ohne Sitzung oder Leserecht: null. */
export async function lies<T>(
  mandantId: string,
  fn: (ctx: DienstKontext) => Promise<T>,
): Promise<T | null> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return null;
  try {
    return await imDienst(akteur, DEMO_PORTS, fn);
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return null;
    throw e;
  }
}
