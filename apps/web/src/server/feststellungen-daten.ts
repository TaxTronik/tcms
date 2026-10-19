import 'server-only';
import { prisma, type Tx } from '@tcms/db';
import {
  FESTSTELLUNG_STATUS_LABEL,
  P153_LABEL,
  statusAm,
  type AnzeigeStatus,
  type FeststellungStatus,
  type Paragraph153Entscheidung,
} from '@tcms/domain';
import type { MandantZustaendigkeit } from './rechte';
import type { Nutzer } from './sitzung';
import { tagesende } from './zeit';

// =============================================================================
// Detaildaten für S10 (Feststellungen und Maßnahmen), die der Kontext nicht
// enthält: Maßnahmen mit Wiedervorlage, Nachkontrolle, Verlauf aus dem
// Audit-Log, Beteiligte für vertrauliche Feststellungen. Dazu die
// transaktionsgebundenen Helfer für Nummernkreise.
// =============================================================================

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

/** Eine Entscheidung „weitere Klärung" ist nicht abschließend und erlaubt eine Folgeentscheidung. */
export function p153Abschliessend(e: Paragraph153Entscheidung | null | undefined): boolean {
  return e != null && e !== 'WEITERE_KLAERUNG';
}

/** Kontrollcode aus einem Quelltext wie „K-EC-05 September 2026". */
export function kontrollCode(text: string): string | null {
  return /K-EC-\d{2}/.exec(text)?.[0] ?? null;
}

// ----------------------------------------------------------------------------
// Vertraulichkeit (Fachkonzept §13: vertrauliche Feststellungen nur für Beteiligte)
// ----------------------------------------------------------------------------

export interface BeteiligteFakten {
  erfasstVon: string;
  p153EntschiedenVon: string | null;
  verwerfenBeantragtVon?: string | null;
  massnahmenVerantwortlich: string[];
}

/**
 * Beteiligt sind: Admin/Partner, zuständige:r Berufsträger:in, Hauptbearbeitung,
 * die erfassende Person, die würdigende Person und Maßnahmen-Verantwortliche.
 */
export function istBeteiligt(
  n: Pick<Nutzer, 'id' | 'art' | 'istAdmin'>,
  f: BeteiligteFakten,
  m: MandantZustaendigkeit,
): boolean {
  if (n.art !== 'KANZLEI') return false;
  if (n.istAdmin || n.id === m.berufstraegerId || n.id === m.bearbeitungId) return true;
  return (
    n.id === f.erfasstVon ||
    n.id === f.p153EntschiedenVon ||
    n.id === f.verwerfenBeantragtVon ||
    f.massnahmenVerantwortlich.includes(n.id)
  );
}

// ----------------------------------------------------------------------------
// Liste
// ----------------------------------------------------------------------------

export interface FeststellungListenZusatz {
  id: string;
  erfasstVon: string;
  durchfuehrungId: string | null;
  ereignisId: string | null;
  p153EntschiedenVon: string | null;
  p153EntschiedenAm: Date | null;
  p153Frist: Date | null;
  p153Entscheidung: Paragraph153Entscheidung | null;
  verwerfenOffen: boolean;
  massnahmen: MassnahmeZeile[];
}

export interface MassnahmeZeile {
  id: string;
  feststellungId: string;
  wiedervorlageNr: number;
  beschreibung: string;
  verantwortlich: string;
  frist: Date;
  /** Status zum Stichtag. */
  status: 'OFFEN' | 'ERLEDIGT';
  erledigtAm: Date | null;
  erledigtVon: string | null;
  createdAt: Date;
}

function massnahmeAm(
  m: {
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
  },
  ende: Date,
): MassnahmeZeile | null {
  if (m.createdAt.getTime() > ende.getTime()) return null;
  const erledigt =
    m.status === 'ERLEDIGT' && m.erledigtAm != null && m.erledigtAm.getTime() <= ende.getTime();
  return {
    id: m.id,
    feststellungId: m.feststellungId,
    wiedervorlageNr: m.wiedervorlageNr,
    beschreibung: m.beschreibung,
    verantwortlich: m.verantwortlich,
    frist: m.frist,
    status: erledigt ? 'ERLEDIGT' : 'OFFEN',
    erledigtAm: erledigt ? m.erledigtAm : null,
    erledigtVon: erledigt ? m.erledigtVon : null,
    createdAt: m.createdAt,
  };
}

export async function ladeFeststellungListe(
  programmId: string,
  stand: Date,
): Promise<Map<string, FeststellungListenZusatz>> {
  const ende = tagesende(stand);
  const roh = await prisma.feststellung.findMany({
    where: { programmId },
    select: {
      id: true,
      erfasstVon: true,
      durchfuehrungId: true,
      ereignisId: true,
      p153EntschiedenVon: true,
      p153EntschiedenAm: true,
      p153Frist: true,
      p153Entscheidung: true,
      verwerfenBeantragtVon: true,
      verwerfenBestaetigtVon: true,
      status: true,
      massnahmen: { orderBy: { wiedervorlageNr: 'asc' } },
    },
  });
  const out = new Map<string, FeststellungListenZusatz>();
  for (const f of roh) {
    const entschieden =
      f.p153EntschiedenAm != null && f.p153EntschiedenAm.getTime() <= ende.getTime();
    out.set(f.id, {
      id: f.id,
      erfasstVon: f.erfasstVon,
      durchfuehrungId: f.durchfuehrungId,
      ereignisId: f.ereignisId,
      p153EntschiedenVon: entschieden ? f.p153EntschiedenVon : null,
      p153EntschiedenAm: entschieden ? f.p153EntschiedenAm : null,
      p153Frist: entschieden ? f.p153Frist : null,
      p153Entscheidung: entschieden ? f.p153Entscheidung : null,
      verwerfenOffen:
        !!f.verwerfenBeantragtVon && !f.verwerfenBestaetigtVon && f.status !== 'VERWORFEN',
      massnahmen: f.massnahmen
        .map((m) => massnahmeAm(m, ende))
        .filter((m): m is MassnahmeZeile => !!m),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Detail
// ----------------------------------------------------------------------------

export interface VerlaufEintrag {
  id: number;
  at: Date;
  actorName: string;
  text: string;
}

export interface FeststellungDetail {
  id: string;
  programmId: string;
  nummer: string;
  titel: string;
  sachverhalt: string;
  quelle: 'KONTROLLE' | 'EREIGNIS' | 'STICHPROBE' | 'HINWEIS' | 'AUSSENPRUEFUNG';
  quelleText: string;
  klasse: 'DESIGNMANGEL' | 'DURCHFUEHRUNGSMANGEL' | 'STEUERLICHER_FEHLER' | 'HINWEIS';
  schwere: 'GERING' | 'MITTEL' | 'HOCH' | 'KRITISCH';
  auswirkung: 'JA' | 'NEIN' | 'UNKLAR';
  ursache: string | null;
  /** Status zum Stichtag. */
  status: FeststellungStatus;
  vertraulich: boolean;
  /** Aktueller Vertraulichkeitsstatus (unabhängig vom Stichtag) – für die Zugriffsprüfung. */
  vertraulichAktuell: boolean;
  p153: {
    entscheidung: Paragraph153Entscheidung;
    begruendung: string | null;
    frist: Date | null;
    von: string | null;
    am: Date;
  } | null;
  durchfuehrung: { id: string; kontrolleId: string; code: string; periodeLabel: string } | null;
  ereignis: { id: string; nummer: string; typ: string; titel: string } | null;
  nachkontrolle: {
    id: string;
    kontrolleId: string;
    code: string;
    titel: string;
    periodeLabel: string;
    faelligAm: Date;
    anzeige: AnzeigeStatus;
    ausserplanmaessig: boolean;
  } | null;
  verwerfen: { begruendung: string; beantragtVon: string; bestaetigtVon: string | null } | null;
  erfasstVon: string;
  erfasstAm: Date;
  geschlossenAm: Date | null;
  risiken: { id: string; code: string }[];
  erklaerungen: {
    id: string;
    steuerart: string;
    land: string;
    zeitraum: string;
    auswirkungEur: number | null;
  }[];
  massnahmen: (MassnahmeZeile & { nachweis: string | null })[];
  verlauf: VerlaufEintrag[];
}

const MANUELL_AKTIONEN = [
  'tcms.feststellung.erfasst',
  'tcms.feststellung.status',
  'tcms.feststellung.geschlossen',
  'tcms.feststellung.p153_entschieden',
  'tcms.feststellung.wuerdigung',
  'tcms.feststellung.erklaerung',
  'tcms.feststellung.nachkontrolle',
  'tcms.feststellung.verwerfen_beantragt',
  'tcms.feststellung.verwerfen_bestaetigt',
  'tcms.feststellung.verwerfen_abgelehnt',
  'tcms.feststellung.vertraulich',
  'tcms.massnahme.angelegt',
  'tcms.massnahme.erledigt',
];

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Lesbarer Verlaufstext zu einem Audit-Eintrag. */
export function verlaufText(aktion: string, d: Record<string, unknown>): string {
  const status = (x: unknown) => FESTSTELLUNG_STATUS_LABEL[x as FeststellungStatus] ?? s(x);
  switch (aktion) {
    case 'tcms.feststellung.erfasst':
      return d['quelle']
        ? `Feststellung erfasst (Quelle: ${s(d['quelle'])})`
        : 'Feststellung erfasst';
    case 'tcms.feststellung.status':
      return d['von']
        ? `Status ${status(d['von'])} → ${status(d['nach'])}`
        : `Status auf „${status(d['nach'])}" gesetzt`;
    case 'tcms.feststellung.geschlossen':
      return 'Feststellung geschlossen';
    case 'tcms.feststellung.p153_entschieden': {
      const e = d['entscheidung'] as Paragraph153Entscheidung | undefined;
      return `§-153-Würdigung dokumentiert: ${e ? P153_LABEL[e].replace(' bis …', '') : '—'}${d['frist'] ? ` (Frist ${s(d['frist']).split('-').reverse().join('.')})` : ''}`;
    }
    case 'tcms.feststellung.wuerdigung':
      return 'Würdigungsangaben aktualisiert (Schwere, Auswirkung, Ursache)';
    case 'tcms.feststellung.erklaerung':
      return `Betroffene Erklärung erfasst: ${s(d['steuerart'])} · ${s(d['land'])} · ${s(d['zeitraum'])}`;
    case 'tcms.feststellung.nachkontrolle':
      return `Nachkontrolle angelegt: ${s(d['kontrolle'])} (fällig ${s(d['faelligAm']).split('-').reverse().join('.')})`;
    case 'tcms.feststellung.verwerfen_beantragt':
      return 'Verwerfen beantragt';
    case 'tcms.feststellung.verwerfen_bestaetigt':
      return 'Verwerfen bestätigt (zweite Person)';
    case 'tcms.feststellung.verwerfen_abgelehnt':
      return 'Antrag auf Verwerfen abgelehnt';
    case 'tcms.feststellung.vertraulich':
      return d['vertraulich'] ? 'als vertraulich markiert' : 'Vertraulichkeit aufgehoben';
    case 'tcms.massnahme.angelegt':
      return `Maßnahme #${s(d['wiedervorlageNr'])} angelegt${d['beschreibung'] ? `: ${s(d['beschreibung'])}` : ''}`;
    case 'tcms.massnahme.erledigt':
      return `Maßnahme #${s(d['wiedervorlageNr'])} erledigt`;
    default:
      return aktion;
  }
}

const RANG: FeststellungStatus[] = [
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
];

function begrenzeStatus(
  s: FeststellungStatus,
  x: { p153Offen: boolean; massnahmen: number; offen: number; nachkontrolleOhneBefund: boolean },
): FeststellungStatus {
  let max = 4;
  if (x.p153Offen || x.massnahmen === 0) max = Math.min(max, 1);
  if (x.offen > 0) max = Math.min(max, 2);
  if (!x.nachkontrolleOhneBefund) max = Math.min(max, 3);
  const r = RANG.indexOf(s);
  return r > max ? RANG[max]! : s;
}

/** Status zum Stichtag: spätere Statuswechsel aus dem Audit-Log zurückrechnen. */
function statusZumStand(
  aktuell: FeststellungStatus,
  ereignisseNachStand: { aktion: string; detail: Record<string, unknown> }[],
  geschlossenNach: boolean,
): FeststellungStatus {
  const erster = ereignisseNachStand.find(
    (e) =>
      e.aktion === 'tcms.feststellung.status' ||
      e.aktion === 'tcms.feststellung.verwerfen_bestaetigt',
  );
  if (erster && typeof erster.detail['von'] === 'string')
    return erster.detail['von'] as FeststellungStatus;
  if (aktuell === 'GESCHLOSSEN' && geschlossenNach) return 'NACHKONTROLLE';
  return aktuell;
}

export async function ladeFeststellungDetail(
  programmId: string,
  fid: string,
  stand: Date,
  historisch = false,
): Promise<FeststellungDetail | null> {
  const ende = tagesende(stand);
  const f = await prisma.feststellung.findFirst({
    where: { id: fid, programmId },
    include: {
      risiken: { include: { risiko: { select: { id: true, code: true } } } },
      erklaerungen: true,
      massnahmen: { orderBy: { wiedervorlageNr: 'asc' } },
      durchfuehrung: { include: { kontrolle: { select: { code: true } } } },
      nachkontrolle: {
        include: {
          kontrolle: { select: { code: true } },
          kontrolleStand: { select: { titel: true } },
        },
      },
    },
  });
  if (!f || f.erfasstAm.getTime() > ende.getTime()) return null;

  const ereignis = f.ereignisId
    ? await prisma.ereignis.findUnique({
        where: { id: f.ereignisId },
        select: { id: true, nummer: true, typ: true, titel: true },
      })
    : null;

  const audits = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { objektTyp: 'Feststellung', objektId: f.id },
        { objektTyp: 'Massnahme', objektId: { in: f.massnahmen.map((m) => m.id) } },
      ],
    },
    orderBy: { seq: 'asc' },
  });
  const detail = (x: (typeof audits)[number]) => (x.detail ?? {}) as Record<string, unknown>;
  const nachStand = audits
    .filter((a) => a.at.getTime() > ende.getTime())
    .map((a) => ({ aktion: a.aktion, detail: detail(a) }));
  const status = statusZumStand(
    f.status,
    nachStand,
    !!f.geschlossenAm && f.geschlossenAm.getTime() > ende.getTime(),
  );

  const nachweisJe = new Map<string, string>();
  for (const a of audits) {
    if (a.aktion === 'tcms.massnahme.erledigt' && a.at.getTime() <= ende.getTime())
      nachweisJe.set(a.objektId, s(detail(a)['nachweis']) || '');
  }

  const p153Gilt =
    f.p153Entscheidung != null &&
    f.p153EntschiedenAm != null &&
    f.p153EntschiedenAm.getTime() <= ende.getTime();
  // Vertraulichkeit zum Stichtag aus dem jüngsten Vertraulich-Eintrag bis zum Stand.
  const vertraulichEintraege = audits.filter((a) => a.aktion === 'tcms.feststellung.vertraulich');
  const bisStand = vertraulichEintraege.filter((a) => a.at.getTime() <= ende.getTime()).at(-1);
  const ersterNach = vertraulichEintraege.find((a) => a.at.getTime() > ende.getTime());
  const vertraulich = bisStand
    ? detail(bisStand)['vertraulich'] === true
    : ersterNach
      ? detail(ersterNach)['vertraulich'] !== true
      : f.vertraulich;

  const nk = f.nachkontrolle;
  const nachkontrolleSichtbar =
    nk && !(nk.ausserplanmaessig && nk.createdAt.getTime() > ende.getTime());

  const letzterAntrag = audits
    .filter((a) => a.aktion === 'tcms.feststellung.verwerfen_beantragt')
    .at(-1);
  const verwerfenSichtbar =
    !!f.verwerfenBeantragtVon &&
    !!f.verwerfenBegruendung &&
    (!letzterAntrag || letzterAntrag.at.getTime() <= ende.getTime());

  const massnahmenAmStand = f.massnahmen
    .map((m) => massnahmeAm(m, ende))
    .filter((m): m is MassnahmeZeile => !!m);
  const nkAnzeige =
    nk && nachkontrolleSichtbar
      ? statusAm(
          {
            status: nk.status,
            periodeBis: nk.periodeBis,
            faelligAm: nk.faelligAm,
            begonnenAm: nk.begonnenAm,
            eingereichtAm: nk.eingereichtAm,
            abgeschlossenAm: nk.abgeschlossenAm,
            entfallenAm: nk.entfallenAm,
          },
          stand,
        )
      : null;
  // Historischer Stand ohne protokollierte Statuswechsel (z. B. Seed-Daten): Status
  // auf das begrenzen, was die Fakten zum Stichtag zulassen.
  const statusHist =
    historisch && status !== 'VERWORFEN'
      ? begrenzeStatus(status, {
          p153Offen:
            (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
            !(p153Gilt && p153Abschliessend(f.p153Entscheidung)),
          massnahmen: massnahmenAmStand.length,
          offen: massnahmenAmStand.filter((m) => m.status === 'OFFEN').length,
          nachkontrolleOhneBefund: nkAnzeige === 'OHNE_BEFUND',
        })
      : status;

  return {
    id: f.id,
    programmId: f.programmId,
    nummer: f.nummer,
    titel: f.titel,
    sachverhalt: f.sachverhalt,
    quelle: f.quelle,
    quelleText: f.quelleText,
    klasse: f.klasse,
    schwere: f.schwere,
    auswirkung: f.auswirkung,
    ursache: f.ursache,
    status: statusHist,
    vertraulich,
    vertraulichAktuell: f.vertraulich,
    p153: p153Gilt
      ? {
          entscheidung: f.p153Entscheidung!,
          begruendung: f.p153Begruendung,
          frist: f.p153Frist,
          von: f.p153EntschiedenVon,
          am: f.p153EntschiedenAm!,
        }
      : null,
    durchfuehrung: f.durchfuehrung
      ? {
          id: f.durchfuehrung.id,
          kontrolleId: f.durchfuehrung.kontrolleId,
          code: f.durchfuehrung.kontrolle.code,
          periodeLabel: f.durchfuehrung.periodeLabel,
        }
      : null,
    ereignis,
    nachkontrolle:
      nk && nachkontrolleSichtbar
        ? {
            id: nk.id,
            kontrolleId: nk.kontrolleId,
            code: nk.kontrolle.code,
            titel: nk.kontrolleStand.titel,
            periodeLabel: nk.periodeLabel,
            faelligAm: nk.faelligAm,
            ausserplanmaessig: nk.ausserplanmaessig,
            anzeige: statusAm(
              {
                status: nk.status,
                periodeBis: nk.periodeBis,
                faelligAm: nk.faelligAm,
                begonnenAm: nk.begonnenAm,
                eingereichtAm: nk.eingereichtAm,
                abgeschlossenAm: nk.abgeschlossenAm,
                entfallenAm: nk.entfallenAm,
              },
              stand,
            ),
          }
        : null,
    verwerfen:
      verwerfenSichtbar && f.verwerfenBeantragtVon && f.verwerfenBegruendung
        ? {
            begruendung: f.verwerfenBegruendung,
            beantragtVon: f.verwerfenBeantragtVon,
            bestaetigtVon: status === 'VERWORFEN' ? f.verwerfenBestaetigtVon : null,
          }
        : null,
    erfasstVon: f.erfasstVon,
    erfasstAm: f.erfasstAm,
    geschlossenAm:
      f.geschlossenAm && f.geschlossenAm.getTime() <= ende.getTime() ? f.geschlossenAm : null,
    risiken: f.risiken
      .map((r) => ({ id: r.risiko.id, code: r.risiko.code }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    erklaerungen: f.erklaerungen.map((e) => ({
      id: e.id,
      steuerart: e.steuerart,
      land: e.land,
      zeitraum: e.zeitraum,
      auswirkungEur: e.auswirkungEur == null ? null : Number(e.auswirkungEur),
    })),
    massnahmen: f.massnahmen
      .map((m) => massnahmeAm(m, ende))
      .filter((m): m is MassnahmeZeile => !!m)
      .map((m) => ({
        ...m,
        nachweis: m.status === 'ERLEDIGT' ? (nachweisJe.get(m.id) ?? null) : null,
      })),
    verlauf: audits
      .filter((a) => a.at.getTime() <= ende.getTime() && MANUELL_AKTIONEN.includes(a.aktion))
      .map((a) => ({
        id: a.seq,
        at: a.at,
        actorName: a.actorName,
        text: verlaufText(a.aktion, detail(a)),
      }))
      .reverse(),
  };
}

// ----------------------------------------------------------------------------
// Nummernkreise und Anlagen innerhalb einer Transaktion
// ----------------------------------------------------------------------------

export { naechsteFeststellungsnummer, naechsteWiedervorlageNr } from './nummern';

function utcTag(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Legt eine außerplanmäßige Durchführung mit dem aktuell gültigen Kontrollstand
 * an (Muster: Seed `baueProgramm`). Periode = Tag der Anlage, damit sie sofort fällig ist.
 */
export async function legeAusserplanmaessigeDurchfuehrungAn(
  tx: Tx,
  a: {
    kontrolleId: string;
    faelligAm: Date;
    anlass: string;
    label: string;
    ereignisFolgeId?: string | null;
    zeitpunkt: Date;
  },
): Promise<{ id: string; code: string }> {
  const k = await tx.kontrolle.findUnique({
    where: { id: a.kontrolleId },
    include: { staende: true },
  });
  if (!k) throw new Error('Kontrolle nicht gefunden');
  const t = a.zeitpunkt.getTime();
  const stand = k.staende
    .filter(
      (x) => x.gueltigAb.getTime() <= t && (x.gueltigBis == null || x.gueltigBis.getTime() > t),
    )
    .sort((x, y) => y.gueltigAb.getTime() - x.gueltigAb.getTime())[0];
  if (!stand) throw new Error('Kein gültiger Kontrollstand');
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
  });
  return { id: d.id, code: k.code };
}
