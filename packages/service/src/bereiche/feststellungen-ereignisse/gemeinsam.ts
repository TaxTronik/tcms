// =============================================================================
// Gemeinsame Bausteine des Bereichs „feststellungen-ereignisse": Eingabeprüfung,
// Rechte-Grundprüfung, Zeilensperren (TS-05), ISO-Abbildung, Namen und die
// beiden Anlage-Helfer, die mehrere Wege teilen (Feststellung anlegen mit
// TS-04, außerplanmäßige Durchführung).
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { mitAudit, type Protokoll } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { naechsteFeststellungsnummer } from '../../kern/nummern';
import { auswirkungBeimAnlegen, kannLesen, type Auswirkung } from '../../rechte';

// ---------------------------------------------------------------------------
// Meldungen (für Nutzer; ohne interne Details)
// ---------------------------------------------------------------------------

export const EINGABE_UNGUELTIG = 'Eingabe ungültig.';
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
export const NUR_BERUFSTRAEGER = 'Dieser Schritt ist Berufsträger:innen vorbehalten.';
export const VERTRAULICH = 'Diese Feststellung ist vertraulich und nur für Beteiligte zugänglich.';
export const KEIN_PROGRAMM = 'Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.';
export const ZWEITE_PERSON = 'Die Bestätigung muss durch eine zweite Person erfolgen.';
export const GEAENDERT = 'Der Stand hat sich zwischenzeitlich geändert. Bitte neu laden.';

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

interface Pruefbar<T> {
  safeParse(eingabe: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

/**
 * Prüft eine Eingabe mit dem Contract-Schema (auch ohne HTTP, Demo).
 * Feldfehler als `UNGUELTIG` mit `felder`, wie der Dienst bei zod-Fehlern.
 */
export function pruefe<T>(schema: Pruefbar<T>, eingabe: unknown): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = {};
  for (const i of p.error.issues.slice(0, 50)) {
    (felder[i.path.map(String).join('.') || 'eingabe'] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', EINGABE_UNGUELTIG, felder);
}

// ---------------------------------------------------------------------------
// Änderung mit Protokoll; Unique-Verletzung und Schreibkonflikt → KONFLIKT
// ---------------------------------------------------------------------------

/** Prisma-Fehlercodes: P2002 eindeutiger Schlüssel verletzt, P2034 Schreibkonflikt/Verklemmung. */
const KONFLIKT_CODES = new Set(['P2002', 'P2034']);

/** Übersetzt Unique-Verletzung und Schreibkonflikt in `KONFLIKT` (TS-05), sonst unverändert. */
export function alsKonflikt(e: unknown): unknown {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && KONFLIKT_CODES.has(code)
    ? new DienstFehler('KONFLIKT', GEAENDERT)
    : e;
}

/**
 * `mitAudit` des Bereichs: wie `mitAudit`, aber eine Verletzung eindeutiger
 * Schlüssel (Nummernkreise, Wiedervorlagen) oder ein Schreibkonflikt wird
 * zu `KONFLIKT` statt zu einem internen Fehler. Die Transaktion rollt in
 * jedem Fall zurück, weil der Fehler weitergeworfen wird.
 */
export async function aendere<T>(
  ctx: DienstKontext,
  fn: Parameters<typeof mitAudit<T>>[1],
): Promise<T> {
  try {
    return await mitAudit(ctx, fn);
  } catch (e) {
    throw alsKonflikt(e);
  }
}

// ---------------------------------------------------------------------------
// Rechte-Grundprüfung
// ---------------------------------------------------------------------------

/**
 * Staff-Bereich (S10–S12): Kanzleiperson mit bestätigtem Bezug zu genau diesem
 * Mandanten (`kannLesen`, TS-03). Mandantenkontakte lesen und handeln hier
 * nicht (nur über die Portal-Endpunkte). Sonst `NICHT_GEFUNDEN`, ohne Hinweis
 * auf die Existenz.
 */
export function pruefeKanzleiZugriff(ctx: DienstKontext, mandantId: string): void {
  if (ctx.akteur.art !== 'KANZLEI' || !kannLesen(ctx.akteur, mandantId)) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
}

/**
 * Mandant im Tenant des Akteurs vorhanden (RLS: ein Mandant eines anderen
 * Tenants ist unsichtbar)? Sonst `NICHT_GEFUNDEN` – vor jeder Rechteprüfung,
 * die `NICHT_BERECHTIGT` ergeben könnte (kein Existenz-Orakel).
 */
export async function pruefeMandant(tx: Tx, mandantId: string): Promise<void> {
  const m = await tx.mandant.findFirst({ where: { id: mandantId }, select: { id: true } });
  if (!m) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Programm des Mandanten (höchstens eines je Mandant, TS-05) oder null. */
export async function programmVon(tx: Tx, mandantId: string): Promise<{ id: string } | null> {
  return tx.tcmsProgramm.findFirst({
    where: { mandantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Zeilensperren (TS-05): Prüfung und Änderung in derselben Transaktion
// ---------------------------------------------------------------------------

/**
 * Sperrt eine Feststellung des Mandanten (`FOR UPDATE`) und prüft dabei die
 * Zugehörigkeit zum Programm dieses Mandanten. Fremder Mandant, fremder
 * Tenant (RLS) und unbekannte ID: `NICHT_GEFUNDEN`.
 */
export async function sperreFeststellung(
  tx: Tx,
  mandantId: string,
  feststellungId: string,
): Promise<void> {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM "Feststellung" f
    JOIN "TcmsProgramm" p ON p.tenant_id = f.tenant_id AND p.id = f."programmId"
    WHERE f.id = ${feststellungId} AND p."mandantId" = ${mandantId}::uuid
    FOR UPDATE OF f`;
  if (zeilen.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
}

/** Sperrt ein Ereignis des Mandanten (`FOR UPDATE`), sonst `NICHT_GEFUNDEN`. */
export async function sperreEreignis(tx: Tx, mandantId: string, ereignisId: string): Promise<void> {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM "Ereignis" e
    JOIN "TcmsProgramm" p ON p.tenant_id = e.tenant_id AND p.id = e."programmId"
    WHERE e.id = ${ereignisId} AND p."mandantId" = ${mandantId}::uuid
    FOR UPDATE OF e`;
  if (zeilen.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Sperrt eine Maßnahme des Mandanten und liefert die ID ihrer Feststellung.
 * Die Feststellung wird zuerst gesperrt (gleiche Reihenfolge wie alle anderen
 * Operationen an Feststellungen: keine Verklemmung).
 */
export async function sperreMassnahme(
  tx: Tx,
  mandantId: string,
  massnahmeId: string,
): Promise<string> {
  const ziel = await tx.$queryRaw<{ feststellungId: string }[]>`
    SELECT m."feststellungId" FROM "Massnahme" m
    JOIN "Feststellung" f ON f.tenant_id = m.tenant_id AND f.id = m."feststellungId"
    JOIN "TcmsProgramm" p ON p.tenant_id = f.tenant_id AND p.id = f."programmId"
    WHERE m.id = ${massnahmeId} AND p."mandantId" = ${mandantId}::uuid`;
  const feststellungId = ziel[0]?.feststellungId;
  if (ziel.length !== 1 || !feststellungId) throw new DienstFehler('NICHT_GEFUNDEN');
  await sperreFeststellung(tx, mandantId, feststellungId);
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Massnahme" WHERE id = ${massnahmeId} AND "feststellungId" = ${feststellungId}
    FOR UPDATE`;
  if (zeilen.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
  return feststellungId;
}

/** Sperrt das Programm des Mandanten (serialisiert z. B. Länderstände je Programm). */
export async function sperreProgramm(tx: Tx, mandantId: string): Promise<string> {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "TcmsProgramm" WHERE "mandantId" = ${mandantId}::uuid FOR UPDATE`;
  const id = zeilen[0]?.id;
  if (zeilen.length !== 1 || !id) throw new DienstFehler('NICHT_GEFUNDEN', KEIN_PROGRAMM);
  return id;
}

// ---------------------------------------------------------------------------
// Abbildung (JSON, ADR 0001 §7)
// ---------------------------------------------------------------------------

/** Kalendertag (DATE-Spalte, UTC-Mitternacht) als `YYYY-MM-DD`. */
export function isoTag(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function isoTagOderNull(d: Date | null | undefined): string | null {
  return d ? isoTag(d) : null;
}
export function isoZeit(d: Date): string {
  return d.toISOString();
}
export function isoZeitOderNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
/** `YYYY-MM-DD` als Date auf UTC-Mitternacht. */
export function alsTag(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Anzeigenamen über den Port (im Dienst leer, ADR 0001 §5) als sortierte Liste. */
export async function namenListe(
  ctx: DienstKontext,
  ids: Iterable<string | null | undefined>,
): Promise<{ id: string; name: string }[]> {
  const eindeutig = [...new Set([...ids].filter((x): x is string => !!x))].sort();
  if (eindeutig.length === 0) return [];
  const namen = await ctx.personen.namen(eindeutig);
  return eindeutig.flatMap((id) => {
    const name = namen.get(id);
    return name ? [{ id, name }] : [];
  });
}

/** Text-Wert aus einem Audit-Detail. */
export function text(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ---------------------------------------------------------------------------
// Feststellung anlegen – einziger Weg für alle Quellen (TS-04)
// ---------------------------------------------------------------------------

export interface NeueFeststellung {
  mandantId: string;
  programmId: string;
  titel: string;
  sachverhalt: string;
  quelle: 'KONTROLLE' | 'EREIGNIS' | 'STICHPROBE' | 'HINWEIS' | 'AUSSENPRUEFUNG';
  quelleText: string;
  durchfuehrungId?: string | null;
  ereignisId?: string | null;
  klasse: 'DESIGNMANGEL' | 'DURCHFUEHRUNGSMANGEL' | 'STEUERLICHER_FEHLER' | 'HINWEIS';
  schwere: 'GERING' | 'MITTEL' | 'HOCH' | 'KRITISCH';
  /** Vom Aufrufer angegebene steuerliche Auswirkung (wirkt als „NEIN" nur mit `kannWuerdigen`). */
  auswirkung: Auswirkung;
  risikoIds?: readonly string[];
  /** Zusätzliche Angaben für das Audit-Detail (z. B. Quelle, Durchführung). */
  detail?: Record<string, unknown>;
}

export interface AngelegteFeststellung {
  id: string;
  nummer: string;
  auswirkung: Auswirkung;
  auswirkungHerabgestuft: boolean;
  protokoll: Protokoll;
}

/**
 * Legt eine Feststellung in der laufenden Transaktion an. Einziger Weg für
 * manuelle Erfassung, Folge „Feststellung anlegen" und Befund aus der
 * Gegenzeichnung: Die steuerliche Auswirkung „NEIN" ist eine
 * Würdigungsentscheidung und gilt nur mit `kannWuerdigen` des Akteurs; sonst
 * entsteht „UNKLAR" (TS-04, AGENTS.md Regel 5). Risiken und Durchführung
 * müssen zum Programm gehören (sonst `NICHT_GEFUNDEN`). Das Recht zum Anlegen
 * (`kannBearbeiten` bzw. Gegenzeichnung) prüft der Aufrufer; das zurückgegebene
 * Protokoll schreibt er mit `mitAudit`.
 */
export async function legeFeststellungAn(
  ctx: DienstKontext,
  zeitpunkt: Date,
  f: NeueFeststellung,
): Promise<AngelegteFeststellung> {
  const tx = ctx.tx;
  const risikoIds = [...new Set(f.risikoIds ?? [])];
  if (risikoIds.length > 0) {
    const gefunden = await tx.risiko.count({
      where: { id: { in: risikoIds }, programmId: f.programmId },
    });
    if (gefunden !== risikoIds.length) throw new DienstFehler('NICHT_GEFUNDEN');
  }
  if (f.durchfuehrungId) {
    const d = await tx.durchfuehrung.findFirst({
      where: { id: f.durchfuehrungId, kontrolle: { programmId: f.programmId } },
      select: { id: true },
    });
    if (!d) throw new DienstFehler('NICHT_GEFUNDEN');
  }
  const auswirkung = auswirkungBeimAnlegen(ctx.akteur, f.mandantId, f.auswirkung);
  const herabgestuft = auswirkung !== f.auswirkung;
  const nummer = await naechsteFeststellungsnummer(tx, f.programmId, zeitpunkt.getUTCFullYear());
  const neu = await tx.feststellung.create({
    data: {
      programmId: f.programmId,
      nummer,
      titel: f.titel,
      sachverhalt: f.sachverhalt,
      quelle: f.quelle,
      quelleText: f.quelleText,
      durchfuehrungId: f.durchfuehrungId ?? null,
      ereignisId: f.ereignisId ?? null,
      klasse: f.klasse,
      schwere: f.schwere,
      auswirkung,
      status: 'ERFASST',
      erfasstVon: ctx.akteur.id,
      erfasstAm: zeitpunkt,
      risiken: { create: risikoIds.map((risikoId) => ({ risikoId })) },
    },
    select: { id: true },
  });
  return {
    id: neu.id,
    nummer,
    auswirkung,
    auswirkungHerabgestuft: herabgestuft,
    protokoll: {
      aktion: 'tcms.feststellung.erfasst',
      objektTyp: 'Feststellung',
      objektId: neu.id,
      programmId: f.programmId,
      detail: {
        ...f.detail,
        nummer,
        auswirkung,
        ...(herabgestuft ? { auswirkungAngegeben: f.auswirkung } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Außerplanmäßige Durchführung (Nachkontrolle, Folge „Kontrolle einplanen")
// ---------------------------------------------------------------------------

function utcTag(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Legt eine außerplanmäßige Durchführung mit dem zum Zeitpunkt gültigen
 * Kontrollstand an (Muster: Seed `baueProgramm`). Periode = Tag der Anlage,
 * damit sie sofort fällig ist. Die Kontrolle muss zum Programm gehören und
 * aktiv sein (sonst `UNGUELTIG` mit Grund).
 */
export async function legeAusserplanmaessigeDurchfuehrungAn(
  tx: Tx,
  a: {
    programmId: string;
    kontrolleId: string;
    faelligAm: Date;
    anlass: string;
    label: string;
    ereignisFolgeId?: string | null;
    zeitpunkt: Date;
  },
): Promise<{ id: string; code: string }> {
  const k = await tx.kontrolle.findFirst({
    where: { id: a.kontrolleId, programmId: a.programmId },
    include: { staende: true },
  });
  if (!k) throw new DienstFehler('NICHT_GEFUNDEN');
  const t = a.zeitpunkt.getTime();
  if (k.aktivAb.getTime() > t || (k.entfallenAb && k.entfallenAb.getTime() <= t)) {
    throw new DienstFehler('UNGUELTIG', 'Die Kontrolle ist im Programm nicht aktiv.');
  }
  const stand = k.staende
    .filter(
      (x) => x.gueltigAb.getTime() <= t && (x.gueltigBis == null || x.gueltigBis.getTime() > t),
    )
    .sort((x, y) => y.gueltigAb.getTime() - x.gueltigAb.getTime())[0];
  if (!stand) throw new DienstFehler('UNGUELTIG', 'Die Kontrolle hat keinen gültigen Stand.');
  const tag = utcTag(a.zeitpunkt);
  const d = await tx.durchfuehrung.create({
    data: {
      kontrolleId: k.id,
      kontrolleStandId: stand.id,
      periodeLabel: a.label,
      periodeVon: tag,
      periodeBis: tag,
      faelligAm: a.faelligAm,
      ausserplanmaessig: true,
      anlass: a.anlass,
      ereignisFolgeId: a.ereignisFolgeId ?? null,
      createdAt: a.zeitpunkt,
    },
    select: { id: true },
  });
  return { id: d.id, code: k.code };
}
