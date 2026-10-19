import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  DF_MIN_BEGRUENDUNG,
  DienstFehler,
  gueltigerNachweisDateiname,
  type Akteur,
} from '@tcms/contract';
import { leseDatei } from '@tcms/db/demo-ablage';
import type { AnzeigeStatus, Klasse } from '@tcms/domain';
import {
  bestaetigeDurchfuehrung as dienstBestaetige,
  entferneNachweis as dienstEntferneNachweis,
  haengeNachweisAn as dienstHaengeNachweisAn,
  imDienst,
  ladeDurchfuehrung,
  ladeKontrollaufgabe,
  reicheDurchfuehrungEin as dienstReicheEin,
  speichereDurchfuehrung as dienstSpeichere,
  verweisAblage,
  weiseDurchfuehrungZurueck as dienstWeiseZurueck,
  type DienstKontext,
  type DienstPorts,
  type NachweisVerweis,
} from '@tcms/service';
import {
  MAX_DATEI_BYTES,
  parseDezimal,
  type KennzahlDef,
  type Werte,
} from '@/components/durchfuehrung/werte';
import { aktualisiereMandant } from './aktion';
import { DEMO_PORTS, demoAblage, demoPersonen, zustaendigkeit } from './demo';
import type { Ergebnis } from './ergebnis';
import { brauchtKanzleiFuer, brauchtPortal } from './sitzung';
import { leseStand } from './zeit';

// =============================================================================
// Kontrolldurchführung (S8, P2) in der Demo: dünne Hülle um @tcms/service.
// Laden, Rechte und alle Handlungen prüft der Service (ADR 0001 §2); die Demo
// bildet nur die JSON-Antwort auf die bisherigen Anzeige-Typen ab (Date,
// Personen aus dem Demo-Verzeichnis, Zuständigkeit des Mandanten) und spielt
// für Nachweise die kanzleikonsole: Sie legt Dateien lokal ab und reicht dem
// Service nur den Verweis (ADR 0001 §6).
// =============================================================================

export { DF_MIN_BEFUND_KOMMENTAR as MIN_BEFUND_KOMMENTAR } from '@tcms/contract';

/** Zuständigkeit eines Mandanten zur Anzeige (Demo-Verzeichnis); Rechte laufen über den Akteur. */
export interface MandantZustaendigkeit {
  id: string;
  berufstraegerId: string;
  bearbeitungId: string;
}

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
  pos: number;
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

type GespeicherterStatus =
  | 'GEPLANT'
  | 'IN_DURCHFUEHRUNG'
  | 'ZUR_GEGENZEICHNUNG'
  | 'ZURUECKGEWIESEN'
  | 'OHNE_BEFUND'
  | 'MIT_BEFUND'
  | 'ENTFALLEN';

export interface DurchfuehrungDetail {
  id: string;
  mandantId: string;
  mandant: MandantZustaendigkeit;
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
  /** Verknüpfte Feststellungen; vertrauliche für Nicht-Beteiligte ohne Titel und Schwere (RT-01). */
  feststellungen: (
    | {
        maskiert: false;
        id: string;
        nummer: string;
        titel: string;
        status: string;
        schwere: Klasse;
      }
    | { maskiert: true; id: string; nummer: string; status: string }
  )[];
  risiken: { id: string; code: string; titel: string }[];
  letzte: DurchfuehrungKurz[];
  nachtraege: DurchfuehrungKurz[];
  original: { id: string; periodeLabel: string } | null;
  verlauf: VerlaufEintrag[];
  /** Personen, die an der Durchführung mitgewirkt haben (dürfen nicht gegenzeichnen). */
  beteiligte: string[];
  personen: Record<string, PersonInfo>;
  /** Rechte des Akteurs je Handlung (vom Service, zum aktuellen Stand). */
  rechte: DurchfuehrungRechte;
  /** Prüfung des gespeicherten Stands für das Einreichen (vom Service). */
  pruefung: EinreichPruefung;
}

// ---------------------------------------------------------------------------
// Abbildung der Service-Antwort (JSON) auf die Anzeige-Typen der Demo
// ---------------------------------------------------------------------------

type DienstDetail = Awaited<ReturnType<typeof ladeDurchfuehrung>>;
type DienstAufgabe = Awaited<ReturnType<typeof ladeKontrollaufgabe>>;

const zeit = (iso: string): Date => new Date(iso);
const zeitN = (iso: string | null): Date | null => (iso ? new Date(iso) : null);
const tag = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function personenVerzeichnis(): Record<string, PersonInfo> {
  const out: Record<string, PersonInfo> = {};
  for (const p of demoPersonen.alle()) {
    out[p.id] = { id: p.id, name: p.name, art: p.art, funktion: p.funktion };
  }
  return out;
}

function alsDetail(d: DienstDetail | DienstAufgabe): DurchfuehrungDetail {
  const personen = personenVerzeichnis();
  const z = zustaendigkeit(d.mandantId);
  const kanzlei = 'verlauf' in d ? d : null;
  const werte: Werte = {};
  for (const w of d.werte)
    werte[w.key] = { wert: w.wert, bemerkung: w.bemerkung, erklaert: w.erklaert };
  const kurz = (x: { id: string; periodeLabel: string; anzeige: AnzeigeStatus }) => ({ ...x });
  return {
    id: d.id,
    mandantId: d.mandantId,
    mandant: {
      id: d.mandantId,
      berufstraegerId: z.berufstraegerId ?? '',
      bearbeitungId: z.bearbeitungId ?? '',
    },
    kontrolle: {
      ...d.kontrolle,
      gueltigAb: zeit(d.kontrolle.gueltigAb),
      design: kanzlei?.kontrolle.design ?? 'NICHT_BEURTEILT',
      designVon: kanzlei?.kontrolle.designVon ?? null,
      designAm: zeitN(kanzlei?.kontrolle.designAm ?? null),
    },
    periodeLabel: d.periodeLabel,
    periodeVon: tag(d.periodeVon),
    periodeBis: tag(d.periodeBis),
    faelligAm: tag(d.faelligAm),
    status: d.status,
    anzeige: d.anzeige,
    ausserplanmaessig: d.ausserplanmaessig,
    anlass: kanzlei?.anlass ?? null,
    schritte: d.schritte,
    kennzahlen: d.kontrolle.kennzahlen,
    werte,
    ergebnis: d.ergebnis,
    ergebnisKommentar: d.ergebnisKommentar,
    durchgefuehrtVon: d.durchgefuehrtVon,
    begonnenAm: zeitN(d.begonnenAm),
    eingereichtAm: zeitN(d.eingereichtAm),
    mandantBestaetigtVon: d.mandantBestaetigtVon,
    mandantBestaetigtAm: zeitN(d.mandantBestaetigtAm),
    gegengezeichnetVon: d.gegengezeichnetVon,
    abgeschlossenAm: zeitN(d.abgeschlossenAm),
    zurueckgewiesenVon: d.zurueckgewiesenVon,
    zurueckgewiesenAm: zeitN(d.zurueckgewiesenAm),
    zurueckweisungsgrund: d.zurueckweisungsgrund,
    entfallenBegruendung: d.entfallenBegruendung,
    entfallenVon: kanzlei?.entfallenVon ?? null,
    entfallenAm: zeitN(d.entfallenAm),
    entfallenFreigegebenVon: kanzlei?.entfallenFreigegebenVon ?? null,
    nachtragZuId: kanzlei?.nachtragZuId ?? null,
    createdAt: zeit(d.createdAt),
    vorhandenZumStand: d.vorhandenZumStand,
    nachweise: d.nachweise.map((n) => ({
      id: n.id,
      dateiname: n.dateiname,
      mime: n.mime,
      groesse: n.groesse,
      sha256: n.sha256,
      gesperrt: n.gesperrt,
      hochgeladenVon: n.hochgeladenVon,
      hochgeladenAm: zeit(n.hochgeladenAm),
    })),
    nachweiseAusgeblendet: d.nachweiseAusgeblendet,
    feststellungen: (kanzlei?.feststellungen ?? []).map((f) =>
      f.maskiert
        ? { maskiert: true as const, id: f.id, nummer: f.nummer, status: f.status }
        : {
            maskiert: false as const,
            id: f.id,
            nummer: f.nummer,
            titel: f.titel,
            status: f.status,
            schwere: f.schwere,
          },
    ),
    risiken: kanzlei?.risiken ?? [],
    letzte: (kanzlei?.letzte ?? []).map(kurz),
    nachtraege: (kanzlei?.nachtraege ?? []).map(kurz),
    original: d.original,
    verlauf: (kanzlei?.verlauf ?? []).map((v) => ({
      pos: v.pos,
      at: zeit(v.at),
      actorId: v.actorId,
      actorName: v.system ? 'System' : ((v.actorId && personen[v.actorId]?.name) ?? '—'),
      aktion: v.aktion,
      text: v.text,
      system: v.system,
    })),
    beteiligte: kanzlei?.beteiligte ?? [],
    personen,
    rechte: d.rechte,
    pruefung: d.pruefung,
  };
}

/** Optionen der Demo-Transaktionen (wie `mitAudit` der Demo). */
const DEMO_TX = { timeoutMs: 30_000, maxWaitMs: 10_000 };

/** Führt `fn` im Dienstkontext des Demo-Akteurs aus (Ports der Demo oder abweichend). */
export function imDemoDienst<T>(
  akteur: Akteur,
  fn: (ctx: DienstKontext) => Promise<T>,
  ports: DienstPorts = DEMO_PORTS,
): Promise<T> {
  return imDienst(akteur, ports, fn, DEMO_TX);
}

/**
 * Lädt eine Kontrolldurchführung (Kanzlei, S8) über den Service. Nicht
 * sichtbar (fremder Mandant, unbekannt, ungültig) → null (Seite: 404).
 */
export async function ladeDurchfuehrungDetail(
  akteur: Akteur,
  mandantId: string,
  id: string,
  stand?: string,
): Promise<DurchfuehrungDetail | null> {
  try {
    const d = await imDemoDienst(akteur, (ctx) =>
      ladeDurchfuehrung(ctx, { mandantId, durchfuehrungId: id, ...(stand ? { stand } : {}) }),
    );
    return alsDetail(d);
  } catch (e) {
    if (e instanceof DienstFehler && (e.code === 'NICHT_GEFUNDEN' || e.code === 'UNGUELTIG'))
      return null;
    throw e;
  }
}

/** Lädt eine Kontrollaufgabe im Portal (P2) für den Mandantenkontakt; nicht sichtbar → null. */
export async function ladeAufgabeDetail(
  akteur: Extract<Akteur, { art: 'MANDANT' }>,
  id: string,
  stand?: string,
): Promise<DurchfuehrungDetail | null> {
  try {
    const d = await imDemoDienst(akteur, (ctx) =>
      ladeKontrollaufgabe(ctx, {
        mandantId: akteur.mandantId,
        durchfuehrungId: id,
        ...(stand ? { stand } : {}),
      }),
    );
    return alsDetail(d);
  } catch (e) {
    if (e instanceof DienstFehler && (e.code === 'NICHT_GEFUNDEN' || e.code === 'UNGUELTIG'))
      return null;
    throw e;
  }
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

/** Prüfung des gespeicherten Stands für das Einreichen (berechnet im Service). */
export function pruefungAus(d: DurchfuehrungDetail): EinreichPruefung {
  return d.pruefung;
}

// ---------------------------------------------------------------------------
// Helfer der Server Actions
// ---------------------------------------------------------------------------

export function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

/** true, wenn das Formular aus einem historischen Stand gesendet wurde (Bedienung; der Service nimmt keinen Stichtag an). */
export function ausHistorischemStand(fd: FormData): boolean {
  const s = text(fd, 'stand');
  return !!s && leseStand(s).historisch;
}

/**
 * Fehler des Service als Meldung der Action. Nicht sichtbare Objekte ergeben
 * immer dieselbe Meldung; andere Fehler werden weitergeworfen.
 */
export function alsErgebnis(e: unknown, nichtGefunden: string): Ergebnis {
  if (!(e instanceof DienstFehler)) throw e;
  if (e.code === 'NICHT_GEFUNDEN') return { fehler: nichtGefunden };
  if (e.code === 'UNGUELTIG' && e.felder) {
    const details = Object.values(e.felder).flat();
    return {
      fehler: details.length
        ? `${e.message.replace(/\.$/, '')}: ${details.join(', ')}.`
        : e.message,
    };
  }
  return { fehler: e.message === e.code ? 'Aktion nicht möglich.' : e.message };
}

// ---------------------------------------------------------------------------
// Nachweise: Demo als kanzleikonsole (Dateiablage), Service nur mit Verweis
// ---------------------------------------------------------------------------

/** Ports der Demo für das Anhängen: Der Service erhält nur Verweise (ADR 0001 §6). */
export const VERWEIS_PORTS: DienstPorts = { ...DEMO_PORTS, ablage: verweisAblage };

const RICHTUNG_UND_STEUER = /[\u0000-\u001f\u007f"\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function dateinameBereinigt(name: string): string {
  const basis = name.split(/[\\/]/).pop() ?? '';
  const sauber = basis.replace(RICHTUNG_UND_STEUER, '').trim().slice(0, 180);
  return sauber && gueltigerNachweisDateiname(sauber) ? sauber : 'Nachweis';
}

function mimeBereinigt(typ: string): string {
  const t = typ.toLowerCase();
  return t.length <= 127 && MIME.test(t) ? t : 'application/octet-stream';
}

/**
 * Demo-Ablage (Stellvertreterin der Dokumentenpipeline der kanzleikonsole):
 * legt die Datei inhaltsadressiert ab und vergibt eine Dokument-ID (UUID).
 * Der Service speichert nur den Verweis.
 */
export async function legeNachweisdateiAb(
  inhalt: Buffer,
  dateiname: string,
  mime: string,
): Promise<NachweisVerweis> {
  const v = await demoAblage.annehmen({
    art: 'DATEI',
    dateiname: dateinameBereinigt(dateiname),
    mime: mimeBereinigt(mime),
    inhalt,
  });
  return { ...v, dokumentId: randomUUID() };
}

/**
 * Demo: liest eine abgelegte Datei über ihren SHA-256 (inhaltsadressierte
 * Ablage `<sha[0:2]>/<sha256>`) und prüft dabei den Inhalt (TS-09).
 */
export function leseNachweisdatei(n: Pick<NachweisVerweis, 'sha256'>): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(n.sha256)) return Promise.reject(new Error('Ungültiger SHA-256'));
  return leseDatei(`${n.sha256.slice(0, 2)}/${n.sha256}`, n.sha256);
}

// ---------------------------------------------------------------------------
// Handlungen der Server Actions (Kanzlei S8 und Portal P2). Bewusst nicht in
// den 'use server'-Dateien: Diese Funktionen nehmen einen Akteur entgegen und
// dürfen nie als Server Action vom Browser aufrufbar sein.
// ---------------------------------------------------------------------------

const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
const NICHT_GEFUNDEN_KANZLEI = 'Durchführung nicht gefunden.';
const NICHT_GEFUNDEN_PORTAL = 'Diese Aufgabe wurde nicht gefunden.';
const ZU_KURZ = `Bitte eine Begründung mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen angeben.`;

/** Akteur und Mandant der Handlung: Kanzlei mit Bezug auf den Mandanten des Formulars, Portal mit eigenem Mandanten. */
export interface Handlung {
  akteur: Akteur;
  mandantId: string;
  nichtGefunden: string;
}

export async function kanzleiHandlung(fd: FormData): Promise<Handlung> {
  const mandantId = text(fd, 'mandant');
  return {
    akteur: await brauchtKanzleiFuer(mandantId),
    mandantId,
    nichtGefunden: NICHT_GEFUNDEN_KANZLEI,
  };
}

export async function portalHandlung(): Promise<Handlung> {
  const { akteur } = await brauchtPortal();
  return { akteur, mandantId: akteur.mandantId, nichtGefunden: NICHT_GEFUNDEN_PORTAL };
}

/** Führt eine Handlung im Service aus; Service-Fehler werden zur Meldung. */
export async function handeln(
  h: Handlung,
  fd: FormData,
  fn: (
    ctx: DienstKontext,
    ziel: { mandantId: string; durchfuehrungId: string },
  ) => Promise<Ergebnis>,
): Promise<Ergebnis> {
  if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
  const ziel = { mandantId: h.mandantId, durchfuehrungId: text(fd, 'id') };
  try {
    const erg = await imDemoDienst(h.akteur, (ctx) => fn(ctx, ziel));
    aktualisiereMandant(h.mandantId);
    return erg;
  } catch (e) {
    return alsErgebnis(e, h.nichtGefunden);
  }
}

/** Liest Schrittzahl und Kennzahlen der Durchführung (über den Service, mit Rechteprüfung). */
async function aufbau(h: Handlung, durchfuehrungId: string) {
  const ziel = { mandantId: h.mandantId, durchfuehrungId };
  return imDemoDienst(h.akteur, (ctx) =>
    h.akteur.art === 'MANDANT' ? ladeKontrollaufgabe(ctx, ziel) : ladeDurchfuehrung(ctx, ziel),
  );
}

// ---------------------------------------------------------------------------
// Gemeinsame Hüllen (Kanzlei und Portal)
// ---------------------------------------------------------------------------

/** Schritte, Werte und Ergebnis speichern; mit absicht=einreichen zusätzlich einreichen. */
export async function speichernAls(h: Handlung, fd: FormData): Promise<Ergebnis> {
  if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
  let d: Awaited<ReturnType<typeof aufbau>>;
  try {
    d = await aufbau(h, text(fd, 'id'));
  } catch (e) {
    return alsErgebnis(e, h.nichtGefunden);
  }
  const einreichen = text(fd, 'absicht') === 'einreichen';
  const schritte = d.schritte.map((_, i) => ({
    erledigt: fd.get(`schritt_${i}_erledigt`) === 'on',
    kommentar: text(fd, `schritt_${i}_kommentar`).trim().slice(0, 2000),
  }));
  const werte: { key: string; wert: number | null; bemerkung: string; erklaert: boolean }[] = [];
  const unlesbar: string[] = [];
  for (const k of d.kontrolle.kennzahlen) {
    const bemerkung = text(fd, `bemerkung_${k.key}`).trim().slice(0, 1000);
    const erklaert = fd.get(`erklaert_${k.key}`) === 'on';
    if (k.differenzAus) {
      werte.push({ key: k.key, wert: null, bemerkung, erklaert });
      continue;
    }
    const w = parseDezimal(text(fd, `wert_${k.key}`));
    if (w === 'fehler') unlesbar.push(k.label);
    else werte.push({ key: k.key, wert: w, bemerkung, erklaert });
  }
  if (unlesbar.length)
    return { fehler: `Bitte Beträge im Format 1.234,56 eingeben: ${unlesbar.join(', ')}.` };
  const e = text(fd, 'ergebnis');
  const ergebnis = e === 'OHNE_BEFUND' || e === 'MIT_BEFUND' ? e : null;
  const ergebnisKommentar = text(fd, 'ergebnisKommentar').trim().slice(0, 4000) || null;

  const gespeichert = await handeln(h, fd, async (ctx, ziel) => {
    await dienstSpeichere(ctx, { ...ziel, schritte, werte, ergebnis, ergebnisKommentar });
    return { ok: 'Entwurf gespeichert.' };
  });
  if (!einreichen || gespeichert?.fehler) return gespeichert;

  // Einreichen in eigener Transaktion: Der gespeicherte Entwurf bleibt bei Mängeln erhalten.
  try {
    await imDemoDienst(h.akteur, (ctx) =>
      dienstReicheEin(ctx, { mandantId: h.mandantId, durchfuehrungId: d.id }),
    );
  } catch (err) {
    if (err instanceof DienstFehler && err.code === 'UNGUELTIG' && err.felder?.['maengel']) {
      return {
        fehler: `Entwurf gespeichert, aber noch nicht eingereicht: ${err.felder['maengel'].join(' · ')}.`,
      };
    }
    return alsErgebnis(err, h.nichtGefunden);
  } finally {
    aktualisiereMandant(h.mandantId);
  }
  if (h.akteur.art === 'MANDANT') {
    return {
      ok: d.kontrolle.gegenzeichnungMandant
        ? 'Übermittelt. Eine zweite Person bei Ihnen bestätigt nun die Vollständigkeit.'
        : 'An die Kanzlei übermittelt. Die Nachweise sind jetzt gesperrt.',
    };
  }
  return { ok: 'Zur Gegenzeichnung eingereicht. Die Nachweise sind jetzt gesperrt.' };
}

/** Dateien ablegen (Demo als kanzleikonsole) und als Verweise anhängen. */
export async function hochladenAls(h: Handlung, fd: FormData): Promise<Ergebnis> {
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
  // Rechte vor der Ablage: ohne Recht wird nichts gespeichert.
  let vorhanden: Map<string, string>;
  try {
    const d = await aufbau(h, text(fd, 'id'));
    if (!d.rechte.bearbeiten.erlaubt)
      return { fehler: d.rechte.bearbeiten.grund ?? 'Upload nicht möglich.' };
    vorhanden = new Map(d.nachweise.map((n) => [n.sha256, n.dateiname]));
  } catch (e) {
    return alsErgebnis(e, h.nichtGefunden);
  }
  // Ablage wie in der kanzleikonsole (inhaltsadressiert, idempotent); gleicher Inhalt
  // in derselben Durchführung wird übersprungen (wie bisher).
  const neue: NachweisVerweis[] = [];
  const doppelt: string[] = [];
  for (const f of dateien) {
    const v = await legeNachweisdateiAb(Buffer.from(await f.arrayBuffer()), f.name, f.type);
    if (vorhanden.has(v.sha256)) doppelt.push(v.dateiname);
    else {
      vorhanden.set(v.sha256, v.dateiname);
      neue.push(v);
    }
  }
  if (neue.length === 0) return { fehler: `Bereits vorhanden: ${doppelt.join(', ')}.` };
  const ziel = { mandantId: h.mandantId, durchfuehrungId: text(fd, 'id') };
  try {
    await imDemoDienst(
      h.akteur,
      async (ctx) => {
        for (const verweis of neue) await dienstHaengeNachweisAn(ctx, { ...ziel, verweis });
      },
      VERWEIS_PORTS,
    );
    aktualisiereMandant(h.mandantId);
  } catch (e) {
    return alsErgebnis(e, h.nichtGefunden);
  }
  const teil = neue.length === 1 ? '1 Datei hochgeladen' : `${neue.length} Dateien hochgeladen`;
  return { ok: doppelt.length ? `${teil}; bereits vorhanden: ${doppelt.join(', ')}.` : `${teil}.` };
}

export async function entfernenAls(h: Handlung, fd: FormData): Promise<Ergebnis> {
  return handeln(h, fd, async (ctx, ziel) => {
    await dienstEntferneNachweis(ctx, { ...ziel, nachweisId: text(fd, 'nachweisId') });
    return { ok: 'Nachweis entfernt.' };
  });
}

/** Zurückweisen (Kanzlei-Prüfer:in) bzw. Zurückgeben (zweite Person beim Mandanten). */
export async function zurueckweisenAls(h: Handlung, fd: FormData): Promise<Ergebnis> {
  const begruendung = text(fd, 'begruendung').trim().slice(0, 4000);
  if (begruendung.length < DF_MIN_BEGRUENDUNG) return { fehler: ZU_KURZ };
  return handeln(h, fd, async (ctx, ziel) => {
    await dienstWeiseZurueck(ctx, { ...ziel, begruendung });
    return {
      ok: 'Zurückgewiesen. Die durchführende Person kann die Angaben überarbeiten und erneut einreichen.',
    };
  });
}

/** Bestätigung durch eine zweite Person beim Mandanten. */
export async function bestaetigenAls(h: Handlung, fd: FormData): Promise<Ergebnis> {
  return handeln(h, fd, async (ctx, ziel) => {
    await dienstBestaetige(ctx, ziel);
    return { ok: 'Vollständigkeit bestätigt. Die Kanzlei prüft nun und schließt die Aufgabe ab.' };
  });
}
