// =============================================================================
// Feststellungen und Maßnahmen (S10): schreibende Operationen.
//
// Muster jeder Operation (TS-05, ADR 0001 §5, AGENTS.md Regeln 1, 4, 5):
//   1. Eingabe streng prüfen (Contract-Schema), kein Stichtag (TS-07).
//   2. Kanzleiperson mit Bezug zu diesem Mandanten (sonst NICHT_GEFUNDEN).
//   3. In der Transaktion: Zeile mit FOR UPDATE sperren – dabei Zugehörigkeit
//      zum Programm dieses Mandanten prüfen (sonst NICHT_GEFUNDEN) –, dann
//      Recht (NICHT_BERECHTIGT mit Grund), Vertraulichkeit und Status aus der
//      gesperrten Zeile prüfen (KONFLIKT), ändern und protokollieren (mitAudit).
// =============================================================================

import {
  DienstFehler,
  nichtBerechtigt,
  ErklaerungSchema,
  FeststellungAktionSchema,
  FeststellungErfassenSchema,
  FeststellungVerwerfenBeantragenSchema,
  FeststellungWeiterSchema,
  MassnahmeErledigenSchema,
  MassnahmeSchema,
  NachkontrolleSchema,
  P153Schema,
  VertraulichSchema,
  WuerdigungSchema,
  type ErklaerungEingabe,
  type ErklaerungErgebnis,
  type FeststellungAktion,
  type FeststellungErfassen,
  type FeststellungErfasst,
  type FeststellungErgebnis,
  type FeststellungVerwerfenBeantragen,
  type FeststellungWeiter,
  type MassnahmeEingabe,
  type MassnahmeErgebnis,
  type MassnahmeErledigenEingabe,
  type NachkontrolleEingabe,
  type NachkontrolleErgebnis,
  type P153Eingabe,
  type P153Ergebnis,
  type VertraulichEingabe,
  type VertraulichErgebnis,
  type VerwerfenAbgelehnt,
  type WuerdigungEingabe,
} from '@tcms/contract';
import { naechsterFeststellungsschritt, p153Erforderlich } from '@tcms/domain';
import type { Protokoll } from '../../audit';
import { naechsteWiedervorlageNr } from '../../kern/nummern';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import {
  gleicheId,
  kannBearbeiten,
  kannVertraulichLesen,
  kannVerwerfenBestaetigen,
  kannWuerdigen,
} from '../../rechte';
import {
  alsTag,
  GEAENDERT,
  isoTag,
  KEIN_PROGRAMM,
  KEIN_RECHT,
  legeAusserplanmaessigeDurchfuehrungAn,
  legeFeststellungAn,
  NUR_BERUFSTRAEGER,
  programmVon,
  pruefe,
  pruefeKanzleiZugriff,
  pruefeMandant,
  sperreFeststellung,
  sperreMassnahme,
  VERTRAULICH,
  aendere,
} from './gemeinsam';

const ABGESCHLOSSEN =
  'Die Feststellung ist geschlossen oder verworfen und kann nicht mehr geändert werden.';
const FRIST_VERGANGEN = 'Die Frist darf nicht in der Vergangenheit liegen.';
const KEIN_ANTRAG = 'Es liegt kein offener Antrag auf Verwerfen vor.';

/** Eine Entscheidung „weitere Klärung" ist nicht abschließend und erlaubt eine Folgeentscheidung. */
export function p153Abschliessend(e: string | null | undefined): boolean {
  return e != null && e !== 'WEITERE_KLAERUNG';
}

// ---------------------------------------------------------------------------
// Laden und Prüfen unter Sperre
// ---------------------------------------------------------------------------

async function ladeGesperrt(ctx: DienstKontext, mandantId: string, feststellungId: string) {
  await sperreFeststellung(ctx.tx, mandantId, feststellungId);
  return ctx.tx.feststellung.findUniqueOrThrow({
    where: { id: feststellungId },
    include: { massnahmen: true, nachkontrolle: true },
  });
}
type Gesperrt = Awaited<ReturnType<typeof ladeGesperrt>>;

/** Beteiligte einer Feststellung (Fachkonzept §13), wie im Lader. */
export function beteiligteVon(f: {
  erfasstVon: string;
  p153EntschiedenVon: string | null;
  verwerfenBeantragtVon: string | null;
  massnahmen: readonly { verantwortlich: string }[];
}): string[] {
  return [
    f.erfasstVon,
    f.p153EntschiedenVon,
    f.verwerfenBeantragtVon,
    ...f.massnahmen.map((m) => m.verantwortlich),
  ].filter((x): x is string => !!x);
}

function pruefeVertraulich(ctx: DienstKontext, mandantId: string, f: Gesperrt): void {
  if (f.vertraulich && !kannVertraulichLesen(ctx.akteur, mandantId, beteiligteVon(f))) {
    throw nichtBerechtigt('VERTRAULICH', VERTRAULICH);
  }
}

function pruefeBearbeiten(ctx: DienstKontext, mandantId: string): void {
  if (!kannBearbeiten(ctx.akteur, mandantId)) throw nichtBerechtigt('BEARBEITEN', KEIN_RECHT);
}

function pruefeOffen(f: { status: string }): void {
  if (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN') {
    throw new DienstFehler('KONFLIKT', ABGESCHLOSSEN);
  }
}

/** Gemeinsame Prüfung der meisten Änderungen: Bearbeitungsrecht, Vertraulichkeit, offen. */
async function ladeZumAendern(ctx: DienstKontext, mandantId: string, feststellungId: string) {
  const f = await ladeGesperrt(ctx, mandantId, feststellungId);
  pruefeBearbeiten(ctx, mandantId);
  pruefeVertraulich(ctx, mandantId, f);
  pruefeOffen(f);
  return f;
}

function statusProtokoll(
  f: { id: string; nummer: string; programmId: string },
  von: string,
  nach: string,
  grund?: string,
): Protokoll {
  return {
    aktion: 'tcms.feststellung.status',
    objektTyp: 'Feststellung',
    objektId: f.id,
    programmId: f.programmId,
    detail: { nummer: f.nummer, von, nach, ...(grund ? { grund } : {}) },
  };
}

function ergebnis(f: { id: string; nummer: string }, status: FeststellungErgebnis['status']) {
  return { id: f.id, nummer: f.nummer, status };
}

// ---------------------------------------------------------------------------
// Status weiterschalten
// ---------------------------------------------------------------------------

/**
 * Fachlich gesperrter Schritt auf dem gesehenen Stand: `UNGUELTIG` mit
 * Feldfehler `von` (der Aufrufer kann ihn erst nach einer anderen Handlung
 * gehen); `KONFLIKT` bleibt der gleichzeitigen Änderung vorbehalten.
 */
function schrittGesperrt(text: string): DienstFehler {
  return new DienstFehler('UNGUELTIG', text, { von: [text] });
}

/**
 * Schaltet die Feststellung einen Schritt weiter (`naechsterFeststellungsschritt`).
 * `von` ist der Status, den der Aufrufer gesehen hat: Zwei gleichzeitige
 * Klicks schalten so nicht zwei Schritte weiter (TS-05). Unter der
 * Zeilensperre: Recht und Vertraulichkeit (403), dann ein anderer als der
 * gesehene Status → `KONFLIKT` (409, gleichzeitige Änderung), dann die
 * fachlichen Sperren des gesehenen Stands (abgeschlossen, kein weiterer
 * Schritt, Bedingung offen) → `UNGUELTIG` mit Feldfehler `von` (400).
 */
export async function schalteFeststellungWeiter(
  ctx: DienstKontext,
  eingabe: FeststellungWeiter,
): Promise<FeststellungErgebnis> {
  const e = pruefe(FeststellungWeiterSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const f = await ladeGesperrt(ctx, mandantId, e.feststellungId);
    pruefeBearbeiten(ctx, mandantId);
    pruefeVertraulich(ctx, mandantId, f);
    if (f.status !== e.von) throw new DienstFehler('KONFLIKT', GEAENDERT);
    if (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN') {
      throw schrittGesperrt(ABGESCHLOSSEN);
    }
    const schritt = naechsterFeststellungsschritt({
      status: f.status,
      auswirkung: f.auswirkung,
      p153Entschieden: p153Abschliessend(f.p153Entscheidung),
      massnahmen: f.massnahmen.length,
      massnahmenOffen: f.massnahmen.filter((m) => m.status === 'OFFEN').length,
      nachkontrolleOhneBefund:
        f.nachkontrolle?.status === 'OHNE_BEFUND' && !!f.nachkontrolle.gegengezeichnetVon,
    });
    if (!schritt.ziel) {
      throw schrittGesperrt('Für diesen Status gibt es keinen weiteren Schritt.');
    }
    if (schritt.blockiert) {
      throw schrittGesperrt(`Noch nicht möglich: ${schritt.blockiert}.`);
    }
    const ziel = schritt.ziel;
    const n = await tx.feststellung.updateMany({
      where: { id: f.id, status: f.status },
      data: { status: ziel, ...(ziel === 'GESCHLOSSEN' ? { geschlossenAm: zeitpunkt } : {}) },
    });
    if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    return { wert: ergebnis(f, ziel), protokoll: statusProtokoll(f, f.status, ziel) };
  });
}

// ---------------------------------------------------------------------------
// §-153-Würdigung (nur Berufsträger:in mit Zuständigkeit, höchstpersönlich)
// ---------------------------------------------------------------------------

/**
 * Dokumentiert die §-153-Würdigung. Nur `kannWuerdigen` (AGENTS.md Regel 5);
 * die vier Optionen sind gleichrangig, die Entscheidung ist Pflicht (kein
 * Standardwert). Eine abschließende Entscheidung ist endgültig; jede weitere –
 * auch gleichzeitige – Entscheidung ergibt KONFLIKT. Nach „weitere Klärung"
 * ist eine Folgeentscheidung möglich, aber nur auf dem Stand, den der
 * Aufrufer gesehen hat (`bisher`).
 */
export async function entscheideP153(
  ctx: DienstKontext,
  eingabe: P153Eingabe,
): Promise<P153Ergebnis> {
  const e = pruefe(P153Schema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const braucheFrist = e.entscheidung === 'BERICHTIGUNG' || e.entscheidung === 'WEITERE_KLAERUNG';
  if (braucheFrist && !e.frist) {
    const text =
      e.entscheidung === 'BERICHTIGUNG'
        ? 'Bitte eine Frist für die Berichtigung setzen.'
        : 'Bitte das Datum setzen, bis zu dem geklärt wird.';
    throw new DienstFehler('UNGUELTIG', text, { frist: [text] });
  }
  const frist = braucheFrist && e.frist ? alsTag(e.frist) : null;
  if (frist && frist.getTime() < heuteDatum(ctx.uhr).getTime()) {
    throw new DienstFehler('UNGUELTIG', FRIST_VERGANGEN, { frist: [FRIST_VERGANGEN] });
  }
  return aendere(ctx, async (tx, zeitpunkt) => {
    const f = await ladeGesperrt(ctx, mandantId, e.feststellungId);
    // Höchstpersönlich: ausschließlich zuständige Berufsträger:innen (oder Admin-BT).
    if (!kannWuerdigen(ctx.akteur, mandantId)) {
      throw nichtBerechtigt('WUERDIGEN', NUR_BERUFSTRAEGER);
    }
    pruefeVertraulich(ctx, mandantId, f);
    pruefeOffen(f);
    if (!p153Erforderlich(f.auswirkung)) {
      throw new DienstFehler(
        'KONFLIKT',
        'Ohne steuerliche Auswirkung („nein") gibt es keinen §-153-Pfad.',
      );
    }
    if (p153Abschliessend(f.p153Entscheidung)) {
      throw new DienstFehler('KONFLIKT', 'Die §-153-Würdigung ist bereits dokumentiert.');
    }
    if ((f.p153Entscheidung ?? null) !== e.bisher) throw new DienstFehler('KONFLIKT', GEAENDERT);

    const n = await tx.feststellung.updateMany({
      where: { id: f.id, p153Entscheidung: f.p153Entscheidung },
      data: {
        p153Entscheidung: e.entscheidung,
        p153Begruendung: e.begruendung,
        p153Frist: frist,
        p153EntschiedenVon: ctx.akteur.id,
        p153EntschiedenAm: zeitpunkt,
        ...(f.status === 'ERFASST' ? { status: 'IN_WUERDIGUNG' as const } : {}),
      },
    });
    if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.feststellung.p153_entschieden',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          entscheidung: e.entscheidung,
          frist: frist ? isoTag(frist) : null,
          vorher: f.p153Entscheidung,
        },
      },
    ];
    if (f.status === 'ERFASST') protokoll.push(statusProtokoll(f, 'ERFASST', 'IN_WUERDIGUNG'));
    // Wiedervorlage mit der vom Berufsträger gesetzten Frist (Fachkonzept §9, §-153-Pfad Schritt 3).
    let nr: number | null = null;
    if (frist) {
      nr = await naechsteWiedervorlageNr(tx);
      const beschreibung =
        e.entscheidung === 'BERICHTIGUNG'
          ? 'Berichtigung veranlassen und Nachweis ablegen (Übermittlungsprotokoll, Bescheid)'
          : 'Sachverhalt klären und §-153-Würdigung erneut vornehmen';
      const m = await tx.massnahme.create({
        data: {
          feststellungId: f.id,
          wiedervorlageNr: nr,
          beschreibung,
          verantwortlich: ctx.akteur.id,
          frist,
          createdAt: zeitpunkt,
        },
        select: { id: true },
      });
      protokoll.push({
        aktion: 'tcms.massnahme.angelegt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, wiedervorlageNr: nr, beschreibung, frist: isoTag(frist) },
      });
    }
    return {
      wert: { id: f.id, entscheidung: e.entscheidung, wiedervorlageNr: nr },
      protokoll,
    };
  });
}

// ---------------------------------------------------------------------------
// Würdigungsangaben und betroffene Erklärungen
// ---------------------------------------------------------------------------

/**
 * Schwere, Auswirkung, Ursache bis zum Ende der Würdigung. Herabstufen auf
 * „keine Auswirkung" beendet den §-153-Pfad und ist eine Würdigungs-
 * entscheidung: nur mit `kannWuerdigen` (TS-04, AGENTS.md Regel 5).
 */
export async function aktualisiereWuerdigung(
  ctx: DienstKontext,
  eingabe: WuerdigungEingabe,
): Promise<FeststellungErgebnis> {
  const e = pruefe(WuerdigungSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (f.status !== 'ERFASST' && f.status !== 'IN_WUERDIGUNG') {
      throw new DienstFehler(
        'KONFLIKT',
        'Schwere und Auswirkung sind nur bis zum Ende der Würdigung änderbar.',
      );
    }
    if (f.p153Entscheidung && e.auswirkung !== f.auswirkung) {
      throw new DienstFehler(
        'KONFLIKT',
        'Nach dokumentierter §-153-Würdigung ist die steuerliche Auswirkung nicht mehr änderbar.',
      );
    }
    if (
      f.auswirkung !== 'NEIN' &&
      e.auswirkung === 'NEIN' &&
      !kannWuerdigen(ctx.akteur, mandantId)
    ) {
      throw nichtBerechtigt(
        'WUERDIGEN',
        `${NUR_BERUFSTRAEGER} Die steuerliche Auswirkung auf „nein“ zu setzen beendet die §-153-Würdigung.`,
      );
    }
    const ursache = e.ursache ? e.ursache : null;
    await tx.feststellung.update({
      where: { id: f.id },
      data: { schwere: e.schwere, auswirkung: e.auswirkung, ursache },
    });
    return {
      wert: ergebnis(f, f.status),
      protokoll: {
        aktion: 'tcms.feststellung.wuerdigung',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          vorher: { schwere: f.schwere, auswirkung: f.auswirkung, ursache: f.ursache },
          nachher: { schwere: e.schwere, auswirkung: e.auswirkung, ursache },
        },
      },
    };
  });
}

export async function fuegeErklaerungHinzu(
  ctx: DienstKontext,
  eingabe: ErklaerungEingabe,
): Promise<ErklaerungErgebnis> {
  const e = pruefe(ErklaerungSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const betrag = e.auswirkungEur == null ? null : Math.round(e.auswirkungEur * 100) / 100;
  const land = e.land.toUpperCase();
  return aendere(ctx, async (tx) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    const neu = await tx.betroffeneErklaerung.create({
      data: {
        feststellungId: f.id,
        steuerart: e.steuerart,
        land,
        zeitraum: e.zeitraum,
        auswirkungEur: betrag,
      },
      select: { id: true },
    });
    return {
      wert: { id: neu.id, feststellungId: f.id },
      protokoll: {
        aktion: 'tcms.feststellung.erklaerung',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          erklaerungId: neu.id,
          steuerart: e.steuerart,
          land,
          zeitraum: e.zeitraum,
          auswirkungEur: betrag,
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Maßnahmen
// ---------------------------------------------------------------------------

/**
 * Legt eine Maßnahme mit kanzleiweiter Wiedervorlage-Nummer an (Nummernkreis
 * unter Sperre je Tenant). Verantwortlich ist eine Kanzleiperson (ID der
 * kanzleikonsole) oder ein Mandantenkontakt mit aktiver Rolle bei genau
 * diesem Mandanten.
 */
export async function legeMassnahmeAn(
  ctx: DienstKontext,
  eingabe: MassnahmeEingabe,
): Promise<MassnahmeErgebnis> {
  const e = pruefe(MassnahmeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const frist = alsTag(e.frist);
  if (frist.getTime() < heuteDatum(ctx.uhr).getTime()) {
    throw new DienstFehler('UNGUELTIG', FRIST_VERGANGEN, { frist: [FRIST_VERGANGEN] });
  }
  const verantwortlich = e.verantwortlich.id.toLowerCase();
  return aendere(ctx, async (tx, zeitpunkt) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (e.verantwortlich.art === 'MANDANT') {
      const rollen = await tx.mandantKontaktRolle.count({
        where: { mandantId, kontaktId: verantwortlich, aktiv: true },
      });
      if (rollen === 0) {
        const text = 'Die verantwortliche Person ist für diesen Mandanten nicht zulässig.';
        throw new DienstFehler('UNGUELTIG', text, { verantwortlich: [text] });
      }
    }
    const wv = await naechsteWiedervorlageNr(tx);
    const m = await tx.massnahme.create({
      data: {
        feststellungId: f.id,
        wiedervorlageNr: wv,
        beschreibung: e.beschreibung,
        verantwortlich,
        frist,
        createdAt: zeitpunkt,
      },
      select: { id: true },
    });
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.massnahme.angelegt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          wiedervorlageNr: wv,
          beschreibung: e.beschreibung,
          verantwortlich,
          frist: isoTag(frist),
        },
      },
    ];
    // Neue offene Maßnahme während der Nachkontrolle: zurück auf „Maßnahmen offen".
    if (f.status === 'NACHKONTROLLE') {
      await tx.feststellung.update({ where: { id: f.id }, data: { status: 'MASSNAHMEN_OFFEN' } });
      protokoll.push(
        statusProtokoll(f, 'NACHKONTROLLE', 'MASSNAHMEN_OFFEN', `neue Maßnahme #${wv}`),
      );
    }
    return { wert: { id: m.id, wiedervorlageNr: wv }, protokoll };
  });
}

/**
 * Erledigt eine offene Maßnahme: Bearbeitungsrecht oder die verantwortliche
 * Person selbst (Kanzleiperson mit Bezug zum Mandanten). Doppeltes Erledigen
 * ergibt KONFLIKT (bedingtes Update unter Sperre).
 */
export async function erledigeMassnahme(
  ctx: DienstKontext,
  eingabe: MassnahmeErledigenEingabe,
): Promise<MassnahmeErgebnis> {
  const e = pruefe(MassnahmeErledigenSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx, zeitpunkt) => {
    const feststellungId = await sperreMassnahme(tx, mandantId, e.massnahmeId);
    const f = await tx.feststellung.findUniqueOrThrow({
      where: { id: feststellungId },
      include: { massnahmen: true, nachkontrolle: true },
    });
    const m = f.massnahmen.find((x) => x.id === e.massnahmeId);
    if (!m) throw new DienstFehler('NICHT_GEFUNDEN');
    if (!kannBearbeiten(ctx.akteur, mandantId) && !gleicheId(ctx.akteur.id, m.verantwortlich)) {
      throw nichtBerechtigt('BEARBEITEN', KEIN_RECHT);
    }
    pruefeVertraulich(ctx, mandantId, f);
    pruefeOffen(f);
    if (m.status !== 'OFFEN')
      throw new DienstFehler('KONFLIKT', 'Die Maßnahme ist bereits erledigt.');
    const n = await tx.massnahme.updateMany({
      where: { id: m.id, status: 'OFFEN' },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt, erledigtVon: ctx.akteur.id },
    });
    if (n.count !== 1) throw new DienstFehler('KONFLIKT', GEAENDERT);
    return {
      wert: { id: m.id, wiedervorlageNr: m.wiedervorlageNr },
      protokoll: {
        aktion: 'tcms.massnahme.erledigt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, wiedervorlageNr: m.wiedervorlageNr, nachweis: e.nachweis },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Nachkontrolle: außerplanmäßige Durchführung anlegen und verknüpfen
// ---------------------------------------------------------------------------

export async function legeNachkontrolleAn(
  ctx: DienstKontext,
  eingabe: NachkontrolleEingabe,
): Promise<NachkontrolleErgebnis> {
  const e = pruefe(NachkontrolleSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const faelligAm = alsTag(e.faelligAm);
  if (faelligAm.getTime() < heuteDatum(ctx.uhr).getTime()) {
    const text = 'Die Fälligkeit darf nicht in der Vergangenheit liegen.';
    throw new DienstFehler('UNGUELTIG', text, { faelligAm: [text] });
  }
  return aendere(ctx, async (tx, zeitpunkt) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (f.status !== 'MASSNAHMEN_OFFEN' && f.status !== 'NACHKONTROLLE') {
      throw new DienstFehler(
        'KONFLIKT',
        'Eine Nachkontrolle ist ab dem Status „Maßnahmen offen" möglich.',
      );
    }
    const nk = f.nachkontrolle;
    if (nk && nk.status !== 'MIT_BEFUND' && nk.status !== 'ENTFALLEN') {
      throw new DienstFehler('KONFLIKT', 'Es ist bereits eine Nachkontrolle verknüpft.');
    }
    const d = await legeAusserplanmaessigeDurchfuehrungAn(tx, {
      programmId: f.programmId,
      kontrolleId: e.kontrolleId,
      faelligAm,
      anlass: `Nachkontrolle ${f.nummer}`,
      label: `außerplanmäßig (Nachkontrolle ${f.nummer})`,
      zeitpunkt,
    });
    await tx.feststellung.update({ where: { id: f.id }, data: { nachkontrolleId: d.id } });
    return {
      wert: { durchfuehrungId: d.id, kontrolleCode: d.code },
      protokoll: [
        {
          aktion: 'tcms.feststellung.nachkontrolle',
          objektTyp: 'Feststellung',
          objektId: f.id,
          programmId: f.programmId,
          detail: {
            nummer: f.nummer,
            durchfuehrungId: d.id,
            kontrolle: d.code,
            faelligAm: e.faelligAm,
          },
        },
        {
          aktion: 'tcms.durchfuehrung.ausserplanmaessig',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: f.programmId,
          detail: {
            kontrolle: d.code,
            anlass: `Nachkontrolle ${f.nummer}`,
            faelligAm: e.faelligAm,
          },
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Verwerfen (Begründung ≥ 30, Bestätigung durch eine zweite Person)
// ---------------------------------------------------------------------------

export async function beantrageFeststellungVerwerfen(
  ctx: DienstKontext,
  eingabe: FeststellungVerwerfenBeantragen,
): Promise<FeststellungErgebnis> {
  const e = pruefe(FeststellungVerwerfenBeantragenSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (f.verwerfenBeantragtVon && !f.verwerfenBestaetigtVon) {
      throw new DienstFehler('KONFLIKT', 'Das Verwerfen ist bereits beantragt.');
    }
    await tx.feststellung.update({
      where: { id: f.id },
      data: {
        verwerfenBegruendung: e.begruendung,
        verwerfenBeantragtVon: ctx.akteur.id,
        verwerfenBestaetigtVon: null,
      },
    });
    return {
      wert: ergebnis(f, f.status),
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_beantragt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, begruendung: e.begruendung },
      },
    };
  });
}

/**
 * Bestätigt das Verwerfen. Antragsteller:in und Auswirkung werden aus der
 * gesperrten Zeile gelesen; bestätigen darf nur eine zweite Person (AGENTS.md
 * Regel 4), bei Auswirkung „JA" oder „UNKLAR" nur mit `kannWuerdigen`
 * (Regel 5, `kannVerwerfenBestaetigen`).
 */
export async function bestaetigeFeststellungVerwerfen(
  ctx: DienstKontext,
  eingabe: FeststellungAktion,
): Promise<FeststellungErgebnis> {
  const e = pruefe(FeststellungAktionSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (!f.verwerfenBeantragtVon || f.verwerfenBestaetigtVon) {
      throw new DienstFehler('KONFLIKT', KEIN_ANTRAG);
    }
    // Vier-Augen und – bei nicht ausgeschlossener Steuerwirkung – Würdigungsrecht,
    // beides aus der gesperrten Zeile (Antrag, Auswirkung).
    const recht = kannVerwerfenBestaetigen(
      ctx.akteur,
      mandantId,
      f.verwerfenBeantragtVon,
      f.auswirkung,
    );
    if (!recht.erlaubt) throw nichtBerechtigt(recht.verweigerung, recht.grund);
    await tx.feststellung.update({
      where: { id: f.id },
      data: { status: 'VERWORFEN', verwerfenBestaetigtVon: ctx.akteur.id },
    });
    return {
      wert: ergebnis(f, 'VERWORFEN'),
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_bestaetigt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          von: f.status,
          nach: 'VERWORFEN',
          beantragtVon: f.verwerfenBeantragtVon,
        },
      },
    };
  });
}

/** Lehnt einen offenen Antrag ab bzw. zieht ihn zurück (Antragsteller:in selbst). */
export async function lehneFeststellungVerwerfenAb(
  ctx: DienstKontext,
  eingabe: FeststellungAktion,
): Promise<VerwerfenAbgelehnt> {
  const e = pruefe(FeststellungAktionSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  return aendere(ctx, async (tx) => {
    const f = await ladeZumAendern(ctx, mandantId, e.feststellungId);
    if (!f.verwerfenBeantragtVon || f.verwerfenBestaetigtVon) {
      throw new DienstFehler('KONFLIKT', KEIN_ANTRAG);
    }
    const zurueckgezogen = gleicheId(f.verwerfenBeantragtVon, ctx.akteur.id);
    await tx.feststellung.update({
      where: { id: f.id },
      data: { verwerfenBegruendung: null, verwerfenBeantragtVon: null },
    });
    return {
      wert: { id: f.id, zurueckgezogen },
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_abgelehnt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          beantragtVon: f.verwerfenBeantragtVon,
          begruendung: f.verwerfenBegruendung,
          zurueckgezogen,
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Vertraulich (wie eine Subsumtion; nur mit Würdigungsrecht)
// ---------------------------------------------------------------------------

export async function setzeVertraulich(
  ctx: DienstKontext,
  eingabe: VertraulichEingabe,
): Promise<VertraulichErgebnis> {
  const e = pruefe(VertraulichSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const f = await ladeGesperrt(ctx, mandantId, e.feststellungId);
  if (!kannWuerdigen(ctx.akteur, mandantId)) {
    throw nichtBerechtigt('WUERDIGEN', NUR_BERUFSTRAEGER);
  }
  pruefeVertraulich(ctx, mandantId, f);
  // Unverändert: keine fachliche Änderung, also auch kein Audit-Eintrag.
  if (f.vertraulich === e.vertraulich) {
    return { id: f.id, vertraulich: f.vertraulich, geaendert: false };
  }
  // Dieselbe Transaktion: die Sperre aus `ladeGesperrt` gilt weiter (TS-05).
  return aendere(ctx, async (tx) => {
    await tx.feststellung.update({ where: { id: f.id }, data: { vertraulich: e.vertraulich } });
    return {
      wert: { id: f.id, vertraulich: e.vertraulich, geaendert: true },
      protokoll: {
        aktion: 'tcms.feststellung.vertraulich',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, vertraulich: e.vertraulich },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Feststellung manuell erfassen
// ---------------------------------------------------------------------------

/**
 * Erfasst eine Feststellung im Programm des Mandanten. „NEIN" als steuerliche
 * Auswirkung gilt nur mit `kannWuerdigen`, sonst „UNKLAR" (TS-04, über
 * `legeFeststellungAn`). Risiken und Durchführung müssen zum Programm gehören.
 */
export async function erfasseFeststellung(
  ctx: DienstKontext,
  eingabe: FeststellungErfassen,
): Promise<FeststellungErfasst> {
  const e = pruefe(FeststellungErfassenSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  if (e.durchfuehrungId && e.quelle !== 'KONTROLLE') {
    const text = 'Eine Durchführung ist nur bei Quelle „Kontrolle" zulässig.';
    throw new DienstFehler('UNGUELTIG', text, { durchfuehrungId: [text] });
  }
  return aendere(ctx, async (tx, zeitpunkt) => {
    await pruefeMandant(tx, mandantId);
    if (!kannBearbeiten(ctx.akteur, mandantId)) throw nichtBerechtigt('BEARBEITEN', KEIN_RECHT);
    const programm = await programmVon(tx, mandantId);
    if (!programm) throw new DienstFehler('NICHT_GEFUNDEN', KEIN_PROGRAMM);
    const neu = await legeFeststellungAn(ctx, zeitpunkt, {
      mandantId,
      programmId: programm.id,
      titel: e.titel,
      sachverhalt: e.sachverhalt,
      quelle: e.quelle,
      quelleText: e.quelleText,
      durchfuehrungId: e.durchfuehrungId ?? null,
      klasse: e.klasse,
      schwere: e.schwere,
      auswirkung: e.auswirkung,
      risikoIds: e.risikoIds ?? [],
      detail: { quelle: e.quelleText, manuell: true },
    });
    return {
      wert: {
        id: neu.id,
        nummer: neu.nummer,
        auswirkung: neu.auswirkung,
        auswirkungHerabgestuft: neu.auswirkungHerabgestuft,
      },
      protokoll: neu.protokoll,
    };
  });
}
