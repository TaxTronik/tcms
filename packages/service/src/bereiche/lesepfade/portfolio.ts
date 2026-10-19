// =============================================================================
// S1 Tax-CMS-Portfolio (`POST /v1/portfolio`): je zugänglichem Mandanten die
// Kennzahlen der Portfoliozeile aus dem aktuellen Kontext. Keine
// Personenvergleiche, nur Objekte; Zuständigkeit und Namen ergänzt die
// kanzleikonsole.
//
// Kosten: Die Kontexte werden blockweise geladen (`jeAktuellerKontext`, je
// Block eine feste Zahl Abfragen) und sofort zu einer Zeile verdichtet; nur
// die Zeilen bleiben im Speicher. Messung bei 500 Mandanten siehe Bericht und
// `portfolio.perf.test.ts`.
// =============================================================================

import { PortfolioAntwortSchema, type MandantenListe, type PortfolioAntwort } from '@tcms/contract';
import { isoDatum, PAKET, PHASEN, tageZwischen, type AnzeigeStatus } from '@tcms/domain';
import { jeAktuellerKontext, type TcmsKontext } from '../../kern/tcms-kontext';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten } from '../../rechte';
import type { Akteur } from '@tcms/contract';
import { alsJson, antwortNach } from './hilfen';
import { zugaengeAusListe } from './zugang';

type Zeile = PortfolioAntwort['zeilen'][number];
type ZeileRoh = Omit<Zeile, 'zeitraum' | 'naechsterTermin'> & {
  zeitraum:
    | { art: 'LAUFEND'; monat: number; monate: number; ab: Date; bis: Date }
    | { art: 'BEVORSTEHEND' | 'ABGESCHLOSSEN'; ab: Date; bis: Date }
    | { art: 'OFFEN' };
  naechsterTermin: {
    datum: Date;
    code: string;
    titel: string;
    periode: string;
    durchfuehrungId: string;
    anzeige: AnzeigeStatus;
  } | null;
};

const OFFEN: readonly AnzeigeStatus[] = ['FAELLIG', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];

/** Verdichtet einen Kontext zur Portfoliozeile (Logik wie bisher in der Demo). */
export function portfolioZeile(ctx: TcmsKontext, akteur: Akteur, heute: Date): ZeileRoh {
  const m = ctx.mandant;
  const basis = {
    mandant: { id: m.id, name: m.name, rechtsform: m.rechtsform },
    darfBearbeiten: kannBearbeiten(akteur, m.id),
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
      appetit: null,
      prueflast: null,
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
  // Prüflast im Folgemonat (wie Cockpit); ohne geplante Durchführungen keine.
  const last = d.length > 0 ? (ctx.prueflast[1] ?? ctx.prueflast[0] ?? null) : null;

  const p = ctx.programm;
  let zeitraum: ZeileRoh['zeitraum'] = { art: 'OFFEN' };
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

/**
 * Portfolio über die von der kanzleikonsole bestätigten Mandanten (nur
 * Kanzleipersonen; höchstens `MAX_MANDANTEN_JE_ANFRAGE`). Mandanten außerhalb
 * der Liste werden nie geladen; unbekannte oder inaktive entfallen ohne
 * Hinweis. Sortierung: mit Programm vor ohne, dann Dringlichkeit, dann Name.
 */
export async function ladePortfolio(
  ctx: DienstKontext,
  eingabe: MandantenListe,
): Promise<PortfolioAntwort> {
  const zugaenge = zugaengeAusListe(ctx.akteur, eingabe);
  const heute = heuteDatum(ctx.uhr);
  const zeilen: ZeileRoh[] = [];
  await jeAktuellerKontext(ctx, zugaenge, (k, akteur) =>
    zeilen.push(portfolioZeile(k, akteur, heute)),
  );
  zeilen.sort((a, b) => {
    if (a.hatProgramm !== b.hatProgramm) return a.hatProgramm ? -1 : 1;
    return b.prioritaet - a.prioritaet || a.mandant.name.localeCompare(b.mandant.name, 'de');
  });
  return antwortNach(
    PortfolioAntwortSchema,
    'ladePortfolio',
    alsJson({ heute: isoDatum(heute), zeilen }),
  );
}
