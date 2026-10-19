// =============================================================================
// Gemeinsame Bausteine des Bereichs „programm-beschreibung": Eingabeprüfung,
// Zugriffsprüfung (Kanzlei/Portal) und Zeilensperren (TS-05).
//
// Zugriff (ADR 0001 §3.3/§5, Welle-2-Regeln):
//   - Fremder Mandant, fremder Tenant, unbekannte ID → `NICHT_GEFUNDEN`
//     (dieselbe Antwort, kein Existenz-Orakel).
//   - Fehlendes Recht auf einem sichtbaren Objekt → `NICHT_BERECHTIGT` mit
//     fachlichem Grund.
//   - Jede Objekt-ID der Eingabe wird gegen den Mandanten der Anfrage geprüft:
//     Die Sperrabfragen verbinden das Objekt mit dem Programm genau dieses
//     Mandanten (RLS trennt nur Tenants, nicht Mandanten).
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import { Prisma, type Tx } from '@tcms/db';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten, kannLesen, type KontaktRolle } from '../../rechte';
import { ladeKontaktRollen } from '../../rollen';

export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';

interface SchemaFehler {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

/** Strukturelle Sicht auf ein zod-Schema (der Service hängt nicht direkt von zod ab). */
export interface Schema<T> {
  safeParse(eingabe: unknown): { success: true; data: T } | { success: false; error: SchemaFehler };
}

/** Prüft die Eingabe mit dem Vertragsschema; Feldfehler als `UNGUELTIG` (wie der Dienst). */
export function pruefeEingabe<T>(schema: Schema<T>, eingabe: unknown): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = Object.create(null);
  for (const i of p.error.issues.slice(0, 50)) {
    const pfad = i.path.map(String).join('.') || 'eingabe';
    (felder[pfad] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', 'Eingabe ungültig.', { ...felder });
}

/** Fachliche Prüffehler (z. B. unvollständiger Schritt) als `UNGUELTIG` mit Feldern. */
export function fachlichUngueltig(meldung: string, feld: string, fehler: string[]): never {
  throw new DienstFehler('UNGUELTIG', meldung, { [feld]: fehler.slice(0, 200) });
}

export function nichtGefunden(): never {
  throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Kanzlei-Zugriff auf einen Mandanten: nur Kanzleipersonen mit bestätigtem
 * Bezug (`cli`) zu genau diesem Mandanten; der Mandant muss im Tenant
 * existieren. `bearbeiten`: zusätzlich `kannBearbeiten` (sonst
 * `NICHT_BERECHTIGT`, der Mandant ist für den Akteur ja sichtbar).
 */
export async function kanzleiZugriff(
  ctx: DienstKontext,
  mandantId: string,
  bearbeiten: boolean,
): Promise<{ id: string; name: string }> {
  const a = ctx.akteur;
  if (a.art !== 'KANZLEI' || !kannLesen(a, mandantId)) nichtGefunden();
  // RLS: ein Mandant eines anderen Tenants ist hier unsichtbar.
  const mandant = await ctx.tx.mandant.findUnique({
    where: { id: mandantId },
    select: { id: true, name: true },
  });
  if (!mandant) return nichtGefunden();
  if (bearbeiten && !kannBearbeiten(a, mandantId)) {
    throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
  }
  return mandant;
}

/**
 * Portal-Zugriff: nur Mandantenkontakte mit aktiver Rolle beim eigenen
 * Mandanten (ADR 0001 §5). Kanzleipersonen nutzen die Kanzlei-Endpunkte.
 */
export async function portalZugriff(
  ctx: DienstKontext,
  mandantId: string,
): Promise<{ rollen: KontaktRolle[]; mandant: { id: string; name: string } }> {
  const a = ctx.akteur;
  if (a.art !== 'MANDANT') return nichtGefunden();
  const rollen = await ladeKontaktRollen(ctx.tx, a);
  if (!kannLesen(a, mandantId, rollen)) nichtGefunden();
  const mandant = await ctx.tx.mandant.findUnique({
    where: { id: mandantId },
    select: { id: true, name: true },
  });
  if (!mandant) return nichtGefunden();
  return { rollen, mandant };
}

/** ID des (einzigen) Programms eines Mandanten, optional unter Zeilensperre. */
export async function programmIdDesMandanten(
  tx: Tx,
  mandantId: string,
  sperren: boolean,
): Promise<string | null> {
  const zeilen = sperren
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "TcmsProgramm" WHERE "mandantId" = ${mandantId}::uuid FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "TcmsProgramm" WHERE "mandantId" = ${mandantId}::uuid`;
  return zeilen[0]?.id ?? null;
}

/**
 * Sperrt eine Beschreibungsversion (FOR UPDATE), sofern sie zum Programm des
 * Mandanten gehört; sonst `NICHT_GEFUNDEN`. Alle Statusübergänge einer Version
 * laufen nach dieser Sperre, damit Prüfung und Änderung in derselben
 * Transaktion ohne Wettlauf stattfinden (TS-05).
 */
export async function sperreVersion(tx: Tx, mandantId: string, versionId: string) {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT v.id FROM "BeschreibungVersion" v
    JOIN "TcmsProgramm" p ON p.tenant_id = v.tenant_id AND p.id = v."programmId"
    WHERE v.id = ${versionId} AND p."mandantId" = ${mandantId}::uuid
    FOR UPDATE OF v`;
  if (zeilen.length !== 1) return nichtGefunden();
  const v = await tx.beschreibungVersion.findUnique({ where: { id: versionId } });
  if (!v) return nichtGefunden();
  return v;
}

/** Sperrt eine Freigabe (FOR UPDATE), sofern sie zum Programm des Mandanten gehört. */
export async function sperreFreigabe(tx: Tx, mandantId: string, freigabeId: string) {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM "Freigabe" f
    JOIN "TcmsProgramm" p ON p.tenant_id = f.tenant_id AND p.id = f."programmId"
    WHERE f.id = ${freigabeId} AND p."mandantId" = ${mandantId}::uuid
    FOR UPDATE OF f`;
  if (zeilen.length !== 1) return nichtGefunden();
  const f = await tx.freigabe.findUnique({ where: { id: freigabeId } });
  if (!f) return nichtGefunden();
  return f;
}

/** Eindeutiger Schlüssel verletzt (gleichzeitiges Anlegen) → `KONFLIKT`. */
export function istEindeutigkeitsfehler(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export async function konfliktBeiEindeutigkeit<T>(meldung: string, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (istEindeutigkeitsfehler(e)) throw new DienstFehler('KONFLIKT', meldung);
    throw e;
  }
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoTagVon = (d: Date): string => d.toISOString().slice(0, 10);

/** Aktive Kontakte eines Mandanten mit Rolle (nach Anlage sortiert). */
export async function aktiveKontakte(tx: Tx, mandantId: string) {
  return tx.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true },
    orderBy: { createdAt: 'asc' },
    select: { kontaktId: true, rolle: true },
  });
}
