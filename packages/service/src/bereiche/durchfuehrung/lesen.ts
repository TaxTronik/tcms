// =============================================================================
// Lader der Kontrolldurchführung (bisher apps/web/src/server/durchfuehrung-
// daten.ts: ladeDurchfuehrungDetail): Kanzlei-Detail (S8), Kontrollaufgabe
// und Aufgabenliste im Portal (P2), Nachweis-Verweis für Downloads.
//
// Rechte (TS-03): Kanzleipersonen nur mit bestätigtem Bezug zum Mandanten
// (`kannLesen`), Mandantenkontakte nur für Aufgaben ihrer Seite, die ihnen
// offenstehen (GV/TCB oder zugewiesen). Fremder Mandant, fremder Tenant,
// unbekannte ID, Objekt eines anderen Mandanten: immer NICHT_GEFUNDEN.
// Ergebnisse sind JSON (ISO-Strings, Listen); Personen nur als IDs, Namen
// über `ctx.personen` (im Dienst leer). Vertrauliche Feststellungen sind für
// Nicht-Beteiligte maskiert (`kannVertraulichLesen`).
// =============================================================================

import {
  DienstFehler,
  DurchfuehrungLesenEingabeSchema,
  KontrollaufgabenEingabeSchema,
  NachweisLesenEingabeSchema,
  type DurchfuehrungDetail,
  type DurchfuehrungLesenEingabe,
  type Kontrollaufgabe,
  type Kontrollaufgaben,
  type KontrollaufgabenEingabe,
  type NachweisErgebnis,
  type NachweisLesenEingabe,
} from '@tcms/contract';
import { addTage, fmtDatum, isoDatum, statusAm, type AnzeigeStatus } from '@tcms/domain';
import { auditGrenze, heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import { VERTRAULICH_MASKE } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import { gleicheId, kannVertraulichLesen } from '../../rechte';
import { ladeLage, pruefeEingabe, pruefeLeserecht, type Lage } from './lage';
import { darfPortalLesen, durchfuehrungsRechte, rechteFlags } from './rechte';
import {
  leseKennzahlen,
  leseSchrittAntworten,
  leseSchrittDefs,
  leseWerte,
  pruefeEinreichung,
} from './werte';

const iso = (d: Date): string => d.toISOString();
const isoN = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const vorStand = (d: Date | null | undefined, ende: Date): Date | null =>
  d && d.getTime() <= ende.getTime() ? d : null;

type Nachweiszeile = Lage['d']['nachweise'][number];

/** Nachweis als Antwort: nur die Felder des Verweises und der Sperre (ADR 0001 §6). */
export function nachweisAntwort(n: Nachweiszeile) {
  return {
    id: n.id,
    dokumentId: n.dokumentId,
    dateiname: n.dateiname,
    mime: n.mime,
    groesse: n.groesse,
    sha256: n.sha256,
    gesperrt: n.gesperrt,
    hochgeladenVon: n.hochgeladenVon,
    hochgeladenAm: iso(n.hochgeladenAm),
  };
}

function verlaufText(
  aktion: string,
  detail: Record<string, unknown>,
  partei: 'KANZLEI' | 'MANDANT',
): string {
  const s = (k: string) => (typeof detail[k] === 'string' ? (detail[k] as string) : '');
  switch (aktion) {
    case 'tcms.durchfuehrung.begonnen':
      return 'Durchführung begonnen';
    case 'tcms.durchfuehrung.gespeichert':
      return typeof detail['erledigt'] === 'number' && typeof detail['gesamt'] === 'number'
        ? `Entwurf gespeichert (${detail['erledigt']} von ${detail['gesamt']} Schritten)`
        : 'Entwurf gespeichert';
    case 'tcms.durchfuehrung.nachweis_hochgeladen':
      return `Nachweis hochgeladen: ${s('dateiname')}`;
    case 'tcms.durchfuehrung.nachweis_entfernt':
      return `Nachweis entfernt: ${s('dateiname')}`;
    case 'tcms.durchfuehrung.eingereicht':
      return partei === 'MANDANT' ? 'an die Kanzlei übermittelt' : 'zur Gegenzeichnung eingereicht';
    case 'tcms.durchfuehrung.mandant_bestaetigt':
      return 'Vollständigkeit bestätigt (zweite Person beim Mandanten)';
    case 'tcms.durchfuehrung.gegengezeichnet':
      return detail['ergebnis'] === 'MIT_BEFUND'
        ? 'gegengezeichnet – abgeschlossen mit Befund'
        : 'gegengezeichnet – abgeschlossen ohne Befund';
    case 'tcms.durchfuehrung.zurueckgewiesen':
      return `zurückgewiesen: ${s('begruendung')}`;
    case 'tcms.durchfuehrung.entfallen_beantragt':
      return `Entfallen beantragt: ${s('begruendung')}`;
    case 'tcms.durchfuehrung.entfallen':
      return 'Entfallen freigegeben';
    case 'tcms.durchfuehrung.entfallen_abgelehnt':
      return s('begruendung')
        ? `Entfallen-Antrag abgelehnt: ${s('begruendung')}`
        : 'Entfallen-Antrag zurückgezogen';
    case 'tcms.durchfuehrung.nachtrag_angelegt':
      return `Nachtrag angelegt: ${s('begruendung')}`;
    case 'tcms.feststellung.erfasst':
      return `Feststellung ${s('nummer')} erfasst`;
    default: {
      const teil = aktion.split('.').pop() ?? aktion;
      return teil.replace(/_/g, ' ');
    }
  }
}

interface Gemeinsam {
  felder: Omit<Kontrollaufgabe, 'kontrolle' | 'namen' | 'rechte'>;
  kontrolle: Kontrollaufgabe['kontrolle'];
  audit: { seq: number; at: Date; actorId: string | null; aktion: string; detail: unknown }[];
  ende: Date;
  personen: Set<string>;
}

/** Felder, die Kanzlei-Detail und Portal-Aufgabe teilen, zum Stichtag. */
async function gemeinsam(
  ctx: DienstKontext,
  lage: Lage,
  stand: Date,
  historisch: boolean,
): Promise<Gemeinsam> {
  const { d, heute } = lage;
  const ks = d.kontrolleStand;
  const ende = tagesende(stand);
  const audit = await ctx.tx.auditEvent.findMany({
    where: {
      OR: [
        { objektTyp: 'Durchfuehrung', objektId: d.id },
        { detail: { path: ['durchfuehrungId'], equals: d.id } },
        { detail: { path: ['nachtragZuId'], equals: d.id } },
      ],
    },
    orderBy: { seq: 'desc' },
    select: { seq: true, at: true, actorId: true, aktion: true, detail: true },
  });
  // Audit-Zeitstempel sind echte Zeit (auditGrenze, kern/zeit.ts).
  const grenze = auditGrenze(stand, heute).getTime();
  const imStand = audit.filter((e) => e.at.getTime() <= grenze);
  const letztes = (aktion: string) => imStand.find((e) => e.aktion === aktion) ?? null;
  const bestaetigt = letztes('tcms.durchfuehrung.mandant_bestaetigt');
  const zurueck = letztes('tcms.durchfuehrung.zurueckgewiesen');

  const defs = leseSchrittDefs(ks.schritte);
  const antworten = leseSchrittAntworten(d.schritte, defs.length);
  const kennzahlen = leseKennzahlen(ks.kennzahlen);
  const werte = leseWerte(d.werte, kennzahlen);
  const toleranzEur = ks.toleranzEur == null ? null : Number(ks.toleranzEur);
  const nachweiseImStand = d.nachweise.filter((n) => n.hochgeladenAm.getTime() <= ende.getTime());
  const original = d.nachtragZuId
    ? await ctx.tx.durchfuehrung.findFirst({
        where: { id: d.nachtragZuId, kontrolleId: d.kontrolleId },
        select: { id: true, periodeLabel: true },
      })
    : null;

  const felder: Gemeinsam['felder'] = {
    id: d.id,
    mandantId: lage.mandantId,
    periodeLabel: d.periodeLabel,
    periodeVon: isoDatum(d.periodeVon),
    periodeBis: isoDatum(d.periodeBis),
    faelligAm: isoDatum(d.faelligAm),
    status: d.status,
    anzeige: statusAm(d, stand),
    ausserplanmaessig: d.ausserplanmaessig,
    schritte: defs.map((s, i) => ({
      titel: s.titel,
      hinweis: s.hinweis,
      erledigt: antworten[i]!.erledigt,
      kommentar: antworten[i]!.kommentar,
    })),
    werte: kennzahlen
      .filter((k) => werte[k.key] !== undefined)
      .map((k) => ({ key: k.key, ...werte[k.key]! })),
    ergebnis: d.ergebnis,
    ergebnisKommentar: d.ergebnisKommentar,
    durchgefuehrtVon: d.durchgefuehrtVon,
    begonnenAm: isoN(historisch ? vorStand(d.begonnenAm, ende) : d.begonnenAm),
    eingereichtAm: isoN(historisch ? vorStand(d.eingereichtAm, ende) : d.eingereichtAm),
    mandantBestaetigtVon: bestaetigt || !historisch ? d.mandantBestaetigtVon : null,
    mandantBestaetigtAm: isoN(bestaetigt?.at),
    gegengezeichnetVon:
      historisch && !vorStand(d.abgeschlossenAm, ende) ? null : d.gegengezeichnetVon,
    abgeschlossenAm: isoN(historisch ? vorStand(d.abgeschlossenAm, ende) : d.abgeschlossenAm),
    zurueckgewiesenVon: d.zurueckgewiesenVon,
    zurueckgewiesenAm: isoN(zurueck?.at),
    zurueckweisungsgrund: d.zurueckweisungsgrund,
    entfallenBegruendung: d.entfallenBegruendung,
    entfallenAm: isoN(historisch ? vorStand(d.entfallenAm, ende) : d.entfallenAm),
    createdAt: iso(d.createdAt),
    vorhandenZumStand: !(d.ausserplanmaessig && d.createdAt.getTime() > ende.getTime()),
    nachweise: nachweiseImStand.map(nachweisAntwort),
    nachweiseAusgeblendet: d.nachweise.length - nachweiseImStand.length,
    original: original ?? null,
    pruefung: pruefeEinreichung({
      schritte: antworten,
      kennzahlen,
      werte,
      toleranzEur,
      nachweise: nachweiseImStand.length,
      mindestNachweise: ks.mindestNachweise,
      ergebnis: d.ergebnis,
      ergebnisKommentar: d.ergebnisKommentar,
    }),
    heute: isoDatum(heute),
    stand: isoDatum(stand),
    historisch,
  };
  const kontrolle: Kontrollaufgabe['kontrolle'] = {
    id: d.kontrolle.id,
    code: d.kontrolle.code,
    standId: ks.id,
    version: ks.version,
    gueltigAb: iso(ks.gueltigAb),
    titel: ks.titel,
    ziel: ks.ziel,
    art: ks.art,
    ausfuehrung: ks.ausfuehrung,
    partei: ks.partei,
    schluessel: ks.schluessel,
    nachweis: ks.nachweis,
    mindestNachweise: ks.mindestNachweise,
    toleranzEur,
    faelligNachTagen: ks.faelligNachTagen,
    durchfuehrendId: ks.durchfuehrendId,
    vertretungId: ks.vertretungId,
    gegenzeichnerId: ks.gegenzeichnerId,
    gegenzeichnungMandant: ks.gegenzeichnungMandant,
    kennzahlen,
  };
  const personen = new Set<string>();
  for (const id of [
    ks.durchfuehrendId,
    ks.vertretungId,
    ks.gegenzeichnerId,
    felder.durchgefuehrtVon,
    felder.mandantBestaetigtVon,
    felder.gegengezeichnetVon,
    felder.zurueckgewiesenVon,
    ...felder.nachweise.map((n) => n.hochgeladenVon),
  ]) {
    if (id) personen.add(id);
  }
  return { felder, kontrolle, audit: imStand, ende, personen };
}

async function namenAufloesen(
  ctx: DienstKontext,
  ids: Set<string>,
): Promise<{ liste: { id: string; name: string }[]; name: (id: string | null) => string | null }> {
  const sortiert = [...ids].sort();
  const karte =
    sortiert.length > 0 ? await ctx.personen.namen(sortiert) : new Map<string, string>();
  const liste = sortiert.filter((id) => karte.has(id)).map((id) => ({ id, name: karte.get(id)! }));
  return { liste, name: (id) => (id ? (karte.get(id) ?? null) : null) };
}

function rechteZumStand(
  lage: Lage,
  historisch: boolean,
  name: (id: string | null) => string | null,
) {
  return rechteFlags(durchfuehrungsRechte({ ...lage.rechteLage, historisch, name }));
}

/**
 * Kontrolldurchführung in der Kanzlei (S8): Detail inkl. Nachweise, Verlauf
 * (Audit), verknüpfter Feststellungen und Risiken, Rechte des Akteurs als
 * Flags. Nur für Kanzleipersonen mit `kannLesen`; sonst NICHT_GEFUNDEN.
 */
export async function ladeDurchfuehrung(
  ctx: DienstKontext,
  eingabe: DurchfuehrungLesenEingabe,
): Promise<DurchfuehrungDetail> {
  const e = pruefeEingabe(DurchfuehrungLesenEingabeSchema, eingabe);
  if (ctx.akteur.art !== 'KANZLEI') throw new DienstFehler('NICHT_GEFUNDEN');
  const lage = await ladeLage(ctx, e, { sperren: false });
  const { d, heute } = lage;
  const { stand, historisch } = leseStand(e.stand, heute);
  const g = await gemeinsam(ctx, lage, stand, historisch);
  const ks = d.kontrolleStand;
  const partei = ks.partei;

  const verlauf: DurchfuehrungDetail['verlauf'] = g.audit.map((x) => ({
    seq: x.seq,
    at: iso(x.at),
    actorId: x.actorId,
    aktion: x.aktion,
    text: verlaufText(
      x.aktion,
      x.detail && typeof x.detail === 'object' ? (x.detail as Record<string, unknown>) : {},
      partei,
    ),
    system: false,
  }));
  // Abgeleitete Zustände (nicht gespeichert, daher „System").
  if (d.periodeBis.getTime() <= g.ende.getTime() && !d.ausserplanmaessig) {
    verlauf.push({
      seq: -1,
      at: iso(d.periodeBis),
      actorId: null,
      aktion: 'system.faellig',
      text: `fällig (Periodenende ${fmtDatum(d.periodeBis)})`,
      system: true,
    });
  }
  if (g.felder.anzeige === 'UEBERFAELLIG') {
    verlauf.push({
      seq: -2,
      at: iso(addTage(d.faelligAm, 1)),
      actorId: null,
      aktion: 'system.ueberfaellig',
      text: `überfällig (Fälligkeit ${fmtDatum(d.faelligAm)} überschritten)`,
      system: true,
    });
  }
  verlauf.sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
  const entfallenFrei = g.audit.find((x) => x.aktion === 'tcms.durchfuehrung.entfallen') ?? null;

  // Nacheinander: eine Transaktion, eine Verbindung.
  const feststellungenRoh = await ctx.tx.feststellung.findMany({
    where: { durchfuehrungId: d.id },
    select: {
      id: true,
      nummer: true,
      titel: true,
      status: true,
      schwere: true,
      erfasstAm: true,
      vertraulich: true,
      erfasstVon: true,
      p153EntschiedenVon: true,
      verwerfenBeantragtVon: true,
      massnahmen: { select: { verantwortlich: true } },
    },
    orderBy: { nummer: 'asc' },
  });
  const risikoLinks = await ctx.tx.risikoKontrolle.findMany({
    where: { kontrolleId: d.kontrolleId },
    include: { risiko: { include: { staende: true } } },
  });
  const letzteRoh = await ctx.tx.durchfuehrung.findMany({
    where: {
      kontrolleId: d.kontrolleId,
      id: { not: d.id },
      periodeVon: { lt: d.periodeVon },
      nachtragZuId: null,
    },
    orderBy: { periodeVon: 'desc' },
    take: 3,
  });
  const nachtraegeRoh = await ctx.tx.durchfuehrung.findMany({
    where: { nachtragZuId: d.id, kontrolleId: d.kontrolleId },
    orderBy: { createdAt: 'asc' },
  });
  const kurz = (x: (typeof letzteRoh)[number]) => ({
    id: x.id,
    periodeLabel: x.periodeLabel,
    anzeige: statusAm(x, stand) as AnzeigeStatus,
  });

  const feststellungen = feststellungenRoh
    .filter((f) => f.erfasstAm.getTime() <= g.ende.getTime())
    .map((f) => {
      const beteiligte = [
        f.erfasstVon,
        f.p153EntschiedenVon,
        f.verwerfenBeantragtVon,
        ...f.massnahmen.map((m) => m.verantwortlich),
      ].filter((x): x is string => !!x);
      const sichtbar =
        !f.vertraulich || kannVertraulichLesen(ctx.akteur, lage.mandantId, beteiligte);
      return {
        id: f.id,
        nummer: f.nummer,
        titel: sichtbar ? f.titel : VERTRAULICH_MASKE.titel,
        status: f.status,
        schwere: f.schwere,
        vertraulich: f.vertraulich,
      };
    });

  const risiken = risikoLinks
    .filter((rk) => rk.risiko.entscheidung === 'UEBERNOMMEN')
    .map((rk) => {
      const st = [...rk.risiko.staende]
        .filter((s) => s.gueltigAb.getTime() <= g.ende.getTime())
        .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
      return { id: rk.risiko.id, code: rk.risiko.code, titel: st?.titel ?? rk.risiko.code };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const personen = g.personen;
  for (const id of [
    ks.designVon,
    d.entfallenVon,
    entfallenFrei?.actorId,
    ...lage.beteiligte,
    ...verlauf.map((v) => v.actorId),
  ]) {
    if (id) personen.add(id);
  }
  const namen = await namenAufloesen(ctx, personen);

  return {
    ...g.felder,
    programmId: lage.programmId,
    kontrolle: {
      ...g.kontrolle,
      design: ks.design,
      designVon: ks.designVon,
      designAm: isoN(ks.designAm),
    },
    anlass: d.anlass,
    entfallenVon: d.entfallenVon,
    entfallenFreigegebenVon: entfallenFrei?.actorId ?? null,
    nachtragZuId: d.nachtragZuId,
    feststellungen,
    risiken,
    letzte: letzteRoh
      .filter((x) => !(x.ausserplanmaessig && x.createdAt.getTime() > g.ende.getTime()))
      .map(kurz),
    nachtraege: nachtraegeRoh.filter((x) => x.createdAt.getTime() <= g.ende.getTime()).map(kurz),
    verlauf,
    beteiligte: lage.beteiligte,
    rechte: rechteZumStand(lage, historisch, namen.name),
    namen: namen.liste,
  };
}

/**
 * Kontrollaufgabe im Portal (P2) für einen Mandantenkontakt: ohne Verlauf,
 * Feststellungen und Risiken. Kanzleipersonen und nicht zugewiesene Kontakte
 * ohne GV/TCB-Rolle: NICHT_GEFUNDEN.
 */
export async function ladeKontrollaufgabe(
  ctx: DienstKontext,
  eingabe: DurchfuehrungLesenEingabe,
): Promise<Kontrollaufgabe> {
  const e = pruefeEingabe(DurchfuehrungLesenEingabeSchema, eingabe);
  if (ctx.akteur.art !== 'MANDANT') throw new DienstFehler('NICHT_GEFUNDEN');
  const lage = await ladeLage(ctx, e, { sperren: false });
  const { stand, historisch } = leseStand(e.stand, lage.heute);
  const g = await gemeinsam(ctx, lage, stand, historisch);
  const namen = await namenAufloesen(ctx, g.personen);
  return {
    ...g.felder,
    kontrolle: g.kontrolle,
    rechte: rechteZumStand(lage, historisch, namen.name),
    namen: namen.liste,
  };
}

const OFFEN_ANZEIGE = new Set<AnzeigeStatus>([
  'FAELLIG',
  'UEBERFAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZURUECKGEWIESEN',
]);

/**
 * Offene Kontrollaufgaben eines Mandantenkontakts (P2): Durchführungen der
 * Partei Mandant, die fällig, in Arbeit, zurückgegeben oder in 30 Tagen
 * fällig sind, und Bestätigungen durch eine zweite Person. Nur Aufgaben, die
 * der Kontakt öffnen darf (GV/TCB alle, sonst zugewiesene).
 */
export async function listeKontrollaufgaben(
  ctx: DienstKontext,
  eingabe: KontrollaufgabenEingabe,
): Promise<Kontrollaufgaben> {
  const { mandantId } = pruefeEingabe(KontrollaufgabenEingabeSchema, eingabe);
  const a = ctx.akteur;
  if (a.art !== 'MANDANT') throw new DienstFehler('NICHT_GEFUNDEN');
  const rollen = await pruefeLeserecht(ctx, mandantId);
  const heute = heuteDatum(ctx.uhr);
  const ende = tagesende(heute);
  const horizont = addTage(heute, 30);
  const zeilen = await ctx.tx.durchfuehrung.findMany({
    where: {
      kontrolle: { programm: { mandantId } },
      kontrolleStand: { partei: 'MANDANT' },
      status: { in: ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN', 'ZUR_GEGENZEICHNUNG'] },
    },
    include: {
      kontrolleStand: true,
      kontrolle: { select: { code: true, aktivAb: true, entfallenAb: true } },
      _count: { select: { nachweise: { where: { entferntAm: null } } } },
    },
    orderBy: [{ faelligAm: 'asc' }, { id: 'asc' }],
  });
  const aufgaben: Kontrollaufgaben['aufgaben'] = [];
  for (const d of zeilen) {
    const k = d.kontrolle;
    if (k.aktivAb.getTime() > ende.getTime()) continue;
    if (k.entfallenAb && k.entfallenAb.getTime() <= ende.getTime()) continue;
    const ks = d.kontrolleStand;
    const zustaendigkeit = {
      partei: ks.partei,
      durchfuehrendId: ks.durchfuehrendId,
      vertretungId: ks.vertretungId,
      gegenzeichnerId: ks.gegenzeichnerId,
    };
    if (!darfPortalLesen(a, mandantId, rollen, zustaendigkeit)) continue;
    const anzeige = statusAm(d, heute);
    const bald =
      anzeige === 'GEPLANT' &&
      d.faelligAm.getTime() <= horizont.getTime() &&
      d.periodeBis.getTime() < horizont.getTime();
    let art: 'DURCHFUEHREN' | 'BESTAETIGEN';
    let eigene: boolean;
    if (OFFEN_ANZEIGE.has(anzeige) || bald) {
      art = 'DURCHFUEHREN';
      eigene = gleicheId(a.id, ks.durchfuehrendId) || gleicheId(a.id, ks.vertretungId);
    } else if (
      anzeige === 'ZUR_GEGENZEICHNUNG' &&
      ks.gegenzeichnungMandant &&
      !d.mandantBestaetigtVon
    ) {
      art = 'BESTAETIGEN';
      eigene =
        (gleicheId(a.id, ks.gegenzeichnerId) || gleicheId(a.id, ks.vertretungId)) &&
        !gleicheId(a.id, d.durchgefuehrtVon);
    } else continue;
    aufgaben.push({
      id: d.id,
      kontrolleCode: k.code,
      titel: ks.titel,
      periodeLabel: d.periodeLabel,
      periodeBis: isoDatum(d.periodeBis),
      faelligAm: isoDatum(d.faelligAm),
      status: d.status,
      anzeige,
      art,
      eigene,
      durchfuehrendId: ks.durchfuehrendId,
      nachweise: d._count.nachweise,
      mindestNachweise: ks.mindestNachweise,
    });
  }
  const prio = (x: (typeof aufgaben)[number]) =>
    x.anzeige === 'UEBERFAELLIG'
      ? 0
      : x.anzeige === 'ZURUECKGEWIESEN'
        ? 1
        : x.art === 'BESTAETIGEN'
          ? 2
          : 3;
  aufgaben.sort((x, y) => prio(x) - prio(y) || x.faelligAm.localeCompare(y.faelligAm));
  return { aufgaben, heute: isoDatum(heute) };
}

/**
 * Verweis eines Nachweises für einen Download (Demo-Route bzw. Pipeline der
 * kanzleikonsole), TS-03: Kanzleipersonen mit `kannLesen`, Mandantenkontakte
 * nur für Aufgaben, die sie öffnen dürfen. Sonst NICHT_GEFUNDEN.
 */
export async function ladeNachweis(
  ctx: DienstKontext,
  eingabe: NachweisLesenEingabe,
): Promise<NachweisErgebnis> {
  const { mandantId, nachweisId } = pruefeEingabe(NachweisLesenEingabeSchema, eingabe);
  const rollen = await pruefeLeserecht(ctx, mandantId);
  const n = await ctx.tx.nachweis.findFirst({
    where: {
      id: nachweisId,
      entferntAm: null,
      durchfuehrung: { kontrolle: { programm: { mandantId } } },
    },
    include: { durchfuehrung: { include: { kontrolleStand: true } } },
  });
  if (!n) throw new DienstFehler('NICHT_GEFUNDEN');
  if (ctx.akteur.art === 'MANDANT') {
    const ks = n.durchfuehrung.kontrolleStand;
    const sichtbar = darfPortalLesen(ctx.akteur, mandantId, rollen, {
      partei: ks.partei,
      durchfuehrendId: ks.durchfuehrendId,
      vertretungId: ks.vertretungId,
      gegenzeichnerId: ks.gegenzeichnerId,
    });
    if (!sichtbar) throw new DienstFehler('NICHT_GEFUNDEN');
  }
  return { durchfuehrungId: n.durchfuehrungId, nachweis: nachweisAntwort(n) };
}
