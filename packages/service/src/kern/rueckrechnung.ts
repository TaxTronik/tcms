// =============================================================================
// Rückrechnung zum Stichtag (`?stand=YYYY-MM-DD`): Feststellungen, Maßnahmen,
// Ereignisse und Folgen tragen in der Datenbank nur ihren heutigen Zustand.
// Was zum Stichtag galt, folgt aus ihren Zeitpunkten und den Audit-Einträgen
// nach dem Stichtag. Eine Regel für den Tax-CMS-Kontext, die Listen und die
// Details (bisher rechneten Kontext und Listen nur einen Teil zurück, der
// Maßnahmenfilter des Kontexts war wirkungslos).
//
// Audit-Zeitstempel sind echte Zeit, fachliche Zeitpunkte folgen der Uhr
// (`auditGrenze`, kern/zeit.ts): Im aktuellen Stand gibt es keine späteren
// Einträge, die Rückrechnung ändert dort nichts.
// =============================================================================

import type { Tx } from '@tcms/db';
import { FESTSTELLUNG_STATUS_LABEL, type FeststellungStatus } from '@tcms/domain';

/** Audit-Eintrag nach dem Stichtag (nur, was die Rückrechnung liest). */
export interface SpaeterEintrag {
  aktion: string;
  objektId: string;
  detail: Record<string, unknown>;
}

/** Spätere Einträge je Objekt-ID, aufsteigend nach Position. */
export type SpaetereEintraege = ReadonlyMap<string, readonly SpaeterEintrag[]>;

export const KEINE_SPAETEREN: SpaetereEintraege = new Map();

/** Aktionen, die einen Zustand ändern, den die Zeile nicht mit Zeitpunkt trägt. */
const AKTIONEN = [
  'tcms.feststellung.status',
  'tcms.feststellung.verwerfen_bestaetigt',
  'tcms.ereignis.abgeschlossen',
  'tcms.ereignis.verwerfen_beantragt',
  'tcms.ereignis.verwerfen_bestaetigt',
  'tcms.ereignis.verwerfen_abgelehnt',
  'tcms.ereignis.folge_hinzugefuegt',
  'tcms.ereignis.folge_angelegt',
  'tcms.ereignis.folge_verworfen',
];

/**
 * Audit-Einträge der Programme nach `auditEnde` (Ende des Stichtags), nur im
 * historischen Stand; im aktuellen Stand ohne Abfrage leer.
 */
export async function ladeSpaetereEintraege(
  tx: Tx,
  programmIds: readonly string[],
  zeit: { historisch: boolean; auditEnde: Date },
): Promise<SpaetereEintraege> {
  if (!zeit.historisch || programmIds.length === 0) return KEINE_SPAETEREN;
  const zeilen = await tx.auditEvent.findMany({
    where: {
      programmId: { in: [...programmIds] },
      aktion: { in: AKTIONEN },
      at: { gt: zeit.auditEnde },
    },
    orderBy: { pos: 'asc' },
    select: { aktion: true, objektId: true, detail: true },
  });
  const je = new Map<string, SpaeterEintrag[]>();
  for (const z of zeilen) {
    const detail =
      typeof z.detail === 'object' && z.detail !== null && !Array.isArray(z.detail)
        ? (z.detail as Record<string, unknown>)
        : {};
    je.set(z.objektId, [
      ...(je.get(z.objektId) ?? []),
      { aktion: z.aktion, objektId: z.objektId, detail },
    ]);
  }
  return je;
}

// ---------------------------------------------------------------------------
// Maßnahmen
// ---------------------------------------------------------------------------

interface MassnahmeZeit {
  createdAt: Date;
  status: 'OFFEN' | 'ERLEDIGT';
  erledigtAm: Date | null;
  frist: Date;
}

/** Zum Stichtag erledigt: erledigt mit Zeitpunkt bis zum Ende des Stichtags. */
export function massnahmeErledigtAm(
  m: Omit<MassnahmeZeit, 'createdAt' | 'frist'>,
  ende: Date,
): boolean {
  return (
    m.status === 'ERLEDIGT' && m.erledigtAm != null && m.erledigtAm.getTime() <= ende.getTime()
  );
}

/**
 * Maßnahmen zum Stichtag: später angelegte fehlen, später erledigte sind offen;
 * dazu die älteste Frist der offenen. Kennzahlen (offen, gesamt, Frist) und
 * Zeilen rechnen über dieselbe Menge.
 */
export function massnahmenZumStand<M extends MassnahmeZeit>(
  liste: readonly M[],
  ende: Date,
): { bestand: M[]; offen: M[]; aeltesteFrist: Date | null } {
  const bestand = liste.filter((m) => m.createdAt.getTime() <= ende.getTime());
  const offen = bestand.filter((m) => !massnahmeErledigtAm(m, ende));
  const fristen = offen.map((m) => m.frist.getTime()).sort((a, b) => a - b);
  return { bestand, offen, aeltesteFrist: fristen.length ? new Date(fristen[0]!) : null };
}

// ---------------------------------------------------------------------------
// Feststellungen
// ---------------------------------------------------------------------------

/**
 * Status einer Feststellung zum Stichtag: der Ausgangsstatus (`von`) des
 * ersten protokollierten Statuswechsels oder Verwerfens nach dem Stichtag;
 * ohne solchen Eintrag eine später geschlossene als „Nachkontrolle“.
 */
export function feststellungsStatusZumStand(
  f: { status: FeststellungStatus; geschlossenAm: Date | null },
  spaeter: readonly SpaeterEintrag[],
  ende: Date,
): FeststellungStatus {
  const erster = spaeter.find(
    (e) =>
      e.aktion === 'tcms.feststellung.status' ||
      e.aktion === 'tcms.feststellung.verwerfen_bestaetigt',
  );
  const von = erster?.detail['von'];
  if (typeof von === 'string' && von in FESTSTELLUNG_STATUS_LABEL) return von as FeststellungStatus;
  if (
    f.status === 'GESCHLOSSEN' &&
    f.geschlossenAm != null &&
    f.geschlossenAm.getTime() > ende.getTime()
  )
    return 'NACHKONTROLLE';
  return f.status;
}

/** §-153-Würdigung zum Stichtag entschieden (Entscheidung mit Zeitpunkt bis zum Stichtag). */
export function p153EntschiedenAm(
  f: { p153Entscheidung: string | null; p153EntschiedenAm: Date | null },
  ende: Date,
): boolean {
  return (
    f.p153Entscheidung != null &&
    f.p153EntschiedenAm != null &&
    f.p153EntschiedenAm.getTime() <= ende.getTime()
  );
}

/** §-153-Würdigung offen: Auswirkung nicht ausgeschlossen, nicht entschieden, nicht verworfen. */
export function p153OffenAm(
  f: { auswirkung: 'JA' | 'NEIN' | 'UNKLAR' },
  entschieden: boolean,
  statusAmStand: FeststellungStatus,
): boolean {
  return (
    (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
    !entschieden &&
    statusAmStand !== 'VERWORFEN'
  );
}

// ---------------------------------------------------------------------------
// Ereignisse und Folgen
// ---------------------------------------------------------------------------

type EreignisStatus = 'NEU' | 'IN_TRIAGE' | 'ERLEDIGT' | 'VERWORFEN';

export interface EreignisZumStand {
  status: EreignisStatus;
  triagiertVon: string | null;
  triagiertAm: Date | null;
  /** Begründung des zum Stichtag offenen bzw. bestätigten Verwerfen-Antrags. */
  verwerfenBegruendung: string | null;
}

const VERWERFEN_AKTIONEN = new Set([
  'tcms.ereignis.verwerfen_beantragt',
  'tcms.ereignis.verwerfen_abgelehnt',
  'tcms.ereignis.verwerfen_bestaetigt',
  'tcms.ereignis.abgeschlossen',
]);

/**
 * Ereignis zum Stichtag: erst nach dem Stichtag triagiert → neu (ohne Triage);
 * nach dem Stichtag abgeschlossen oder verworfen → in Triage. Der
 * Verwerfen-Antrag zum Stichtag folgt aus dem ersten späteren Eintrag dazu:
 * später beantragt → keiner; später abgelehnt → der abgelehnte (Begründung
 * aus dem Eintrag); später bestätigt → der heutige; später abgeschlossen
 * (Abschluss leert den Antrag ohne Protokoll der Begründung) → keiner bekannt.
 */
export function ereignisZumStand(
  e: EreignisZumStand,
  spaeter: readonly SpaeterEintrag[],
  ende: Date,
): EreignisZumStand {
  const neu = e.triagiertAm != null && e.triagiertAm.getTime() > ende.getTime();
  const abschluss = spaeter.some(
    (x) =>
      x.aktion === 'tcms.ereignis.abgeschlossen' ||
      x.aktion === 'tcms.ereignis.verwerfen_bestaetigt',
  );
  const status: EreignisStatus = neu
    ? 'NEU'
    : abschluss && (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN')
      ? 'IN_TRIAGE'
      : e.status;
  const erster = spaeter.find((x) => VERWERFEN_AKTIONEN.has(x.aktion));
  let verwerfenBegruendung = e.verwerfenBegruendung;
  if (erster?.aktion === 'tcms.ereignis.verwerfen_abgelehnt') {
    const b = erster.detail['begruendung'];
    verwerfenBegruendung = typeof b === 'string' ? b : null;
  } else if (erster && erster.aktion !== 'tcms.ereignis.verwerfen_bestaetigt') {
    verwerfenBegruendung = null;
  }
  return {
    status,
    triagiertVon: neu ? null : e.triagiertVon,
    triagiertAm: neu ? null : e.triagiertAm,
    verwerfenBegruendung,
  };
}

type FolgeStatus = 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN';

/**
 * Folge zum Stichtag (`null`: erst nach dem Stichtag hinzugefügt). Status aus
 * den späteren Schritten zurückgerechnet: später verworfen → der Status davor
 * (`vorher`), später erledigt → angelegt, später angelegt → vorgeschlagen; das
 * verknüpfte Objekt nur, wenn die Folge zum Stichtag angelegt war.
 */
export function folgeZumStand(
  f: { status: FolgeStatus; erledigtAm: Date | null; objektId: string | null },
  spaeter: readonly SpaeterEintrag[],
  ende: Date,
): { status: FolgeStatus; objektId: string | null } | null {
  if (spaeter.some((x) => x.aktion === 'tcms.ereignis.folge_hinzugefuegt')) return null;
  const verworfen = spaeter.filter((x) => x.aktion === 'tcms.ereignis.folge_verworfen').at(-1);
  const angelegtSpaeter = spaeter.some((x) => x.aktion === 'tcms.ereignis.folge_angelegt');
  let status = f.status;
  if (status === 'VERWORFEN' && verworfen) {
    status = verworfen.detail['vorher'] === 'ANGELEGT' ? 'ANGELEGT' : 'VORGESCHLAGEN';
  }
  if (status === 'ERLEDIGT' && f.erledigtAm && f.erledigtAm.getTime() > ende.getTime())
    status = 'ANGELEGT';
  if ((status === 'ANGELEGT' || status === 'ERLEDIGT') && angelegtSpaeter) status = 'VORGESCHLAGEN';
  return { status, objektId: status === 'VORGESCHLAGEN' ? null : f.objektId };
}
