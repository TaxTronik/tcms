// =============================================================================
// Ereigniseingang und Triage (S11): schreibende Operationen. Ein Ereignis ist
// erst erledigt, wenn jede Folge erledigt oder begründet verworfen ist.
//
// Muster wie bei Feststellungen (TS-05): Ereignis-Zeile unter Sperre laden
// (Zugehörigkeit zum Mandanten geprüft), dann Recht, Status und Folgen aus
// der gesperrten Zeile prüfen, ändern und protokollieren. Folgen werden mit
// bedingtem Update übernommen (Status unverändert, sonst KONFLIKT).
// =============================================================================

import {
  DienstFehler,
  EreignisAktionSchema,
  EreignisErfassenSchema,
  EreignisVerwerfenBeantragenSchema,
  FolgeAktionSchema,
  FolgeHinzufuegenSchema,
  FolgenAnlegenSchema,
  FolgeVerwerfenSchema,
  type EreignisAktion,
  type EreignisErfassen,
  type EreignisErfasst,
  type EreignisErgebnis,
  type EreignisVerwerfenBeantragen,
  type FolgeAktion,
  type FolgeErgebnis,
  type FolgeHinzufuegen,
  type FolgenAngelegt,
  type FolgenAnlegen,
  type FolgeVerwerfen,
  type PersonZuweisung,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  EREIGNISTYPEN,
  ereignistyp,
  ereignisErledigt,
  FOLGE_LABEL,
  type FolgeArt,
} from '@tcms/domain';
import type { Protokoll } from '../../audit';
import { naechsteEreignisnummer } from '../../kern/nummern';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { gleicheId, kannBearbeiten, zweitePerson } from '../../rechte';
import {
  alsTag,
  GEAENDERT,
  isoTag,
  KEIN_PROGRAMM,
  KEIN_RECHT,
  legeAusserplanmaessigeDurchfuehrungAn,
  legeFeststellungAn,
  programmVon,
  pruefe,
  pruefeKanzleiZugriff,
  pruefeMandant,
  sperreEreignis,
  ZWEITE_PERSON,
  aendere,
} from './gemeinsam';

const ABGESCHLOSSEN = 'Das Ereignis ist bereits erledigt oder verworfen.';
const KEIN_ANTRAG = 'Es liegt kein offener Antrag auf Verwerfen vor.';

// ---------------------------------------------------------------------------
// Anlegen (gemeinsam für Kanzlei, Portal und Länder-Monitor)
// ---------------------------------------------------------------------------

/** Legt ein Ereignis mit den Katalogfolgen als Vorschläge an (Triage folgt in S11). */
export async function legeEreignisAn(
  tx: Tx,
  a: {
    programmId: string;
    typ: string;
    titel: string;
    beschreibung: string;
    quelle: 'PORTAL' | 'KONTROLLE' | 'STAMMDATEN' | 'RSS' | 'MANUELL';
    gemeldetVon: string;
    ereignisDatum: Date;
    zeitpunkt: Date;
  },
): Promise<{ id: string; nummer: string; folgen: number }> {
  const nummer = await naechsteEreignisnummer(tx, a.zeitpunkt.getUTCFullYear());
  const kat = ereignistyp(a.typ);
  const folgen: { art: FolgeArt; ziel: string | null; text: string }[] = kat
    ? kat.folgen.map((f) => ({ art: f.art, ziel: f.ziel ?? null, text: f.text }))
    : [{ art: 'HINWEIS', ziel: null, text: 'Meldung sichten und Folgen festlegen' }];
  const e = await tx.ereignis.create({
    data: {
      programmId: a.programmId,
      nummer,
      typ: a.typ,
      titel: a.titel,
      beschreibung: a.beschreibung,
      quelle: a.quelle,
      gemeldetVon: a.gemeldetVon,
      gemeldetAm: a.zeitpunkt,
      ereignisDatum: a.ereignisDatum,
      status: 'NEU',
      folgen: { create: folgen },
    },
    select: { id: true },
  });
  return { id: e.id, nummer, folgen: folgen.length };
}

// ---------------------------------------------------------------------------
// Laden und Prüfen unter Sperre
// ---------------------------------------------------------------------------

async function ladeGesperrt(ctx: DienstKontext, mandantId: string, ereignisId: string) {
  await sperreEreignis(ctx.tx, mandantId, ereignisId);
  return ctx.tx.ereignis.findUniqueOrThrow({
    where: { id: ereignisId },
    include: { folgen: { orderBy: { id: 'asc' } } },
  });
}
type Gesperrt = Awaited<ReturnType<typeof ladeGesperrt>>;

function pruefeOffen(e: { status: string }): void {
  if (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN') {
    throw new DienstFehler('KONFLIKT', ABGESCHLOSSEN);
  }
}

/** Gemeinsame Prüfung: Bearbeitungsrecht und Ereignis offen. */
async function ladeZumAendern(ctx: DienstKontext, mandantId: string, ereignisId: string) {
  const e = await ladeGesperrt(ctx, mandantId, ereignisId);
  if (!kannBearbeiten(ctx.akteur, mandantId))
    throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
  pruefeOffen(e);
  return e;
}

/** „In Triage" beim ersten Triage-Schritt (Status NEU), sonst nichts. */
async function triageStart(
  ctx: DienstKontext,
  e: Pick<Gesperrt, 'id' | 'status' | 'nummer' | 'programmId'>,
  zeitpunkt: Date,
): Promise<Protokoll | null> {
  if (e.status !== 'NEU') return null;
  const n = await ctx.tx.ereignis.updateMany({
    where: { id: e.id, status: 'NEU' },
    data: { status: 'IN_TRIAGE', triagiertVon: ctx.akteur.id, triagiertAm: zeitpunkt },
  });
  if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
  return {
    aktion: 'tcms.ereignis.in_triage',
    objektTyp: 'Ereignis',
    objektId: e.id,
    programmId: e.programmId,
    detail: { nummer: e.nummer },
  };
}

/** Zuständige Person: Kanzleiperson oder Mandantenkontakt mit aktiver Rolle bei diesem Mandanten. */
async function zuweisungZulaessig(
  tx: Tx,
  mandantId: string,
  p: PersonZuweisung | null | undefined,
): Promise<boolean> {
  if (!p || p.art === 'KANZLEI') return true;
  const n = await tx.mandantKontaktRolle.count({
    where: { mandantId, kontaktId: p.id.toLowerCase(), aktiv: true },
  });
  return n > 0;
}

/**
 * Hebt die Neubewertungs-Markierung eines Risikos auf, wenn keine andere
 * angelegte Folge sie braucht. Die Risiko-Zeile wird gesperrt, damit ein
 * gleichzeitiges Markieren nicht verloren geht (TS-05).
 */
async function gibMarkierungFrei(
  ctx: DienstKontext,
  e: Pick<Gesperrt, 'programmId' | 'nummer'>,
  folge: { id: string; art: FolgeArt; objektId: string | null; ziel: string | null },
  anlass: string,
): Promise<Protokoll | null> {
  if ((folge.art !== 'RISIKO_NEU_BEWERTEN' && folge.art !== 'RISIKO_AKTIVIEREN') || !folge.objektId)
    return null;
  const tx = ctx.tx;
  const r = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Risiko" WHERE id = ${folge.objektId} AND "programmId" = ${e.programmId}
    FOR UPDATE`;
  if (r.length !== 1) return null;
  const andere = await tx.ereignisFolge.count({
    where: {
      id: { not: folge.id },
      objektId: folge.objektId,
      art: { in: ['RISIKO_NEU_BEWERTEN', 'RISIKO_AKTIVIEREN'] },
      status: 'ANGELEGT',
    },
  });
  if (andere > 0) return null;
  await tx.risiko.update({ where: { id: folge.objektId }, data: { neuBewerten: false } });
  return {
    aktion: 'tcms.risiko.neubewertung_erledigt',
    objektTyp: 'Risiko',
    objektId: folge.objektId,
    programmId: e.programmId,
    detail: { code: folge.ziel, anlass },
  };
}

function ergebnis(e: { id: string; nummer: string }, status: EreignisErgebnis['status']) {
  return { id: e.id, nummer: e.nummer, status };
}

// ---------------------------------------------------------------------------
// In Prüfung nehmen
// ---------------------------------------------------------------------------

export async function nehmeEreignisInPruefung(
  ctx: DienstKontext,
  eingabe: EreignisAktion,
): Promise<EreignisErgebnis> {
  const x = pruefe(EreignisAktionSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (_tx, zeitpunkt) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    if (e.status !== 'NEU')
      throw new DienstFehler('KONFLIKT', 'Das Ereignis ist bereits in Prüfung.');
    const p = await triageStart(ctx, e, zeitpunkt);
    return { wert: ergebnis(e, 'IN_TRIAGE'), protokoll: p! };
  });
}

// ---------------------------------------------------------------------------
// Folgen anlegen (Auswahl der Vorschläge)
// ---------------------------------------------------------------------------

interface Plan {
  folge: Gesperrt['folgen'][number];
  zustaendig: string | null;
  frist: Date | null;
  risiko?: { id: string; code: string; aktiv: boolean } | null;
  kontrolle?: { id: string; code: string };
  feststellung?: NonNullable<FolgenAnlegen['folgen'][number]['feststellung']>;
}

/**
 * Übernimmt vorgeschlagene Folgen: markiert Risiken zur Neubewertung, plant
 * außerplanmäßige Durchführungen ein oder legt Feststellungen an (TS-04 über
 * `legeFeststellungAn`). Alle Eingaben werden geprüft, bevor etwas
 * geschrieben wird; eine Folge, die nicht mehr vorgeschlagen ist (auch durch
 * eine gleichzeitige Anfrage), ergibt KONFLIKT.
 */
export async function legeFolgenAn(
  ctx: DienstKontext,
  eingabe: FolgenAnlegen,
): Promise<FolgenAngelegt> {
  const x = pruefe(FolgenAnlegenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const heute = heuteDatum(ctx.uhr);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    const t = zeitpunkt.getTime();
    const plaene: Plan[] = [];
    const fehler: string[] = [];
    const felder: Record<string, string[]> = {};
    const melde = (i: number, text: string) => {
      fehler.push(text);
      (felder[`folgen.${i}`] ??= []).push(text);
    };
    for (const [i, wahl] of x.folgen.entries()) {
      const folge = e.folgen.find((f) => f.id === wahl.folgeId);
      // Folge eines anderen Ereignisses oder Mandanten: wie unbekannt.
      if (!folge) throw new DienstFehler('NICHT_GEFUNDEN');
      if (folge.status !== 'VORGESCHLAGEN') {
        throw new DienstFehler('KONFLIKT', 'Eine gewählte Folge ist nicht mehr offen.');
      }
      const label = `${FOLGE_LABEL[folge.art]}${folge.ziel ? ` ${folge.ziel}` : ''}`;
      if (!(await zuweisungZulaessig(tx, mandantId, wahl.zustaendig))) {
        melde(i, `${label}: Zuständigkeit ist nicht zulässig.`);
        continue;
      }
      let frist: Date | null = null;
      if (wahl.frist) {
        frist = alsTag(wahl.frist);
        if (frist.getTime() < heute.getTime()) {
          melde(i, `${label}: Frist liegt in der Vergangenheit.`);
          continue;
        }
      }
      if (wahl.feststellung && folge.art !== 'FESTSTELLUNG_ANLEGEN') {
        melde(i, `${label}: Feststellungsangaben nur bei „Feststellung anlegen".`);
        continue;
      }
      const plan: Plan = {
        folge,
        zustaendig: wahl.zustaendig ? wahl.zustaendig.id.toLowerCase() : null,
        frist,
      };
      if (folge.art === 'RISIKO_NEU_BEWERTEN' || folge.art === 'RISIKO_AKTIVIEREN') {
        const r = folge.ziel
          ? await tx.risiko.findFirst({
              where: { programmId: e.programmId, code: folge.ziel },
              select: { id: true, code: true, entscheidung: true, inaktivAb: true },
            })
          : null;
        const aktiv =
          !!r && r.entscheidung === 'UEBERNOMMEN' && (!r.inaktivAb || r.inaktivAb.getTime() > t);
        if (folge.art === 'RISIKO_NEU_BEWERTEN' && !aktiv) {
          melde(
            i,
            `${label}: Risiko ist im Inventar nicht aktiv – Folge verwerfen oder Risiko zuerst aufnehmen.`,
          );
          continue;
        }
        plan.risiko = r ? { id: r.id, code: r.code, aktiv } : null;
      }
      if (folge.art === 'KONTROLLE_AUSSERPLANMAESSIG') {
        const k = folge.ziel
          ? await tx.kontrolle.findFirst({
              where: { programmId: e.programmId, code: folge.ziel },
              select: { id: true, code: true, aktivAb: true, entfallenAb: true },
            })
          : null;
        if (!k || k.aktivAb.getTime() > t || (k.entfallenAb && k.entfallenAb.getTime() <= t)) {
          melde(i, `${label}: Kontrolle ist im Programm nicht aktiv.`);
          continue;
        }
        if (!frist) {
          melde(i, `${label}: Bitte eine Fälligkeit (Frist) setzen.`);
          continue;
        }
        plan.kontrolle = { id: k.id, code: k.code };
      }
      if (folge.art === 'FESTSTELLUNG_ANLEGEN') {
        if (!wahl.feststellung) {
          melde(i, `${label}: Titel (mind. 5 Zeichen), Klasse, Schwere und Auswirkung angeben.`);
          continue;
        }
        plan.feststellung = wahl.feststellung;
      }
      plaene.push(plan);
    }
    if (fehler.length) {
      throw new DienstFehler('UNGUELTIG', fehler.join(' ').slice(0, 500), felder);
    }

    const protokoll: Protokoll[] = [];
    const start = await triageStart(ctx, e, zeitpunkt);
    if (start) protokoll.push(start);
    const angelegt: FolgenAngelegt['folgen'] = [];
    for (const pl of plaene) {
      const f = pl.folge;
      let objektId: string | null = null;
      let objekt: string | null = null;
      let status: 'ANGELEGT' | 'ERLEDIGT' = 'ANGELEGT';
      let herabgestuft = false;
      if (f.art === 'RISIKO_NEU_BEWERTEN' || (f.art === 'RISIKO_AKTIVIEREN' && pl.risiko?.aktiv)) {
        await tx.risiko.update({ where: { id: pl.risiko!.id }, data: { neuBewerten: true } });
        objektId = pl.risiko!.id;
        protokoll.push({
          aktion: 'tcms.risiko.neu_bewerten_markiert',
          objektTyp: 'Risiko',
          objektId: pl.risiko!.id,
          programmId: e.programmId,
          detail: { code: pl.risiko!.code, anlass: `Ereignis ${e.nummer}` },
        });
      } else if (f.art === 'RISIKO_AKTIVIEREN') {
        objektId = pl.risiko?.id ?? null;
      } else if (f.art === 'KONTROLLE_AUSSERPLANMAESSIG') {
        const d = await legeAusserplanmaessigeDurchfuehrungAn(tx, {
          programmId: e.programmId,
          kontrolleId: pl.kontrolle!.id,
          faelligAm: pl.frist!,
          anlass: `Ereignis ${e.nummer} (${e.typ})`,
          label: `außerplanmäßig (Ereignis ${e.nummer})`,
          ereignisFolgeId: f.id,
          zeitpunkt,
        });
        objektId = d.id;
        objekt = d.code;
        protokoll.push({
          aktion: 'tcms.durchfuehrung.ausserplanmaessig',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: e.programmId,
          detail: {
            kontrolle: d.code,
            anlass: `Ereignis ${e.nummer}`,
            faelligAm: isoTag(pl.frist!),
          },
        });
      } else if (f.art === 'FESTSTELLUNG_ANLEGEN') {
        const fs = pl.feststellung!;
        // TS-04: „keine Auswirkung" nur mit Würdigungsrecht, sonst „unklar".
        const neu = await legeFeststellungAn(ctx, zeitpunkt, {
          mandantId,
          programmId: e.programmId,
          titel: fs.titel,
          sachverhalt: e.beschreibung,
          quelle: 'EREIGNIS',
          quelleText: `Ereignis ${e.nummer} (${e.typ})`,
          ereignisId: e.id,
          klasse: fs.klasse,
          schwere: fs.schwere,
          auswirkung: fs.auswirkung,
          detail: { quelle: `Ereignis ${e.nummer}` },
        });
        objektId = neu.id;
        objekt = neu.nummer;
        status = 'ERLEDIGT';
        herabgestuft = neu.auswirkungHerabgestuft;
        protokoll.push(neu.protokoll);
      }
      const n = await tx.ereignisFolge.updateMany({
        where: { id: f.id, ereignisId: e.id, status: 'VORGESCHLAGEN' },
        data: {
          status,
          objektId,
          zustaendig: pl.zustaendig,
          frist: pl.frist,
          ...(status === 'ERLEDIGT' ? { erledigtAm: zeitpunkt } : {}),
        },
      });
      if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
      protokoll.push({
        aktion: 'tcms.ereignis.folge_angelegt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId: e.programmId,
        detail: {
          ereignis: e.nummer,
          art: f.art,
          label: FOLGE_LABEL[f.art],
          ziel: f.ziel,
          objekt,
          zustaendig: pl.zustaendig,
          frist: pl.frist ? isoTag(pl.frist) : null,
        },
      });
      angelegt.push({
        folgeId: f.id,
        status,
        objektId,
        objekt,
        auswirkungHerabgestuft: herabgestuft,
      });
    }
    return { wert: { ereignisId: e.id, folgen: angelegt }, protokoll };
  });
}

// ---------------------------------------------------------------------------
// Weitere Folge vorschlagen (eigene Triage-Entscheidung)
// ---------------------------------------------------------------------------

export async function fuegeFolgeHinzu(
  ctx: DienstKontext,
  eingabe: FolgeHinzufuegen,
): Promise<FolgeErgebnis> {
  const x = pruefe(FolgeHinzufuegenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const ziel = x.ziel ?? null;
  if (
    (x.art === 'RISIKO_NEU_BEWERTEN' || x.art === 'RISIKO_AKTIVIEREN') &&
    !/^EC-[A-Z]{3}-\d{2}$/.test(ziel ?? '')
  ) {
    const text = 'Bitte den Risikocode angeben (z. B. EC-UST-02).';
    throw new DienstFehler('UNGUELTIG', text, { ziel: [text] });
  }
  if (x.art === 'KONTROLLE_AUSSERPLANMAESSIG' && !/^K-EC-\d{2}$/.test(ziel ?? '')) {
    const text = 'Bitte den Kontrollcode angeben (z. B. K-EC-02).';
    throw new DienstFehler('UNGUELTIG', text, { ziel: [text] });
  }
  return aendere(ctx, async (tx) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    const f = await tx.ereignisFolge.create({
      data: { ereignisId: e.id, art: x.art, ziel, text: x.text },
      select: { id: true },
    });
    return {
      wert: { id: f.id, status: 'VORGESCHLAGEN' as const },
      protokoll: {
        aktion: 'tcms.ereignis.folge_hinzugefuegt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId: e.programmId,
        detail: { ereignis: e.nummer, art: x.art, label: FOLGE_LABEL[x.art], ziel, text: x.text },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Folge erledigen / verwerfen
// ---------------------------------------------------------------------------

async function ladeFolge(
  ctx: DienstKontext,
  mandantId: string,
  ereignisId: string,
  folgeId: string,
) {
  const e = await ladeGesperrt(ctx, mandantId, ereignisId);
  const folge = e.folgen.find((f) => f.id === folgeId);
  // Folge eines anderen Ereignisses (auch eines anderen Mandanten): wie unbekannt.
  if (!folge) throw new DienstFehler('NICHT_GEFUNDEN');
  return { e, folge };
}

/**
 * Erledigt eine angelegte Folge: Bearbeitungsrecht oder die zuständige Person
 * (Kanzleiperson mit Bezug). Eine außerplanmäßige Kontrolle muss
 * abgeschlossen sein.
 */
export async function erledigeFolge(
  ctx: DienstKontext,
  eingabe: FolgeAktion,
): Promise<FolgeErgebnis> {
  const x = pruefe(FolgeAktionSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const { e, folge: f } = await ladeFolge(ctx, mandantId, x.ereignisId, x.folgeId);
    if (!kannBearbeiten(ctx.akteur, mandantId) && !gleicheId(ctx.akteur.id, f.zustaendig)) {
      throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
    }
    pruefeOffen(e);
    if (f.status !== 'ANGELEGT') {
      throw new DienstFehler('KONFLIKT', 'Nur angelegte Folgen können erledigt werden.');
    }
    if (f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && f.objektId) {
      const d = await tx.durchfuehrung.findFirst({
        where: { id: f.objektId, kontrolle: { programmId: e.programmId } },
        select: { status: true },
      });
      if (!d || !['OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN'].includes(d.status)) {
        throw new DienstFehler(
          'KONFLIKT',
          'Die außerplanmäßige Durchführung ist noch nicht abgeschlossen (gegengezeichnet).',
        );
      }
    }
    const n = await tx.ereignisFolge.updateMany({
      where: { id: f.id, ereignisId: e.id, status: 'ANGELEGT' },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt },
    });
    if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.ereignis.folge_erledigt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId: e.programmId,
        detail: { ereignis: e.nummer, art: f.art, label: FOLGE_LABEL[f.art], ziel: f.ziel },
      },
    ];
    const frei = await gibMarkierungFrei(ctx, e, f, `Ereignis ${e.nummer}`);
    if (frei) protokoll.push(frei);
    return { wert: { id: f.id, status: 'ERLEDIGT' as const }, protokoll };
  });
}

export async function verwerfeFolge(
  ctx: DienstKontext,
  eingabe: FolgeVerwerfen,
): Promise<FolgeErgebnis> {
  const x = pruefe(FolgeVerwerfenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const { e, folge: f } = await ladeFolge(ctx, mandantId, x.ereignisId, x.folgeId);
    if (!kannBearbeiten(ctx.akteur, mandantId))
      throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
    pruefeOffen(e);
    if (f.status !== 'VORGESCHLAGEN' && f.status !== 'ANGELEGT') {
      throw new DienstFehler('KONFLIKT', 'Die Folge ist bereits erledigt oder verworfen.');
    }
    if (f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId) {
      throw new DienstFehler(
        'KONFLIKT',
        'Die Feststellung ist angelegt; sie wird in S10 bearbeitet oder verworfen.',
      );
    }
    const protokoll: Protokoll[] = [];
    const start = await triageStart(ctx, e, zeitpunkt);
    if (start) protokoll.push(start);
    const n = await tx.ereignisFolge.updateMany({
      where: { id: f.id, ereignisId: e.id, status: f.status },
      data: { status: 'VERWORFEN' },
    });
    if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    protokoll.push({
      aktion: 'tcms.ereignis.folge_verworfen',
      objektTyp: 'EreignisFolge',
      objektId: f.id,
      programmId: e.programmId,
      detail: {
        ereignis: e.nummer,
        art: f.art,
        label: FOLGE_LABEL[f.art],
        ziel: f.ziel,
        vorher: f.status,
        begruendung: x.begruendung,
      },
    });
    if (f.status === 'ANGELEGT') {
      const frei = await gibMarkierungFrei(ctx, e, f, `Folge verworfen (Ereignis ${e.nummer})`);
      if (frei) protokoll.push(frei);
    }
    return { wert: { id: f.id, status: 'VERWORFEN' as const }, protokoll };
  });
}

// ---------------------------------------------------------------------------
// Ereignis abschließen / verwerfen
// ---------------------------------------------------------------------------

export async function schliesseEreignisAb(
  ctx: DienstKontext,
  eingabe: EreignisAktion,
): Promise<EreignisErgebnis> {
  const x = pruefe(EreignisAktionSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    if (!ereignisErledigt(e.folgen)) {
      throw new DienstFehler(
        'KONFLIKT',
        'Noch nicht möglich: jede Folge muss erledigt oder begründet verworfen sein.',
      );
    }
    // Ohne erledigte Folge wäre das Abschließen ein Verwerfen – das braucht eine zweite Person.
    if (!e.folgen.some((f) => f.status === 'ERLEDIGT')) {
      throw new DienstFehler(
        'KONFLIKT',
        'Keine Folge ist erledigt. Bitte „Ereignis verwerfen“ verwenden – das bestätigt eine zweite Person.',
      );
    }
    await tx.ereignis.update({
      where: { id: e.id },
      data: {
        status: 'ERLEDIGT',
        verwerfenBegruendung: null,
        ...(e.triagiertVon ? {} : { triagiertVon: ctx.akteur.id, triagiertAm: zeitpunkt }),
      },
    });
    return {
      wert: ergebnis(e, 'ERLEDIGT'),
      protokoll: {
        aktion: 'tcms.ereignis.abgeschlossen',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, folgen: e.folgen.length },
      },
    };
  });
}

export async function beantrageEreignisVerwerfen(
  ctx: DienstKontext,
  eingabe: EreignisVerwerfenBeantragen,
): Promise<EreignisErgebnis> {
  const x = pruefe(EreignisVerwerfenBeantragenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    if (e.verwerfenBegruendung)
      throw new DienstFehler('KONFLIKT', 'Das Verwerfen ist bereits beantragt.');
    if (e.folgen.some((f) => f.status === 'ANGELEGT' || f.status === 'ERLEDIGT')) {
      throw new DienstFehler(
        'KONFLIKT',
        'Es sind bereits Folgen angelegt. Diese einzeln erledigen oder verwerfen und das Ereignis dann abschließen.',
      );
    }
    await tx.ereignis.update({
      where: { id: e.id },
      data: { verwerfenBegruendung: x.begruendung },
    });
    return {
      wert: ergebnis(e, e.status),
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_beantragt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, begruendung: x.begruendung },
      },
    };
  });
}

/**
 * Antragsteller:in des offenen Antrags: jüngster Antrag im Audit-Log. Wird
 * nach der Sperre der Ereignis-Zeile gelesen; Antrag und Audit-Eintrag
 * entstehen in derselben Transaktion, sind also konsistent. Ohne Eintrag:
 * null (dann ist keine Bestätigung möglich, fail closed).
 */
async function antragsteller(
  tx: Tx,
  e: Pick<Gesperrt, 'id' | 'programmId'>,
): Promise<string | null> {
  const a = await tx.auditEvent.findFirst({
    where: {
      objektTyp: 'Ereignis',
      objektId: e.id,
      programmId: e.programmId,
      aktion: 'tcms.ereignis.verwerfen_beantragt',
    },
    orderBy: { seq: 'desc' },
    select: { actorId: true },
  });
  return a?.actorId ?? null;
}

export async function bestaetigeEreignisVerwerfen(
  ctx: DienstKontext,
  eingabe: EreignisAktion,
): Promise<EreignisErgebnis> {
  const x = pruefe(EreignisAktionSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    if (!e.verwerfenBegruendung) throw new DienstFehler('KONFLIKT', KEIN_ANTRAG);
    const von = await antragsteller(tx, e);
    if (!zweitePerson(ctx.akteur, von)) throw new DienstFehler('NICHT_BERECHTIGT', ZWEITE_PERSON);
    const offene = e.folgen.filter((f) => f.status === 'VORGESCHLAGEN');
    await tx.ereignisFolge.updateMany({
      where: { ereignisId: e.id, status: 'VORGESCHLAGEN' },
      data: { status: 'VERWORFEN' },
    });
    await tx.ereignis.update({
      where: { id: e.id },
      data: {
        status: 'VERWORFEN',
        ...(e.triagiertVon ? {} : { triagiertVon: ctx.akteur.id, triagiertAm: zeitpunkt }),
      },
    });
    return {
      wert: ergebnis(e, 'VERWORFEN'),
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_bestaetigt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, beantragtVon: von, folgenVerworfen: offene.length },
      },
    };
  });
}

export async function lehneEreignisVerwerfenAb(
  ctx: DienstKontext,
  eingabe: EreignisAktion,
): Promise<{ id: string; zurueckgezogen: boolean }> {
  const x = pruefe(EreignisAktionSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const e = await ladeZumAendern(ctx, mandantId, x.ereignisId);
    if (!e.verwerfenBegruendung) throw new DienstFehler('KONFLIKT', KEIN_ANTRAG);
    const von = await antragsteller(tx, e);
    const zurueckgezogen = gleicheId(von, ctx.akteur.id);
    await tx.ereignis.update({ where: { id: e.id }, data: { verwerfenBegruendung: null } });
    return {
      wert: { id: e.id, zurueckgezogen },
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_abgelehnt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: {
          nummer: e.nummer,
          beantragtVon: von,
          begruendung: e.verwerfenBegruendung,
          zurueckgezogen,
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Ereignis manuell erfassen (Kanzlei)
// ---------------------------------------------------------------------------

export async function erfasseEreignis(
  ctx: DienstKontext,
  eingabe: EreignisErfassen,
): Promise<EreignisErfasst> {
  const x = pruefe(EreignisErfassenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  if (!EREIGNISTYPEN.some((t) => t.code === x.typ)) {
    const text = 'Unbekannter Ereignistyp.';
    throw new DienstFehler('UNGUELTIG', text, { typ: [text] });
  }
  return aendere(ctx, async (tx, zeitpunkt) => {
    await pruefeMandant(tx, mandantId);
    if (!kannBearbeiten(ctx.akteur, mandantId))
      throw new DienstFehler('NICHT_BERECHTIGT', KEIN_RECHT);
    const programm = await programmVon(tx, mandantId);
    if (!programm) throw new DienstFehler('NICHT_GEFUNDEN', KEIN_PROGRAMM);
    const neu = await legeEreignisAn(tx, {
      programmId: programm.id,
      typ: x.typ,
      titel: x.titel,
      beschreibung: x.beschreibung,
      quelle: x.quelle,
      gemeldetVon: ctx.akteur.id,
      ereignisDatum: alsTag(x.datum),
      zeitpunkt,
    });
    return {
      wert: neu,
      protokoll: {
        aktion: 'tcms.ereignis.erfasst',
        objektTyp: 'Ereignis',
        objektId: neu.id,
        programmId: programm.id,
        detail: { nummer: neu.nummer, typ: x.typ, quelle: x.quelle, folgen: neu.folgen },
      },
    };
  });
}
