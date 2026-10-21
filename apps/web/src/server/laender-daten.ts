import 'server-only';
import { DienstFehler, type Laender } from '@tcms/contract';
import { imDienst, ladeLaender } from '@tcms/service';
import { DEMO_PORTS } from './demo';
import type { EreignisView, KontrolleView, RisikoView, TcmsKontext } from './kontext';
import { demoAkteur } from './sitzung';

// =============================================================================
// Länder-Monitor (Fachkonzept S12, §4 P2/P3/P9/P10, §5 EC-UST-01…-06, EC-ERT):
// Historie der Länderstände, Bezug zu Feststellungen (vertrauliche nur für die
// Kanzleileitung, tcms-s12) und die Bezüge zu Risiken, Kontrollen und
// Ereignissen kommen aus dem Service-Lader (`ladeLaender`, Regeln im Service);
// die Demo ordnet die Codes und IDs nur den Objekten des Tax-CMS-Kontexts zu.
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

export type LandBezug = Laender['bezuege'][number];

export interface LaenderDetail {
  historie: Map<string, LandStandRoh[]>;
  feststellungen: Map<string, LandFeststellung[]>;
  bezuege: Map<string, LandBezug>;
}

const tag = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

/**
 * Alle Länderstände bis zum Stichtag (neueste zuerst) und Feststellungen mit
 * Länderbezug (vertrauliche nur für die Kanzleileitung), über den Service-Lader
 * im Dienstkontext der angemeldeten Person. Ohne Zugriff: leer.
 */
export async function ladeLaenderDetail(
  mandantId: string,
  standIso: string,
): Promise<LaenderDetail> {
  const leer: LaenderDetail = {
    historie: new Map(),
    feststellungen: new Map(),
    bezuege: new Map(),
  };
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
      bezuege: new Map(l.bezuege.map((b) => [b.land, b])),
    };
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return leer;
    throw e;
  }
}

/** Ereignisse, die das Land nennen (IDs aus dem Service, Objekte aus dem Kontext). */
export function ereignisseZumLand(
  ctx: TcmsKontext,
  detail: LaenderDetail,
  land: string,
): EreignisView[] {
  const ids = new Set(detail.bezuege.get(land)?.ereignisse ?? []);
  return ctx.ereignisse.filter((e) => ids.has(e.id));
}

export interface LandRisiko {
  risiko: RisikoView;
  grund: string;
}

/** Länderbezogene Risiken mit Grund (Regeln im Service). */
export function risikenZumLand(
  ctx: TcmsKontext,
  detail: LaenderDetail,
  land: string,
): LandRisiko[] {
  const je = new Map(ctx.risiken.map((r) => [r.code, r]));
  return (detail.bezuege.get(land)?.risiken ?? []).flatMap(({ code, grund }) => {
    const r = je.get(code);
    return r ? [{ risiko: r, grund }] : [];
  });
}

/** Kontrollen an den länderbezogenen Risiken (Codes aus dem Service). */
export function kontrollenZumLand(
  ctx: TcmsKontext,
  detail: LaenderDetail,
  land: string,
): KontrolleView[] {
  const codes = new Set(detail.bezuege.get(land)?.kontrollen ?? []);
  return ctx.kontrollen.filter((k) => codes.has(k.code));
}
