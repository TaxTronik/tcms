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
//
// Sperrreihenfolge (TS-05, verbindlich für alle Bereiche, AGENTS.md): Jede
// Transaktion nimmt ihre Sperren nur in dieser Ordnung, damit sich Operationen
// nicht verklemmen (eine Verklemmung bleibt ein wiederholbarer KONFLIKT,
// `kern/konflikt.ts`):
//   1. Idempotenz- und Anker-Advisory-Locks (`portal-meldung|…`, `mandant.anker.…`)
//   2. Programm
//   3. Ereignis
//   4. Feststellung
//   5. Freigabe bzw. BeschreibungVersion
//   6. Risiken (nach ID)
//   7. Kontrollen (nach ID)
//   8. Durchführungen (nach ID)
//   9. Kindzeilen (Ereignisfolge, Maßnahme, Nachweis)
//  10. Nummernkreis-Advisory-Locks (`nummer.*`, `kern/nummern.ts`)
//  11. Mandant FOR KEY SHARE (`halteRollenFest`)
//  12. Audit-Lock (immer zuletzt, nimmt `mitAudit`)
// Implizite Sperren zählen mit: Ein INSERT bzw. ein UPDATE eines Fremdschlüssels
// nimmt FOR KEY SHARE auf die referenzierte Elternzeile, ein UPDATE ohne
// Schlüsseländerung FOR NO KEY UPDATE auf die eigene Zeile. Elternzeilen, an
// denen nur Nicht-Schlüsselspalten geändert werden (Programm, Risiko,
// Kontrolle), sperren die Helfer hier deshalb mit FOR NO KEY UPDATE: Das
// serialisiert Änderungen derselben Zeile wie FOR UPDATE, blockiert aber nicht
// die FK-Prüfung anderer Transaktionen, die Kindzeilen anlegen (z. B. ein
// Ereignis, eine Freigabe oder eine RisikoKontrolle) – so entsteht keine Kante
// „Kind → Eltern“ gegen die Ordnung. Durchführungen bleiben FOR UPDATE, weil
// die Neuplanung unberührte Durchführungen löscht.
// =============================================================================

import { DienstFehler, nichtBerechtigt, type Akteur } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten, kannLesen } from '../../rechte';

/** Einheitlicher Grund fehlender Bearbeitungsrechte (Fachkonzept 6.8). */
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const ZWEITE_PERSON =
  'Die Entscheidung trifft eine zweite Person – nicht die beantragende bzw. einreichende Person.';

export { pruefeEingabe } from '../../kern/eingabe';

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

/**
 * Bearbeitungsrecht des Bereichs: einzige Quelle für die Schreiboperationen
 * (`pruefeBearbeiten`) und das Kennzeichen der Lese-Antworten (`bearbeitenRechte`).
 */
function darfBearbeiten(a: Akteur, mandantId: string): boolean {
  return kannBearbeiten(a, mandantId);
}

/** Bearbeiten: wie Lesen, zusätzlich `kannBearbeiten` (sonst NICHT_BERECHTIGT mit Grund). */
export function pruefeBearbeiten(a: Akteur, mandantId: string): void {
  pruefeStaffLesen(a, mandantId);
  if (!darfBearbeiten(a, mandantId)) throw nichtBerechtigt('BEARBEITEN', KEIN_RECHT);
}

/**
 * Kennzeichen `rechte.bearbeiten` für Risikoinventar und Kontrollmatrix: wie
 * `pruefeBearbeiten`; im historischen Stand (Regel 6) und ohne Programm (die
 * Schreiboperationen fänden nichts) `false`.
 */
export function bearbeitenRechte(
  a: Akteur,
  mandantId: string,
  k: { historisch: boolean; programm: unknown },
): { bearbeiten: boolean } {
  return { bearbeiten: !k.historisch && k.programm != null && darfBearbeiten(a, mandantId) };
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
// Zeilensperren (TS-05, Ordnung im Dateikopf). Parametrisiert, feste
// Tabellennamen; RLS gilt auch für SELECT … FOR NO KEY UPDATE. Jede Sperre
// prüft zugleich die Zugehörigkeit zum Programm des Mandanten: eine fremde ID
// ergibt keine Zeile → NICHT_GEFUNDEN. Programm, Risiko und Kontrolle werden
// nie gelöscht und ihre Schlüssel (id, tenant_id, mandantId bzw. programmId,
// code) nie geändert – deshalb FOR NO KEY UPDATE.
// -----------------------------------------------------------------------------

/** Sperrt das Programm des Mandanten (Profil, Risikoaufnahme). */
export async function sperreProgramm(tx: Tx, mandantId: string): Promise<ProgrammRef> {
  const z = await tx.$queryRaw<ProgrammRef[]>`
    SELECT "id", "mandantId"::text AS "mandantId" FROM "TcmsProgramm"
    WHERE "mandantId" = ${mandantId}::uuid FOR NO KEY UPDATE`;
  if (z.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
  return z[0]!;
}

/** Sperrt Risiken des Programms in fester Reihenfolge; fehlt eines → NICHT_GEFUNDEN. */
export async function sperreRisiken(tx: Tx, programmId: string, ids: readonly string[]) {
  const sortiert = [...new Set(ids)].sort();
  if (sortiert.length === 0) return;
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Risiko"
    WHERE "programmId" = ${programmId} AND "id" = ANY(${sortiert}::text[])
    ORDER BY "id" FOR NO KEY UPDATE`;
  if (z.length !== sortiert.length) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Sperrt Kontrollen des Programms in fester Reihenfolge; fehlt eine → NICHT_GEFUNDEN. */
export async function sperreKontrollen(tx: Tx, programmId: string, ids: readonly string[]) {
  const sortiert = [...new Set(ids)].sort();
  if (sortiert.length === 0) return;
  const z = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Kontrolle"
    WHERE "programmId" = ${programmId} AND "id" = ANY(${sortiert}::text[])
    ORDER BY "id" FOR NO KEY UPDATE`;
  if (z.length !== sortiert.length) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Sperrt alle Durchführungen einer Kontrolle (vor einer Neuplanung). FOR
 * UPDATE, weil die Neuplanung unberührte Durchführungen löscht.
 */
export async function sperreDurchfuehrungen(tx: Tx, kontrolleId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "Durchfuehrung" WHERE "kontrolleId" = ${kontrolleId}
    ORDER BY "id" FOR UPDATE`;
}

// -----------------------------------------------------------------------------
// Datenbankfehler → KONFLIKT: die eine Abbildung aus dem Kern (Befund 92).
// -----------------------------------------------------------------------------

export { konfliktSicher } from '../../kern/konflikt';

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
