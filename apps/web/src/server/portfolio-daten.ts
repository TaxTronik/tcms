import 'server-only';
import type { PortfolioAntwort } from '@tcms/contract';
import { MONATE, type AnzeigeStatus, type Pruflast } from '@tcms/domain';
import { imDienst, ladePortfolio as ladePortfolioImDienst } from '@tcms/service';
import {
  DEMO_PORTS,
  demoPersonen,
  mandantenListe,
  zustaendigkeit,
  type KanzleiAkteur,
} from './demo';
import { heute as heuteFn } from './zeit';

// =============================================================================
// S1 Tax-CMS-Portfolio der Demo: Kennzahlen aus @tcms/service (`ladePortfolio`,
// Liste der zugänglichen Mandanten wie von der kanzleikonsole); die Demo
// ergänzt nur Zuständigkeit und Namen aus ihrem Verzeichnis und wandelt
// ISO-Strings für die Anzeige in Datumswerte.
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
  /** Bearbeitungsrecht laut Service (z. B. Einrichtung starten). */
  darfBearbeiten: boolean;
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

const datum = (iso: string) => new Date(iso);

function zeitraum(z: PortfolioAntwort['zeilen'][number]['zeitraum']): PortfolioZeile['zeitraum'] {
  if (z.art === 'OFFEN') return z;
  if (z.art === 'LAUFEND') return { ...z, ab: datum(z.ab), bis: datum(z.bis) };
  return { art: z.art, ab: datum(z.ab), bis: datum(z.bis) };
}

/** Portfolio der angemeldeten Kanzleiperson über ihre zugänglichen Mandanten. */
export async function ladePortfolio(nutzer: KanzleiAkteur): Promise<Portfolio> {
  const p = await imDienst(nutzer, DEMO_PORTS, (ctx) =>
    ladePortfolioImDienst(ctx, mandantenListe(nutzer)),
  );
  const name = (id: string | null) => (id ? (demoPersonen.person(id)?.name ?? '—') : '—');
  const zeilen = p.zeilen.map((z): PortfolioZeile => {
    const zust = zustaendigkeit(z.mandant.id);
    return {
      ...z,
      mandant: {
        ...z.mandant,
        berufstraegerId: zust.berufstraegerId ?? '',
        bearbeitungId: zust.bearbeitungId ?? '',
      },
      berufstraeger: name(zust.berufstraegerId),
      bearbeitung: name(zust.bearbeitungId),
      appetit: z.appetit ?? '',
      prueflastMonat: z.prueflast
        ? `${MONATE[Number(z.prueflast.monat.slice(5, 7)) - 1]} ${z.prueflast.monat.slice(0, 4)}`
        : '',
      zeitraum: zeitraum(z.zeitraum),
      naechsterTermin: z.naechsterTermin
        ? { ...z.naechsterTermin, datum: datum(z.naechsterTermin.datum) }
        : null,
    };
  });
  const bt = demoPersonen
    .alle()
    .filter((x) => x.art === 'KANZLEI' && x.istBerufstraeger)
    .map((x) => ({ id: x.id, name: x.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { heute: heuteFn(), zeilen, berufstraeger: bt };
}
