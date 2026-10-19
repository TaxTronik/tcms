// =============================================================================
// Kontrollstände und Planung künftiger Durchführungen (bisher
// apps/web/src/server/kontrollen-daten.ts). Alles läuft in der Transaktion der
// jeweiligen Operation (`tx` aus `mitAudit`).
//
// Fachkonzept §6: Ändern sich GT oder Bruttoklasse, werden künftige
// Durchführungen neu geplant; abgeschlossene bleiben unverändert. Entfernt
// werden nur geplante, unberührte Durchführungen – geprüft unter Zeilensperre
// und noch einmal als Bedingung des Löschens (TS-05).
// =============================================================================

import type { Prisma, Tx } from '@tcms/db';
import {
  addTage,
  brutto,
  leiteFrequenzAb,
  perioden,
  type Frequenz,
  type FrequenzAbleitung,
  type GovernanceTyp,
  type Klasse,
  type Turnus,
} from '@tcms/domain';
import type { KontrollNeuplanung } from '@tcms/contract';
import { konflikt, sperreDurchfuehrungen } from './gemeinsam';

export type KontrolleStandRoh = Prisma.KontrolleStandGetPayload<object>;

export interface RisikoFuerPlanung {
  code: string;
  gt: GovernanceTyp;
  brutto: Klasse;
}

/** true, wenn der Stand eine beantragte, noch nicht freigegebene Abweichung trägt. */
export function abweichungOffen(
  s: Pick<KontrolleStandRoh, 'abweichungTurnus' | 'abweichungFreigegebenVon'>,
): boolean {
  return s.abweichungTurnus != null && !s.abweichungFreigegebenVon;
}

function gleicheAbweichung(a: KontrolleStandRoh, b: KontrolleStandRoh): boolean {
  return (
    a.abweichungTurnus === b.abweichungTurnus &&
    (a.abweichungAnlass ?? false) === (b.abweichungAnlass ?? false) &&
    a.abweichungBegruendung === b.abweichungBegruendung &&
    a.abweichungFreigegebenVon === b.abweichungFreigegebenVon
  );
}

function gleicherAntrag(a: KontrolleStandRoh, b: KontrolleStandRoh): boolean {
  return (
    a.abweichungTurnus === b.abweichungTurnus &&
    (a.abweichungAnlass ?? false) === (b.abweichungAnlass ?? false) &&
    a.abweichungBegruendung === b.abweichungBegruendung
  );
}

export interface Antrag {
  von: string | null;
  am: Date | null;
}

/**
 * Wer hat die offene Abweichung beantragt? Der früheste Stand der
 * ununterbrochenen Folge mit derselben offenen Abweichung (spätere Stände
 * können durch Design- oder Personenänderungen entstanden sein). Für die
 * Vier-Augen-Prüfung werden die Stände unter der Sperre der Kontrolle gelesen.
 */
export function antragDerAbweichung(staendeAufsteigend: readonly KontrolleStandRoh[]): Antrag {
  const letzter = staendeAufsteigend[staendeAufsteigend.length - 1];
  if (!letzter || !abweichungOffen(letzter)) return { von: null, am: null };
  let i = staendeAufsteigend.length - 1;
  while (i > 0 && gleicheAbweichung(staendeAufsteigend[i - 1]!, letzter)) i--;
  return { von: staendeAufsteigend[i]!.erstelltVon, am: staendeAufsteigend[i]!.gueltigAb };
}

/** Antrag einer offenen oder freigegebenen Abweichung (Anzeige). */
export function antragAnzeige(staendeAufsteigend: readonly KontrolleStandRoh[]): Antrag {
  const offen = antragDerAbweichung(staendeAufsteigend);
  if (offen.von) return offen;
  const letzter = staendeAufsteigend[staendeAufsteigend.length - 1];
  if (!letzter || letzter.abweichungTurnus == null || !letzter.abweichungFreigegebenVon) {
    return { von: null, am: null };
  }
  let i = staendeAufsteigend.length - 1;
  while (i > 0 && gleicherAntrag(staendeAufsteigend[i - 1]!, letzter)) i--;
  return { von: staendeAufsteigend[i]!.erstelltVon, am: staendeAufsteigend[i]!.gueltigAb };
}

/** Kurzbeschreibung der Änderung eines Kontrollstands gegenüber dem Vorgänger. */
export function aenderungenGegen(
  vorher: KontrolleStandRoh | undefined,
  s: KontrolleStandRoh,
): string[] {
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
  const {
    id: _id,
    tenantId: _t,
    createdAt: _c,
    gueltigBis: _gb,
    schritte,
    kennzahlen,
    ...rest
  } = alt;
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

/** Offener Stand einer (gesperrten) Kontrolle, sonst KONFLIKT. */
export async function offenerKontrollStand(
  tx: Tx,
  kontrolleId: string,
): Promise<KontrolleStandRoh> {
  const s = await tx.kontrolleStand.findFirst({ where: { kontrolleId, gueltigBis: null } });
  if (!s) throw konflikt('Kein gültiger Kontrollstand vorhanden.');
  return s;
}

/**
 * Schließt den aktuellen Stand und legt den neuen an (AGENTS.md Regel 3).
 * TS-05: nur den noch offenen Stand schließen (bedingtes Update mit
 * count-Prüfung); die eindeutigen Schlüssel (kontrolleId, version) und „ein
 * offener Stand je Kontrolle" verhindern zusätzlich eine Gabelung.
 */
export async function neuerKontrollStand(
  tx: Tx,
  alt: KontrolleStandRoh,
  aenderung: Partial<Prisma.KontrolleStandUncheckedCreateInput>,
  zeitpunkt: Date,
  personId: string,
): Promise<KontrolleStandRoh> {
  const zu = await tx.kontrolleStand.updateMany({
    where: { id: alt.id, gueltigBis: null },
    data: { gueltigBis: zeitpunkt },
  });
  if (zu.count !== 1) throw konflikt('Die Kontrolle wurde inzwischen geändert. Bitte neu laden.');
  return tx.kontrolleStand.create({ data: fortschreibung(alt, aenderung, zeitpunkt, personId) });
}

function gleichePeriode(
  a: { periodeVon: Date; periodeBis: Date },
  b: { von: Date; bis: Date },
): boolean {
  return a.periodeVon.getTime() === b.von.getTime() && a.periodeBis.getTime() === b.bis.getTime();
}

/**
 * Bedingung „unberührt": nur geplante, nicht begonnene, nicht eingereichte,
 * nicht abgeschlossene Durchführungen ohne Nachweise und ohne Bezug zu
 * Feststellungen. Gilt bei der Auswahl und noch einmal beim Löschen.
 */
export const UNBERUEHRT = {
  status: 'GEPLANT',
  ausserplanmaessig: false,
  begonnenAm: null,
  durchgefuehrtVon: null,
  eingereichtAm: null,
  abgeschlossenAm: null,
  nachweise: { none: {} },
  feststellungen: { none: {} },
  nachkontrolleFuer: { none: {} },
} as const satisfies Prisma.DurchfuehrungWhereInput;

/**
 * Löscht geplante, unberührte Durchführungen; jede andere ID (inzwischen
 * begonnen, abgeschlossen, mit Nachweis) bricht mit KONFLIKT ab, statt sie zu
 * löschen.
 */
export async function loescheUnberuehrte(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await tx.durchfuehrung.deleteMany({ where: { id: { in: [...ids] }, ...UNBERUEHRT } });
  if (r.count !== ids.length) {
    throw konflikt('Eine geplante Durchführung wurde inzwischen bearbeitet. Bitte neu laden.');
  }
}

/**
 * Plant künftige Durchführungen einer Kontrolle nach neuem Turnus. Betroffen
 * sind nur unberührte Durchführungen, deren Periode nach heute endet. Neue
 * Perioden reichen bis zum Planungshorizont des Programms (Ende des
 * Wirksamkeitszeitraums bzw. der spätesten geplanten Durchführung). Ohne
 * Wirksamkeitszeitraum wird nichts geplant (wie im Seed).
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
    zeitpunkt: Date;
  },
): Promise<KontrollNeuplanung | null> {
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

  // TS-05: Durchführungen dieser Kontrolle sperren, bevor über sie entschieden wird.
  await sperreDurchfuehrungen(tx, a.kontrolleId);
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
    !d.abgeschlossenAm &&
    d.periodeBis.getTime() > a.heute.getTime() &&
    d._count.nachweise === 0 &&
    d._count.feststellungen === 0 &&
    d._count.nachkontrolleFuer === 0;
  const kandidaten = alle.filter(istKandidat);
  const feste = alle.filter((d) => !istKandidat(d));

  const soll = perioden(a.turnusNachher, addTage(a.heute, 1), horizont);
  const behalten = new Set<string>();
  const neu: Prisma.DurchfuehrungCreateManyInput[] = [];
  for (const p of soll) {
    if (feste.some((d) => gleichePeriode(d, p))) continue;
    const vorhanden = kandidaten.find((d) => gleichePeriode(d, p));
    if (vorhanden) {
      behalten.add(vorhanden.id);
      continue;
    }
    neu.push({
      kontrolleId: a.kontrolleId,
      kontrolleStandId: a.standId,
      periodeLabel: p.label,
      periodeVon: p.von,
      periodeBis: p.bis,
      faelligAm: addTage(p.bis, a.faelligNachTagen),
      status: 'GEPLANT',
      createdAt: a.zeitpunkt,
    });
  }
  const weg = kandidaten.filter((d) => !behalten.has(d.id));
  await loescheUnberuehrte(
    tx,
    weg.map((d) => d.id),
  );
  if (neu.length) await tx.durchfuehrung.createMany({ data: neu });
  if (weg.length === 0 && neu.length === 0) return null;
  return {
    kontrolleId: a.kontrolleId,
    code: a.code,
    turnusVorher: a.turnusVorher,
    turnusNachher: a.turnusNachher,
    entfernt: weg
      .sort((x, y) => x.periodeVon.getTime() - y.periodeVon.getTime())
      .map((d) => d.periodeLabel),
    angelegt: neu.map((d) => d.periodeLabel),
    behalten: kandidaten.filter((d) => behalten.has(d.id)).map((d) => d.periodeLabel),
    bis: horizont.toISOString().slice(0, 10),
  };
}
