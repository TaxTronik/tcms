import 'server-only';
import { DienstFehler, type Akteur, type FeststellungDetail as DienstDetail } from '@tcms/contract';
import type { AnzeigeStatus, FeststellungStatus, Paragraph153Entscheidung } from '@tcms/domain';
import {
  EINGABE_UNGUELTIG,
  imDienst,
  ladeFeststellung,
  ladeFeststellungen,
  type DienstKontext,
} from '@tcms/service';
import { aktualisiereMandant } from './aktion';
import { DEMO_PORTS } from './demo';
import type { Ergebnis } from './ergebnis';
import { demoAkteur } from './sitzung';

// =============================================================================
// Demo-Anbindung S10 (Feststellungen und Maßnahmen) an @tcms/service: Lader
// (Liste, Detail) im Dienstkontext der angemeldeten Person, Umrechnung der
// JSON-Antwort (ISO-Strings) in die Anzeigeform der Seiten, Anzeigekonstanten
// und der gemeinsame Aufruf für Server Actions (`dienstAktion`). Rechte,
// Vertraulichkeit und Stichtag behandelt ausschließlich der Service.
// =============================================================================

export { p153Abschliessend } from '@tcms/service';

export const FESTSTELLUNG_STATUS_BADGE: Record<FeststellungStatus, string> = {
  ERFASST: 'badge-gray',
  IN_WUERDIGUNG: 'badge-brand',
  MASSNAHMEN_OFFEN: 'badge-yellow',
  NACHKONTROLLE: 'badge-purple',
  GESCHLOSSEN: 'badge-green',
  VERWORFEN: 'badge-gray',
};

/** Erläuterung je §-153-Option (gleichrangig, ohne Empfehlung). */
export const P153_ERLAEUTERUNG: Record<Paragraph153Entscheidung, string> = {
  BERICHTIGUNG:
    'Die erforderliche Berichtigung wird veranlasst; Frist und Umfang werden dokumentiert.',
  KEINE_PFLICHT:
    'Die Feststellung führt zu keiner Berichtigungspflicht; die Begründung ist Pflicht.',
  WEITERE_KLAERUNG:
    'Die Würdigung ist noch nicht abschließend möglich; Klärung bis zum angegebenen Datum.',
  UEBERGABE: 'Der Einzelfall wird zur Entscheidung an spezialisierte Beratung übergeben.',
};

/** Feste Reihenfolge der vier Optionen (keine Sortierung nach Häufigkeit). */
export const P153_OPTIONEN: readonly Paragraph153Entscheidung[] = [
  'BERICHTIGUNG',
  'KEINE_PFLICHT',
  'WEITERE_KLAERUNG',
  'UEBERGABE',
];

/** Kontrollcode aus einem Quelltext wie „K-EC-05 September 2026". */
export function kontrollCode(text: string): string | null {
  return /K-EC-\d{2}/.exec(text)?.[0] ?? null;
}

// ----------------------------------------------------------------------------
// Aufruf des Service aus Server Actions
// ----------------------------------------------------------------------------

const PRUEFEN = 'Bitte die Eingaben prüfen.';

/** Text eines Formularfelds (leer, wenn nicht vorhanden oder keine Zeichenkette). */
export function feld(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
}

/** Leeres Feld → nicht angegeben. */
export function optional(fd: FormData, name: string): string | undefined {
  const v = feld(fd, name).trim();
  return v ? v : undefined;
}

/**
 * Führt eine Fachoperation im Dienstkontext des Akteurs aus (eine Transaktion
 * im Tenant des Akteurs) und übersetzt Dienstfehler in eine Meldung für das
 * Formular. `ungueltig` ersetzt die allgemeine Meldung bei Schemafehlern durch
 * den bisherigen Formulartext; fachliche Meldungen des Service bleiben.
 */
export async function dienstAufruf<T>(
  akteur: Akteur,
  fn: (ctx: DienstKontext) => Promise<T>,
  texte: { ungueltig?: string; nichtGefunden?: string } = {},
): Promise<{ wert: T } | { fehler: string }> {
  try {
    return {
      wert: await imDienst(akteur, DEMO_PORTS, fn, { timeoutMs: 30_000, maxWaitMs: 10_000 }),
    };
  } catch (e) {
    if (!(e instanceof DienstFehler)) throw e;
    if (e.code === 'UNGUELTIG' && e.message === EINGABE_UNGUELTIG) {
      return { fehler: texte.ungueltig ?? PRUEFEN };
    }
    if (e.message !== e.code) return { fehler: e.message };
    if (e.code === 'NICHT_GEFUNDEN') return { fehler: texte.nichtGefunden ?? 'Nicht gefunden.' };
    if (e.code === 'KONFLIKT') return { fehler: 'Der Stand hat sich geändert. Bitte neu laden.' };
    return { fehler: PRUEFEN };
  }
}

/** `dienstAufruf` für Actions mit Rückmeldung; nach Erfolg werden die Seiten des Mandanten neu geladen. */
export async function dienstAktion<T>(
  akteur: Akteur,
  mandantId: string,
  fn: (ctx: DienstKontext) => Promise<T>,
  ok: (wert: T) => string,
  texte: { ungueltig?: string; nichtGefunden?: string } = {},
): Promise<Ergebnis> {
  const r = await dienstAufruf(akteur, fn, texte);
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return { ok: ok(r.wert) };
}

/** Eingabe aus Formularwerten; Typ und Inhalt prüft der Service mit dem Contract-Schema. */
export function eingabe<T>(x: Record<string, unknown>): T {
  return x as T;
}

// ----------------------------------------------------------------------------
// Lader (Anzeigeform mit Date)
// ----------------------------------------------------------------------------

const datum = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
const datumOderNull = (iso: string | null | undefined) => (iso ? datum(iso) : null);

export interface MassnahmeZeile {
  id: string;
  feststellungId: string;
  wiedervorlageNr: number;
  beschreibung: string;
  verantwortlich: string;
  frist: Date;
  status: 'OFFEN' | 'ERLEDIGT';
  erledigtAm: Date | null;
  erledigtVon: string | null;
  createdAt: Date;
}

export interface P153Stand {
  entscheidung: Paragraph153Entscheidung;
  begruendung: string | null;
  frist: Date | null;
  von: string | null;
  am: Date;
}

export type FeststellungListenZeile =
  | {
      maskiert: false;
      id: string;
      nummer: string;
      titel: string;
      quelle: 'KONTROLLE' | 'EREIGNIS' | 'STICHPROBE' | 'HINWEIS' | 'AUSSENPRUEFUNG';
      quelleText: string;
      klasse: 'DESIGNMANGEL' | 'DURCHFUEHRUNGSMANGEL' | 'STEUERLICHER_FEHLER' | 'HINWEIS';
      schwere: 'GERING' | 'MITTEL' | 'HOCH' | 'KRITISCH';
      auswirkung: 'JA' | 'NEIN' | 'UNKLAR';
      status: FeststellungStatus;
      vertraulich: boolean;
      p153: P153Stand | null;
      p153Offen: boolean;
      verwerfenOffen: boolean;
      massnahmenOffen: number;
      massnahmenGesamt: number;
      aeltesteFrist: Date | null;
      massnahmen: MassnahmeZeile[];
    }
  | {
      maskiert: true;
      id: string;
      nummer: string;
      vertraulich: true;
      status: FeststellungStatus;
      massnahmen: Pick<
        MassnahmeZeile,
        'id' | 'feststellungId' | 'wiedervorlageNr' | 'frist' | 'status'
      >[];
    };

function massnahme(m: {
  id: string;
  feststellungId: string;
  wiedervorlageNr: number;
  beschreibung: string;
  verantwortlich: string;
  frist: string;
  status: 'OFFEN' | 'ERLEDIGT';
  erledigtAm: string | null;
  erledigtVon: string | null;
  createdAt: string;
}): MassnahmeZeile {
  return {
    ...m,
    frist: datum(m.frist),
    erledigtAm: datumOderNull(m.erledigtAm),
    createdAt: datum(m.createdAt),
  };
}

function p153(p: NonNullable<Extract<DienstDetail, { maskiert: false }>['p153']>): P153Stand {
  return { ...p, frist: datumOderNull(p.frist), am: datum(p.am) };
}

/**
 * Feststellungen eines Mandanten zum Stichtag für die angemeldete Person;
 * vertrauliche sind für Nicht-Beteiligte bereits im Service maskiert.
 * Ohne Sitzung, ohne Leserecht oder ohne Programm: leere Liste.
 */
export async function ladeFeststellungListe(
  mandantId: string,
  standIso: string,
): Promise<FeststellungListenZeile[]> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return [];
  try {
    const l = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeFeststellungen(ctx, { mandantId, stand: standIso }),
    );
    return l.feststellungen.map((f): FeststellungListenZeile => {
      if (f.maskiert) {
        return {
          maskiert: true,
          id: f.id,
          nummer: f.nummer,
          vertraulich: true,
          status: f.status,
          massnahmen: f.massnahmen.map((m) => ({ ...m, frist: datum(m.frist) })),
        };
      }
      return {
        maskiert: false,
        id: f.id,
        nummer: f.nummer,
        titel: f.titel,
        quelle: f.quelle,
        quelleText: f.quelleText,
        klasse: f.klasse,
        schwere: f.schwere,
        auswirkung: f.auswirkung,
        status: f.status,
        vertraulich: f.vertraulich,
        p153: f.p153 ? p153(f.p153) : null,
        p153Offen: f.p153Offen,
        verwerfenOffen: f.verwerfenOffen,
        massnahmenOffen: f.massnahmenOffen,
        massnahmenGesamt: f.massnahmenGesamt,
        aeltesteFrist: datumOderNull(f.aeltesteFrist),
        massnahmen: f.massnahmen.map(massnahme),
      };
    });
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return [];
    throw e;
  }
}

export interface VerlaufEintrag {
  id: number;
  at: Date;
  actorName: string;
  text: string;
}

type Sichtbar = Extract<DienstDetail, { maskiert: false }>;

export type FeststellungDetail =
  | { maskiert: true; id: string; nummer: string }
  | (Omit<
      Sichtbar,
      | 'erfasstAm'
      | 'geschlossenAm'
      | 'p153'
      | 'massnahmen'
      | 'verlauf'
      | 'nachkontrolle'
      | 'namen'
      | 'stand'
      | 'historisch'
    > & {
      erfasstAm: Date;
      geschlossenAm: Date | null;
      p153: P153Stand | null;
      massnahmen: (MassnahmeZeile & { nachweis: string | null })[];
      nachkontrolle:
        | (Omit<NonNullable<Sichtbar['nachkontrolle']>, 'faelligAm'> & {
            faelligAm: Date;
            anzeige: AnzeigeStatus;
          })
        | null;
      verlauf: VerlaufEintrag[];
    });

/**
 * Detail einer Feststellung zum Stichtag (Service-Lader). Für Nicht-Beteiligte
 * einer vertraulichen Feststellung liefert der Service nur Nummer und
 * Kennzeichen (`maskiert`). Nicht vorhanden oder kein Zugriff: null.
 */
export async function ladeFeststellungDetail(
  mandantId: string,
  fid: string,
  standIso: string,
): Promise<FeststellungDetail | null> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur || !/^[a-z0-9]{16,40}$/.test(fid)) return null;
  let d: DienstDetail;
  try {
    d = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeFeststellung(ctx, { mandantId, feststellungId: fid, stand: standIso }),
    );
  } catch (e) {
    if (e instanceof DienstFehler && (e.code === 'NICHT_GEFUNDEN' || e.code === 'UNGUELTIG'))
      return null;
    throw e;
  }
  if (d.maskiert) return { maskiert: true, id: d.id, nummer: d.nummer };
  const namen = new Map(d.namen.map((n) => [n.id, n.name]));
  const {
    stand: _s,
    historisch: _h,
    namen: _n,
    erfasstAm,
    geschlossenAm,
    p153: p,
    massnahmen,
    nachkontrolle,
    verlauf,
    ...rest
  } = d;
  return {
    ...rest,
    erfasstAm: datum(erfasstAm),
    geschlossenAm: datumOderNull(geschlossenAm),
    p153: p ? p153(p) : null,
    massnahmen: massnahmen.map((m) => ({ ...massnahme(m), nachweis: m.nachweis })),
    nachkontrolle: nachkontrolle
      ? { ...nachkontrolle, faelligAm: datum(nachkontrolle.faelligAm) }
      : null,
    verlauf: verlauf.map((v) => ({
      id: v.pos,
      at: datum(v.at),
      actorName: (v.actorId && namen.get(v.actorId)) || '—',
      text: v.text,
    })),
  };
}
