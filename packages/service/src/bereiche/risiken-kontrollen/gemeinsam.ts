// =============================================================================
// Gemeinsame Bausteine des Bereichs „risiken-kontrollen": Eingabeprüfung,
// Rechte, Zeilensperren (TS-05), Programm des Mandanten, Abbildung nach JSON.
//
// Reihenfolge jeder Operation (Welle 2):
//   1. Eingabe strikt prüfen (Contract-Schema; die Demo ruft ohne HTTP).
//   2. Rechte aus dem Akteur: ohne Lesebezug zum Mandanten NICHT_GEFUNDEN (kein
//      Existenz-Orakel), ohne Bearbeitungsrecht NICHT_BERECHTIGT – beides vor
//      dem ersten Zugriff auf Objekte, damit keine Antwort die Existenz einer
//      fremden ID verrät.
//   3. Objekt in derselben Transaktion sperren, und zwar nur, wenn es zum
//      Programm dieses Mandanten gehört (RLS trennt nur Tenants), dann den
//      Zustand unter der Sperre lesen, prüfen und ändern.
// Sperrreihenfolge, damit sich Operationen nicht gegenseitig blockieren:
// Programm → Risiken (nach ID) → Kontrollen (nach ID) → Durchführungen.
// =============================================================================

import { DienstFehler, type Akteur } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten, kannLesen } from '../../rechte';

/** Einheitlicher Grund fehlender Bearbeitungsrechte (Fachkonzept 6.8). */
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const ZWEITE_PERSON =
  'Die Entscheidung trifft eine zweite Person – nicht die beantragende bzw. einreichende Person.';

/** Strukturelle Sicht auf ein zod-Schema (der Dienst hängt nicht direkt von zod ab). */
interface Schema<T> {
  safeParse(
    wert: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/** Prüft die Eingabe mit dem Contract-Schema; Feldfehler als `UNGUELTIG`. */
export function pruefeEingabe<T>(schema: Schema<T>, eingabe: unknown): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = {};
  for (const i of p.error.issues.slice(0, 50)) {
    const pfad = i.path.map(String).join('.') || 'eingabe';
    (felder[pfad] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', 'Eingabe ungültig.', felder);
}

/** Kanonische Personen- bzw. Mandanten-ID (UUID in Kleinbuchstaben). */
export function kanonisch(id: string): string {
  return id.toLowerCase();
}

/**
 * Staff-Lesen (Risikoinventar, Kontrollmatrix, Profil): nur Kanzleipersonen
 * mit bestätigtem Bezug zu genau diesem Mandanten (TS-03). Mandantenkontakte
 * lesen diese Sichten nicht (Portal-Endpunkte liegen in anderen Bereichen).
 */
export function pruefeStaffLesen(a: Akteur, mandantId: string): void {
  if (a.art !== 'KANZLEI' || !kannLesen(a, mandantId)) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Bearbeiten: wie Lesen, zusätzlich `kannBearbeiten` (sonst NICHT_BERECHTIGT mit Grund). */
export function pruefeBearbeiten(a: Akteur, mandantId: string): void {
  pruefeStaffLesen(a, mandantId);
  if (!kannBearbeiten(a, mandantId)) throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
}

export interface ProgrammRef {
  id: string;
  mandantId: string;
}

/** Programm des Mandanten (höchstens eines je Mandant); sonst NICHT_GEFUNDEN. */
export async function programmDes(tx: Tx, mandantId: string): Promise<ProgrammRef> {
  const p = await tx.tcmsProgramm.findFirst({
    where: { mandantId },
    select: { id: true, mandantId: true },
  });
  if (!p) throw new DienstFehler('NICHT_GEFUNDEN');
  return p;
}

// -----------------------------------------------------------------------------
// Zeilensperren (TS-05). Parametrisiert, feste Tabellennamen; RLS gilt auch für
// SELECT … FOR UPDATE. Jede Sperre prüft zugleich die Zugehörigkeit zum
// Programm des Mandanten: eine fremde ID ergibt keine Zeile → NICHT_GEFUNDEN.
// -----------------------------------------------------------------------------

/** Sperrt das Programm des Mandanten (Profil, Risikoaufnahme). */
export async function sperreProgramm(tx: Tx, mandantId: string): Promise<ProgrammRef> {
  const z = await tx.$queryRaw<ProgrammRef[]>`
    SELECT "id", "mandantId"::text AS "mandantId" FROM "TcmsProgramm"
    WHERE "mandantId" = ${mandantId}::uuid FOR UPDATE`;
  if (z.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
  return z[0]!;
}

/** Sperrt Risiken des Programms in fester Reihenfolge; fehlt eines → NICHT_GEFUNDEN. */
export async function sperreRisiken(tx: Tx, programmId: string, ids: readonly string[]) {
  const sortiert = [...new Set(ids)].sort();
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Risiko"
    WHERE "programmId" = ${programmId} AND "id" = ANY(${sortiert}::text[])
    ORDER BY "id" FOR UPDATE`;
  if (z.length !== sortiert.length) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Sperrt Kontrollen des Programms in fester Reihenfolge; fehlt eine → NICHT_GEFUNDEN. */
export async function sperreKontrollen(tx: Tx, programmId: string, ids: readonly string[]) {
  const sortiert = [...new Set(ids)].sort();
  if (sortiert.length === 0) return;
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Kontrolle"
    WHERE "programmId" = ${programmId} AND "id" = ANY(${sortiert}::text[])
    ORDER BY "id" FOR UPDATE`;
  if (z.length !== sortiert.length) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Sperrt alle Durchführungen einer Kontrolle (vor einer Neuplanung). */
export async function sperreDurchfuehrungen(tx: Tx, kontrolleId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "Durchfuehrung" WHERE "kontrolleId" = ${kontrolleId}
    ORDER BY "id" FOR UPDATE`;
}

// -----------------------------------------------------------------------------
// Datenbankfehler → KONFLIKT
// -----------------------------------------------------------------------------

const KONFLIKT_CODES = new Set([
  // Prisma: Unique-Verletzung, Schreibkonflikt/Deadlock
  'P2002',
  'P2034',
  // PostgreSQL: unique_violation, serialization_failure, deadlock_detected
  '23505',
  '40001',
  '40P01',
]);

function fehlerCodes(e: unknown, tiefe = 0): string[] {
  if (!e || typeof e !== 'object' || tiefe > 4) return [];
  const x = e as { code?: unknown; meta?: { code?: unknown }; cause?: unknown };
  const out: string[] = [];
  if (typeof x.code === 'string') out.push(x.code);
  if (x.meta && typeof x.meta.code === 'string') out.push(x.meta.code);
  return [...out, ...fehlerCodes(x.cause, tiefe + 1)];
}

/**
 * Übersetzt gleichzeitige Änderungen (eindeutige Schlüssel, Deadlock,
 * Serialisierung) in `KONFLIKT`; alle anderen Fehler unverändert. Die
 * Transaktion ist danach ohnehin abgebrochen und rollt vollständig zurück.
 */
export async function konfliktSicher<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DienstFehler) throw e;
    if (fehlerCodes(e).some((c) => KONFLIKT_CODES.has(c))) {
      throw new DienstFehler('KONFLIKT', 'Der Stand wurde inzwischen geändert. Bitte neu laden.');
    }
    throw e;
  }
}

export function konflikt(meldung: string): DienstFehler {
  return new DienstFehler('KONFLIKT', meldung);
}

// -----------------------------------------------------------------------------
// Abbildung nach JSON
// -----------------------------------------------------------------------------

export function iso(d: Date): string;
export function iso(d: Date | null | undefined): string | null;
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Kalendertag `YYYY-MM-DD` eines Stichtags (UTC-Mitternacht). */
export function tag(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Anzeigenamen über das Personenverzeichnis (im Dienst leer). */
export async function namenFuer(
  ctx: DienstKontext,
  ids: Iterable<string | null | undefined>,
): Promise<Record<string, string>> {
  const menge = new Set<string>();
  for (const id of ids) if (id) menge.add(id);
  if (menge.size === 0) return {};
  const m = await ctx.personen.namen([...menge].sort());
  return Object.fromEntries([...m].filter(([id]) => menge.has(id)));
}
