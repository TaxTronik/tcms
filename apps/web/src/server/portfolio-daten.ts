import 'server-only';
import { prisma } from '@tcms/db';
import {
  isoDatum,
  MONATE,
  PAKET,
  PHASEN,
  tageZwischen,
  type AnzeigeStatus,
  type Pruflast,
} from '@tcms/domain';
import { ladeKontext, personName, type TcmsKontext } from './kontext';
import { heute as heuteFn } from './zeit';

// =============================================================================
// S1 Tax-CMS-Portfolio: je Mandant der aktuelle Kontext (ladeKontext), daraus
// die Kennzahlen der Portfoliozeile. Keine Personenvergleiche, nur Objekte.
// =============================================================================

export interface PortfolioTermin {
  datum: Date;
  code: string;
  titel: string;
  periode: string;
  durchfuehrungId: string;
  anzeige: AnzeigeStatus;
}

export interface PortfolioZeile {
  mandant: {
    id: string;
    name: string;
    rechtsform: string;
    berufstraegerId: string;
    bearbeitungId: string;
  };
  berufstraeger: string;
  bearbeitung: string;
  hatProgramm: boolean;
  /** Programm im Einrichtungsentwurf (Version 1 noch nicht angelegt). */
  entwurf: boolean;
  paket: string | null;
  teilbereich: string | null;
  phase: number;
  phaseName: string;
  risiken: number;
  ueberAppetit: number;
  appetit: string;
  /** Manuelle Prüflast im Folgemonat (wie Cockpit); null = noch keine Durchführungen geplant. */
  prueflast: Pruflast | null;
  prueflastMonat: string;
  faellig: number;
  ueberfaellig: number;
  zurGegenzeichnung: number;
  feststellungenOffen: number;
  feststellungenHochOffen: number;
  p153Offen: number;
  ereignisseNeu: number;
  zeitraum:
    | { art: 'LAUFEND'; monat: number; monate: number; ab: Date; bis: Date }
    | { art: 'BEVORSTEHEND'; ab: Date; bis: Date }
    | { art: 'ABGESCHLOSSEN'; ab: Date; bis: Date }
    | { art: 'OFFEN' };
  naechsterTermin: PortfolioTermin | null;
  handlungsbedarf: boolean;
  /** Sortierschlüssel: höher = dringender. */
  prioritaet: number;
}

export interface Portfolio {
  heute: Date;
  zeilen: PortfolioZeile[];
  berufstraeger: { id: string; name: string }[];
}

const OFFEN: readonly AnzeigeStatus[] = ['FAELLIG', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];

function zeile(ctx: TcmsKontext, heute: Date): PortfolioZeile {
  const m = ctx.mandant;
  const basis = {
    mandant: {
      id: m.id,
      name: m.name,
      rechtsform: m.rechtsform,
      berufstraegerId: m.berufstraegerId,
      bearbeitungId: m.bearbeitungId,
    },
    berufstraeger: personName(ctx, m.berufstraegerId),
    bearbeitung: personName(ctx, m.bearbeitungId),
  };
  const entwurf = !!ctx.programm && ctx.programm.status === 'ENTWURF' && !ctx.programm.version1Am;
  if (!ctx.programm || entwurf) {
    return {
      ...basis,
      hatProgramm: false,
      entwurf,
      paket: null,
      teilbereich: null,
      phase: 0,
      phaseName: entwurf ? 'Einrichtung läuft' : 'kein Tax-CMS',
      risiken: 0,
      ueberAppetit: 0,
      appetit: '',
      prueflast: null,
      prueflastMonat: '',
      faellig: 0,
      ueberfaellig: 0,
      zurGegenzeichnung: 0,
      feststellungenOffen: 0,
      feststellungenHochOffen: 0,
      p153Offen: 0,
      ereignisseNeu: 0,
      zeitraum: { art: 'OFFEN' },
      naechsterTermin: null,
      handlungsbedarf: false,
      prioritaet: -1,
    };
  }

  const d = ctx.durchfuehrungen;
  const ueberfaellig = d.filter((x) => x.anzeige === 'UEBERFAELLIG').length;
  const faellig = d.filter(
    (x) =>
      OFFEN.includes(x.anzeige) ||
      (x.anzeige === 'GEPLANT' && tageZwischen(heute, x.faelligAm) <= 14),
  ).length;
  const zurGegenzeichnung = d.filter((x) => x.anzeige === 'ZUR_GEGENZEICHNUNG').length;
  const offeneF = ctx.feststellungen.filter(
    (f) => f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN',
  );
  const hochOffen = offeneF.filter((f) => f.schwere === 'HOCH' || f.schwere === 'KRITISCH').length;
  const p153Offen = ctx.feststellungen.filter((f) => f.p153Offen).length;
  const ereignisseNeu = ctx.ereignisse.filter((e) => e.status === 'NEU').length;
  const ueberAppetit = ctx.risiken.filter((r) => r.ueberAppetit).length;

  const last = d.length > 0 ? (ctx.prueflast[1] ?? ctx.prueflast[0] ?? null) : null;
  const lastMonat = last
    ? `${MONATE[Number(last.monat.slice(5, 7)) - 1]} ${last.monat.slice(0, 4)}`
    : '';

  const p = ctx.programm;
  let zeitraum: PortfolioZeile['zeitraum'] = { art: 'OFFEN' };
  if (p.wirksamAb && p.wirksamBis) {
    if (heute.getTime() < p.wirksamAb.getTime())
      zeitraum = { art: 'BEVORSTEHEND', ab: p.wirksamAb, bis: p.wirksamBis };
    else if (heute.getTime() > p.wirksamBis.getTime())
      zeitraum = { art: 'ABGESCHLOSSEN', ab: p.wirksamAb, bis: p.wirksamBis };
    else if (ctx.zeitraum)
      zeitraum = {
        art: 'LAUFEND',
        monat: ctx.zeitraum.monat,
        monate: ctx.zeitraum.monate,
        ab: p.wirksamAb,
        bis: p.wirksamBis,
      };
  }

  const naechste = d
    .filter(
      (x) =>
        (OFFEN.includes(x.anzeige) || x.anzeige === 'GEPLANT') &&
        tageZwischen(heute, x.faelligAm) >= 0,
    )
    .sort((a, b) => a.faelligAm.getTime() - b.faelligAm.getTime())[0];

  const handlungsbedarf =
    ueberfaellig > 0 ||
    p153Offen > 0 ||
    hochOffen > 0 ||
    ereignisseNeu > 0 ||
    ueberAppetit > 0 ||
    zurGegenzeichnung > 0;
  const prioritaet =
    p153Offen * 10_000 +
    ueberfaellig * 1_000 +
    hochOffen * 300 +
    ueberAppetit * 100 +
    ereignisseNeu * 30 +
    zurGegenzeichnung * 10 +
    faellig;

  return {
    ...basis,
    hatProgramm: true,
    entwurf: false,
    paket: `${PAKET.name} v${p.paketVersion}`,
    teilbereich: ctx.teilbereich?.name ?? null,
    phase: ctx.aktivePhase,
    phaseName: PHASEN[ctx.aktivePhase - 1] ?? '',
    risiken: ctx.risiken.length,
    ueberAppetit,
    appetit: ctx.appetit,
    prueflast: last,
    prueflastMonat: lastMonat,
    faellig,
    ueberfaellig,
    zurGegenzeichnung,
    feststellungenOffen: offeneF.length,
    feststellungenHochOffen: hochOffen,
    p153Offen,
    ereignisseNeu,
    zeitraum,
    naechsterTermin: naechste
      ? {
          datum: naechste.faelligAm,
          code: naechste.code,
          titel: naechste.titel,
          periode: naechste.periodeLabel,
          durchfuehrungId: naechste.id,
          anzeige: naechste.anzeige,
        }
      : null,
    handlungsbedarf,
    prioritaet,
  };
}

export async function ladePortfolio(): Promise<Portfolio> {
  const heute = heuteFn();
  const iso = isoDatum(heute);
  const [mandanten, bt] = await Promise.all([
    prisma.mandant.findMany({
      where: { aktiv: true },
      orderBy: { name: 'asc' },
      select: { id: true },
    }),
    prisma.person.findMany({
      where: { art: 'KANZLEI', kanzleiRolle: 'BERUFSTRAEGER', aktiv: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  const kontexte = await Promise.all(mandanten.map((m) => ladeKontext(m.id, iso, false)));
  const zeilen = kontexte
    .filter((c): c is TcmsKontext => c != null)
    .map((c) => zeile(c, heute))
    .sort((a, b) => {
      if (a.hatProgramm !== b.hatProgramm) return a.hatProgramm ? -1 : 1;
      return b.prioritaet - a.prioritaet || a.mandant.name.localeCompare(b.mandant.name, 'de');
    });
  return { heute, zeilen, berufstraeger: bt };
}
