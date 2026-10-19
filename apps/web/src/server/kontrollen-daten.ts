import 'server-only';
import { prisma, type Prisma, type Tx } from '@tcms/db';
import {
  addTage,
  brutto,
  leiteFrequenzAb,
  perioden,
  type FrequenzAbleitung,
  type Frequenz,
  type GovernanceTyp,
  type Klasse,
  type Turnus,
} from '@tcms/domain';
import type { TcmsKontext } from './kontext';
import { jetzt, tagesende } from './zeit';

// =============================================================================
// Zusatzdaten und Planungshelfer für die Kontrollmatrix (S6):
// Stand-Historie, Audit-Spur, Feststellungen je Durchführung sowie die
// Neuplanung künftiger Durchführungen bei Frequenzänderung (Fachkonzept §6:
// „Ändern sich GT oder Bruttoklasse, werden künftige Durchführungen neu
// geplant; abgeschlossene bleiben unverändert").
// =============================================================================

type KontrolleStandRoh = Prisma.KontrolleStandGetPayload<object>;

export interface KontrolleStandView {
  id: string;
  version: number;
  gueltigAb: Date;
  gueltigBis: Date | null;
  erstelltVon: string | null;
  design: 'ANGEMESSEN' | 'NICHT_BEURTEILT' | 'MANGEL';
  designVon: string | null;
  designAm: Date | null;
  designBegruendung: string | null;
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  abweichung: {
    turnus: Turnus;
    anlass: boolean;
    begruendung: string | null;
    freigegebenVon: string | null;
  } | null;
  /** Kurzbeschreibung der Änderung gegenüber dem Vorgängerstand. */
  aenderungen: string[];
}

export interface AuditZeile {
  seq: number;
  at: Date;
  actorName: string;
  aktion: string;
  detail: Record<string, unknown>;
}

export interface KontrolleDetail {
  staende: KontrolleStandView[];
  audit: AuditZeile[];
  /** Antragsteller:in der (offenen oder freigegebenen) Frequenzabweichung. */
  abweichungBeantragtVon: string | null;
  abweichungBeantragtAm: Date | null;
}

function abw(s: KontrolleStandRoh): KontrolleStandView['abweichung'] {
  return s.abweichungTurnus != null
    ? {
        turnus: s.abweichungTurnus,
        anlass: s.abweichungAnlass ?? false,
        begruendung: s.abweichungBegruendung,
        freigegebenVon: s.abweichungFreigegebenVon,
      }
    : null;
}

function gleicheAbweichung(a: KontrolleStandRoh, b: KontrolleStandRoh): boolean {
  return (
    a.abweichungTurnus === b.abweichungTurnus &&
    (a.abweichungAnlass ?? false) === (b.abweichungAnlass ?? false) &&
    a.abweichungBegruendung === b.abweichungBegruendung &&
    a.abweichungFreigegebenVon === b.abweichungFreigegebenVon
  );
}

/** true, wenn der Stand eine beantragte, noch nicht freigegebene Abweichung trägt. */
export function abweichungOffen(
  s: Pick<KontrolleStandRoh, 'abweichungTurnus' | 'abweichungFreigegebenVon'>,
): boolean {
  return s.abweichungTurnus != null && !s.abweichungFreigegebenVon;
}

/**
 * Ermittelt, wer die offene Abweichung beantragt hat: der früheste Stand der
 * ununterbrochenen Folge mit derselben offenen Abweichung (spätere Stände
 * können durch Design- oder Personenänderungen entstanden sein).
 */
export function antragDerAbweichung(staendeAufsteigend: KontrolleStandRoh[]): {
  von: string | null;
  am: Date | null;
  vorAntrag: KontrolleStandRoh | null;
} {
  const letzter = staendeAufsteigend[staendeAufsteigend.length - 1];
  if (!letzter || !abweichungOffen(letzter)) return { von: null, am: null, vorAntrag: null };
  let i = staendeAufsteigend.length - 1;
  while (i > 0 && gleicheAbweichung(staendeAufsteigend[i - 1]!, letzter)) i--;
  return {
    von: staendeAufsteigend[i]!.erstelltVon,
    am: staendeAufsteigend[i]!.gueltigAb,
    vorAntrag: staendeAufsteigend[i - 1] ?? null,
  };
}

function aenderungenGegen(vorher: KontrolleStandRoh | undefined, s: KontrolleStandRoh): string[] {
  if (!vorher) return ['Kontrolle angelegt'];
  const out: string[] = [];
  if (vorher.design !== s.design || vorher.designAm?.getTime() !== s.designAm?.getTime())
    out.push('Designbeurteilung');
  if (
    vorher.durchfuehrendId !== s.durchfuehrendId ||
    vorher.vertretungId !== s.vertretungId ||
    vorher.gegenzeichnerId !== s.gegenzeichnerId ||
    vorher.gegenzeichnungMandant !== s.gegenzeichnungMandant
  )
    out.push('Zuständigkeiten');
  if (!gleicheAbweichung(vorher, s)) {
    if (s.abweichungTurnus == null)
      out.push(
        vorher.abweichungFreigegebenVon
          ? 'Frequenzabweichung aufgehoben'
          : 'Frequenzabweichung abgelehnt',
      );
    else if (!s.abweichungFreigegebenVon) out.push('Frequenzabweichung beantragt');
    else out.push('Frequenzabweichung freigegeben');
  }
  if (
    vorher.titel !== s.titel ||
    vorher.ziel !== s.ziel ||
    JSON.stringify(vorher.schritte) !== JSON.stringify(s.schritte)
  )
    out.push('Beschreibung');
  return out.length ? out : ['Stand fortgeschrieben'];
}

/** Stand-Historie, Antrag einer offenen Abweichung und Audit-Spur einer Kontrolle zum Stichtag. */
export async function ladeKontrolleDetail(
  kontrolleId: string,
  stand: Date,
): Promise<KontrolleDetail | null> {
  const ende = tagesende(stand);
  const k = await prisma.kontrolle.findUnique({
    where: { id: kontrolleId },
    include: { staende: { where: { gueltigAb: { lte: ende } }, orderBy: { version: 'asc' } } },
  });
  if (!k) return null;
  const audit = await prisma.auditEvent.findMany({
    where: { objektTyp: 'Kontrolle', objektId: k.id, at: { lte: ende } },
    orderBy: { seq: 'desc' },
    take: 40,
  });
  let antrag = antragDerAbweichung(k.staende);
  const letzter = k.staende[k.staende.length - 1];
  if (!antrag.von && letzter?.abweichungTurnus != null && letzter.abweichungFreigegebenVon) {
    // Freigegebene Abweichung: Antrag = frühester Stand derselben Abweichung (vor der Freigabe offen).
    const gleich = (x: KontrolleStandRoh) =>
      x.abweichungTurnus === letzter.abweichungTurnus &&
      (x.abweichungAnlass ?? false) === (letzter.abweichungAnlass ?? false) &&
      x.abweichungBegruendung === letzter.abweichungBegruendung;
    let i = k.staende.length - 1;
    while (i > 0 && gleich(k.staende[i - 1]!)) i--;
    antrag = {
      von: k.staende[i]!.erstelltVon,
      am: k.staende[i]!.gueltigAb,
      vorAntrag: k.staende[i - 1] ?? null,
    };
  }
  return {
    staende: k.staende
      .map((s, i) => ({
        id: s.id,
        version: s.version,
        gueltigAb: s.gueltigAb,
        gueltigBis: s.gueltigBis && s.gueltigBis.getTime() <= ende.getTime() ? s.gueltigBis : null,
        erstelltVon: s.erstelltVon,
        design: s.design,
        designVon: s.designVon,
        designAm: s.designAm,
        designBegruendung: s.designBegruendung,
        durchfuehrendId: s.durchfuehrendId,
        vertretungId: s.vertretungId,
        gegenzeichnerId: s.gegenzeichnerId,
        gegenzeichnungMandant: s.gegenzeichnungMandant,
        abweichung: abw(s),
        aenderungen: aenderungenGegen(k.staende[i - 1], s),
      }))
      .reverse(),
    audit: audit.map((a) => ({
      seq: a.seq,
      at: a.at,
      actorName: a.actorName,
      aktion: a.aktion,
      detail: (a.detail ?? {}) as Record<string, unknown>,
    })),
    abweichungBeantragtVon: antrag.von,
    abweichungBeantragtAm: antrag.am,
  };
}

/** Feststellungen je Quell-Durchführung (für „mit Befund → F-…"). */
export async function ladeFeststellungenJeDurchfuehrung(
  ctx: TcmsKontext,
): Promise<Map<string, { id: string; nummer: string; p153Offen: boolean }>> {
  const out = new Map<string, { id: string; nummer: string; p153Offen: boolean }>();
  if (!ctx.programm) return out;
  const liste = await prisma.feststellung.findMany({
    where: {
      programmId: ctx.programm.id,
      durchfuehrungId: { not: null },
      erfasstAm: { lte: tagesende(ctx.stand) },
    },
    select: { id: true, nummer: true, durchfuehrungId: true },
  });
  const offen = new Map(ctx.feststellungen.map((f) => [f.id, f.p153Offen]));
  for (const f of liste)
    if (f.durchfuehrungId)
      out.set(f.durchfuehrungId, {
        id: f.id,
        nummer: f.nummer,
        p153Offen: offen.get(f.id) ?? false,
      });
  return out;
}

/** Antragsteller:innen offener Abweichungen je Kontrolle (aktueller Stand). */
export async function ladeOffeneAbweichungen(
  ctx: TcmsKontext,
): Promise<Map<string, { von: string | null; am: Date | null }>> {
  const out = new Map<string, { von: string | null; am: Date | null }>();
  const offen = ctx.kontrollen.filter((k) => k.abweichung && !k.abweichung.freigegebenVon);
  if (offen.length === 0) return out;
  const ende = tagesende(ctx.stand);
  const staende = await prisma.kontrolleStand.findMany({
    where: { kontrolleId: { in: offen.map((k) => k.id) }, gueltigAb: { lte: ende } },
    orderBy: { version: 'asc' },
  });
  for (const k of offen) {
    const a = antragDerAbweichung(staende.filter((s) => s.kontrolleId === k.id));
    out.set(k.id, { von: a.von, am: a.am });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Planung (innerhalb einer Transaktion)
// -----------------------------------------------------------------------------

export interface RisikoFuerPlanung {
  code: string;
  gt: GovernanceTyp;
  brutto: Klasse;
}

/** Aktuell gültige, verknüpfte Risiken einer Kontrolle mit GT und Bruttoklasse. */
export async function aktuelleRisikenDerKontrolle(
  tx: Tx,
  kontrolleId: string,
  zeitpunkt: Date,
): Promise<RisikoFuerPlanung[]> {
  const links = await tx.risikoKontrolle.findMany({
    where: { kontrolleId },
    include: { risiko: { include: { staende: { where: { gueltigBis: null } } } } },
  });
  return links.flatMap((l) => {
    const r = l.risiko;
    if (r.entscheidung !== 'UEBERNOMMEN' || r.aktivAb.getTime() > zeitpunkt.getTime()) return [];
    if (r.inaktivAb && r.inaktivAb.getTime() <= zeitpunkt.getTime()) return [];
    const s = [...r.staende].sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
    return s ? [{ code: r.code, gt: s.gt, brutto: brutto(s.s, s.w, s.r as 1 | 2 | 3).klasse }] : [];
  });
}

/** Effektive Frequenz wie im Kontext: freigegebene Abweichung, sonst strengere aus Vorlage und Matrix. */
export function effektiveFrequenz(
  s: Pick<
    KontrolleStandRoh,
    | 'vorlageTurnus'
    | 'vorlageAnlass'
    | 'abweichungTurnus'
    | 'abweichungAnlass'
    | 'abweichungFreigegebenVon'
  >,
  risiken: readonly RisikoFuerPlanung[],
  programmTurnus: Turnus,
): { ableitung: FrequenzAbleitung; frequenz: Frequenz } {
  const ableitung = leiteFrequenzAb(
    { turnus: s.vorlageTurnus, anlass: s.vorlageAnlass },
    risiken,
    programmTurnus,
  );
  const frequenz =
    s.abweichungTurnus != null && s.abweichungFreigegebenVon
      ? { turnus: s.abweichungTurnus, anlass: s.abweichungAnlass ?? false }
      : ableitung.effektiv;
  return { ableitung, frequenz };
}

/** Daten für einen neuen Kontrollstand als Fortschreibung des bisherigen (Regel 3). */
export function fortschreibung(
  alt: KontrolleStandRoh,
  aenderung: Partial<Prisma.KontrolleStandUncheckedCreateInput>,
  zeitpunkt: Date,
  personId: string,
): Prisma.KontrolleStandUncheckedCreateInput {
  const { id: _id, createdAt: _c, gueltigBis: _gb, schritte, kennzahlen, ...rest } = alt;
  return {
    ...rest,
    schritte: schritte as Prisma.InputJsonValue,
    kennzahlen: kennzahlen as Prisma.InputJsonValue,
    version: alt.version + 1,
    gueltigAb: zeitpunkt,
    gueltigBis: null,
    erstelltVon: personId,
    createdAt: zeitpunkt,
    ...aenderung,
  };
}

/** Schließt den aktuellen Stand und legt den neuen an. */
export async function neuerKontrollStand(
  tx: Tx,
  alt: KontrolleStandRoh,
  aenderung: Partial<Prisma.KontrolleStandUncheckedCreateInput>,
  zeitpunkt: Date,
  personId: string,
): Promise<KontrolleStandRoh> {
  await tx.kontrolleStand.update({ where: { id: alt.id }, data: { gueltigBis: zeitpunkt } });
  return tx.kontrolleStand.create({ data: fortschreibung(alt, aenderung, zeitpunkt, personId) });
}

export interface Neuplanung {
  kontrolleId: string;
  code: string;
  turnusVorher: Turnus;
  turnusNachher: Turnus;
  entfernt: string[];
  angelegt: string[];
  behalten: string[];
  bis: string;
}

function gleichePeriode(
  a: { periodeVon: Date; periodeBis: Date },
  b: { von: Date; bis: Date },
): boolean {
  return a.periodeVon.getTime() === b.von.getTime() && a.periodeBis.getTime() === b.bis.getTime();
}

/**
 * Plant künftige Durchführungen einer Kontrolle nach neuem Turnus. Betroffen
 * sind nur geplante, nicht begonnene Durchführungen ohne Nachweise und ohne
 * Feststellungsbezug, deren Periode nach heute endet. Neue Perioden reichen
 * bis zum Planungshorizont des Programms (Ende des Wirksamkeitszeitraums bzw.
 * der spätesten geplanten Durchführung). Ohne Wirksamkeitszeitraum wird nichts
 * geplant (wie im Seed).
 */
export async function planeDurchfuehrungenNeu(
  tx: Tx,
  a: {
    programmId: string;
    kontrolleId: string;
    code: string;
    standId: string;
    faelligNachTagen: number;
    turnusVorher: Turnus;
    turnusNachher: Turnus;
    heute: Date;
  },
): Promise<Neuplanung | null> {
  const programm = await tx.tcmsProgramm.findUnique({
    where: { id: a.programmId },
    select: { wirksamAb: true, wirksamBis: true },
  });
  if (!programm?.wirksamAb) return null;
  const spaeteste = await tx.durchfuehrung.aggregate({
    where: { kontrolle: { programmId: a.programmId }, ausserplanmaessig: false },
    _max: { periodeBis: true },
  });
  const kandidatenHorizont = [programm.wirksamBis, spaeteste._max.periodeBis].filter(
    (d): d is Date => d != null,
  );
  if (kandidatenHorizont.length === 0) return null;
  const horizont = new Date(Math.max(...kandidatenHorizont.map((d) => d.getTime())));
  if (horizont.getTime() <= a.heute.getTime()) return null;

  const alle = await tx.durchfuehrung.findMany({
    where: { kontrolleId: a.kontrolleId, ausserplanmaessig: false },
    include: {
      _count: { select: { nachweise: true, feststellungen: true, nachkontrolleFuer: true } },
    },
  });
  const istKandidat = (d: (typeof alle)[number]) =>
    d.status === 'GEPLANT' &&
    !d.begonnenAm &&
    !d.durchgefuehrtVon &&
    !d.eingereichtAm &&
    d.periodeBis.getTime() > a.heute.getTime() &&
    d._count.nachweise === 0 &&
    d._count.feststellungen === 0 &&
    d._count.nachkontrolleFuer === 0;
  const kandidaten = alle.filter(istKandidat);
  const feste = alle.filter((d) => !istKandidat(d));

  const soll = perioden(a.turnusNachher, addTage(a.heute, 1), horizont);
  const behalten = new Set<string>();
  const angelegt: string[] = [];
  for (const p of soll) {
    if (feste.some((d) => gleichePeriode(d, p))) continue;
    const vorhanden = kandidaten.find((d) => gleichePeriode(d, p));
    if (vorhanden) {
      behalten.add(vorhanden.id);
      continue;
    }
    await tx.durchfuehrung.create({
      data: {
        kontrolleId: a.kontrolleId,
        kontrolleStandId: a.standId,
        periodeLabel: p.label,
        periodeVon: p.von,
        periodeBis: p.bis,
        faelligAm: addTage(p.bis, a.faelligNachTagen),
        status: 'GEPLANT',
        createdAt: jetzt(),
      },
    });
    angelegt.push(p.label);
  }
  const weg = kandidaten.filter((d) => !behalten.has(d.id));
  if (weg.length)
    await tx.durchfuehrung.deleteMany({ where: { id: { in: weg.map((d) => d.id) } } });
  if (weg.length === 0 && angelegt.length === 0) return null;
  return {
    kontrolleId: a.kontrolleId,
    code: a.code,
    turnusVorher: a.turnusVorher,
    turnusNachher: a.turnusNachher,
    entfernt: weg
      .sort((x, y) => x.periodeVon.getTime() - y.periodeVon.getTime())
      .map((d) => d.periodeLabel),
    angelegt,
    behalten: kandidaten.filter((d) => behalten.has(d.id)).map((d) => d.periodeLabel),
    bis: horizont.toISOString().slice(0, 10),
  };
}
