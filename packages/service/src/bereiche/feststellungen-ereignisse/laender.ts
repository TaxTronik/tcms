// =============================================================================
// Länder-Monitor (Fachkonzept S12): Länderstände lesen und manuell erfassen.
// Jede Erfassung legt einen neuen LandStand an; frühere Stände bleiben
// unverändert (AGENTS.md Regel 3). Ein neues Lagerland (T-02) und ein
// Schwellenwechsel der EU-Fernverkäufe (T-04) lösen Ereignisse aus.
// Schreibende Operationen sperren das Programm (TS-05: keine doppelte
// Aufnahme eines Landes, keine Stände auf veralteter Grundlage).
// =============================================================================

import {
  DienstFehler,
  LaenderLesenSchema,
  LandHinzufuegenSchema,
  LandStaendeSchema,
  type LaenderLesen,
  type Laender,
  type LandEingabe,
  type LandHinzufuegenEingabe,
  type LandStaendeEingabe,
  type LandStaendeErgebnis,
  type LandStand,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  bewerteSchwelle,
  EU_LAENDER,
  fmtEurGanz,
  fmtMonatJahr,
  istEuAusland,
  LAND_NAME,
  type FeststellungStatus,
} from '@tcms/domain';
import type { Protokoll } from '../../audit';
import { heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten } from '../../rechte';
import { legeEreignisAn } from './ereignisse';
import {
  alsTag,
  isoTag,
  isoTagOderNull,
  isoZeit,
  KEIN_RECHT,
  namenListe,
  programmVon,
  pruefe,
  pruefeKanzleiZugriff,
  pruefeMandant,
  sperreProgramm,
  aendere,
} from './gemeinsam';

type Registrierung = LandStand['registrierung'];

/** Lager ohne lokale USt-Nr. → fehlt; ohne Satzprüfung → prüfen (wie im Tax-CMS-Kontext). */
export function registrierungVon(l: {
  lagerSeit: string | null;
  lokaleUstNr: boolean;
  steuersaetzeGeprueftAm: Date | null;
}): Registrierung {
  if (l.lagerSeit && !l.lokaleUstNr) return 'FEHLT';
  if (!l.steuersaetzeGeprueftAm) return 'PRUEFEN';
  return 'VOLLSTAENDIG';
}

function datumDe(d: Date): string {
  return isoTag(d).split('-').reverse().join('.');
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * Alle Länderstände bis zum Stichtag (je Land neueste zuerst) und nicht
 * vertrauliche Feststellungen mit Länderbezug (Erklärungen oder Ländercode im
 * Titel). Vertrauliche Feststellungen erscheinen hier nie.
 */
export async function ladeLaender(ctx: DienstKontext, eingabe: LaenderLesen): Promise<Laender> {
  const x = pruefe(LaenderLesenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  await pruefeMandant(ctx.tx, mandantId);
  const heute = heuteDatum(ctx.uhr);
  const { stand, historisch } = leseStand(x.stand, heute);
  const ende = tagesende(stand);
  const kopf = { stand: isoTag(stand), historisch };
  const programm = await programmVon(ctx.tx, mandantId);
  if (!programm) return { ...kopf, programmId: null, historie: [], feststellungen: [], namen: [] };

  const [staende, feststellungen] = await Promise.all([
    ctx.tx.landStand.findMany({
      where: { programmId: programm.id },
      orderBy: [{ stand: 'desc' }, { createdAt: 'desc' }],
    }),
    ctx.tx.feststellung.findMany({
      where: { programmId: programm.id, vertraulich: false },
      include: { erklaerungen: { select: { land: true } } },
      orderBy: { nummer: 'desc' },
    }),
  ]);
  const historie = new Map<string, LandStand[]>();
  for (const s of staende) {
    if (s.stand.getTime() > ende.getTime() || s.createdAt.getTime() > ende.getTime()) continue;
    historie.set(s.land, [
      ...(historie.get(s.land) ?? []),
      {
        id: s.id,
        land: s.land,
        fernverkaeufeLfdEur: Number(s.fernverkaeufeLfdEur),
        fernverkaeufeVorjahrEur: Number(s.fernverkaeufeVorjahrEur),
        lagerSeit: s.lagerSeit,
        oss: s.oss,
        lokaleUstNr: s.lokaleUstNr,
        zmRelevant: s.zmRelevant,
        steuersaetzeGeprueftAm: isoTagOderNull(s.steuersaetzeGeprueftAm),
        stand: isoTag(s.stand),
        quelle: s.quelle,
        erfasstVon: s.erfasstVon,
        createdAt: isoZeit(s.createdAt),
        registrierung: registrierungVon(s),
      },
    ]);
  }
  const fJe = new Map<string, Laender['feststellungen'][number]['eintraege']>();
  for (const f of feststellungen) {
    if (f.erfasstAm.getTime() > ende.getTime() || f.status === 'VERWORFEN') continue;
    const entschieden =
      f.p153EntschiedenAm != null && f.p153EntschiedenAm.getTime() <= ende.getTime();
    const status: FeststellungStatus =
      f.status === 'GESCHLOSSEN' && f.geschlossenAm && f.geschlossenAm.getTime() > ende.getTime()
        ? 'NACHKONTROLLE'
        : f.status;
    const laender = new Set(f.erklaerungen.map((e) => e.land).filter((l) => l && l !== 'DE'));
    for (const code of historie.keys()) {
      if (/^[A-Z]{2}$/.test(code) && new RegExp(`\\b${code}\\b`).test(f.titel)) laender.add(code);
    }
    for (const code of laender) {
      fJe.set(code, [
        ...(fJe.get(code) ?? []),
        {
          id: f.id,
          nummer: f.nummer,
          titel: f.titel,
          status,
          p153Offen: (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') && !entschieden,
        },
      ]);
    }
  }
  return {
    ...kopf,
    programmId: programm.id,
    historie: [...historie].map(([land, liste]) => ({ land, staende: liste })),
    feststellungen: [...fJe].map(([land, eintraege]) => ({ land, eintraege })),
    namen: await namenListe(
      ctx,
      [...historie.values()].flat().map((s) => s.erfasstVon),
    ),
  };
}

// ---------------------------------------------------------------------------
// Erfassen
// ---------------------------------------------------------------------------

function ungueltig(text: string, feld = 'laender'): never {
  throw new DienstFehler('UNGUELTIG', text, { [feld]: [text] });
}

/** Fachliche Prüfung einer Landeseingabe gegen den Datenstand (vor der Transaktion). */
function pruefeLand(l: LandEingabe, datenstand: Date): void {
  if (l.lagerSeit && l.lagerSeit > isoTag(datenstand).slice(0, 7)) {
    ungueltig(`${l.land}: „Lager seit“ liegt nach dem Stand.`);
  }
  if (
    l.steuersaetzeGeprueftAm &&
    alsTag(l.steuersaetzeGeprueftAm).getTime() > datenstand.getTime()
  ) {
    ungueltig(`${l.land}: Die Prüfung der Steuersätze liegt nach dem Stand.`);
  }
}

function betrag(n: number): number {
  return Math.round(n * 100) / 100;
}

type StandZeile = Awaited<ReturnType<Tx['landStand']['findMany']>>[number];

function juengsteJeLand(staende: StandZeile[]): Map<string, StandZeile> {
  const m = new Map<string, StandZeile>();
  for (const s of staende) {
    const b = m.get(s.land);
    if (
      !b ||
      s.stand > b.stand ||
      (s.stand.getTime() === b.stand.getTime() && s.createdAt > b.createdAt)
    )
      m.set(s.land, s);
  }
  return m;
}

function summen(
  m: Map<string, { land: string; fernverkaeufeLfdEur: unknown; fernverkaeufeVorjahrEur: unknown }>,
) {
  let lfd = 0;
  let vj = 0;
  for (const s of m.values()) {
    if (!istEuAusland(s.land)) continue;
    lfd += Number(s.fernverkaeufeLfdEur);
    vj += Number(s.fernverkaeufeVorjahrEur);
  }
  return { lfd, vj };
}

/**
 * Legt die neuen Stände an (Prüfung gegen den jüngsten Stand je Land) und
 * erzeugt die ausgelösten Ereignisse. Läuft unter der Sperre des Programms.
 */
async function schreibeStaende(
  ctx: DienstKontext,
  zeitpunkt: Date,
  programmId: string,
  datenstand: Date,
  eingaben: LandEingabe[],
  modus: 'neu' | 'aktualisieren',
): Promise<{ wert: LandStaendeErgebnis; protokoll: Protokoll[] }> {
  const tx = ctx.tx;
  const alle = await tx.landStand.findMany({ where: { programmId } });
  const vorher = juengsteJeLand(alle);
  const nachher = new Map<
    string,
    { land: string; fernverkaeufeLfdEur: unknown; fernverkaeufeVorjahrEur: unknown }
  >(vorher);
  const protokoll: Protokoll[] = [];
  const staende: LandStaendeErgebnis['staende'] = [];
  const ausgeloest: { typ: string; titel: string; beschreibung: string; datum: Date }[] = [];

  for (const e of eingaben) {
    const alt = vorher.get(e.land);
    if (modus === 'neu' && alt)
      throw new DienstFehler('KONFLIKT', `${e.land} ist bereits im Länder-Monitor.`);
    if (modus === 'aktualisieren' && !alt) {
      throw new DienstFehler('KONFLIKT', `${e.land} ist nicht im Länder-Monitor.`);
    }
    if (alt && datenstand.getTime() < alt.stand.getTime()) {
      ungueltig(
        `${e.land}: Es gibt bereits einen Stand zum ${datumDe(alt.stand)}. Neue Stände dürfen nicht davor liegen.`,
        'datenstand',
      );
    }
    const lfd = betrag(e.fernverkaeufeLfdEur);
    const vj = betrag(e.fernverkaeufeVorjahrEur);
    const geprueft = e.steuersaetzeGeprueftAm ? alsTag(e.steuersaetzeGeprueftAm) : null;
    const neu = await tx.landStand.create({
      data: {
        programmId,
        land: e.land,
        fernverkaeufeLfdEur: lfd,
        fernverkaeufeVorjahrEur: vj,
        lagerSeit: e.lagerSeit,
        oss: e.oss,
        lokaleUstNr: e.lokaleUstNr,
        zmRelevant: e.zmRelevant,
        steuersaetzeGeprueftAm: geprueft,
        stand: datenstand,
        quelle: 'MANUELL',
        erfasstVon: ctx.akteur.id,
        createdAt: zeitpunkt,
      },
      select: { id: true },
    });
    staende.push({ id: neu.id, land: e.land });
    nachher.set(e.land, { land: e.land, fernverkaeufeLfdEur: lfd, fernverkaeufeVorjahrEur: vj });
    const vergleich = alt
      ? {
          fernverkaeufeLfdEur: [Number(alt.fernverkaeufeLfdEur), lfd],
          fernverkaeufeVorjahrEur: [Number(alt.fernverkaeufeVorjahrEur), vj],
          lagerSeit: [alt.lagerSeit, e.lagerSeit],
          oss: [alt.oss, e.oss],
          lokaleUstNr: [alt.lokaleUstNr, e.lokaleUstNr],
          zmRelevant: [alt.zmRelevant, e.zmRelevant],
          steuersaetzeGeprueftAm: [
            alt.steuersaetzeGeprueftAm ? isoTag(alt.steuersaetzeGeprueftAm) : null,
            e.steuersaetzeGeprueftAm,
          ],
        }
      : null;
    const geaendert = vergleich
      ? Object.fromEntries(Object.entries(vergleich).filter(([, [a, b]]) => a !== b))
      : null;
    protokoll.push({
      aktion: modus === 'neu' ? 'tcms.laender.land_hinzugefuegt' : 'tcms.laender.stand_erfasst',
      objektTyp: 'LandStand',
      objektId: neu.id,
      programmId,
      detail: {
        land: e.land,
        stand: isoTag(datenstand),
        vorherigerStand: alt ? alt.id : null,
        geaendert,
        quelle: 'manuell',
      },
    });
    if (e.lagerSeit && (!alt || !alt.lagerSeit) && e.land !== 'DE') {
      const name = LAND_NAME[e.land] ?? e.land;
      ausgeloest.push({
        typ: 'T-02',
        titel: `Neues Lagerland ${e.land} seit ${fmtMonatJahr(e.lagerSeit)} (Länder-Monitor)`,
        beschreibung: `Im Länder-Monitor wurde für ${name} erstmals ein Lager erfasst (seit ${fmtMonatJahr(e.lagerSeit)}, Stand ${datumDe(datenstand)}). Lokale USt-Registrierung: ${e.lokaleUstNr ? 'erfasst' : 'nicht erfasst'}.`,
        datum: new Date(`${e.lagerSeit}-01T00:00:00Z`),
      });
    }
  }

  // Schwellenwechsel der EU-Fernverkäufe (K-EC-01): Warnstufe oder Überschreitung neu erreicht.
  const a = summen(vorher);
  const b = summen(nachher);
  const sa = bewerteSchwelle(a.lfd, a.vj).status;
  const sb = bewerteSchwelle(b.lfd, b.vj).status;
  if (sa !== sb && (sb === 'UEBERSCHRITTEN' || (sb === 'WARNUNG' && sa === 'UNTERSCHRITTEN'))) {
    const pct = Math.round((b.lfd / 10_000) * 100);
    ausgeloest.push({
      typ: 'T-04',
      titel:
        sb === 'UEBERSCHRITTEN'
          ? `Lieferschwelle überschritten (${fmtEurGanz(b.lfd)} von 10.000 €)`
          : `Lieferschwelle ${pct} % erreicht (${fmtEurGanz(b.lfd)} von 10.000 €)`,
      beschreibung: `Die im Länder-Monitor erfassten kumulierten EU-Fernverkäufe liegen bei ${fmtEurGanz(b.lfd)} (Vorjahr ${fmtEurGanz(b.vj)}).`,
      datum: datenstand,
    });
  }

  const nummern: string[] = [];
  for (const ev of ausgeloest) {
    const neu = await legeEreignisAn(tx, {
      programmId,
      typ: ev.typ,
      titel: ev.titel,
      beschreibung: ev.beschreibung,
      quelle: 'MANUELL',
      gemeldetVon: ctx.akteur.id,
      ereignisDatum: ev.datum,
      zeitpunkt,
    });
    nummern.push(neu.nummer);
    protokoll.push({
      aktion: 'tcms.ereignis.gemeldet',
      objektTyp: 'Ereignis',
      objektId: neu.id,
      programmId,
      detail: { nummer: neu.nummer, typ: ev.typ, quelle: 'Länder-Monitor' },
    });
  }
  return { wert: { staende, ereignisse: nummern }, protokoll };
}

function vorpruefung(ctx: DienstKontext, mandantId: string, datenstandIso: string): Date {
  pruefeKanzleiZugriff(ctx, mandantId);
  const datenstand = alsTag(datenstandIso);
  if (datenstand.getTime() > heuteDatum(ctx.uhr).getTime()) {
    ungueltig('Der Stand darf nicht in der Zukunft liegen.', 'datenstand');
  }
  return datenstand;
}

/** In der Transaktion: Mandant sichtbar, Bearbeitungsrecht, Programm gesperrt (TS-05). */
async function sperreZumErfassen(ctx: DienstKontext, mandantId: string): Promise<string> {
  await pruefeMandant(ctx.tx, mandantId);
  if (!kannBearbeiten(ctx.akteur, mandantId))
    throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
  return sperreProgramm(ctx.tx, mandantId);
}

/** Neue Stände für Länder, die im Monitor sind (Einzel- und Sammelerfassung). */
export async function speichereLandStaende(
  ctx: DienstKontext,
  eingabe: LandStaendeEingabe,
): Promise<LandStaendeErgebnis> {
  const x = pruefe(LandStaendeSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  const datenstand = vorpruefung(ctx, mandantId, x.datenstand);
  for (const l of x.laender) pruefeLand(l, datenstand);
  return aendere(ctx, async (_tx, zeitpunkt) => {
    const programmId = await sperreZumErfassen(ctx, mandantId);
    return schreibeStaende(ctx, zeitpunkt, programmId, datenstand, x.laender, 'aktualisieren');
  });
}

/** Nimmt ein EU-Land (außer Deutschland) mit erstem Stand in den Monitor auf. */
export async function fuegeLandHinzu(
  ctx: DienstKontext,
  eingabe: LandHinzufuegenEingabe,
): Promise<LandStaendeErgebnis> {
  const x = pruefe(LandHinzufuegenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  const datenstand = vorpruefung(ctx, mandantId, x.datenstand);
  if (!EU_LAENDER.includes(x.land.land) || x.land.land === 'DE') {
    ungueltig('Bitte ein EU-Land außer Deutschland wählen.', 'land');
  }
  pruefeLand(x.land, datenstand);
  return aendere(ctx, async (_tx, zeitpunkt) => {
    const programmId = await sperreZumErfassen(ctx, mandantId);
    return schreibeStaende(ctx, zeitpunkt, programmId, datenstand, [x.land], 'neu');
  });
}
