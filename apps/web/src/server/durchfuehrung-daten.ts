import 'server-only';
import type { Prisma, Tx } from '@tcms/db';
import { addTage, fmtDatum, statusAm, type AnzeigeStatus, type Klasse } from '@tcms/domain';
import {
  fehlendeWerte,
  MAX_DATEI_BYTES,
  normalisiereWerte,
  parseDezimal,
  werteZeilen,
  type KennzahlDef,
  type Werte,
} from '@/components/durchfuehrung/werte';
import { kannPortalLesen, type NachweisVerweis } from '@tcms/service';
import {
  db,
  demoAblage,
  demoPersonen,
  zustaendigkeit as mandantZustaendigkeit,
  type Handelnde,
} from './demo';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from './aktion';
import type { Ergebnis } from './ergebnis';
import { kannBearbeiten, kannDurchfuehren, kannGegenzeichnen, kannWuerdigen } from './berechtigung';
import { auditGrenze, heute, leseStand, tagesende } from './zeit';
import type { KontrollZustaendigkeit } from '@tcms/service';

/** Zuständigkeit eines Mandanten zur Anzeige (Demo-Verzeichnis); Rechte laufen über den Akteur. */
export interface MandantZustaendigkeit {
  id: string;
  berufstraegerId: string;
  bearbeitungId: string;
}

// =============================================================================
// Kontrolldurchführung (S8, P2): Laden der Detaildaten, Rechte je Handlung
// und die Kernlogik der Handlungen, die Kanzlei (S8) und Portal (P2) teilen.
// Die Server Actions in actions/durchfuehrung.ts und actions/portal-aufgabe.ts
// sind dünne Hüllen um diese Funktionen; jede Änderung läuft über mitAudit.
// =============================================================================

const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';

type GespeicherterStatus =
  | 'GEPLANT'
  | 'IN_DURCHFUEHRUNG'
  | 'ZUR_GEGENZEICHNUNG'
  | 'ZURUECKGEWIESEN'
  | 'OHNE_BEFUND'
  | 'MIT_BEFUND'
  | 'ENTFALLEN';
const BEARBEITBAR: readonly GespeicherterStatus[] = ['IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];
const OFFEN: readonly GespeicherterStatus[] = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];
/** Audit-Aktionen, deren Akteur an der Durchführung beteiligt war (Vier-Augen). */
const DURCHFUEHRUNGS_AKTIONEN = [
  'tcms.durchfuehrung.begonnen',
  'tcms.durchfuehrung.gespeichert',
  'tcms.durchfuehrung.nachweis_hochgeladen',
  'tcms.durchfuehrung.nachweis_entfernt',
  'tcms.durchfuehrung.eingereicht',
];

export interface PersonInfo {
  id: string;
  name: string;
  art: 'KANZLEI' | 'MANDANT';
  funktion: string | null;
}

export interface SchrittZeile {
  titel: string;
  hinweis: string;
  erledigt: boolean;
  kommentar: string;
}

export interface NachweisZeile {
  id: string;
  dateiname: string;
  mime: string;
  groesse: number;
  sha256: string;
  gesperrt: boolean;
  hochgeladenVon: string;
  hochgeladenAm: Date;
}

export interface VerlaufEintrag {
  seq: number;
  at: Date;
  actorId: string | null;
  actorName: string;
  aktion: string;
  text: string;
  system?: boolean;
}

export interface DurchfuehrungKurz {
  id: string;
  periodeLabel: string;
  anzeige: AnzeigeStatus;
}

export interface DurchfuehrungDetail {
  id: string;
  mandantId: string;
  mandantName: string;
  mandant: MandantZustaendigkeit;
  programmId: string;
  kontrolle: {
    id: string;
    code: string;
    standId: string;
    version: number;
    gueltigAb: Date;
    titel: string;
    ziel: string;
    art: 'P' | 'D' | 'K';
    ausfuehrung: 'M' | 'IT' | 'A';
    partei: 'KANZLEI' | 'MANDANT';
    schluessel: boolean;
    nachweis: string;
    mindestNachweise: number;
    toleranzEur: number | null;
    faelligNachTagen: number;
    durchfuehrendId: string | null;
    vertretungId: string | null;
    gegenzeichnerId: string | null;
    gegenzeichnungMandant: boolean;
    design: 'ANGEMESSEN' | 'NICHT_BEURTEILT' | 'MANGEL';
    designVon: string | null;
    designAm: Date | null;
  };
  zustaendigkeit: KontrollZustaendigkeit;
  periodeLabel: string;
  periodeVon: Date;
  periodeBis: Date;
  faelligAm: Date;
  status: GespeicherterStatus;
  /** Status zum Stichtag (inkl. abgeleitet Fällig/Überfällig). */
  anzeige: AnzeigeStatus;
  ausserplanmaessig: boolean;
  anlass: string | null;
  schritte: SchrittZeile[];
  kennzahlen: KennzahlDef[];
  werte: Werte;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
  durchgefuehrtVon: string | null;
  begonnenAm: Date | null;
  eingereichtAm: Date | null;
  mandantBestaetigtVon: string | null;
  mandantBestaetigtAm: Date | null;
  gegengezeichnetVon: string | null;
  abgeschlossenAm: Date | null;
  zurueckgewiesenVon: string | null;
  zurueckgewiesenAm: Date | null;
  zurueckweisungsgrund: string | null;
  entfallenBegruendung: string | null;
  entfallenVon: string | null;
  entfallenAm: Date | null;
  entfallenFreigegebenVon: string | null;
  nachtragZuId: string | null;
  createdAt: Date;
  /** false, wenn die Durchführung zum Stichtag noch nicht existierte. */
  vorhandenZumStand: boolean;
  nachweise: NachweisZeile[];
  /** Nachweise, die nach dem Stichtag hochgeladen wurden (ausgeblendet). */
  nachweiseAusgeblendet: number;
  feststellungen: { id: string; nummer: string; titel: string; status: string; schwere: Klasse }[];
  risiken: { id: string; code: string; titel: string }[];
  letzte: DurchfuehrungKurz[];
  nachtraege: DurchfuehrungKurz[];
  original: { id: string; periodeLabel: string } | null;
  verlauf: VerlaufEintrag[];
  /** Personen, die an der Durchführung mitgewirkt haben (dürfen nicht gegenzeichnen). */
  beteiligte: string[];
  personen: Record<string, PersonInfo>;
}

// ---------------------------------------------------------------------------
// Dateiablage (gemeinsame Ablage aus @tcms/db, Layout <sha[0:2]>/<sha256>)
// ---------------------------------------------------------------------------

/** Demo: legt eine Datei über den Ablage-Port ab (Dienst: nur Verweise, ADR 0001 §6). */
export function legeNachweisdateiAb(
  inhalt: Buffer,
  dateiname: string,
  mime: string,
): Promise<NachweisVerweis> {
  return demoAblage.annehmen({ art: 'DATEI', dateiname, mime, inhalt });
}

/** Demo: liest eine abgelegte Datei und prüft dabei den SHA-256 (TS-09). */
export function leseNachweisdatei(
  n: Pick<NachweisVerweis, 'dokumentId' | 'sha256'>,
): Promise<Buffer> {
  return demoAblage.lese(n);
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

function ladeRoh(id: string) {
  return db.durchfuehrung.findUnique({
    where: { id },
    include: {
      kontrolleStand: true,
      kontrolle: {
        include: {
          programm: { include: { mandant: true } },
          risiken: { include: { risiko: { include: { staende: true } } } },
        },
      },
      nachweise: { orderBy: { hochgeladenAm: 'asc' } },
      feststellungen: {
        select: {
          id: true,
          nummer: true,
          titel: true,
          status: true,
          schwere: true,
          erfasstAm: true,
        },
        orderBy: { nummer: 'asc' },
      },
    },
  });
}

const vorStand = (d: Date | null | undefined, ende: Date): Date | null =>
  d && d.getTime() <= ende.getTime() ? d : null;

function verlaufText(
  aktion: string,
  detail: Record<string, unknown>,
  partei: 'KANZLEI' | 'MANDANT',
): string {
  const s = (k: string) => (typeof detail[k] === 'string' ? (detail[k] as string) : '');
  switch (aktion) {
    case 'tcms.durchfuehrung.begonnen':
      return 'Durchführung begonnen';
    case 'tcms.durchfuehrung.gespeichert':
      return typeof detail['erledigt'] === 'number'
        ? `Entwurf gespeichert (${detail['erledigt']} von ${detail['gesamt']} Schritten)`
        : 'Entwurf gespeichert';
    case 'tcms.durchfuehrung.nachweis_hochgeladen':
      return `Nachweis hochgeladen: ${s('dateiname')}`;
    case 'tcms.durchfuehrung.nachweis_entfernt':
      return `Nachweis entfernt: ${s('dateiname')}`;
    case 'tcms.durchfuehrung.eingereicht':
      return partei === 'MANDANT' ? 'an die Kanzlei übermittelt' : 'zur Gegenzeichnung eingereicht';
    case 'tcms.durchfuehrung.mandant_bestaetigt':
      return 'Vollständigkeit bestätigt (zweite Person beim Mandanten)';
    case 'tcms.durchfuehrung.gegengezeichnet':
      return detail['ergebnis'] === 'MIT_BEFUND'
        ? 'gegengezeichnet – abgeschlossen mit Befund'
        : 'gegengezeichnet – abgeschlossen ohne Befund';
    case 'tcms.durchfuehrung.zurueckgewiesen':
      return `zurückgewiesen: ${s('begruendung')}`;
    case 'tcms.durchfuehrung.entfallen_beantragt':
      return `Entfallen beantragt: ${s('begruendung')}`;
    case 'tcms.durchfuehrung.entfallen':
      return 'Entfallen freigegeben';
    case 'tcms.durchfuehrung.entfallen_abgelehnt':
      return s('begruendung')
        ? `Entfallen-Antrag abgelehnt: ${s('begruendung')}`
        : 'Entfallen-Antrag zurückgezogen';
    case 'tcms.durchfuehrung.nachtrag_angelegt':
      return `Nachtrag angelegt: ${s('begruendung')}`;
    case 'tcms.feststellung.erfasst':
      return `Feststellung ${s('nummer')} erfasst`;
    default: {
      const teil = aktion.split('.').pop() ?? aktion;
      return teil.replace(/_/g, ' ');
    }
  }
}

/** Lädt eine Durchführung mit allen Detaildaten zum Stichtag. */
export async function ladeDurchfuehrungDetail(
  id: string,
  stand: Date,
  historisch: boolean,
): Promise<DurchfuehrungDetail | null> {
  const d = await ladeRoh(id);
  if (!d) return null;
  const ende = tagesende(stand);
  const ks = d.kontrolleStand;
  const programm = d.kontrolle.programm;
  const partei = ks.partei;

  const personenRoh = demoPersonen
    .alle()
    .map((p) => ({ id: p.id, name: p.name, art: p.art, funktion: p.funktion }));
  const [audit, letzteRoh, nachtraegeRoh, original] = await Promise.all([
    db.auditEvent.findMany({
      where: {
        OR: [
          { objektTyp: 'Durchfuehrung', objektId: id },
          { detail: { path: ['durchfuehrungId'], equals: id } },
          { detail: { path: ['nachtragZuId'], equals: id } },
        ],
      },
      orderBy: { seq: 'desc' },
    }),
    db.durchfuehrung.findMany({
      where: {
        kontrolleId: d.kontrolleId,
        id: { not: id },
        periodeVon: { lt: d.periodeVon },
        nachtragZuId: null,
      },
      orderBy: { periodeVon: 'desc' },
      take: 3,
    }),
    db.durchfuehrung.findMany({ where: { nachtragZuId: id }, orderBy: { createdAt: 'asc' } }),
    d.nachtragZuId
      ? db.durchfuehrung.findUnique({
          where: { id: d.nachtragZuId },
          select: { id: true, periodeLabel: true },
        })
      : null,
  ]);
  const personen: Record<string, PersonInfo> = {};
  for (const p of personenRoh) personen[p.id] = p;

  const kurz = (x: (typeof letzteRoh)[number]): DurchfuehrungKurz => ({
    id: x.id,
    periodeLabel: x.periodeLabel,
    anzeige: statusAm(x, stand),
  });

  // Audit-Zeitstempel sind echte Zeit (auditGrenze, zeit.ts).
  const auditGrenzeMs = auditGrenze(stand).getTime();
  const auditImStand = audit.filter((e) => e.at.getTime() <= auditGrenzeMs);
  const letztesEreignis = (aktion: string) => auditImStand.find((e) => e.aktion === aktion) ?? null;

  const verlauf: VerlaufEintrag[] = auditImStand.map((e) => ({
    seq: e.seq,
    at: e.at,
    actorId: e.actorId,
    actorName: e.actorName,
    aktion: e.aktion,
    text: verlaufText(e.aktion, (e.detail ?? {}) as Record<string, unknown>, partei),
  }));
  // Abgeleitete Zustände (nicht gespeichert, daher „System").
  if (d.periodeBis.getTime() <= ende.getTime() && !d.ausserplanmaessig) {
    verlauf.push({
      seq: -1,
      at: d.periodeBis,
      actorId: null,
      actorName: 'System',
      aktion: 'system.faellig',
      text: `fällig (Periodenende ${fmtDatum(d.periodeBis)})`,
      system: true,
    });
  }
  const anzeige = statusAm(d, stand);
  if (anzeige === 'UEBERFAELLIG') {
    verlauf.push({
      seq: -2,
      at: addTage(d.faelligAm, 1),
      actorId: null,
      actorName: 'System',
      aktion: 'system.ueberfaellig',
      text: `überfällig (Fälligkeit ${fmtDatum(d.faelligAm)} überschritten)`,
      system: true,
    });
  }
  verlauf.sort((a, b) => b.at.getTime() - a.at.getTime() || b.seq - a.seq);

  const beteiligte = new Set<string>();
  if (d.durchgefuehrtVon) beteiligte.add(d.durchgefuehrtVon);
  for (const n of d.nachweise) beteiligte.add(n.hochgeladenVon);
  for (const e of audit)
    if (e.actorId && DURCHFUEHRUNGS_AKTIONEN.includes(e.aktion)) beteiligte.add(e.actorId);

  const schritteDef = (ks.schritte as unknown as { titel: string; hinweis: string }[]) ?? [];
  const antworten = Array.isArray(d.schritte)
    ? (d.schritte as unknown as { erledigt?: boolean; kommentar?: string }[])
    : [];
  const nachweiseImStand = d.nachweise.filter((n) => n.hochgeladenAm.getTime() <= ende.getTime());
  const bestaetigt = letztesEreignis('tcms.durchfuehrung.mandant_bestaetigt');
  const zurueck = letztesEreignis('tcms.durchfuehrung.zurueckgewiesen');
  const entfallenFrei = letztesEreignis('tcms.durchfuehrung.entfallen');

  const risiken = d.kontrolle.risiken
    .map((rk) => {
      const st = [...rk.risiko.staende]
        .filter((s) => s.gueltigAb.getTime() <= ende.getTime())
        .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
      return {
        id: rk.risiko.id,
        code: rk.risiko.code,
        titel: st?.titel ?? rk.risiko.code,
        aktiv: rk.risiko.entscheidung === 'UEBERNOMMEN',
      };
    })
    .filter((r) => r.aktiv)
    .map(({ aktiv: _a, ...r }) => r)
    .sort((a, b) => a.code.localeCompare(b.code));

  const zustaendigkeit: KontrollZustaendigkeit = {
    durchfuehrendId: ks.durchfuehrendId,
    vertretungId: ks.vertretungId,
    gegenzeichnerId: ks.gegenzeichnerId,
    gegenzeichnungMandant: ks.gegenzeichnungMandant,
    partei: ks.partei,
  };

  return {
    id: d.id,
    mandantId: programm.mandantId,
    mandantName: programm.mandant.name,
    mandant: {
      id: programm.mandant.id,
      berufstraegerId: mandantZustaendigkeit(programm.mandant.id).berufstraegerId ?? '',
      bearbeitungId: mandantZustaendigkeit(programm.mandant.id).bearbeitungId ?? '',
    },
    programmId: programm.id,
    kontrolle: {
      id: d.kontrolle.id,
      code: d.kontrolle.code,
      standId: ks.id,
      version: ks.version,
      gueltigAb: ks.gueltigAb,
      titel: ks.titel,
      ziel: ks.ziel,
      art: ks.art,
      ausfuehrung: ks.ausfuehrung,
      partei: ks.partei,
      schluessel: ks.schluessel,
      nachweis: ks.nachweis,
      mindestNachweise: ks.mindestNachweise,
      toleranzEur: ks.toleranzEur == null ? null : Number(ks.toleranzEur),
      faelligNachTagen: ks.faelligNachTagen,
      durchfuehrendId: ks.durchfuehrendId,
      vertretungId: ks.vertretungId,
      gegenzeichnerId: ks.gegenzeichnerId,
      gegenzeichnungMandant: ks.gegenzeichnungMandant,
      design: ks.design,
      designVon: ks.designVon,
      designAm: ks.designAm,
    },
    zustaendigkeit,
    periodeLabel: d.periodeLabel,
    periodeVon: d.periodeVon,
    periodeBis: d.periodeBis,
    faelligAm: d.faelligAm,
    status: d.status,
    anzeige,
    ausserplanmaessig: d.ausserplanmaessig,
    anlass: d.anlass,
    schritte: schritteDef.map((s, i) => ({
      titel: s.titel,
      hinweis: s.hinweis,
      erledigt: antworten[i]?.erledigt === true,
      kommentar: typeof antworten[i]?.kommentar === 'string' ? antworten[i]!.kommentar! : '',
    })),
    kennzahlen: (ks.kennzahlen as unknown as KennzahlDef[]) ?? [],
    werte: normalisiereWerte(d.werte),
    ergebnis: d.ergebnis,
    ergebnisKommentar: d.ergebnisKommentar,
    durchgefuehrtVon: d.durchgefuehrtVon,
    begonnenAm: historisch ? vorStand(d.begonnenAm, ende) : d.begonnenAm,
    eingereichtAm: historisch ? vorStand(d.eingereichtAm, ende) : d.eingereichtAm,
    mandantBestaetigtVon: bestaetigt || !historisch ? d.mandantBestaetigtVon : null,
    mandantBestaetigtAm: bestaetigt?.at ?? null,
    gegengezeichnetVon:
      historisch && !vorStand(d.abgeschlossenAm, ende) ? null : d.gegengezeichnetVon,
    abgeschlossenAm: historisch ? vorStand(d.abgeschlossenAm, ende) : d.abgeschlossenAm,
    zurueckgewiesenVon: d.zurueckgewiesenVon,
    zurueckgewiesenAm: zurueck?.at ?? null,
    zurueckweisungsgrund: d.zurueckweisungsgrund,
    entfallenBegruendung: d.entfallenBegruendung,
    entfallenVon: d.entfallenVon,
    entfallenAm: historisch ? vorStand(d.entfallenAm, ende) : d.entfallenAm,
    entfallenFreigegebenVon: entfallenFrei?.actorId ?? null,
    nachtragZuId: d.nachtragZuId,
    createdAt: d.createdAt,
    vorhandenZumStand: !(d.ausserplanmaessig && d.createdAt.getTime() > ende.getTime()),
    nachweise: nachweiseImStand.map((n) => ({
      id: n.id,
      dateiname: n.dateiname,
      mime: n.mime,
      groesse: n.groesse,
      sha256: n.sha256,
      gesperrt: n.gesperrt,
      hochgeladenVon: n.hochgeladenVon,
      hochgeladenAm: n.hochgeladenAm,
    })),
    nachweiseAusgeblendet: d.nachweise.length - nachweiseImStand.length,
    feststellungen: d.feststellungen
      .filter((f) => f.erfasstAm.getTime() <= ende.getTime())
      .map((f) => ({
        id: f.id,
        nummer: f.nummer,
        titel: f.titel,
        status: f.status,
        schwere: f.schwere,
      })),
    risiken,
    letzte: letzteRoh
      .filter((x) => !(x.ausserplanmaessig && x.createdAt.getTime() > ende.getTime()))
      .map(kurz),
    nachtraege: nachtraegeRoh.filter((x) => x.createdAt.getTime() <= ende.getTime()).map(kurz),
    original: original ?? null,
    verlauf,
    beteiligte: [...beteiligte],
    personen,
  };
}

export function personName(
  d: Pick<DurchfuehrungDetail, 'personen'>,
  id: string | null | undefined,
): string {
  if (!id) return '—';
  return d.personen[id]?.name ?? '—';
}

/** Gespeicherter Status, wie er zum Stichtag galt (für die Bedienleiste im historischen Stand). */
export function statusZumStand(d: DurchfuehrungDetail): DurchfuehrungDetail['status'] {
  switch (d.anzeige) {
    case 'FAELLIG':
    case 'UEBERFAELLIG':
    case 'GEPLANT':
      return d.begonnenAm ? 'IN_DURCHFUEHRUNG' : 'GEPLANT';
    default:
      return d.anzeige;
  }
}

export function ohneInhalte(
  d: DurchfuehrungDetail,
): Pick<DurchfuehrungDetail, 'schritte' | 'werte' | 'ergebnis' | 'ergebnisKommentar'> {
  return {
    schritte: d.schritte.map((s) => ({ ...s, erledigt: false, kommentar: '' })),
    werte: {},
    ergebnis: null,
    ergebnisKommentar: null,
  };
}

// ---------------------------------------------------------------------------
// Prüfung der Einreichung (gespeicherter bzw. übergebener Stand)
// ---------------------------------------------------------------------------

export interface EinreichPruefung {
  schritteErledigt: number;
  schritteGesamt: number;
  werteFehlend: string[];
  ausserhalb: string[];
  nachweise: number;
  mindestNachweise: number;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  kommentarFehlt: boolean;
  maengel: string[];
}

export const MIN_BEFUND_KOMMENTAR = 20;

export function pruefeEinreichung(x: {
  schritte: { erledigt: boolean }[];
  kennzahlen: KennzahlDef[];
  werte: Werte;
  toleranzEur: number | null;
  nachweise: number;
  mindestNachweise: number;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
}): EinreichPruefung {
  const erledigt = x.schritte.filter((s) => s.erledigt).length;
  const werteFehlend = fehlendeWerte(x.kennzahlen, x.werte);
  const ausserhalb = werteZeilen(x.kennzahlen, x.werte, x.toleranzEur)
    .filter((z) => z.lage === 'AUSSERHALB')
    .map((z) => z.def.label);
  const kommentarFehlt =
    x.ergebnis === 'MIT_BEFUND' && (x.ergebnisKommentar ?? '').trim().length < MIN_BEFUND_KOMMENTAR;
  const maengel: string[] = [];
  if (erledigt < x.schritte.length)
    maengel.push(`${x.schritte.length - erledigt} von ${x.schritte.length} Schritten offen`);
  if (werteFehlend.length) maengel.push(`Werte fehlen: ${werteFehlend.join(', ')}`);
  if (ausserhalb.length && x.ergebnis !== 'MIT_BEFUND')
    maengel.push(`Abweichung außerhalb der Toleranz ohne Erklärung: ${ausserhalb.join(', ')}`);
  if (x.nachweise < x.mindestNachweise)
    maengel.push(`Nachweise: ${x.nachweise} von mindestens ${x.mindestNachweise}`);
  if (!x.ergebnis) maengel.push('Ergebnis nicht gewählt');
  if (kommentarFehlt)
    maengel.push(`Befund beschreiben (mindestens ${MIN_BEFUND_KOMMENTAR} Zeichen)`);
  return {
    schritteErledigt: erledigt,
    schritteGesamt: x.schritte.length,
    werteFehlend,
    ausserhalb,
    nachweise: x.nachweise,
    mindestNachweise: x.mindestNachweise,
    ergebnis: x.ergebnis,
    kommentarFehlt,
    maengel,
  };
}

export function pruefungAus(d: DurchfuehrungDetail): EinreichPruefung {
  return pruefeEinreichung({
    schritte: d.schritte,
    kennzahlen: d.kennzahlen,
    werte: d.werte,
    toleranzEur: d.kontrolle.toleranzEur,
    nachweise: d.nachweise.length,
    mindestNachweise: d.kontrolle.mindestNachweise,
    ergebnis: d.ergebnis,
    ergebnisKommentar: d.ergebnisKommentar,
  });
}

// ---------------------------------------------------------------------------
// Rechte je Handlung (serverseitig in jeder Action geprüft, in der UI für
// disabled + Tooltip verwendet)
// ---------------------------------------------------------------------------

export interface Recht {
  erlaubt: boolean;
  grund: string | null;
}

export interface DurchfuehrungRechte {
  beginnen: Recht;
  /** Schritte, Werte, Ergebnis, Nachweise (ggf. mit implizitem Beginn). */
  bearbeiten: Recht;
  gegenzeichnen: Recht;
  mandantBestaetigen: Recht;
  zurueckweisen: Recht;
  entfallenBeantragen: Recht;
  entfallenFreigeben: Recht;
  entfallenAblehnen: Recht;
  nachtrag: Recht;
}

const ja: Recht = { erlaubt: true, grund: null };
const nein = (grund: string): Recht => ({ erlaubt: false, grund });

function statusGrund(s: GespeicherterStatus): string {
  switch (s) {
    case 'ZUR_GEGENZEICHNUNG':
      return 'Einreichung liegt vor — keine Änderung mehr möglich';
    case 'OHNE_BEFUND':
    case 'MIT_BEFUND':
      return 'Abgeschlossen — unveränderlich; Korrekturen entstehen als Nachtrag';
    case 'ENTFALLEN':
      return 'Entfallen — keine Änderung möglich';
    case 'GEPLANT':
      return 'Durchführung noch nicht begonnen';
    default:
      return 'In diesem Status nicht möglich';
  }
}

/** Portal: Lesen für gesetzliche Vertreter, Tax-Compliance-Beauftragte und zugewiesene Personen. */
export interface PortalLeseBezug {
  mandantId: string;
  kontrolle: Pick<
    DurchfuehrungDetail['kontrolle'],
    'partei' | 'durchfuehrendId' | 'vertretungId' | 'gegenzeichnerId'
  >;
}

export function darfPortalLesen(n: Handelnde, d: PortalLeseBezug): boolean {
  if (n.art !== 'MANDANT' || n.mandantId !== d.mandantId) return false;
  if (d.kontrolle.partei !== 'MANDANT') return false;
  // Ohne aktive Rolle beim Mandanten kein Zugriff (ADR 0001 §5).
  if (!n.rollen.some((r) => r.aktiv && r.mandantId === d.mandantId && r.kontaktId === n.id))
    return false;
  if (kannPortalLesen(n, d.mandantId, n.rollen)) return true;
  return [
    d.kontrolle.durchfuehrendId,
    d.kontrolle.vertretungId,
    d.kontrolle.gegenzeichnerId,
  ].includes(n.id);
}

function durchfuehrenGrund(n: Handelnde, d: DurchfuehrungDetail): string {
  if (d.kontrolle.partei === 'MANDANT' && n.art === 'KANZLEI')
    return 'Diese Kontrolle führt der Mandant im Portal durch';
  if (d.kontrolle.partei === 'KANZLEI' && n.art === 'MANDANT')
    return 'Diese Kontrolle führt die Kanzlei durch';
  return `Durchführung durch ${personName(d, d.kontrolle.durchfuehrendId)} oder Vertretung ${personName(d, d.kontrolle.vertretungId)}`;
}

export function rechteFuer(
  n: Handelnde,
  d: DurchfuehrungDetail,
  historisch: boolean,
): DurchfuehrungRechte {
  const m = d.mandant;
  const darfDurchfuehren = kannDurchfuehren(n, d.zustaendigkeit, d.mandantId, n.rollen);
  const beteiligt = d.beteiligte.includes(n.id);
  const vierAugen = 'Gegenzeichnung muss durch eine andere Person erfolgen (Vier-Augen-Prinzip)';

  const beginnen = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (d.status !== 'GEPLANT')
      return nein(BEARBEITBAR.includes(d.status) ? 'Bereits begonnen' : statusGrund(d.status));
    if (d.anzeige === 'GEPLANT')
      return nein(`Periode endet am ${fmtDatum(d.periodeBis)} — Beginn danach möglich`);
    if (!darfDurchfuehren) return nein(durchfuehrenGrund(n, d));
    return ja;
  })();

  const bearbeiten = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (d.status === 'GEPLANT') return beginnen;
    if (!BEARBEITBAR.includes(d.status)) return nein(statusGrund(d.status));
    if (!darfDurchfuehren) return nein(durchfuehrenGrund(n, d));
    return ja;
  })();

  /** Kanzlei-Gegenzeichnung (bei Mandanten-Gegenzeichnung: Abschluss nach der Bestätigung). */
  const kanzleiPruefer = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (d.status !== 'ZUR_GEGENZEICHNUNG')
      return nein(
        d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND'
          ? 'Bereits gegengezeichnet'
          : 'Nur für eingereichte Durchführungen',
      );
    if (n.art !== 'KANZLEI') return nein('Abschluss durch die Kanzlei');
    if (beteiligt) return nein(vierAugen);
    // Abschluss durch die Kanzlei; die ausstehende Mandanten-Bestätigung prüft `gegenzeichnen` gesondert.
    const g = kannGegenzeichnen(n, d.zustaendigkeit, m, d.durchgefuehrtVon, true, n.rollen);
    return g.erlaubt ? ja : nein(g.grund ?? KEIN_RECHT);
  })();

  const gegenzeichnen = ((): Recht => {
    if (!kanzleiPruefer.erlaubt) return kanzleiPruefer;
    if (d.kontrolle.gegenzeichnungMandant && !d.mandantBestaetigtVon)
      return nein('Bestätigung durch eine zweite Person beim Mandanten steht aus');
    return ja;
  })();

  const mandantBestaetigen = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (!d.kontrolle.gegenzeichnungMandant)
      return nein('Für diese Kontrolle ist keine Bestätigung beim Mandanten vorgesehen');
    if (d.status !== 'ZUR_GEGENZEICHNUNG') return nein('Nur für übermittelte Aufgaben');
    if (d.mandantBestaetigtVon)
      return nein(`Bereits bestätigt durch ${personName(d, d.mandantBestaetigtVon)}`);
    if (n.art !== 'MANDANT' || !darfPortalLesen(n, d))
      return nein('Bestätigung durch eine zweite Person beim Mandanten');
    if (beteiligt)
      return nein(
        'Die Bestätigung erfolgt durch eine zweite Person, nicht durch die durchführende',
      );
    const g = kannGegenzeichnen(n, d.zustaendigkeit, m, d.durchgefuehrtVon, false, n.rollen);
    return g.erlaubt ? ja : nein(g.grund ?? KEIN_RECHT);
  })();

  const zurueckweisen = n.art === 'KANZLEI' ? kanzleiPruefer : mandantBestaetigen;

  const hatAntrag = d.status !== 'ENTFALLEN' && !!d.entfallenBegruendung;
  const entfallenBeantragen = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (n.art !== 'KANZLEI') return nein(KEIN_RECHT);
    if (!OFFEN.includes(d.status))
      return nein(
        d.status === 'ZUR_GEGENZEICHNUNG'
          ? 'Eingereicht — zuerst zurückweisen'
          : statusGrund(d.status),
      );
    if (hatAntrag) return nein('Ein Antrag liegt bereits vor');
    if (!darfDurchfuehren && !kannBearbeiten(n, m)) return nein(KEIN_RECHT);
    return ja;
  })();
  const entfallenFreigeben = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (!hatAntrag) return nein('Kein Antrag offen');
    if (!kannWuerdigen(n, m))
      return nein('Freigabe durch die zuständige Berufsträgerin bzw. den zuständigen Berufsträger');
    if (n.id === d.entfallenVon) return nein('Freigabe durch eine zweite Person');
    return ja;
  })();
  const entfallenAblehnen = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (!hatAntrag) return nein('Kein Antrag offen');
    if (n.id === d.entfallenVon) return ja;
    return entfallenFreigeben;
  })();

  const nachtrag = ((): Recht => {
    if (historisch) return nein(NUR_AKTUELL);
    if (n.art !== 'KANZLEI') return nein(KEIN_RECHT);
    if (d.status !== 'OHNE_BEFUND' && d.status !== 'MIT_BEFUND')
      return nein('Nachträge nur zu abgeschlossenen Durchführungen');
    if (!darfDurchfuehren && !kannBearbeiten(n, m)) return nein(KEIN_RECHT);
    return ja;
  })();

  return {
    beginnen,
    bearbeiten,
    gegenzeichnen,
    mandantBestaetigen,
    zurueckweisen,
    entfallenBeantragen,
    entfallenFreigeben,
    entfallenAblehnen,
    nachtrag,
  };
}

// ---------------------------------------------------------------------------
// Kernlogik der gemeinsamen Handlungen
// ---------------------------------------------------------------------------

/** Fachlicher Abbruch innerhalb einer Transaktion (wird zu { fehler }). */
export class Abbruch extends Error {}

export function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

/** true, wenn das Formular aus einem historischen Stand gesendet wurde. */
export function ausHistorischemStand(fd: FormData): boolean {
  const s = text(fd, 'stand');
  return !!s && leseStand(s).historisch;
}

/** Lädt den aktuellen Stand (heute) für eine Action. */
export async function ladeFuerAktion(id: string): Promise<DurchfuehrungDetail | null> {
  if (!id) return null;
  return ladeDurchfuehrungDetail(id, heute(), false);
}

export async function fuehreAus(fn: () => Promise<Ergebnis>): Promise<Ergebnis> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return {
        fehler: 'Gleichzeitige Änderung erkannt. Bitte die Seite neu laden und erneut versuchen.',
      };
    }
    throw e;
  }
}

async function statusSperre(
  tx: Tx,
  id: string,
  erlaubt: readonly GespeicherterStatus[],
): Promise<void> {
  // Zeilensperre, damit parallele Handlungen denselben Übergang nicht doppelt ausführen.
  await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${id} FOR UPDATE`;
  const akt = await tx.durchfuehrung.findUnique({ where: { id }, select: { status: true } });
  if (!akt || !erlaubt.includes(akt.status))
    throw new Abbruch('Der Status hat sich zwischenzeitlich geändert. Bitte die Seite neu laden.');
}

function protokoll(
  d: DurchfuehrungDetail,
  aktion: string,
  detail: Record<string, unknown> = {},
  objekt?: { typ: string; id: string },
): Protokoll {
  return {
    aktion,
    objektTyp: objekt?.typ ?? 'Durchfuehrung',
    objektId: objekt?.id ?? d.id,
    programmId: d.programmId,
    detail: { kontrolle: d.kontrolle.code, periode: d.periodeLabel, ...detail },
  };
}

/** Status GEPLANT → IN_DURCHFUEHRUNG (explizit oder implizit beim ersten Speichern/Upload). */
async function beginneInTx(
  tx: Tx,
  d: DurchfuehrungDetail,
  nutzer: Handelnde,
  zeitpunkt: Date,
): Promise<Protokoll> {
  await tx.durchfuehrung.update({
    where: { id: d.id },
    data: {
      status: 'IN_DURCHFUEHRUNG',
      begonnenAm: zeitpunkt,
      durchgefuehrtVon: nutzer.id,
      schritte: d.schritte.map((s) => ({
        erledigt: s.erledigt,
        kommentar: s.kommentar,
      })) as unknown as Prisma.InputJsonValue,
    },
  });
  return protokoll(d, 'tcms.durchfuehrung.begonnen');
}

export async function kernBeginnen(nutzer: Handelnde, fd: FormData): Promise<Ergebnis> {
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).beginnen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    await mitAudit(nutzer, async (tx, zeitpunkt) => {
      await statusSperre(tx, d.id, ['GEPLANT']);
      return { wert: null, protokoll: await beginneInTx(tx, d, nutzer, zeitpunkt) };
    });
    aktualisiereMandant(d.mandantId);
    return { ok: 'Durchführung begonnen.' };
  });
}

/** Schritte, Werte und Ergebnis speichern; mit absicht=einreichen zusätzlich prüfen und einreichen. */
export async function kernSpeichern(nutzer: Handelnde, fd: FormData): Promise<Ergebnis> {
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).bearbeiten;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    const einreichen = text(fd, 'absicht') === 'einreichen';

    const schritte = d.schritte.map((_, i) => ({
      erledigt: fd.get(`schritt_${i}_erledigt`) === 'on',
      kommentar: text(fd, `schritt_${i}_kommentar`).trim().slice(0, 2000),
    }));
    const werte: Werte = {};
    const unlesbar: string[] = [];
    for (const k of d.kennzahlen) {
      const bemerkung = text(fd, `bemerkung_${k.key}`).trim().slice(0, 1000);
      const erklaert = fd.get(`erklaert_${k.key}`) === 'on';
      if (k.differenzAus) {
        werte[k.key] = { wert: null, bemerkung, erklaert };
        continue;
      }
      const w = parseDezimal(text(fd, `wert_${k.key}`));
      if (w === 'fehler') unlesbar.push(k.label);
      else werte[k.key] = { wert: w, bemerkung, erklaert };
    }
    if (unlesbar.length)
      return { fehler: `Bitte Beträge im Format 1.234,56 eingeben: ${unlesbar.join(', ')}.` };
    const e = text(fd, 'ergebnis');
    const ergebnis = e === 'OHNE_BEFUND' || e === 'MIT_BEFUND' ? e : null;
    const ergebnisKommentar = text(fd, 'ergebnisKommentar').trim().slice(0, 4000) || null;
    const kanal = nutzer.art === 'MANDANT' ? 'Portal' : 'Kanzlei';

    const maengel = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      await statusSperre(tx, d.id, d.status === 'GEPLANT' ? ['GEPLANT'] : BEARBEITBAR);
      const protokolle: Protokoll[] = [];
      if (d.status === 'GEPLANT') protokolle.push(await beginneInTx(tx, d, nutzer, zeitpunkt));
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: {
          schritte: schritte as unknown as Prisma.InputJsonValue,
          werte: werte as unknown as Prisma.InputJsonValue,
          ergebnis,
          ergebnisKommentar,
        },
      });
      protokolle.push(
        protokoll(d, 'tcms.durchfuehrung.gespeichert', {
          erledigt: schritte.filter((s) => s.erledigt).length,
          gesamt: schritte.length,
          werte: Object.values(werte).filter((w) => w.wert != null).length,
          ergebnis,
          kanal,
        }),
      );
      if (!einreichen) return { wert: [] as string[], protokoll: protokolle };

      const nachweise = await tx.nachweis.findMany({
        where: { durchfuehrungId: d.id },
        orderBy: { hochgeladenAm: 'asc' },
      });
      const p = pruefeEinreichung({
        schritte,
        kennzahlen: d.kennzahlen,
        werte,
        toleranzEur: d.kontrolle.toleranzEur,
        nachweise: nachweise.length,
        mindestNachweise: d.kontrolle.mindestNachweise,
        ergebnis,
        ergebnisKommentar,
      });
      if (p.maengel.length) return { wert: p.maengel, protokoll: protokolle };
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: {
          status: 'ZUR_GEGENZEICHNUNG',
          eingereichtAm: zeitpunkt,
          durchgefuehrtVon: nutzer.id,
          mandantBestaetigtVon: null,
        },
      });
      await tx.nachweis.updateMany({ where: { durchfuehrungId: d.id }, data: { gesperrt: true } });
      protokolle.push(
        protokoll(d, 'tcms.durchfuehrung.eingereicht', {
          ergebnis,
          kanal,
          nachweise: nachweise.map((n) => ({ id: n.id, dateiname: n.dateiname, sha256: n.sha256 })),
        }),
      );
      return { wert: [] as string[], protokoll: protokolle };
    });
    aktualisiereMandant(d.mandantId);
    if (einreichen && maengel.length)
      return {
        fehler: `Entwurf gespeichert, aber noch nicht eingereicht: ${maengel.join(' · ')}.`,
      };
    if (einreichen) {
      if (nutzer.art === 'MANDANT') {
        return {
          ok: d.kontrolle.gegenzeichnungMandant
            ? 'Übermittelt. Eine zweite Person bei Ihnen bestätigt nun die Vollständigkeit.'
            : 'An die Kanzlei übermittelt. Die Nachweise sind jetzt gesperrt.',
        };
      }
      return { ok: 'Zur Gegenzeichnung eingereicht. Die Nachweise sind jetzt gesperrt.' };
    }
    return { ok: 'Entwurf gespeichert.' };
  });
}

function dateinameBereinigt(name: string): string {
  const basis = name.split(/[\\/]/).pop() ?? '';
  const sauber = basis
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 180);
  return sauber || 'Nachweis';
}

function mimeBereinigt(typ: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(typ) ? typ.toLowerCase() : 'application/octet-stream';
}

export async function kernHochladen(nutzer: Handelnde, fd: FormData): Promise<Ergebnis> {
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const dateien = fd
      .getAll('dateien')
      .filter(
        (f): f is File =>
          typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0,
      );
    if (dateien.length === 0) return { fehler: 'Bitte mindestens eine Datei auswählen.' };
    const zuGross = dateien.filter((f) => f.size > MAX_DATEI_BYTES);
    if (zuGross.length)
      return { fehler: `Höchstens 20 MB je Datei: ${zuGross.map((f) => f.name).join(', ')}.` };
    if (dateien.reduce((s, f) => s + f.size, 0) > MAX_DATEI_BYTES)
      return { fehler: 'Höchstens 20 MB je Upload. Bitte größere Dateien einzeln hochladen.' };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).bearbeiten;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };

    // Ablage über den Port (Demo: lokal nach SHA-256, inhaltsadressiert, idempotent) vor der Transaktion.
    const gespeichert: (NachweisVerweis & { name: string })[] = [];
    for (const f of dateien) {
      const v = await legeNachweisdateiAb(
        Buffer.from(await f.arrayBuffer()),
        dateinameBereinigt(f.name),
        mimeBereinigt(f.type),
      );
      gespeichert.push({ ...v, name: v.dateiname });
    }

    const { neu, doppelt } = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      await statusSperre(tx, d.id, d.status === 'GEPLANT' ? ['GEPLANT'] : BEARBEITBAR);
      const protokolle: Protokoll[] = [];
      if (d.status === 'GEPLANT') protokolle.push(await beginneInTx(tx, d, nutzer, zeitpunkt));
      const vorhanden = new Set(
        (
          await tx.nachweis.findMany({ where: { durchfuehrungId: d.id }, select: { sha256: true } })
        ).map((n) => n.sha256),
      );
      const doppelt: string[] = [];
      let neu = 0;
      for (const g of gespeichert) {
        if (vorhanden.has(g.sha256)) {
          doppelt.push(g.name);
          continue;
        }
        vorhanden.add(g.sha256);
        const n = await tx.nachweis.create({
          data: {
            durchfuehrungId: d.id,
            dateiname: g.name,
            mime: g.mime,
            groesse: g.groesse,
            sha256: g.sha256,
            dokumentId: g.dokumentId,
            gesperrt: false,
            hochgeladenVon: nutzer.id,
            hochgeladenAm: zeitpunkt,
          },
        });
        neu++;
        protokolle.push(
          protokoll(
            d,
            'tcms.durchfuehrung.nachweis_hochgeladen',
            { durchfuehrungId: d.id, dateiname: g.name, sha256: g.sha256, groesse: g.groesse },
            { typ: 'Nachweis', id: n.id },
          ),
        );
      }
      if (protokolle.length === 0) throw new Abbruch(`Bereits vorhanden: ${doppelt.join(', ')}.`);
      return { wert: { neu, doppelt }, protokoll: protokolle };
    });
    aktualisiereMandant(d.mandantId);
    const teil = neu === 1 ? '1 Datei hochgeladen' : `${neu} Dateien hochgeladen`;
    return {
      ok: doppelt.length ? `${teil}; bereits vorhanden: ${doppelt.join(', ')}.` : `${teil}.`,
    };
  });
}

export async function kernEntfernen(nutzer: Handelnde, fd: FormData): Promise<Ergebnis> {
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const nachweis = await db.nachweis.findUnique({ where: { id: text(fd, 'nachweisId') } });
    if (!nachweis) return { fehler: 'Nachweis nicht gefunden.' };
    if (nachweis.gesperrt) return { fehler: 'Gesperrte Nachweise können nicht entfernt werden.' };
    const d = await ladeFuerAktion(nachweis.durchfuehrungId);
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).bearbeiten;
    if (!r.erlaubt || d.status === 'GEPLANT') return { fehler: r.grund ?? statusGrund(d.status) };
    await mitAudit(nutzer, async (tx) => {
      await statusSperre(tx, d.id, BEARBEITBAR);
      const del = await tx.nachweis.deleteMany({ where: { id: nachweis.id, gesperrt: false } });
      if (del.count !== 1) throw new Abbruch('Der Nachweis ist inzwischen gesperrt.');
      return {
        wert: null,
        protokoll: protokoll(
          d,
          'tcms.durchfuehrung.nachweis_entfernt',
          { durchfuehrungId: d.id, dateiname: nachweis.dateiname, sha256: nachweis.sha256 },
          { typ: 'Nachweis', id: nachweis.id },
        ),
      };
    });
    aktualisiereMandant(d.mandantId);
    return { ok: `${nachweis.dateiname} entfernt.` };
  });
}

/** Zurückweisen (Kanzlei-Prüfer:in oder zweite Person beim Mandanten); entsperrt die Nachweise. */
export async function kernZurueckweisen(nutzer: Handelnde, fd: FormData): Promise<Ergebnis> {
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const begruendung = text(fd, 'begruendung').trim();
    if (begruendung.length < 30)
      return { fehler: 'Bitte eine Begründung mit mindestens 30 Zeichen angeben.' };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).zurueckweisen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    await mitAudit(nutzer, async (tx) => {
      await statusSperre(tx, d.id, ['ZUR_GEGENZEICHNUNG']);
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: {
          status: 'ZURUECKGEWIESEN',
          zurueckgewiesenVon: nutzer.id,
          zurueckweisungsgrund: begruendung.slice(0, 4000),
          mandantBestaetigtVon: null,
        },
      });
      const ent = await tx.nachweis.updateMany({
        where: { durchfuehrungId: d.id },
        data: { gesperrt: false },
      });
      return {
        wert: null,
        protokoll: protokoll(d, 'tcms.durchfuehrung.zurueckgewiesen', {
          begruendung,
          nachweiseEntsperrt: ent.count,
        }),
      };
    });
    aktualisiereMandant(d.mandantId);
    return {
      ok: 'Zurückgewiesen. Die durchführende Person kann die Angaben überarbeiten und erneut einreichen.',
    };
  });
}

// ---------------------------------------------------------------------------
// Nachweis-Download (Route Handler)
// ---------------------------------------------------------------------------

export async function ladeNachweisFuerDownload(id: string) {
  return db.nachweis.findUnique({
    where: { id },
    include: {
      durchfuehrung: {
        include: {
          kontrolleStand: true,
          kontrolle: { include: { programm: { select: { mandantId: true } } } },
        },
      },
    },
  });
}
