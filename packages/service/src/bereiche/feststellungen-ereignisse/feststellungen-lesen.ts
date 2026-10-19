// =============================================================================
// Feststellungen und Maßnahmen (S10): Lader für Liste und Detail zu einem
// Stichtag (bisher apps/web/src/server/feststellungen-daten.ts).
//
// Vertraulichkeit (Fachkonzept §13) wird hier maskiert, nicht in der
// Oberfläche: Für Nicht-Beteiligte (`kannVertraulichLesen`) enthält die
// Antwort nur Nummer, Status und Wiedervorlagen ohne Inhalt. Maßgeblich ist
// die Vertraulichkeit heute und – im Detail – zusätzlich zum Stichtag, damit
// ein früher Stichtag den heutigen Inhalt nicht freilegt.
// =============================================================================

import {
  DienstFehler,
  FeststellungLesenSchema,
  FeststellungenLesenSchema,
  type FeststellungDetail,
  type FeststellungLesen,
  type FeststellungListe,
  type FeststellungListenEintrag,
  type FeststellungenLesen,
  type MassnahmeZeile,
  type VerlaufEintrag,
} from '@tcms/contract';
import {
  FESTSTELLUNG_STATUS_LABEL,
  P153_LABEL,
  statusAm,
  type FeststellungStatus,
  type Paragraph153Entscheidung,
} from '@tcms/domain';
import { auditGrenze, heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannVertraulichLesen } from '../../rechte';
import { beteiligteVon, p153Abschliessend } from './feststellungen';
import {
  isoTag,
  isoTagOderNull,
  isoZeit,
  isoZeitOderNull,
  namenListe,
  programmVon,
  pruefe,
  pruefeKanzleiZugriff,
  pruefeMandant,
  text,
} from './gemeinsam';

interface MassnahmeRoh {
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

/** Maßnahme zum Stichtag (später angelegte fehlen, später erledigte sind offen). */
function massnahmeAm(m: MassnahmeRoh, ende: Date): MassnahmeZeile | null {
  if (m.createdAt.getTime() > ende.getTime()) return null;
  const erledigt =
    m.status === 'ERLEDIGT' && m.erledigtAm != null && m.erledigtAm.getTime() <= ende.getTime();
  return {
    id: m.id,
    feststellungId: m.feststellungId,
    wiedervorlageNr: m.wiedervorlageNr,
    beschreibung: m.beschreibung,
    verantwortlich: m.verantwortlich,
    frist: isoTag(m.frist),
    status: erledigt ? 'ERLEDIGT' : 'OFFEN',
    erledigtAm: erledigt ? isoZeitOderNull(m.erledigtAm) : null,
    erledigtVon: erledigt ? m.erledigtVon : null,
    createdAt: isoZeit(m.createdAt),
  };
}

function stichtag(ctx: DienstKontext, stand: string | undefined) {
  const heute = heuteDatum(ctx.uhr);
  const s = leseStand(stand, heute);
  return { ...s, heute, ende: tagesende(s.stand) };
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

/** Feststellungen eines Mandanten zum Stichtag, vertrauliche für Nicht-Beteiligte maskiert. */
export async function ladeFeststellungen(
  ctx: DienstKontext,
  eingabe: FeststellungenLesen,
): Promise<FeststellungListe> {
  const e = pruefe(FeststellungenLesenSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  await pruefeMandant(ctx.tx, mandantId);
  const { stand, historisch, ende } = stichtag(ctx, e.stand);
  const kopf = { stand: isoTag(stand), historisch };
  const programm = await programmVon(ctx.tx, mandantId);
  if (!programm) return { ...kopf, programmId: null, feststellungen: [], namen: [] };

  const roh = await ctx.tx.feststellung.findMany({
    where: { programmId: programm.id },
    include: {
      massnahmen: { orderBy: [{ wiedervorlageNr: 'asc' }, { id: 'asc' }] },
      risiken: { include: { risiko: { select: { code: true } } }, orderBy: { risikoId: 'asc' } },
    },
    orderBy: [{ nummer: 'asc' }, { id: 'asc' }],
  });
  const personen: (string | null)[] = [];
  const feststellungen: FeststellungListenEintrag[] = roh
    .filter((f) => f.erfasstAm.getTime() <= ende.getTime())
    .sort((a, b) => b.nummer.localeCompare(a.nummer))
    .map((f): FeststellungListenEintrag => {
      const status: FeststellungStatus =
        f.status === 'GESCHLOSSEN' && f.geschlossenAm && f.geschlossenAm.getTime() > ende.getTime()
          ? 'NACHKONTROLLE'
          : f.status;
      const zeilen = f.massnahmen
        .map((m) => massnahmeAm(m, ende))
        .filter((m): m is MassnahmeZeile => !!m);
      if (f.vertraulich && !kannVertraulichLesen(ctx.akteur, mandantId, beteiligteVon(f))) {
        return {
          maskiert: true,
          id: f.id,
          nummer: f.nummer,
          vertraulich: true,
          status,
          erfasstAm: isoZeit(f.erfasstAm),
          massnahmen: zeilen.map((m) => ({
            id: m.id,
            feststellungId: m.feststellungId,
            wiedervorlageNr: m.wiedervorlageNr,
            frist: m.frist,
            status: m.status,
          })),
        };
      }
      const entschieden =
        f.p153Entscheidung != null &&
        f.p153EntschiedenAm != null &&
        f.p153EntschiedenAm.getTime() <= ende.getTime();
      // Kennzahlen wie im Tax-CMS-Kontext (kern/tcms-kontext.ts).
      const offen = f.massnahmen.filter(
        (m) => m.status === 'OFFEN' || (m.erledigtAm && m.erledigtAm.getTime() > ende.getTime()),
      );
      const fristen = offen.map((m) => m.frist.getTime()).sort((a, b) => a - b);
      personen.push(f.erfasstVon, entschieden ? f.p153EntschiedenVon : null);
      for (const m of zeilen) personen.push(m.verantwortlich, m.erledigtVon);
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
        status,
        vertraulich: f.vertraulich,
        erfasstVon: f.erfasstVon,
        erfasstAm: isoZeit(f.erfasstAm),
        durchfuehrungId: f.durchfuehrungId,
        ereignisId: f.ereignisId,
        p153: entschieden
          ? {
              entscheidung: f.p153Entscheidung!,
              begruendung: f.p153Begruendung,
              frist: isoTagOderNull(f.p153Frist),
              von: f.p153EntschiedenVon,
              am: isoZeit(f.p153EntschiedenAm!),
            }
          : null,
        p153Offen:
          (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
          !entschieden &&
          f.status !== 'VERWORFEN',
        verwerfenOffen:
          !!f.verwerfenBeantragtVon && !f.verwerfenBestaetigtVon && f.status !== 'VERWORFEN',
        massnahmenOffen: offen.length,
        massnahmenGesamt: f.massnahmen.length,
        aeltesteFrist: fristen.length ? isoTag(new Date(fristen[0]!)) : null,
        risikoCodes: f.risiken.map((x) => x.risiko.code).sort(),
        massnahmen: zeilen,
      };
    });
  return {
    ...kopf,
    programmId: programm.id,
    feststellungen,
    namen: await namenListe(ctx, personen),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const VERLAUF_AKTIONEN = new Set([
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
]);

/** Lesbarer Verlaufstext zu einem Audit-Eintrag. */
export function verlaufText(aktion: string, d: Record<string, unknown>): string {
  const status = (x: unknown) => FESTSTELLUNG_STATUS_LABEL[x as FeststellungStatus] ?? text(x);
  const datum = (x: unknown) => text(x).split('-').reverse().join('.');
  switch (aktion) {
    case 'tcms.feststellung.erfasst':
      return d['quelle']
        ? `Feststellung erfasst (Quelle: ${text(d['quelle'])})`
        : 'Feststellung erfasst';
    case 'tcms.feststellung.status':
      return d['von']
        ? `Status ${status(d['von'])} → ${status(d['nach'])}`
        : `Status auf „${status(d['nach'])}" gesetzt`;
    case 'tcms.feststellung.geschlossen':
      return 'Feststellung geschlossen';
    case 'tcms.feststellung.p153_entschieden': {
      const e = d['entscheidung'] as Paragraph153Entscheidung | undefined;
      const label = e && P153_LABEL[e] ? P153_LABEL[e].replace(' bis …', '') : '—';
      return `§-153-Würdigung dokumentiert: ${label}${d['frist'] ? ` (Frist ${datum(d['frist'])})` : ''}`;
    }
    case 'tcms.feststellung.wuerdigung':
      return 'Würdigungsangaben aktualisiert (Schwere, Auswirkung, Ursache)';
    case 'tcms.feststellung.erklaerung':
      return `Betroffene Erklärung erfasst: ${text(d['steuerart'])} · ${text(d['land'])} · ${text(d['zeitraum'])}`;
    case 'tcms.feststellung.nachkontrolle':
      return `Nachkontrolle angelegt: ${text(d['kontrolle'])} (fällig ${datum(d['faelligAm'])})`;
    case 'tcms.feststellung.verwerfen_beantragt':
      return 'Verwerfen beantragt';
    case 'tcms.feststellung.verwerfen_bestaetigt':
      return 'Verwerfen bestätigt (zweite Person)';
    case 'tcms.feststellung.verwerfen_abgelehnt':
      return 'Antrag auf Verwerfen abgelehnt';
    case 'tcms.feststellung.vertraulich':
      return d['vertraulich'] ? 'als vertraulich markiert' : 'Vertraulichkeit aufgehoben';
    case 'tcms.massnahme.angelegt':
      return `Maßnahme #${text(d['wiedervorlageNr'])} angelegt${d['beschreibung'] ? `: ${text(d['beschreibung'])}` : ''}`;
    case 'tcms.massnahme.erledigt':
      return `Maßnahme #${text(d['wiedervorlageNr'])} erledigt`;
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
  const von = erster?.detail['von'];
  if (typeof von === 'string' && von in FESTSTELLUNG_STATUS_LABEL) return von as FeststellungStatus;
  if (aktuell === 'GESCHLOSSEN' && geschlossenNach) return 'NACHKONTROLLE';
  return aktuell;
}

/**
 * Detail einer Feststellung zum Stichtag (Maßnahmen, Nachkontrolle, Verlauf
 * aus dem Audit-Log). Für Nicht-Beteiligte einer vertraulichen Feststellung
 * nur Nummer und Kennzeichen (`maskiert`). Feststellung eines anderen
 * Mandanten, fremder Tenant, unbekannte ID oder nach dem Stichtag erfasst:
 * NICHT_GEFUNDEN.
 */
export async function ladeFeststellung(
  ctx: DienstKontext,
  eingabe: FeststellungLesen,
): Promise<FeststellungDetail> {
  const e = pruefe(FeststellungLesenSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const { stand, historisch, heute, ende } = stichtag(ctx, e.stand);
  const kopf = { stand: isoTag(stand), historisch };
  const tx = ctx.tx;
  const f = await tx.feststellung.findFirst({
    where: { id: e.feststellungId, programm: { mandantId } },
    include: {
      risiken: {
        include: { risiko: { select: { id: true, code: true } } },
        orderBy: { risikoId: 'asc' },
      },
      erklaerungen: { orderBy: { id: 'asc' } },
      massnahmen: { orderBy: [{ wiedervorlageNr: 'asc' }, { id: 'asc' }] },
      durchfuehrung: { include: { kontrolle: { select: { code: true } } } },
      nachkontrolle: {
        include: {
          kontrolle: { select: { code: true } },
          kontrolleStand: { select: { titel: true } },
        },
      },
    },
  });
  if (!f || f.erfasstAm.getTime() > ende.getTime()) throw new DienstFehler('NICHT_GEFUNDEN');
  const darf = kannVertraulichLesen(ctx.akteur, mandantId, beteiligteVon(f));
  const maskiert = {
    maskiert: true as const,
    ...kopf,
    id: f.id,
    nummer: f.nummer,
    vertraulich: true as const,
  };
  if (f.vertraulich && !darf) return maskiert;

  // Audit-Zeitstempel sind echte Zeit; Vergleiche mit Audit-Einträgen über auditGrenze.
  const auditEnde = auditGrenze(stand, heute);
  const audits = await tx.auditEvent.findMany({
    where: {
      OR: [
        { objektTyp: 'Feststellung', objektId: f.id },
        { objektTyp: 'Massnahme', objektId: { in: f.massnahmen.map((m) => m.id) } },
      ],
      programmId: f.programmId,
    },
    orderBy: { pos: 'asc' },
    select: { pos: true, at: true, actorId: true, aktion: true, objektId: true, detail: true },
  });
  const detail = (x: (typeof audits)[number]) => (x.detail ?? {}) as Record<string, unknown>;
  const bisStand = (x: { at: Date }) => x.at.getTime() <= auditEnde.getTime();

  // Vertraulichkeit zum Stichtag aus dem jüngsten Vertraulich-Eintrag bis zum Stand.
  const vertraulichEintraege = audits.filter((a) => a.aktion === 'tcms.feststellung.vertraulich');
  const letzterBis = vertraulichEintraege.filter(bisStand).at(-1);
  const ersterNach = vertraulichEintraege.find((a) => !bisStand(a));
  const vertraulich = letzterBis
    ? detail(letzterBis)['vertraulich'] === true
    : ersterNach
      ? detail(ersterNach)['vertraulich'] !== true
      : f.vertraulich;
  if (vertraulich && !darf) return maskiert;

  const nachStand = audits
    .filter((a) => !bisStand(a))
    .map((a) => ({ aktion: a.aktion, detail: detail(a) }));
  const status = statusZumStand(
    f.status,
    nachStand,
    !!f.geschlossenAm && f.geschlossenAm.getTime() > ende.getTime(),
  );

  const nachweisJe = new Map<string, string>();
  for (const a of audits) {
    if (a.aktion === 'tcms.massnahme.erledigt' && bisStand(a)) {
      nachweisJe.set(a.objektId, text(detail(a)['nachweis']));
    }
  }

  const p153Gilt =
    f.p153Entscheidung != null &&
    f.p153EntschiedenAm != null &&
    f.p153EntschiedenAm.getTime() <= ende.getTime();

  const nk = f.nachkontrolle;
  const nkSichtbar = !!nk && !(nk.ausserplanmaessig && nk.createdAt.getTime() > ende.getTime());
  const nkAnzeige =
    nk && nkSichtbar
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

  const letzterAntrag = audits
    .filter((a) => a.aktion === 'tcms.feststellung.verwerfen_beantragt')
    .at(-1);
  const verwerfenSichtbar =
    !!f.verwerfenBeantragtVon &&
    !!f.verwerfenBegruendung &&
    (!letzterAntrag || bisStand(letzterAntrag));

  const massnahmen = f.massnahmen
    .map((m) => massnahmeAm(m, ende))
    .filter((m): m is MassnahmeZeile => !!m);
  // Historischer Stand ohne protokollierte Statuswechsel (z. B. Seed-Daten): Status
  // auf das begrenzen, was die Fakten zum Stichtag zulassen.
  const statusStand =
    historisch && status !== 'VERWORFEN'
      ? begrenzeStatus(status, {
          p153Offen:
            (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
            !(p153Gilt && p153Abschliessend(f.p153Entscheidung)),
          massnahmen: massnahmen.length,
          offen: massnahmen.filter((m) => m.status === 'OFFEN').length,
          nachkontrolleOhneBefund: nkAnzeige === 'OHNE_BEFUND',
        })
      : status;

  const verlauf: VerlaufEintrag[] = audits
    .filter((a) => bisStand(a) && VERLAUF_AKTIONEN.has(a.aktion))
    .map((a) => ({
      pos: a.pos,
      at: isoZeit(a.at),
      actorId: a.actorId,
      text: verlaufText(a.aktion, detail(a)),
    }))
    .reverse();

  const verwerfen =
    verwerfenSichtbar && f.verwerfenBeantragtVon && f.verwerfenBegruendung
      ? {
          begruendung: f.verwerfenBegruendung,
          beantragtVon: f.verwerfenBeantragtVon,
          bestaetigtVon: status === 'VERWORFEN' ? f.verwerfenBestaetigtVon : null,
        }
      : null;
  const p153 = p153Gilt
    ? {
        entscheidung: f.p153Entscheidung!,
        begruendung: f.p153Begruendung,
        frist: isoTagOderNull(f.p153Frist),
        von: f.p153EntschiedenVon,
        am: isoZeit(f.p153EntschiedenAm!),
      }
    : null;

  return {
    maskiert: false,
    ...kopf,
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
    status: statusStand,
    vertraulich,
    vertraulichAktuell: f.vertraulich,
    p153,
    durchfuehrung: f.durchfuehrung
      ? {
          id: f.durchfuehrung.id,
          kontrolleId: f.durchfuehrung.kontrolleId,
          code: f.durchfuehrung.kontrolle.code,
          periodeLabel: f.durchfuehrung.periodeLabel,
        }
      : null,
    ereignis: f.ereignisId
      ? await tx.ereignis.findFirst({
          where: { id: f.ereignisId, programmId: f.programmId },
          select: { id: true, nummer: true, typ: true, titel: true },
        })
      : null,
    nachkontrolle:
      nk && nkSichtbar && nkAnzeige
        ? {
            id: nk.id,
            kontrolleId: nk.kontrolleId,
            code: nk.kontrolle.code,
            titel: nk.kontrolleStand.titel,
            periodeLabel: nk.periodeLabel,
            faelligAm: isoTag(nk.faelligAm),
            anzeige: nkAnzeige,
            ausserplanmaessig: nk.ausserplanmaessig,
          }
        : null,
    verwerfen,
    erfasstVon: f.erfasstVon,
    erfasstAm: isoZeit(f.erfasstAm),
    geschlossenAm:
      f.geschlossenAm && f.geschlossenAm.getTime() <= ende.getTime()
        ? isoZeit(f.geschlossenAm)
        : null,
    risiken: f.risiken
      .map((r) => ({ id: r.risiko.id, code: r.risiko.code }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    erklaerungen: f.erklaerungen.map((x) => ({
      id: x.id,
      steuerart: x.steuerart,
      land: x.land,
      zeitraum: x.zeitraum,
      auswirkungEur: x.auswirkungEur == null ? null : Number(x.auswirkungEur),
    })),
    massnahmen: massnahmen.map((m) => ({
      ...m,
      nachweis: m.status === 'ERLEDIGT' ? (nachweisJe.get(m.id) ?? null) : null,
    })),
    verlauf,
    namen: await namenListe(ctx, [
      f.erfasstVon,
      p153?.von,
      verwerfen?.beantragtVon,
      verwerfen?.bestaetigtVon,
      ...massnahmen.flatMap((m) => [m.verantwortlich, m.erledigtVon]),
      ...verlauf.map((v) => v.actorId),
    ]),
  };
}
