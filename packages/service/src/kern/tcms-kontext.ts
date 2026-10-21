// =============================================================================
// Tax-CMS-Kontext eines Mandanten zu einem Stichtag (bisher
// apps/web/src/server/kontext.ts). Alle Sichten im Mandantenkontext lesen aus
// dieser einen Quelle; Bewertungen, Frequenzen, Phasen und Lücken werden hier
// aus den Daten berechnet, nie gespeichert (AGENTS.md Regel 2).
//
// Rechte (TS-03, ADR 0001 §3.3/§5): Der Lader prüft selbst `kannLesen` für den
// Akteur des Dienstkontexts. Fremder Mandant, fremder Tenant, unbekannte ID:
// immer `NICHT_GEFUNDEN` (kein Existenz-Orakel). Vertrauliche Feststellungen
// sind für Nicht-Beteiligte bereits maskiert (`kannVertraulichLesen` mit
// `beteiligteVon` aus `rechte.ts`): Sie enthalten nur, was auch der dedizierte
// Lesepfad zeigt (`maskiert: true`, Nummer, Status, Erfassung – RT-01), und
// Kennzahlen leiten aus ihnen keine Inhalte (Steuerwirkung, §-153, Schwere) ab.
//
// Personen: Das Ergebnis enthält nur IDs der kanzleikonsole; Anzeigenamen
// kommen über `ctx.personen` (im Dienst leer). Zuständigkeit (BT,
// Hauptbearbeitung) kennt das Tax-CMS nicht (ADR 0001 §5) – sie steht nur im
// Akteur (`cli.bt`/`cli.hb`).
//
// Das Ergebnis ist der interne Lesestand für Fachoperationen (mit `Date` und
// `Map`), keine HTTP-Antwort; der Endpunkt bildet ihn explizit ab.
// =============================================================================

import {
  DienstFehler,
  KontextEingabeSchema,
  type Akteur,
  type KontextEingabe,
  type PflichtattributLuecke,
} from '@tcms/contract';
import type { Prisma } from '@tcms/db';
import {
  abschnittHatText,
  betriebsStand,
  bewerte,
  bewerteGrundelemente,
  bewertePhasen,
  bewerteSchwelle,
  GRUPPE_LABEL,
  hoeher,
  istEuAusland,
  katalogRisiko,
  leiteFrequenzAb,
  monatSchluessel,
  pruflast,
  statusAm,
  ueber,
  type Abschnitt,
  type AnzeigeStatus,
  type BetriebsStand,
  type Design,
  type FrequenzAbleitung,
  type Frequenz,
  type Geschaeftsprofil,
  type GovernanceTyp,
  type GrundelementStatus,
  type Klasse,
  type Normanker,
  type PhasenInfo,
  type Pruflast,
  type RisikoBewertung,
  type RisikoGruppe,
  type SchwellenErgebnis,
  type Turnus,
} from '@tcms/domain';
import type { DienstKontext } from '../kontext';
import { beteiligteVon, kannLesen, kannVertraulichLesen, type MandantRolle } from '../rechte';
import { ladeKontaktRollen } from '../rollen';
import { heuteDatum, leseStand, tagesende } from './zeit';

export interface RisikoView {
  id: string;
  code: string;
  gruppe: RisikoGruppe;
  gruppeLabel: string;
  kern: boolean;
  herkunft: 'KATALOG' | 'BERATER';
  freigabe: 'IDENTIFIZIERT' | 'BEWERTET' | 'ZUR_FREIGABE' | 'FREIGEGEBEN';
  freigabeEingereichtVon: string | null;
  freigegebenVon: string | null;
  freigegebenAm: Date | null;
  ownerId: string | null;
  neuBewerten: boolean;
  vorschlagsgrund: string | null;
  standId: string;
  titel: string;
  fehlerquelle: string;
  folge: string;
  normanker: Normanker[];
  s: 'N' | 'M' | 'H';
  w: 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';
  r: 1 | 2 | 3;
  gt: GovernanceTyp;
  gueltigAb: Date;
  kontrollIds: string[];
  bewertung: RisikoBewertung;
  /** Wirksame Nettoklasse für den Appetit (Betrieb ab Beginn des Wirksamkeitszeitraums). */
  netto: Klasse;
  ueberAppetit: boolean;
  uebersteuerungen: {
    id: string;
    sicht: 'DESIGN' | 'BETRIEB';
    klasse: Klasse;
    berechnet: Klasse;
    begruendung: string;
    status: 'BEANTRAGT' | 'FREIGEGEBEN' | 'ABGELEHNT' | 'AUFGEHOBEN';
    beantragtVon: string;
    beantragtAm: Date;
    entschiedenVon: string | null;
    entschiedenAm: Date | null;
  }[];
  offeneEreignisse: number;
  wirktAuf: string[];
}

export interface Schritt {
  titel: string;
  hinweis: string;
}

export interface KennzahlDef {
  key: string;
  label: string;
  sollEur: number | null;
  differenzAus?: [string, string];
}

export interface KontrolleView {
  id: string;
  code: string;
  standId: string;
  version: number;
  titel: string;
  ziel: string;
  art: 'P' | 'D' | 'K';
  ausfuehrung: 'M' | 'IT' | 'A';
  vorlage: Frequenz;
  abweichung: {
    frequenz: Frequenz;
    begruendung: string | null;
    freigegebenVon: string | null;
  } | null;
  partei: 'KANZLEI' | 'MANDANT';
  schluessel: boolean;
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  nachweis: string;
  mindestNachweise: number;
  schritte: Schritt[];
  kennzahlen: KennzahlDef[];
  toleranzEur: number | null;
  faelligNachTagen: number;
  design: Design;
  designVon: string | null;
  designAm: Date | null;
  designBegruendung: string | null;
  risikoIds: string[];
  risikoCodes: string[];
  ableitung: FrequenzAbleitung;
  /** Effektive Frequenz nach freigegebener Abweichung. */
  frequenz: Frequenz;
  gt: GovernanceTyp | null;
  betrieb: BetriebsStand;
  letzte: DurchfuehrungView | null;
  naechste: DurchfuehrungView | null;
  pflichtattributeOk: boolean;
  /** Fehlende Pflichtattribute (`pflichtattributLuecken`); leer genau bei `pflichtattributeOk`. */
  pflichtattributeLuecken: PflichtattributLuecke[];
}

export interface DurchfuehrungView {
  id: string;
  kontrolleId: string;
  code: string;
  titel: string;
  periodeLabel: string;
  periodeVon: Date;
  periodeBis: Date;
  faelligAm: Date;
  status: string;
  anzeige: AnzeigeStatus;
  ausserplanmaessig: boolean;
  anlass: string | null;
  partei: 'KANZLEI' | 'MANDANT';
  durchfuehrendId: string | null;
  gegenzeichnerId: string | null;
  durchgefuehrtVon: string | null;
  gegengezeichnetVon: string | null;
  /** Bestätigung durch eine zweite Person beim Mandanten (nur bei Mandanten-Gegenzeichnung). */
  mandantBestaetigtVon: string | null;
  eingereichtAm: Date | null;
  abgeschlossenAm: Date | null;
  nachweise: number;
  mindestNachweise: number;
  gt: GovernanceTyp | null;
  schluessel: boolean;
}

/** Feststellung, die der Akteur lesen darf (nicht vertraulich oder beteiligt). */
export interface FeststellungView {
  maskiert: false;
  id: string;
  nummer: string;
  titel: string;
  sachverhalt: string;
  quelle: 'KONTROLLE' | 'EREIGNIS' | 'STICHPROBE' | 'HINWEIS' | 'AUSSENPRUEFUNG';
  quelleText: string;
  klasse: 'DESIGNMANGEL' | 'DURCHFUEHRUNGSMANGEL' | 'STEUERLICHER_FEHLER' | 'HINWEIS';
  schwere: Klasse;
  auswirkung: 'JA' | 'NEIN' | 'UNKLAR';
  status:
    | 'ERFASST'
    | 'IN_WUERDIGUNG'
    | 'MASSNAHMEN_OFFEN'
    | 'NACHKONTROLLE'
    | 'GESCHLOSSEN'
    | 'VERWORFEN';
  vertraulich: boolean;
  /**
   * Beteiligte Personen (`beteiligteVon`); eine vertrauliche Feststellung sehen
   * außerdem Admin, zuständige BT und Hauptbearbeitung.
   */
  beteiligte: string[];
  p153Entscheidung: 'BERICHTIGUNG' | 'KEINE_PFLICHT' | 'WEITERE_KLAERUNG' | 'UEBERGABE' | null;
  p153Offen: boolean;
  massnahmenOffen: number;
  massnahmen: number;
  aeltesteFrist: Date | null;
  erfasstAm: Date;
  risikoCodes: string[];
}

/**
 * Vertrauliche Feststellung für Nicht-Beteiligte (Fachkonzept §13, RT-01):
 * dieselbe Information wie der dedizierte Lesepfad (`ladeFeststellungen`,
 * `maskiert: true`) – Nummer, Status und Erfassungszeitpunkt. Kein Titel,
 * keine Steuerwirkung, keine §-153-Angaben, keine Schwere oder Klasse, keine
 * Maßnahmen-Zähler oder Fristen, keine Risikocodes und keine Beteiligten.
 */
export interface FeststellungMaskiert {
  maskiert: true;
  id: string;
  nummer: string;
  vertraulich: true;
  status: FeststellungView['status'];
  erfasstAm: Date;
}

/** Feststellung im Kontext: lesbar oder maskiert (diskriminiert über `maskiert`). */
export type FeststellungSicht = FeststellungView | FeststellungMaskiert;

export interface EreignisView {
  id: string;
  nummer: string;
  typ: string;
  titel: string;
  beschreibung: string;
  quelle: 'PORTAL' | 'KONTROLLE' | 'STAMMDATEN' | 'RSS' | 'MANUELL';
  gemeldetVon: string | null;
  gemeldetAm: Date;
  ereignisDatum: Date;
  status: 'NEU' | 'IN_TRIAGE' | 'ERLEDIGT' | 'VERWORFEN';
  verwerfenBegruendung: string | null;
  triagiertVon: string | null;
  triagiertAm: Date | null;
  folgen: {
    id: string;
    art: string;
    ziel: string | null;
    text: string;
    zustaendig: string | null;
    frist: Date | null;
    status: 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN';
    objektId: string | null;
  }[];
}

export interface LandView {
  id: string;
  land: string;
  fernverkaeufeLfdEur: number;
  fernverkaeufeVorjahrEur: number;
  lagerSeit: string | null;
  oss: boolean;
  lokaleUstNr: boolean;
  zmRelevant: boolean;
  steuersaetzeGeprueftAm: Date | null;
  stand: Date;
  quelle: 'MANUELL' | 'CSV';
  erfasstVon: string | null;
  registrierung: 'VOLLSTAENDIG' | 'FEHLT' | 'PRUEFEN';
}

export interface BeschreibungView {
  id: string;
  nummer: string;
  status: 'ENTWURF' | 'KANZLEI_REVIEW' | 'BEIM_MANDANTEN' | 'FREIGEGEBEN' | 'ABGELOEST';
  abschnitte: Abschnitt[];
  createdAt: Date;
  erstelltVon: string | null;
  reviewAngefordertVon: string | null;
  reviewAngefordertAm: Date | null;
  reviewVon: string | null;
  reviewAm: Date | null;
  freigabeAngefordertAm: Date | null;
  freigegebenVon: string | null;
  freigegebenAm: Date | null;
  snapshotSha256: string | null;
}

/** Aktive Rolle eines Mandantenkontakts beim Mandanten (Zeile aus MandantKontaktRolle). */
export interface KontaktRolleView {
  kontaktId: string;
  rolle: MandantRolle;
  funktion: string | null;
}

export interface TcmsKontext {
  heute: Date;
  stand: Date;
  historisch: boolean;
  /** Mandantenanker (Stammdaten der kanzleikonsole, ADR 0001 §5). */
  mandant: {
    id: string;
    name: string;
    rechtsform: string;
    datevNr: string | null;
  };
  /**
   * Aktive Rollen der Mandantenseite (MandantKontaktRolle), nach Anlage
   * sortiert; ein Kontakt mit mehreren Rollen erscheint mehrfach.
   */
  kontaktRollen: KontaktRolleView[];
  /**
   * Anzeigenamen der im Kontext genannten Personen-IDs über `ctx.personen`
   * (im Dienst leer: die kanzleikonsole löst Namen auf).
   */
  namen: Map<string, string>;
  programm: {
    id: string;
    status: 'ENTWURF' | 'AKTIV';
    paketVersion: string;
    erklaerungsTurnus: Turnus;
    angemessenheitStichtag: Date | null;
    wirksamAb: Date | null;
    wirksamBis: Date | null;
    version1Am: Date | null;
    createdAt: Date;
  } | null;
  teilbereich: {
    id: string;
    name: string;
    abgrenzung: string;
    einschluesse: string[];
    ausschluesse: string[];
  } | null;
  ziele: {
    id: string;
    text: string;
    wesentlichkeitEur: number;
    risikoappetit: Klasse;
    freigabe: 'ENTWURF' | 'AUSSTEHEND' | 'FREIGEGEBEN';
    freigegebenAm: Date | null;
    freigegebenVon: string | null;
  }[];
  appetit: Klasse;
  profil: Geschaeftsprofil | null;
  profilGueltigAb: Date | null;
  risiken: RisikoView[];
  vorschlaege: {
    id: string;
    code: string;
    grund: string | null;
    entscheidung: 'VORGESCHLAGEN' | 'ABGELEHNT';
    ablehnungsgrund: string | null;
  }[];
  kontrollen: KontrolleView[];
  durchfuehrungen: DurchfuehrungView[];
  /** Vertrauliche Feststellungen für Nicht-Beteiligte maskiert (RT-01). */
  feststellungen: FeststellungSicht[];
  ereignisse: EreignisView[];
  laender: LandView[];
  schwelle: SchwellenErgebnis;
  fernverkaeufeLfd: number;
  fernverkaeufeVorjahr: number;
  laenderStand: Date | null;
  laenderQuelle: 'MANUELL' | 'CSV' | null;
  beschreibungen: BeschreibungView[];
  phasen: PhasenInfo[];
  aktivePhase: number;
  grundelemente: GrundelementStatus[];
  prueflast: Pruflast[];
  zeitraum: {
    monat: number;
    monate: number;
    relevante: number;
    ohneBefund: number;
    mitBefund: number;
    offen: number;
    ohneGegenzeichnung: number;
    ueberfaellig: number;
    fehlendeNachweise: number;
    /**
     * Codes wiederkehrender Kontrollen (Turnus ≠ KEIN) ohne jede – auch
     * geplante – nicht entfallene Durchführung mit Fälligkeit im Zeitraum
     * (+ 60 Tage Nachlauf); leer, solange der Zeitraum zum Stand nicht begonnen hat.
     */
    ohneDurchfuehrung: string[];
    /** Summe der Nachweise abgeschlossener Durchführungen (ohne/mit Befund) im Zeitraum. */
    nachweise: number;
    /** Entfallene Durchführungen im Zeitraum (zählen nicht als „ohne Befund"). */
    entfallen: number;
  } | null;
  /** Objekte, die wegen des Stichtags ausgeblendet sind. */
  ausgeblendet: number;
}

function gueltig<T extends { gueltigAb: Date; gueltigBis: Date | null }>(
  liste: T[],
  ende: Date,
): T | undefined {
  return liste
    .filter(
      (s) =>
        s.gueltigAb.getTime() <= ende.getTime() &&
        (s.gueltigBis == null || s.gueltigBis.getTime() > ende.getTime()),
    )
    .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
}

/**
 * Fehlende Pflichtattribute eines Kontrollstands (Fachkonzept §6), in der
 * festen Reihenfolge des Vertrags: Ziel, Schritte, Nachweisanforderung,
 * durchführende Person, Vertretung (verschieden), bei Schlüsselkontrollen eine
 * Gegenzeichnung (andere Person oder beim Mandanten). Einzige Quelle für
 * `pflichtattributeOk` und die Liste.
 */
export function pflichtattributLuecken(ks: {
  ziel: string;
  schritte: readonly unknown[];
  nachweis: string;
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  schluessel: boolean;
}): PflichtattributLuecke[] {
  const luecken: PflichtattributLuecke[] = [];
  if (!ks.ziel) luecken.push('Ziel');
  if (ks.schritte.length === 0) luecken.push('Schritte');
  if (!ks.nachweis) luecken.push('Nachweisanforderung');
  if (!ks.durchfuehrendId) luecken.push('durchführende Person');
  if (!ks.vertretungId || ks.vertretungId === ks.durchfuehrendId)
    luecken.push('Vertretung (verschieden von der durchführenden Person)');
  if (
    ks.schluessel &&
    !ks.gegenzeichnungMandant &&
    (!ks.gegenzeichnerId || ks.gegenzeichnerId === ks.durchfuehrendId)
  )
    luecken.push('Gegenzeichnung (Pflicht bei Schlüsselkontrollen)');
  return luecken;
}

/** Nachlauf nach dem Wirksamkeitszeitraum: Fälligkeiten bis 60 Tage nach dessen Ende zählen mit. */
const NACHLAUF_MS = 60 * 86_400_000;

function monatePlus(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Prüft die Eingabe; Feldfehler als `UNGUELTIG` (wie der Dienst bei zod-Fehlern). */
function pruefeEingabe(eingabe: unknown): { mandantId: string; stand: string | undefined } {
  const p = KontextEingabeSchema.safeParse(eingabe);
  if (!p.success) {
    const felder: Record<string, string[]> = {};
    for (const i of p.error.issues) (felder[i.path.join('.') || 'eingabe'] ??= []).push(i.message);
    throw new DienstFehler('UNGUELTIG', 'Eingabe ungültig.', felder);
  }
  return { mandantId: p.data.mandantId.toLowerCase(), stand: p.data.stand };
}

/**
 * Was der Kontext je Programm aus der Datenbank braucht (eine Abfrage, auch für Blöcke).
 * Jede Liste in fester Reihenfolge mit der ID als letzter Stufe (Verknüpfungen: der
 * andere Schlüssel): Ohne ORDER BY hinge sie vom Abfrageplan ab, Einzel- und
 * Blockabfrage lieferten verschiedene Reihenfolgen, und Bausteine eingefrorener
 * Beschreibungen (SHA-256) hingen davon ab (tcms-s9, `__tests__/reihenfolge.test.ts`).
 */
const PROGRAMM_INHALT = {
  teilbereiche: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { ziele: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  },
  profile: { orderBy: [{ version: 'asc' }, { id: 'asc' }] },
  risiken: {
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    include: {
      staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] },
      kontrollen: { orderBy: { kontrolleId: 'asc' } },
      uebersteuerungen: { orderBy: [{ beantragtAm: 'desc' }, { id: 'desc' }] },
    },
  },
  kontrollen: {
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    include: {
      staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] },
      risiken: { orderBy: { risikoId: 'asc' } },
      durchfuehrungen: {
        orderBy: [{ periodeVon: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { nachweise: { where: { entferntAm: null } } } } },
      },
    },
  },
  feststellungen: {
    orderBy: [{ nummer: 'asc' }, { id: 'asc' }],
    include: {
      massnahmen: { orderBy: [{ wiedervorlageNr: 'asc' }, { id: 'asc' }] },
      risiken: { orderBy: { risikoId: 'asc' }, include: { risiko: true } },
    },
  },
  ereignisse: {
    include: { folgen: { orderBy: { id: 'asc' } } },
    orderBy: [{ gemeldetAm: 'desc' }, { id: 'desc' }],
  },
  laender: { orderBy: [{ land: 'asc' }, { stand: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
  beschreibungen: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.TcmsProgrammInclude;

type ProgrammRoh = Prisma.TcmsProgrammGetPayload<{ include: typeof PROGRAMM_INHALT }>;
type MandantRoh = { id: string; name: string; rechtsform: string; datevNr: string | null };
type KontaktRoh = { kontaktId: string; rolle: MandantRolle; funktion: string | null };

/**
 * Lädt den Tax-CMS-Kontext eines Mandanten zum Stichtag `stand` (Standard:
 * heute laut `ctx.uhr`; ein Stand ab heute ist der aktuelle Stand). Nur mit
 * `kannLesen` des Akteurs; sonst – wie bei unbekanntem Mandanten –
 * `DienstFehler('NICHT_GEFUNDEN')`. Ein Mandant ohne Programm liefert einen
 * leeren Kontext (`programm: null`).
 */
export async function ladeKontext(
  ctx: DienstKontext,
  eingabe: KontextEingabe,
): Promise<TcmsKontext> {
  const { mandantId, stand: standIso } = pruefeEingabe(eingabe);
  const tx = ctx.tx;
  // Rechte vor dem ersten Lesezugriff auf Daten des Mandanten (TS-03).
  const rollen = await ladeKontaktRollen(tx, ctx.akteur);
  if (!kannLesen(ctx.akteur, mandantId, rollen)) throw new DienstFehler('NICHT_GEFUNDEN');

  const heute = heuteDatum(ctx.uhr);
  const { stand, historisch } = leseStand(standIso, heute);
  // RLS beschränkt auf den Tenant des Akteurs: ein Mandant eines anderen Tenants ist hier unsichtbar.
  const mandant = await tx.mandant.findFirst({ where: { id: mandantId } });
  if (!mandant) throw new DienstFehler('NICHT_GEFUNDEN');
  const kontakte = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kontaktId: true, rolle: true, funktion: true },
  });
  const programm = await tx.tcmsProgramm.findFirst({
    where: { mandantId },
    orderBy: { createdAt: 'desc' },
    include: PROGRAMM_INHALT,
  });
  const k = berechne({ heute, stand, historisch }, ctx.akteur, mandant, kontakte, programm);
  return vollende(ctx, k, true);
}

/** Zugang zu einem Mandanten in einem mandantenübergreifenden Lesepfad. */
export interface KontextZugang {
  mandantId: string;
  /** Akteur mit Bezug auf genau diesen Mandanten (Rechte und Maskierung). */
  akteur: Akteur;
}

/** Mandanten je Block in `jeAktuellerKontext` (Abfragen und Speicher je Block begrenzt). */
export const KONTEXT_BLOCK = 50;

/**
 * Lädt die aktuellen Kontexte (Stand heute) mehrerer aktiver Mandanten in
 * Blöcken zu `KONTEXT_BLOCK` Mandanten – je Block eine feste Zahl Abfragen
 * statt einer je Mandant – und ruft `fn` je Kontext auf; die Rohdaten eines
 * Blocks werden danach verworfen. Rechte je Mandant wie `ladeKontext`
 * (`kannLesen` und Maskierung mit dem Akteur des Zugangs); Mandanten ohne
 * Leserecht, unbekannte, inaktive oder doppelte werden ausgelassen, ohne das
 * zu verraten. Namen werden hier nicht aufgelöst (`namen` bleibt leer).
 */
export async function jeAktuellerKontext(
  ctx: DienstKontext,
  zugaenge: readonly KontextZugang[],
  fn: (k: TcmsKontext, akteur: Akteur) => void,
  opts: { blockGroesse?: number } = {},
): Promise<void> {
  const groesse = Math.max(1, Math.min(opts.blockGroesse ?? KONTEXT_BLOCK, KONTEXT_BLOCK));
  const tx = ctx.tx;
  const rollen = await ladeKontaktRollen(tx, ctx.akteur);
  const zugangJe = new Map<string, Akteur>();
  for (const z of zugaenge) {
    const id = z.mandantId.toLowerCase();
    if (!zugangJe.has(id) && kannLesen(z.akteur, id, rollen)) zugangJe.set(id, z.akteur);
  }
  const heute = heuteDatum(ctx.uhr);
  const ids = [...zugangJe.keys()];
  for (let i = 0; i < ids.length; i += groesse) {
    const block = ids.slice(i, i + groesse);
    const mandanten = await tx.mandant.findMany({
      where: { id: { in: block }, aktiv: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, rechtsform: true, datevNr: true },
    });
    if (mandanten.length === 0) continue;
    const vorhanden = mandanten.map((m) => m.id);
    const kontakte = await tx.mandantKontaktRolle.findMany({
      where: { mandantId: { in: vorhanden }, aktiv: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { mandantId: true, kontaktId: true, rolle: true, funktion: true },
    });
    const programme = await tx.tcmsProgramm.findMany({
      where: { mandantId: { in: vorhanden } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: PROGRAMM_INHALT,
    });
    const programmJe = new Map<string, ProgrammRoh>();
    for (const p of programme) if (!programmJe.has(p.mandantId)) programmJe.set(p.mandantId, p);
    for (const m of mandanten) {
      const akteur = zugangJe.get(m.id)!;
      const k = berechne(
        { heute, stand: heute, historisch: false },
        akteur,
        m,
        kontakte.filter((x) => x.mandantId === m.id),
        programmJe.get(m.id) ?? null,
      );
      fn(await vollende(ctx, k, false), akteur);
    }
  }
}

/**
 * Berechnet den Kontext aus den Rohdaten (rein, ohne Datenbank). `akteur`
 * bestimmt nur die Sicht auf vertrauliche Feststellungen (Maskierung und die
 * daraus abgeleiteten Kennzahlen), nie Rechte zum Laden.
 */
function berechne(
  zeit: { heute: Date; stand: Date; historisch: boolean },
  akteur: Akteur,
  mandant: MandantRoh,
  kontakte: readonly KontaktRoh[],
  programm: ProgrammRoh | null,
): TcmsKontext {
  const { heute, stand, historisch } = zeit;
  const ende = tagesende(stand);
  const leer: TcmsKontext = {
    heute,
    stand,
    historisch,
    mandant: {
      id: mandant.id,
      name: mandant.name,
      rechtsform: mandant.rechtsform,
      datevNr: mandant.datevNr,
    },
    kontaktRollen: kontakte.map((k) => ({
      kontaktId: k.kontaktId,
      rolle: k.rolle,
      funktion: k.funktion,
    })),
    namen: new Map(),
    programm: null,
    teilbereich: null,
    ziele: [],
    appetit: 'MITTEL',
    profil: null,
    profilGueltigAb: null,
    risiken: [],
    vorschlaege: [],
    kontrollen: [],
    durchfuehrungen: [],
    feststellungen: [],
    ereignisse: [],
    laender: [],
    schwelle: bewerteSchwelle(0, 0),
    fernverkaeufeLfd: 0,
    fernverkaeufeVorjahr: 0,
    laenderStand: null,
    laenderQuelle: null,
    beschreibungen: [],
    phasen: [],
    aktivePhase: 1,
    grundelemente: [],
    prueflast: [],
    zeitraum: null,
    ausgeblendet: 0,
  };
  if (!programm) return leer;

  let ausgeblendet = 0;
  const tb = programm.teilbereiche[0] ?? null;
  const ziele = (tb?.ziele ?? []).filter((z) => z.createdAt.getTime() <= ende.getTime());
  const appetit = ziele.reduce<Klasse>((a, z) => hoeher(a, z.risikoappetit), 'GERING');
  const profilStand = gueltig(programm.profile, ende);
  const betriebAktiv = programm.wirksamAb != null && programm.wirksamAb.getTime() <= ende.getTime();

  // ---- Durchführungen (Status zum Stichtag) ----
  const kontrollStandJe = new Map<
    string,
    (typeof programm.kontrollen)[number]['staende'][number]
  >();
  for (const k of programm.kontrollen) {
    const s = gueltig(k.staende, ende);
    if (s) kontrollStandJe.set(k.id, s);
  }

  const alleDurchf: (DurchfuehrungView & {
    periodeVonRaw: Date;
    zeit: Parameters<typeof statusAm>[0];
  })[] = [];
  for (const k of programm.kontrollen) {
    const ks = kontrollStandJe.get(k.id);
    if (!ks) continue;
    for (const d of k.durchfuehrungen) {
      if (d.createdAt.getTime() > ende.getTime() && d.ausserplanmaessig) {
        ausgeblendet++;
        continue;
      }
      const zeit = {
        status: d.status,
        periodeBis: d.periodeBis,
        faelligAm: d.faelligAm,
        begonnenAm: d.begonnenAm,
        eingereichtAm: d.eingereichtAm,
        abgeschlossenAm: d.abgeschlossenAm,
        entfallenAm: d.entfallenAm,
      };
      alleDurchf.push({
        id: d.id,
        kontrolleId: k.id,
        code: k.code,
        titel: ks.titel,
        periodeLabel: d.periodeLabel,
        periodeVon: d.periodeVon,
        periodeBis: d.periodeBis,
        faelligAm: d.faelligAm,
        status: d.status,
        anzeige: statusAm(zeit, stand),
        ausserplanmaessig: d.ausserplanmaessig,
        anlass: d.anlass,
        partei: ks.partei,
        durchfuehrendId: ks.durchfuehrendId,
        gegenzeichnerId: ks.gegenzeichnungMandant ? ks.vertretungId : ks.gegenzeichnerId,
        durchgefuehrtVon: d.durchgefuehrtVon,
        gegengezeichnetVon: d.gegengezeichnetVon,
        mandantBestaetigtVon: d.mandantBestaetigtVon,
        eingereichtAm:
          d.eingereichtAm && d.eingereichtAm.getTime() <= ende.getTime() ? d.eingereichtAm : null,
        abgeschlossenAm:
          d.abgeschlossenAm && d.abgeschlossenAm.getTime() <= ende.getTime()
            ? d.abgeschlossenAm
            : null,
        nachweise: d._count.nachweise,
        mindestNachweise: ks.mindestNachweise,
        gt: null,
        schluessel: ks.schluessel,
        periodeVonRaw: d.periodeVon,
        zeit,
      });
    }
  }

  // ---- Risiken (Stand) ----
  type RoherStand = (typeof programm.risiken)[number]['staende'][number];
  const risikoStaende = new Map<string, RoherStand>();
  const aktiveRisiken = programm.risiken.filter((r) => {
    if (r.entscheidung !== 'UEBERNOMMEN') return false;
    if (r.aktivAb.getTime() > ende.getTime()) {
      ausgeblendet++;
      return false;
    }
    if (r.inaktivAb && r.inaktivAb.getTime() <= ende.getTime()) return false;
    const s = gueltig(r.staende, ende);
    if (!s) return false;
    risikoStaende.set(r.id, s);
    return true;
  });
  const bruttoJe = new Map<string, { code: string; gt: GovernanceTyp; brutto: Klasse }>();
  for (const r of aktiveRisiken) {
    const s = risikoStaende.get(r.id)!;
    const b = bewerte(s.s, s.w, s.r as 1 | 2 | 3, []);
    bruttoJe.set(r.id, { code: r.code, gt: s.gt, brutto: b.brutto.klasse });
  }

  // ---- Kontrollen ----
  const periodeTurnus = programm.erklaerungsTurnus;
  const kontrollen: KontrolleView[] = [];
  for (const k of programm.kontrollen) {
    const ks = kontrollStandJe.get(k.id);
    if (
      !ks ||
      k.aktivAb.getTime() > ende.getTime() ||
      (k.entfallenAb && k.entfallenAb.getTime() <= ende.getTime())
    ) {
      if (k.aktivAb.getTime() > ende.getTime()) ausgeblendet++;
      continue;
    }
    const risikoIds = k.risiken.map((x) => x.risikoId).filter((id) => bruttoJe.has(id));
    const vorlage: Frequenz = { turnus: ks.vorlageTurnus, anlass: ks.vorlageAnlass };
    const ableitung = leiteFrequenzAb(
      vorlage,
      risikoIds.map((id) => bruttoJe.get(id)!),
      periodeTurnus,
    );
    const abweichung =
      ks.abweichungTurnus != null
        ? {
            frequenz: { turnus: ks.abweichungTurnus, anlass: ks.abweichungAnlass ?? false },
            begruendung: ks.abweichungBegruendung,
            freigegebenVon: ks.abweichungFreigegebenVon,
          }
        : null;
    const frequenz = abweichung?.freigegebenVon ? abweichung.frequenz : ableitung.effektiv;
    const eigene = alleDurchf.filter((d) => d.kontrolleId === k.id);
    for (const d of eigene) d.gt = ableitung.gt;
    const betrieb = betriebsStand(
      eigene.map((d) => ({ ...d.zeit, periodeVon: d.periodeVonRaw })),
      stand,
    );
    const sortiert = [...eigene].sort((a, b) => a.faelligAm.getTime() - b.faelligAm.getTime());
    const letzte =
      [...sortiert]
        .reverse()
        .find(
          (d) =>
            d.anzeige === 'OHNE_BEFUND' ||
            d.anzeige === 'MIT_BEFUND' ||
            d.anzeige === 'ZUR_GEGENZEICHNUNG',
        ) ?? null;
    const naechste =
      sortiert.find(
        (d) =>
          d.anzeige === 'FAELLIG' ||
          d.anzeige === 'UEBERFAELLIG' ||
          d.anzeige === 'IN_DURCHFUEHRUNG' ||
          d.anzeige === 'ZURUECKGEWIESEN',
      ) ??
      sortiert.find((d) => d.anzeige === 'GEPLANT') ??
      null;
    const schritte = (ks.schritte as unknown as Schritt[]) ?? [];
    const luecken = pflichtattributLuecken({ ...ks, schritte });
    kontrollen.push({
      id: k.id,
      code: k.code,
      standId: ks.id,
      version: ks.version,
      titel: ks.titel,
      ziel: ks.ziel,
      art: ks.art,
      ausfuehrung: ks.ausfuehrung,
      vorlage,
      abweichung,
      partei: ks.partei,
      schluessel: ks.schluessel,
      durchfuehrendId: ks.durchfuehrendId,
      vertretungId: ks.vertretungId,
      gegenzeichnerId: ks.gegenzeichnerId,
      gegenzeichnungMandant: ks.gegenzeichnungMandant,
      nachweis: ks.nachweis,
      mindestNachweise: ks.mindestNachweise,
      schritte,
      kennzahlen: (ks.kennzahlen as unknown as KennzahlDef[]) ?? [],
      toleranzEur: ks.toleranzEur == null ? null : Number(ks.toleranzEur),
      faelligNachTagen: ks.faelligNachTagen,
      design: ks.design,
      designVon: ks.designVon,
      designAm: ks.designAm,
      designBegruendung: ks.designBegruendung,
      risikoIds,
      risikoCodes: risikoIds.map((id) => bruttoJe.get(id)!.code).sort(),
      ableitung,
      frequenz,
      gt: ableitung.gt,
      betrieb,
      letzte: letzte ? stripD(letzte) : null,
      naechste: naechste ? stripD(naechste) : null,
      pflichtattributeOk: luecken.length === 0,
      pflichtattributeLuecken: luecken,
    });
  }
  kontrollen.sort((a, b) => a.code.localeCompare(b.code));
  const kontrolleJe = new Map(kontrollen.map((k) => [k.id, k]));

  // ---- Bewertungen ----
  const offeneEreignisseJe = new Map<string, number>();
  for (const e of programm.ereignisse) {
    if (
      e.gemeldetAm.getTime() > ende.getTime() ||
      e.status === 'ERLEDIGT' ||
      e.status === 'VERWORFEN'
    )
      continue;
    for (const f of e.folgen) {
      if (f.ziel && f.status !== 'ERLEDIGT' && f.status !== 'VERWORFEN')
        offeneEreignisseJe.set(f.ziel, (offeneEreignisseJe.get(f.ziel) ?? 0) + 1);
    }
  }

  const risiken: RisikoView[] = aktiveRisiken.map((r) => {
    const s = risikoStaende.get(r.id)!;
    const kat = katalogRisiko(r.code);
    const ks = r.kontrollen
      .map((x) => kontrolleJe.get(x.kontrolleId))
      .filter((x): x is KontrolleView => !!x);
    const uebers = r.uebersteuerungen.filter((u) => u.beantragtAm.getTime() <= ende.getTime());
    const wirksamU = (sicht: 'DESIGN' | 'BETRIEB') =>
      uebers.find(
        (u) =>
          u.sicht === sicht &&
          u.status === 'FREIGEGEBEN' &&
          (u.entschiedenAm?.getTime() ?? 0) <= ende.getTime(),
      )?.klasse ?? null;
    const bewertung = bewerte(
      s.s,
      s.w,
      s.r as 1 | 2 | 3,
      ks.map((k) => ({
        code: k.code,
        art: k.art,
        design: k.design,
        schluessel: k.schluessel,
        betrieb: k.betrieb,
      })),
      { design: wirksamU('DESIGN'), betrieb: wirksamU('BETRIEB') },
    );
    const netto = betriebAktiv ? bewertung.wirksamBetrieb : bewertung.wirksamDesign;
    const gruppe = (kat?.gruppe ?? (r.code.split('-')[1] as RisikoGruppe)) || 'UST';
    return {
      id: r.id,
      code: r.code,
      gruppe,
      gruppeLabel: GRUPPE_LABEL[gruppe] ?? gruppe,
      kern: r.kern,
      herkunft: r.herkunft,
      freigabe: r.freigabe,
      freigabeEingereichtVon: r.freigabeEingereichtVon,
      freigegebenVon: r.freigegebenVon,
      freigegebenAm: r.freigegebenAm,
      ownerId: r.ownerId,
      neuBewerten: r.neuBewerten,
      vorschlagsgrund: r.vorschlagsgrund,
      standId: s.id,
      titel: s.titel,
      fehlerquelle: s.fehlerquelle,
      folge: s.folge,
      normanker: (s.normanker as unknown as Normanker[]) ?? [],
      s: s.s,
      w: s.w,
      r: s.r as 1 | 2 | 3,
      gt: s.gt,
      gueltigAb: s.gueltigAb,
      kontrollIds: ks.map((k) => k.id),
      bewertung,
      netto,
      ueberAppetit: ueber(netto, appetit),
      uebersteuerungen: uebers.map((u) => ({
        id: u.id,
        sicht: u.sicht,
        klasse: u.klasse,
        berechnet: u.berechnet,
        begruendung: u.begruendung,
        status: u.status,
        beantragtVon: u.beantragtVon,
        beantragtAm: u.beantragtAm,
        entschiedenVon: u.entschiedenVon,
        entschiedenAm: u.entschiedenAm,
      })),
      offeneEreignisse: offeneEreignisseJe.get(r.code) ?? 0,
      wirktAuf: kat?.wirktAuf ?? [],
    };
  });
  risiken.sort((a, b) => a.code.localeCompare(b.code));

  const vorschlaege = programm.risiken
    .filter((r) => r.entscheidung !== 'UEBERNOMMEN' && r.createdAt.getTime() <= ende.getTime())
    .map((r) => ({
      id: r.id,
      code: r.code,
      grund: r.vorschlagsgrund,
      entscheidung: r.entscheidung as 'VORGESCHLAGEN' | 'ABGELEHNT',
      ablehnungsgrund: r.ablehnungsgrund,
    }));

  // ---- Feststellungen ----
  const alleFeststellungen: FeststellungView[] = programm.feststellungen
    .filter((f) => {
      if (f.erfasstAm.getTime() > ende.getTime()) {
        ausgeblendet++;
        return false;
      }
      return true;
    })
    .map((f) => {
      const p153Entschieden =
        f.p153EntschiedenAm != null && f.p153EntschiedenAm.getTime() <= ende.getTime();
      const massnahmen = f.massnahmen.filter(
        (m) => m.createdAt.getTime() <= ende.getTime() || true,
      );
      const offen = massnahmen.filter(
        (m) => m.status === 'OFFEN' || (m.erledigtAm && m.erledigtAm.getTime() > ende.getTime()),
      );
      const fristen = offen.map((m) => m.frist.getTime()).sort((a, b) => a - b);
      const geschlossenBisStand =
        f.status === 'GESCHLOSSEN' && f.geschlossenAm && f.geschlossenAm.getTime() > ende.getTime()
          ? 'NACHKONTROLLE'
          : f.status;
      return {
        maskiert: false as const,
        id: f.id,
        nummer: f.nummer,
        titel: f.titel,
        sachverhalt: f.sachverhalt,
        quelle: f.quelle,
        quelleText: f.quelleText,
        klasse: f.klasse,
        schwere: f.schwere,
        auswirkung: f.auswirkung,
        status: geschlossenBisStand,
        vertraulich: f.vertraulich,
        beteiligte: beteiligteVon(f),
        p153Entscheidung: p153Entschieden ? f.p153Entscheidung : null,
        p153Offen:
          (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
          !p153Entschieden &&
          f.status !== 'VERWORFEN',
        massnahmenOffen: offen.length,
        massnahmen: massnahmen.length,
        aeltesteFrist: fristen.length ? new Date(fristen[0]!) : null,
        erfasstAm: f.erfasstAm,
        risikoCodes: f.risiken.map((x) => x.risiko.code).sort(),
      };
    })
    .sort((a, b) => b.nummer.localeCompare(a.nummer));
  // Vertraulichkeit (Fachkonzept §13, RT-01): Nicht-Beteiligte sehen nur, was
  // der dedizierte Lesepfad zeigt. Maskiert wird hier im Service, bevor eine
  // Sicht oder Kennzahl entsteht – nicht erst in der Oberfläche.
  const feststellungen: FeststellungSicht[] = alleFeststellungen.map((f) =>
    !f.vertraulich || kannVertraulichLesen(akteur, mandant.id, f.beteiligte)
      ? f
      : maskiereFeststellung(f),
  );
  const lesbareFeststellungen = feststellungen.filter((f): f is FeststellungView => !f.maskiert);

  // ---- Ereignisse ----
  const ereignisse: EreignisView[] = programm.ereignisse
    .filter((e) => {
      if (e.gemeldetAm.getTime() > ende.getTime()) {
        ausgeblendet++;
        return false;
      }
      return true;
    })
    .map((e) => ({
      id: e.id,
      nummer: e.nummer,
      typ: e.typ,
      titel: e.titel,
      beschreibung: e.beschreibung,
      quelle: e.quelle,
      gemeldetVon: e.gemeldetVon,
      gemeldetAm: e.gemeldetAm,
      ereignisDatum: e.ereignisDatum,
      status: e.triagiertAm && e.triagiertAm.getTime() > ende.getTime() ? 'NEU' : e.status,
      verwerfenBegruendung: e.verwerfenBegruendung,
      triagiertVon: e.triagiertVon,
      triagiertAm: e.triagiertAm,
      folgen: e.folgen.map((f) => ({
        id: f.id,
        art: f.art,
        ziel: f.ziel,
        text: f.text,
        zustaendig: f.zustaendig,
        frist: f.frist,
        status: f.status,
        objektId: f.objektId,
      })),
    }));

  // ---- Länder (jüngster Stand je Land bis zum Stichtag) ----
  const laenderJe = new Map<string, (typeof programm.laender)[number]>();
  for (const l of programm.laender) {
    if (l.stand.getTime() > ende.getTime() || l.createdAt.getTime() > ende.getTime()) continue;
    const bisher = laenderJe.get(l.land);
    if (
      !bisher ||
      l.stand.getTime() > bisher.stand.getTime() ||
      (l.stand.getTime() === bisher.stand.getTime() && l.createdAt > bisher.createdAt)
    )
      laenderJe.set(l.land, l);
  }
  const laender: LandView[] = [...laenderJe.values()]
    .map((l) => ({
      id: l.id,
      land: l.land,
      fernverkaeufeLfdEur: Number(l.fernverkaeufeLfdEur),
      fernverkaeufeVorjahrEur: Number(l.fernverkaeufeVorjahrEur),
      lagerSeit: l.lagerSeit,
      oss: l.oss,
      lokaleUstNr: l.lokaleUstNr,
      zmRelevant: l.zmRelevant,
      steuersaetzeGeprueftAm: l.steuersaetzeGeprueftAm,
      stand: l.stand,
      quelle: l.quelle,
      erfasstVon: l.erfasstVon,
      registrierung: (l.lagerSeit && !l.lokaleUstNr
        ? 'FEHLT'
        : !l.steuersaetzeGeprueftAm
          ? 'PRUEFEN'
          : 'VOLLSTAENDIG') as LandView['registrierung'],
    }))
    .sort((a, b) => b.fernverkaeufeLfdEur - a.fernverkaeufeLfdEur);
  const euLaender = laender.filter((l) => istEuAusland(l.land));
  const fernverkaeufeLfd = euLaender.reduce((s, l) => s + l.fernverkaeufeLfdEur, 0);
  const fernverkaeufeVorjahr = euLaender.reduce((s, l) => s + l.fernverkaeufeVorjahrEur, 0);
  const laenderStand = laender.reduce<Date | null>(
    (m, l) => (!m || l.stand > m ? l.stand : m),
    null,
  );

  // ---- Beschreibungen ----
  const beschreibungen: BeschreibungView[] = programm.beschreibungen
    .filter((b) => b.createdAt.getTime() <= ende.getTime())
    .map((b) => ({
      id: b.id,
      nummer: b.nummer,
      status: b.status,
      abschnitte: (b.abschnitte as unknown as Abschnitt[]) ?? [],
      createdAt: b.createdAt,
      erstelltVon: b.erstelltVon,
      reviewAngefordertVon: b.reviewAngefordertVon,
      reviewAngefordertAm: b.reviewAngefordertAm,
      reviewVon: b.reviewVon,
      reviewAm: b.reviewAm,
      freigabeAngefordertAm: b.freigabeAngefordertAm,
      freigegebenVon: b.freigegebenVon,
      freigegebenAm: b.freigegebenAm,
      snapshotSha256: b.snapshotSha256,
    }));
  const freigegebene = beschreibungen.filter(
    (b) => b.freigegebenAm && b.freigegebenAm.getTime() <= ende.getTime(),
  );
  const letzteFreigabe = freigegebene[freigegebene.length - 1] ?? null;
  const aktuelleBeschreibung = beschreibungen[beschreibungen.length - 1] ?? null;

  // ---- Zeitraum und Lücken ----
  // Regeln der Prüfungsvorbereitung (bisher in der Demo-Seite): Durchführungen
  // zählen, wenn ihre Fälligkeit im Wirksamkeitszeitraum liegt, mit 60 Tagen
  // Nachlauf für Fälligkeiten nach Periodenende. Feststellungen gehen nicht
  // ein; die Zahlen verraten daher nichts Vertrauliches (RT-01).
  const durchfuehrungen = alleDurchf.map(stripD);
  const ueberfaellig = durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length;
  let zeitraum: TcmsKontext['zeitraum'] = null;
  if (programm.wirksamAb && programm.wirksamBis) {
    const ab = programm.wirksamAb;
    const bis = programm.wirksamBis;
    const imFenster = (d: DurchfuehrungView) =>
      d.faelligAm.getTime() >= ab.getTime() && d.faelligAm.getTime() <= bis.getTime() + NACHLAUF_MS;
    const begonnen = ab.getTime() <= ende.getTime();
    const mitDurchfuehrung = new Set(
      durchfuehrungen
        .filter((d) => imFenster(d) && d.anzeige !== 'ENTFALLEN')
        .map((d) => d.kontrolleId),
    );
    const faelligGeworden = durchfuehrungen.filter((d) => imFenster(d) && d.anzeige !== 'GEPLANT');
    const abgeschlossen = faelligGeworden.filter(
      (d) => d.anzeige === 'OHNE_BEFUND' || d.anzeige === 'MIT_BEFUND',
    );
    const monate =
      (bis.getUTCFullYear() - ab.getUTCFullYear()) * 12 + bis.getUTCMonth() - ab.getUTCMonth() + 1;
    const monat = Math.max(
      0,
      Math.min(
        monate,
        (stand.getUTCFullYear() - ab.getUTCFullYear()) * 12 +
          stand.getUTCMonth() -
          ab.getUTCMonth() +
          1,
      ),
    );
    const imZeitraum = faelligGeworden.filter((d) => d.anzeige !== 'ENTFALLEN');
    zeitraum = {
      monat,
      monate,
      relevante: imZeitraum.length,
      ohneBefund: imZeitraum.filter((d) => d.anzeige === 'OHNE_BEFUND').length,
      mitBefund: imZeitraum.filter((d) => d.anzeige === 'MIT_BEFUND').length,
      offen: imZeitraum.filter((d) => d.anzeige !== 'OHNE_BEFUND' && d.anzeige !== 'MIT_BEFUND')
        .length,
      ohneGegenzeichnung: imZeitraum.filter((d) => d.anzeige === 'ZUR_GEGENZEICHNUNG').length,
      ueberfaellig: imZeitraum.filter((d) => d.anzeige === 'UEBERFAELLIG').length,
      fehlendeNachweise: imZeitraum.filter(
        (d) =>
          (d.anzeige === 'OHNE_BEFUND' ||
            d.anzeige === 'MIT_BEFUND' ||
            d.anzeige === 'ZUR_GEGENZEICHNUNG') &&
          d.nachweise < d.mindestNachweise,
      ).length,
      ohneDurchfuehrung: begonnen
        ? kontrollen
            .filter((k) => k.frequenz.turnus !== 'KEIN' && !mitDurchfuehrung.has(k.id))
            .map((k) => k.code)
        : [],
      nachweise: abgeschlossen.reduce((summe, d) => summe + d.nachweise, 0),
      entfallen: faelligGeworden.filter((d) => d.anzeige === 'ENTFALLEN').length,
    };
  }

  // ---- Phasen ----
  const ueberAppetitOhneKontrolle = risiken.filter((r) => {
    if (!ueber(r.bewertung.brutto.klasse, appetit)) return false;
    return !r.kontrollIds.some((id) => {
      const k = kontrolleJe.get(id);
      return k && k.pflichtattributeOk && k.design !== 'NICHT_BEURTEILT';
    });
  }).length;
  const { phasen, aktiv } = bewertePhasen({
    teilbereichAbgegrenzt: !!tb && tb.abgrenzung.trim().length > 0,
    profilErfasst: !!profilStand,
    zieleGesamt: ziele.length,
    zieleFreigegeben: ziele.filter(
      (z) =>
        z.freigabe === 'FREIGEGEBEN' && (z.freigegebenAm?.getTime() ?? Infinity) <= ende.getTime(),
    ).length,
    vorschlaegeOffen: vorschlaege.filter((v) => v.entscheidung === 'VORGESCHLAGEN').length,
    risikenAktiv: risiken.length,
    risikenOhneBewertung: 0,
    risikenNichtFreigegeben: risiken.filter((r) => r.freigabe !== 'FREIGEGEBEN').length,
    risikenUeberAppetitOhneKontrolle: ueberAppetitOhneKontrolle,
    kontrollenOhnePflichtattribute: kontrollen.filter((k) => !k.pflichtattributeOk).length,
    beschreibungFreigegeben: !!letzteFreigabe,
    beschreibungVersion: letzteFreigabe?.nummer ?? null,
    angemessenheitStichtag:
      programm.angemessenheitStichtag && programm.angemessenheitStichtag.getTime() <= ende.getTime()
        ? programm.angemessenheitStichtag
        : null,
    wirksamAb: programm.wirksamAb,
    wirksamBis: programm.wirksamBis,
    durchfuehrungenImZeitraum: zeitraum?.relevante ?? 0,
    heute: stand,
  });

  // ---- Grundelemente ----
  const abs = new Map((aktuelleBeschreibung?.abschnitte ?? []).map((a) => [a.key, a]));
  const kultur = kontrollen.find((k) => k.code === 'K-EC-22');
  const grundelemente = bewerteGrundelemente({
    abschnittGefuellt: {
      kultur: abschnittHatText(abs.get('kultur')),
      ziele: abschnittHatText(abs.get('ziele')),
      risiken: abschnittHatText(abs.get('risiken')),
      programm: abschnittHatText(abs.get('programm')),
      organisation: abschnittHatText(abs.get('organisation')),
      kommunikation: abschnittHatText(abs.get('kommunikation')),
      ueberwachung: abschnittHatText(abs.get('ueberwachung')),
    },
    zieleNichtFreigegeben: ziele.filter((z) => z.freigabe !== 'FREIGEGEBEN').length,
    risikenOhneBewertung: 0,
    risikenNichtFreigegeben: risiken.filter((r) => r.freigabe !== 'FREIGEGEBEN').length,
    kontrollenOhneDesign: kontrollen.filter(
      (k) => k.design === 'NICHT_BEURTEILT' && k.code !== 'K-EC-22',
    ).length,
    durchfuehrungenUeberfaellig: ueberfaellig,
    kontrollenOhneVertretung: kontrollen.filter(
      (k) => !k.vertretungId || k.vertretungId === k.durchfuehrendId,
    ).length,
    // Kennzahlen (RT-01): Status und Zahl der Maßnahmen zeigt auch der
    // dedizierte Lesepfad für maskierte Feststellungen (Status, Wiedervorlagen),
    // daher zählen hier alle. Die offene §-153-Würdigung verrät dagegen die
    // Steuerwirkung und zählt nur lesbare Feststellungen – sonst ergäbe die
    // Differenz zu den sichtbaren Einträgen den Inhalt einer vertraulichen.
    feststellungenOhneMassnahme: alleFeststellungen.filter(
      (f) => f.massnahmen === 0 && f.status !== 'VERWORFEN' && f.status !== 'GESCHLOSSEN',
    ).length,
    p153Offen: lesbareFeststellungen.filter((f) => f.p153Offen).length,
    zusatz:
      kultur && kultur.design === 'NICHT_BEURTEILT'
        ? { kultur: ['Kenntnisnahme Steuerrichtlinie (K-EC-22) ohne Designbeurteilung'] }
        : {},
  });

  // ---- Prüflast (laufender Monat und die zwei folgenden) ----
  const last = durchfuehrungen.map((d) => ({
    faelligAm: d.faelligAm,
    gt: d.gt,
    ausserplanmaessig: d.ausserplanmaessig,
    entfallen: d.anzeige === 'ENTFALLEN',
  }));
  const prueflast = [0, 1, 2].map((i) => pruflast(last, monatSchluessel(monatePlus(stand, i))));

  return {
    ...leer,
    programm: {
      id: programm.id,
      status: programm.status,
      paketVersion: programm.paketVersion,
      erklaerungsTurnus: programm.erklaerungsTurnus,
      angemessenheitStichtag: programm.angemessenheitStichtag,
      wirksamAb: programm.wirksamAb,
      wirksamBis: programm.wirksamBis,
      version1Am: programm.version1Am,
      createdAt: programm.createdAt,
    },
    teilbereich: tb
      ? {
          id: tb.id,
          name: tb.name,
          abgrenzung: tb.abgrenzung,
          einschluesse: tb.einschluesse,
          ausschluesse: tb.ausschluesse,
        }
      : null,
    ziele: ziele.map((z) => ({
      id: z.id,
      text: z.text,
      wesentlichkeitEur: z.wesentlichkeitEur,
      risikoappetit: z.risikoappetit,
      freigabe: z.freigabe,
      freigegebenAm: z.freigegebenAm,
      freigegebenVon: z.freigegebenVon,
    })),
    appetit,
    profil: (profilStand?.antworten as unknown as Geschaeftsprofil) ?? null,
    profilGueltigAb: profilStand?.gueltigAb ?? null,
    risiken,
    vorschlaege,
    kontrollen,
    durchfuehrungen,
    feststellungen,
    ereignisse,
    laender,
    schwelle: bewerteSchwelle(fernverkaeufeLfd, fernverkaeufeVorjahr),
    fernverkaeufeLfd,
    fernverkaeufeVorjahr,
    laenderStand,
    laenderQuelle: laender[0]?.quelle ?? null,
    beschreibungen,
    phasen,
    aktivePhase: aktiv,
    grundelemente,
    prueflast,
    zeitraum,
    ausgeblendet,
  };
}

/**
 * Maskierte Sicht einer vertraulichen Feststellung (RT-01). Ausdrückliche
 * Positivliste der Felder des dedizierten Lesepfads: Ein neues Feld der
 * Feststellung gelangt so nie ungeplant in die maskierte Sicht.
 */
export function maskiereFeststellung(
  f: Pick<FeststellungView, 'id' | 'nummer' | 'status' | 'erfasstAm'>,
): FeststellungMaskiert {
  return {
    maskiert: true,
    id: f.id,
    nummer: f.nummer,
    vertraulich: true,
    status: f.status,
    erfasstAm: f.erfasstAm,
  };
}

/**
 * Letzter Schritt jedes Ladens: die Anzeigenamen der genannten Personen über
 * `ctx.personen` auflösen. Maskierte Feststellungen nennen keine Personen
 * (wer beteiligt ist, gehört selbst zum vertraulichen Inhalt).
 */
async function vollende(
  ctx: DienstKontext,
  k: TcmsKontext,
  mitNamen: boolean,
): Promise<TcmsKontext> {
  const ids = new Set<string>();
  const merke = (...liste: (string | null | undefined)[]) => {
    for (const id of liste) if (id) ids.add(id);
  };
  for (const f of k.feststellungen) if (!f.maskiert) merke(...f.beteiligte);
  merke(...k.kontaktRollen.map((r) => r.kontaktId));
  for (const z of k.ziele) merke(z.freigegebenVon);
  for (const r of k.risiken) {
    merke(r.freigabeEingereichtVon, r.freigegebenVon, r.ownerId);
    for (const u of r.uebersteuerungen) merke(u.beantragtVon, u.entschiedenVon);
  }
  for (const x of k.kontrollen) {
    merke(x.durchfuehrendId, x.vertretungId, x.gegenzeichnerId, x.designVon);
    merke(x.abweichung?.freigegebenVon);
  }
  for (const d of k.durchfuehrungen) {
    merke(d.durchfuehrendId, d.gegenzeichnerId, d.durchgefuehrtVon, d.gegengezeichnetVon);
    merke(d.mandantBestaetigtVon);
  }
  for (const e of k.ereignisse) {
    merke(e.gemeldetVon, e.triagiertVon, ...e.folgen.map((f) => f.zustaendig));
  }
  for (const l of k.laender) merke(l.erfasstVon);
  for (const b of k.beschreibungen) {
    merke(b.erstelltVon, b.reviewAngefordertVon, b.reviewVon, b.freigegebenVon);
  }
  const namen =
    mitNamen && ids.size > 0
      ? await ctx.personen.namen([...ids].sort())
      : new Map<string, string>();
  return { ...k, namen };
}

function stripD(
  d: DurchfuehrungView & { periodeVonRaw?: Date; zeit?: unknown },
): DurchfuehrungView {
  const {
    periodeVonRaw: _a,
    zeit: _b,
    ...rest
  } = d as DurchfuehrungView & { periodeVonRaw?: Date; zeit?: unknown };
  return rest;
}
