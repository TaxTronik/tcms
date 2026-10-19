import 'server-only';
import { DienstFehler } from '@tcms/contract';
import { fmtMonatJahr, istEuAusland, LAND_NAME } from '@tcms/domain';
import { imDienst, ladeLaender } from '@tcms/service';
import { DEMO_PORTS } from './demo';
import type { EreignisView, KontrolleView, LandView, RisikoView, TcmsKontext } from './kontext';
import { demoAkteur } from './sitzung';

// =============================================================================
// Länder-Monitor (Fachkonzept S12, §4 P2/P3/P9/P10, §5 EC-UST-01…-06, EC-ERT):
// Historie der Länderstände und Bezug zu Feststellungen kommen aus dem
// Service-Lader (`ladeLaender`, nur nicht vertrauliche Feststellungen); die
// Zuordnung zu Ereignissen, Risiken und Kontrollen ist deterministisch aus den
// Merkmalen des Landes und dem Tax-CMS-Kontext.
// =============================================================================

export { registrierungVon } from '@tcms/service';

export type Registrierung = 'VOLLSTAENDIG' | 'FEHLT' | 'PRUEFEN';

export interface LandStandRoh {
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
  createdAt: Date;
  registrierung: Registrierung;
}

export interface LandFeststellung {
  id: string;
  nummer: string;
  titel: string;
  status: string;
  p153Offen: boolean;
}

export interface LaenderDetail {
  historie: Map<string, LandStandRoh[]>;
  feststellungen: Map<string, LandFeststellung[]>;
}

const tag = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

/**
 * Alle Länderstände bis zum Stichtag (neueste zuerst) und nicht vertrauliche
 * Feststellungen mit Länderbezug, über den Service-Lader im Dienstkontext der
 * angemeldeten Person. Ohne Zugriff: leer.
 */
export async function ladeLaenderDetail(
  mandantId: string,
  standIso: string,
): Promise<LaenderDetail> {
  const leer: LaenderDetail = { historie: new Map(), feststellungen: new Map() };
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return leer;
  try {
    const l = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeLaender(ctx, { mandantId, stand: standIso }),
    );
    return {
      historie: new Map(
        l.historie.map((h) => [
          h.land,
          h.staende.map((s) => ({
            ...s,
            steuersaetzeGeprueftAm: s.steuersaetzeGeprueftAm ? tag(s.steuersaetzeGeprueftAm) : null,
            stand: tag(s.stand),
            createdAt: tag(s.createdAt),
          })),
        ]),
      ),
      feststellungen: new Map(l.feststellungen.map((f) => [f.land, f.eintraege])),
    };
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return leer;
    throw e;
  }
}

/** Ereignisse, die ein Land im Titel oder in der Beschreibung nennen. */
export function ereignisseZumLand(ereignisse: EreignisView[], land: string): EreignisView[] {
  const name = LAND_NAME[land];
  const re = new RegExp(`\\b${land.replace(/[^A-Z]/g, '')}\\b`);
  return ereignisse.filter(
    (e) =>
      re.test(e.titel) ||
      re.test(e.beschreibung) ||
      (!!name && (e.titel.includes(name) || e.beschreibung.includes(name))),
  );
}

export interface LandRisiko {
  risiko: RisikoView;
  grund: string;
}

/** Länderbezogene Risiken mit Grund (deterministisch aus den Merkmalen des Landes). */
export function risikenZumLand(ctx: TcmsKontext, l: LandView): LandRisiko[] {
  const name = LAND_NAME[l.land] ?? l.land;
  const lager = l.lagerSeit ? `Lager in ${l.land} seit ${fmtMonatJahr(l.lagerSeit)}` : null;
  const kandidaten: [string, string | null][] = [
    ['EC-UST-01', istEuAusland(l.land) ? `EU-Fernverkäufe nach ${name}` : null],
    ['EC-UST-02', `Steuersätze in ${name}`],
    ['EC-UST-03', l.oss ? `Umsätze in ${l.land} über OSS` : null],
    ['EC-UST-04', lager && l.oss ? `${lager}: Abgrenzung OSS / Lagerland` : null],
    ['EC-UST-05', lager],
    ['EC-UST-06', l.zmRelevant ? `ZM-relevante Bewegungen mit ${l.land}` : null],
    ['EC-ERT-01', lager ? `Bestände im Lager ${l.land}` : null],
    [
      'EC-ERT-03',
      lager
        ? `Betriebsstätte durch das Lager in ${l.land} seit ${fmtMonatJahr(l.lagerSeit)}`
        : null,
    ],
  ];
  const je = new Map(ctx.risiken.map((r) => [r.code, r]));
  return kandidaten.flatMap(([code, grund]) => {
    const r = je.get(code);
    return grund && r ? [{ risiko: r, grund }] : [];
  });
}

/** Kontrollen, die an den länderbezogenen Risiken hängen. */
export function kontrollenZumLand(ctx: TcmsKontext, risiken: LandRisiko[]): KontrolleView[] {
  const ids = new Set(risiken.map((r) => r.risiko.id));
  return ctx.kontrollen.filter((k) => k.risikoIds.some((id) => ids.has(id)));
}
