import 'server-only';
import { fmtMonatJahr, istEuAusland, LAND_NAME } from '@tcms/domain';
import { db } from './demo';
import type { EreignisView, KontrolleView, LandView, RisikoView, TcmsKontext } from './kontext';

// =============================================================================
// Länder-Monitor (Fachkonzept S12, §4 P2/P3/P9/P10, §5 EC-UST-01…-06, EC-ERT):
// Historie der Länderstände, Bezug zu Feststellungen, Ereignissen, Risiken und
// Kontrollen. Die Zuordnung ist deterministisch aus den Merkmalen des Landes.
// =============================================================================

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

/** Gleiche Regel wie im Kontext: Lager ohne lokale USt-Nr. → fehlt; ohne Satzprüfung → prüfen. */
export function registrierungVon(l: {
  lagerSeit: string | null;
  lokaleUstNr: boolean;
  steuersaetzeGeprueftAm: Date | null;
}): Registrierung {
  if (l.lagerSeit && !l.lokaleUstNr) return 'FEHLT';
  if (!l.steuersaetzeGeprueftAm) return 'PRUEFEN';
  return 'VOLLSTAENDIG';
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

/** Alle Länderstände bis zum Stichtag (neueste zuerst) und Feststellungen mit Länderbezug. */
export async function ladeLaenderDetail(ctx: TcmsKontext, ende: Date): Promise<LaenderDetail> {
  const programmId = ctx.programm!.id;
  const [staende, feststellungen] = await Promise.all([
    db.landStand.findMany({
      where: { programmId },
      orderBy: [{ stand: 'desc' }, { createdAt: 'desc' }],
    }),
    db.feststellung.findMany({
      where: { programmId, vertraulich: false },
      include: { erklaerungen: { select: { land: true } } },
    }),
  ]);
  const historie = new Map<string, LandStandRoh[]>();
  for (const s of staende) {
    if (s.stand.getTime() > ende.getTime() || s.createdAt.getTime() > ende.getTime()) continue;
    const roh: LandStandRoh = {
      id: s.id,
      land: s.land,
      fernverkaeufeLfdEur: Number(s.fernverkaeufeLfdEur),
      fernverkaeufeVorjahrEur: Number(s.fernverkaeufeVorjahrEur),
      lagerSeit: s.lagerSeit,
      oss: s.oss,
      lokaleUstNr: s.lokaleUstNr,
      zmRelevant: s.zmRelevant,
      steuersaetzeGeprueftAm: s.steuersaetzeGeprueftAm,
      stand: s.stand,
      quelle: s.quelle,
      erfasstVon: s.erfasstVon,
      createdAt: s.createdAt,
      registrierung: registrierungVon(s),
    };
    historie.set(s.land, [...(historie.get(s.land) ?? []), roh]);
  }
  const fJe = new Map<string, LandFeststellung[]>();
  const sichtbar = new Map(ctx.feststellungen.map((f) => [f.id, f]));
  for (const f of feststellungen) {
    const v = sichtbar.get(f.id);
    if (!v || v.status === 'VERWORFEN') continue;
    const laender = new Set(f.erklaerungen.map((e) => e.land).filter((x) => x && x !== 'DE'));
    for (const code of historie.keys())
      if (new RegExp(`\\b${code}\\b`).test(f.titel)) laender.add(code);
    for (const code of laender) {
      fJe.set(code, [
        ...(fJe.get(code) ?? []),
        { id: f.id, nummer: f.nummer, titel: f.titel, status: v.status, p153Offen: v.p153Offen },
      ]);
    }
  }
  return { historie, feststellungen: fJe };
}

/** Ereignisse, die ein Land im Titel oder in der Beschreibung nennen. */
export function ereignisseZumLand(ereignisse: EreignisView[], land: string): EreignisView[] {
  const name = LAND_NAME[land];
  const re = new RegExp(`\\b${land}\\b`);
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
