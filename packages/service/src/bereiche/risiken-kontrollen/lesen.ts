// =============================================================================
// Lader des Bereichs „risiken-kontrollen" (bisher apps/web/src/server/
// risiken-daten.ts, kontrollen-daten.ts, setup-daten.ts/Profil). Grundlage ist
// der Tax-CMS-Kontext aus dem Kern (`ladeKontext`): Bewertungen und Frequenzen
// sind dort berechnet, nie gespeichert (AGENTS.md Regel 2). Hier kommen
// stichtagsbezogene Zusatzdaten hinzu (Hinweise „neu bewerten",
// Risikoakzeptanzen, Stand-Historie, Audit-Spur, Antrag einer Abweichung)
// und die Abbildung nach JSON (ISO-Strings, nur benötigte Felder).
//
// Rechte: nur Kanzleipersonen mit Bezug zum Mandanten (TS-03). Fremder
// Mandant, fremder Tenant, unbekannte oder fremde Objekt-ID → NICHT_GEFUNDEN.
// =============================================================================

import {
  KontrolleLesenSchema,
  KontrollenLesenSchema,
  ProfilLesenSchema,
  RisikenLesenSchema,
  RisikoLesenSchema,
  type AuditSpurZeile,
  type KontrollDurchfuehrung,
  type KontrolleDetail,
  type KontrolleEintrag,
  type KontrollenLesen,
  type KontrolleLesen,
  type KontrollenListe,
  type NeuBewertenHinweis,
  type ProfilDaten,
  type ProfilLesen,
  type RisikenListe,
  type RisikenLesen,
  type RisikoakzeptanzEintrag,
  type RisikoDetail,
  type RisikoEintrag,
  type RisikoLesen,
  DienstFehler,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  brutto,
  fmtDatum,
  katalogRisiko,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  type Geschaeftsprofil,
} from '@tcms/domain';
import type { DienstKontext } from '../../kontext';
import {
  ladeKontext,
  type DurchfuehrungView,
  type KontrolleView,
  type RisikoView,
  type TcmsKontext,
} from '../../kern/tcms-kontext';
import { auditGrenze, heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import { iso, kanonisch, namenFuer, pruefeEingabe, pruefeStaffLesen, tag } from './gemeinsam';
import { aenderungenGegen, antragAnzeige, type KontrolleStandRoh } from './planung';

/** Höchstzahl Audit-Einträge je Objekt in der Detailansicht. */
const AUDIT_LIMIT = 40;

/** Profilfragen (p1–p12), auf die sich die Anwendbarkeit eines Katalogrisikos stützt. */
function anwendbarkeitsFragen(anwendbarWenn: string | undefined): string[] {
  if (!anwendbarWenn) return [];
  return [...new Set([...anwendbarWenn.matchAll(/P(\d{1,2})/g)].map((m) => `p${m[1]}`))];
}

function lesestand(k: TcmsKontext) {
  return {
    mandantId: k.mandant.id,
    programmId: k.programm?.id ?? null,
    heute: tag(k.heute),
    stand: tag(k.stand),
    historisch: k.historisch,
  };
}

function betriebAktiv(k: TcmsKontext): boolean {
  return !!k.programm?.wirksamAb && k.programm.wirksamAb.getTime() <= k.stand.getTime();
}

/** Staff-Leserecht prüfen, dann Kontext laden (der Kern prüft `kannLesen` erneut). */
async function kontextFuerStaff(
  ctx: DienstKontext,
  mandantId: string,
  stand: string | undefined,
): Promise<TcmsKontext> {
  pruefeStaffLesen(ctx.akteur, mandantId);
  return ladeKontext(ctx, { mandantId, ...(stand ? { stand } : {}) });
}

// -----------------------------------------------------------------------------
// Hinweise „neu bewerten" und Risikoakzeptanzen
// -----------------------------------------------------------------------------

/** Welche Profilfragen haben sich zwischen aufeinanderfolgenden Profilständen geändert? */
async function profilAenderungen(
  tx: Tx,
  programmId: string,
  ende: Date,
): Promise<{ am: Date; fragen: string[] }[]> {
  const staende = await tx.profilStand.findMany({
    where: { programmId, gueltigAb: { lte: ende } },
    orderBy: { gueltigAb: 'asc' },
    select: { gueltigAb: true, antworten: true },
  });
  const out: { am: Date; fragen: string[] }[] = [];
  for (let i = 1; i < staende.length; i++) {
    const vorher = staende[i - 1]!.antworten as Record<string, unknown>;
    const nachher = staende[i]!.antworten as Record<string, unknown>;
    const fragen = PROFIL_FRAGEN.map((f) => f.key as string).filter(
      (k) => JSON.stringify(vorher[k] ?? null) !== JSON.stringify(nachher[k] ?? null),
    );
    if (fragen.length) out.push({ am: staende[i]!.gueltigAb, fragen });
  }
  return out;
}

/**
 * Deterministische Hinweise „neu bewerten" je Risiko-ID (AGENTS.md Regel 7:
 * jeder Hinweis nennt seinen Grund): Markierung aus der Ereignis-Triage (nur
 * aktueller Stand), offene Ereignisfolge „Risiko neu bewerten" nach der letzten
 * Bewertung, Änderung einer Profilfrage, auf die sich die Anwendbarkeit stützt.
 */
async function neuBewertenHinweise(
  ctx: DienstKontext,
  k: TcmsKontext,
): Promise<Map<string, NeuBewertenHinweis[]>> {
  const out = new Map<string, NeuBewertenHinweis[]>();
  if (!k.programm) return out;
  const aenderungen = await profilAenderungen(ctx.tx, k.programm.id, tagesende(k.stand));
  const frageNr = new Map(PROFIL_FRAGEN.map((f) => [f.key as string, f.nr]));
  const add = (id: string, h: NeuBewertenHinweis) => out.set(id, [...(out.get(id) ?? []), h]);
  for (const r of k.risiken) {
    if (r.neuBewerten && !k.historisch)
      add(r.id, {
        quelle: 'MARKIERT',
        text: 'aus der Ereignis-Triage zur Neubewertung markiert',
        ereignisId: null,
      });
    for (const e of k.ereignisse) {
      if (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN') continue;
      if (e.gemeldetAm.getTime() <= r.gueltigAb.getTime()) continue;
      const folge = e.folgen.find(
        (f) =>
          f.art === 'RISIKO_NEU_BEWERTEN' &&
          f.ziel === r.code &&
          (f.status === 'VORGESCHLAGEN' || f.status === 'ANGELEGT'),
      );
      if (folge) {
        add(r.id, {
          quelle: 'EREIGNIS',
          ereignisId: e.id,
          text: `Ereignis ${e.nummer} (${e.typ}) vom ${fmtDatum(e.gemeldetAm)}${folge.status === 'VORGESCHLAGEN' ? ' – Triage offen' : ''}`,
        });
      }
    }
    const fragen = anwendbarkeitsFragen(katalogRisiko(r.code)?.anwendbarWenn);
    for (const a of aenderungen) {
      if (a.am.getTime() <= r.gueltigAb.getTime()) continue;
      const betroffen = a.fragen.filter((f) => fragen.includes(f));
      if (betroffen.length) {
        add(r.id, {
          quelle: 'PROFIL',
          ereignisId: null,
          text: `Profiländerung ${betroffen.map((f) => frageNr.get(f) ?? f.toUpperCase()).join(', ')} am ${fmtDatum(a.am)} (letzte Bewertung ${fmtDatum(r.gueltigAb)})`,
        });
      }
    }
  }
  return out;
}

/** Risikoakzeptanzen (Freigabe-Art RISIKOAKZEPTANZ) bis zum Stichtag, jüngste zuerst. */
async function akzeptanzen(
  ctx: DienstKontext,
  k: TcmsKontext,
): Promise<Map<string, RisikoakzeptanzEintrag[]>> {
  const out = new Map<string, RisikoakzeptanzEintrag[]>();
  if (!k.programm) return out;
  const ende = tagesende(k.stand);
  const liste = await ctx.tx.freigabe.findMany({
    where: { programmId: k.programm.id, art: 'RISIKOAKZEPTANZ', angefordertAm: { lte: ende } },
    orderBy: { angefordertAm: 'desc' },
  });
  for (const f of liste) {
    // Zum Stichtag noch nicht entschiedene Akzeptanzen gelten als offen.
    const status = f.erledigtAm && f.erledigtAm.getTime() > ende.getTime() ? 'OFFEN' : f.status;
    out.set(f.refId, [
      ...(out.get(f.refId) ?? []),
      {
        id: f.id,
        status,
        titel: f.titel,
        inhalt: f.inhalt,
        angefordertVon: f.angefordertVon,
        angefordertAm: f.angefordertAm.toISOString(),
        empfaengerId: f.empfaengerId,
        anmerkung: status === 'OFFEN' ? null : f.anmerkung,
        erledigtAm: status === 'OFFEN' ? null : iso(f.erledigtAm),
      },
    ]);
  }
  return out;
}

function risikoEintrag(
  r: RisikoView,
  hinweise: NeuBewertenHinweis[],
  akz: RisikoakzeptanzEintrag[],
): RisikoEintrag {
  return {
    id: r.id,
    code: r.code,
    gruppe: r.gruppe,
    gruppeLabel: r.gruppeLabel,
    kern: r.kern,
    herkunft: r.herkunft,
    freigabe: r.freigabe,
    freigabeEingereichtVon: r.freigabeEingereichtVon,
    freigegebenVon: r.freigegebenVon,
    freigegebenAm: iso(r.freigegebenAm),
    ownerId: r.ownerId,
    neuBewerten: r.neuBewerten,
    vorschlagsgrund: r.vorschlagsgrund,
    standId: r.standId,
    titel: r.titel,
    fehlerquelle: r.fehlerquelle,
    folge: r.folge,
    normanker: r.normanker.map((n) => ({ text: n.text, stufe: n.stufe })),
    s: r.s,
    w: r.w,
    r: r.r,
    gt: r.gt,
    gueltigAb: r.gueltigAb.toISOString(),
    kontrollIds: [...r.kontrollIds],
    bewertung: structuredClone(r.bewertung),
    netto: r.netto,
    ueberAppetit: r.ueberAppetit,
    uebersteuerungen: r.uebersteuerungen.map((u) => ({
      id: u.id,
      sicht: u.sicht,
      klasse: u.klasse,
      berechnet: u.berechnet,
      begruendung: u.begruendung,
      status: u.status,
      beantragtVon: u.beantragtVon,
      beantragtAm: u.beantragtAm.toISOString(),
      entschiedenVon: u.entschiedenVon,
      entschiedenAm: iso(u.entschiedenAm),
    })),
    offeneEreignisse: r.offeneEreignisse,
    wirktAuf: [...r.wirktAuf],
    hinweise,
    akzeptanzen: akz,
  };
}

function personenDesRisikos(r: RisikoEintrag): (string | null)[] {
  return [
    r.freigabeEingereichtVon,
    r.freigegebenVon,
    r.ownerId,
    ...r.uebersteuerungen.flatMap((u) => [u.beantragtVon, u.entschiedenVon]),
    ...r.akzeptanzen.flatMap((a) => [a.angefordertVon, a.empfaengerId]),
  ];
}

async function auditSpur(
  tx: Tx,
  k: TcmsKontext,
  objektTyp: 'Risiko' | 'Kontrolle',
  objektId: string,
): Promise<AuditSpurZeile[]> {
  const zeilen = await tx.auditEvent.findMany({
    // Audit-Zeitstempel sind echte Zeit (auditGrenze, kern/zeit.ts).
    where: {
      objektTyp,
      objektId,
      programmId: k.programm!.id,
      at: { lte: auditGrenze(k.stand, k.heute) },
    },
    orderBy: { seq: 'desc' },
    take: AUDIT_LIMIT,
    select: { seq: true, at: true, actorId: true, aktion: true, detail: true },
  });
  return zeilen.map((a) => ({
    seq: a.seq,
    at: a.at.toISOString(),
    actorId: a.actorId,
    aktion: a.aktion,
    detail: (a.detail && typeof a.detail === 'object' && !Array.isArray(a.detail)
      ? a.detail
      : {}) as Record<string, unknown>,
  }));
}

// -----------------------------------------------------------------------------
// Risiken
// -----------------------------------------------------------------------------

/** Risikoinventar zum Stichtag: berechnete Brutto-/Nettowerte, Hinweise, Akzeptanzen. */
export async function ladeRisiken(
  ctx: DienstKontext,
  eingabe: RisikenLesen,
): Promise<RisikenListe> {
  const e = pruefeEingabe(RisikenLesenSchema, eingabe);
  const k = await kontextFuerStaff(ctx, kanonisch(e.mandantId), e.stand);
  const [hinweise, akz] = await Promise.all([neuBewertenHinweise(ctx, k), akzeptanzen(ctx, k)]);
  const risiken = k.risiken.map((r) =>
    risikoEintrag(r, hinweise.get(r.id) ?? [], akz.get(r.id) ?? []),
  );
  return {
    ...lesestand(k),
    appetit: k.appetit,
    betriebAktiv: betriebAktiv(k),
    risiken,
    vorschlaegeOffen: k.vorschlaege.filter((v) => v.entscheidung === 'VORGESCHLAGEN').length,
    namen: await namenFuer(ctx, risiken.flatMap(personenDesRisikos)),
  };
}

/** Ein Risiko des Inventars mit Stand-Historie, Kontrollen und Audit-Spur zum Stichtag. */
export async function ladeRisiko(ctx: DienstKontext, eingabe: RisikoLesen): Promise<RisikoDetail> {
  const e = pruefeEingabe(RisikoLesenSchema, eingabe);
  const k = await kontextFuerStaff(ctx, kanonisch(e.mandantId), e.stand);
  const r = k.risiken.find((x) => x.id === e.risikoId);
  if (!r || !k.programm) throw new DienstFehler('NICHT_GEFUNDEN');
  const ende = tagesende(k.stand);
  const [hinweise, akz, roh, audit] = await Promise.all([
    neuBewertenHinweise(ctx, k),
    akzeptanzen(ctx, k),
    ctx.tx.risiko.findFirst({
      where: { id: r.id, programmId: k.programm.id },
      select: {
        aktivAb: true,
        staende: { where: { gueltigAb: { lte: ende } }, orderBy: { gueltigAb: 'desc' } },
      },
    }),
    auditSpur(ctx.tx, k, 'Risiko', r.id),
  ]);
  if (!roh) throw new DienstFehler('NICHT_GEFUNDEN');
  const risiko = risikoEintrag(r, hinweise.get(r.id) ?? [], akz.get(r.id) ?? []);
  const staende = roh.staende.map((s) => ({
    id: s.id,
    version: s.version,
    s: s.s,
    w: s.w,
    r: s.r as 1 | 2 | 3,
    gt: s.gt,
    brutto: brutto(s.s, s.w, s.r as 1 | 2 | 3).klasse,
    modell: s.modell,
    gueltigAb: s.gueltigAb.toISOString(),
    // Zum Stichtag war ein später geschlossener Stand noch offen.
    gueltigBis:
      s.gueltigBis && s.gueltigBis.getTime() <= ende.getTime() ? s.gueltigBis.toISOString() : null,
    erstelltVon: s.erstelltVon,
  }));
  const kontrollen = k.kontrollen
    .filter((x) => r.kontrollIds.includes(x.id))
    .map((x) => ({
      id: x.id,
      code: x.code,
      titel: x.titel,
      art: x.art,
      schluessel: x.schluessel,
      design: x.design,
      betrieb: x.betrieb,
      frequenz: { ...x.frequenz },
    }));
  return {
    ...lesestand(k),
    appetit: k.appetit,
    betriebAktiv: betriebAktiv(k),
    risiko,
    aktivAb: roh.aktivAb.toISOString(),
    staende,
    kontrollen,
    audit,
    namen: await namenFuer(ctx, [
      ...personenDesRisikos(risiko),
      ...staende.map((s) => s.erstelltVon),
      ...audit.map((a) => a.actorId),
    ]),
  };
}

// -----------------------------------------------------------------------------
// Kontrollen
// -----------------------------------------------------------------------------

type FeststellungJe = Map<string, { id: string; nummer: string; p153Offen: boolean }>;

/** Feststellungen je Quell-Durchführung (für „mit Befund → F-…"). */
async function feststellungenJeDurchfuehrung(tx: Tx, k: TcmsKontext): Promise<FeststellungJe> {
  const out: FeststellungJe = new Map();
  if (!k.programm) return out;
  const liste = await tx.feststellung.findMany({
    where: {
      programmId: k.programm.id,
      durchfuehrungId: { not: null },
      erfasstAm: { lte: tagesende(k.stand) },
    },
    select: { id: true, nummer: true, durchfuehrungId: true },
  });
  const offen = new Map(k.feststellungen.map((f) => [f.id, f.p153Offen]));
  for (const f of liste)
    if (f.durchfuehrungId)
      out.set(f.durchfuehrungId, {
        id: f.id,
        nummer: f.nummer,
        p153Offen: offen.get(f.id) ?? false,
      });
  return out;
}

function durchfuehrungKurz(d: DurchfuehrungView, fj: FeststellungJe): KontrollDurchfuehrung {
  return {
    id: d.id,
    periodeLabel: d.periodeLabel,
    periodeVon: d.periodeVon.toISOString(),
    periodeBis: d.periodeBis.toISOString(),
    faelligAm: d.faelligAm.toISOString(),
    status: d.status,
    anzeige: d.anzeige,
    ausserplanmaessig: d.ausserplanmaessig,
    anlass: d.anlass,
    durchgefuehrtVon: d.durchgefuehrtVon,
    gegengezeichnetVon: d.gegengezeichnetVon,
    mandantBestaetigtVon: d.mandantBestaetigtVon,
    eingereichtAm: iso(d.eingereichtAm),
    abgeschlossenAm: iso(d.abgeschlossenAm),
    nachweise: d.nachweise,
    mindestNachweise: d.mindestNachweise,
    feststellung: fj.get(d.id) ?? null,
  };
}

/** Kontrollstände bis zum Stichtag, aufsteigend nach Version. */
async function kontrollStaende(
  tx: Tx,
  kontrolleIds: readonly string[],
  ende: Date,
): Promise<Map<string, KontrolleStandRoh[]>> {
  const out = new Map<string, KontrolleStandRoh[]>();
  if (kontrolleIds.length === 0) return out;
  const staende = await tx.kontrolleStand.findMany({
    where: { kontrolleId: { in: [...kontrolleIds] }, gueltigAb: { lte: ende } },
    orderBy: { version: 'asc' },
  });
  for (const s of staende) out.set(s.kontrolleId, [...(out.get(s.kontrolleId) ?? []), s]);
  return out;
}

function kontrolleEintrag(
  x: KontrolleView,
  staende: readonly KontrolleStandRoh[],
  fj: FeststellungJe,
): KontrolleEintrag {
  const antrag = x.abweichung ? antragAnzeige(staende) : { von: null, am: null };
  return {
    id: x.id,
    code: x.code,
    standId: x.standId,
    version: x.version,
    titel: x.titel,
    ziel: x.ziel,
    art: x.art,
    ausfuehrung: x.ausfuehrung,
    vorlage: { ...x.vorlage },
    abweichung: x.abweichung
      ? {
          frequenz: { ...x.abweichung.frequenz },
          begruendung: x.abweichung.begruendung,
          freigegebenVon: x.abweichung.freigegebenVon,
          beantragtVon: antrag.von,
          beantragtAm: iso(antrag.am),
        }
      : null,
    partei: x.partei,
    schluessel: x.schluessel,
    durchfuehrendId: x.durchfuehrendId,
    vertretungId: x.vertretungId,
    gegenzeichnerId: x.gegenzeichnerId,
    gegenzeichnungMandant: x.gegenzeichnungMandant,
    nachweis: x.nachweis,
    mindestNachweise: x.mindestNachweise,
    schritte: x.schritte.map((s) => ({ titel: String(s.titel), hinweis: String(s.hinweis) })),
    kennzahlen: x.kennzahlen.map((kz) => ({
      key: kz.key,
      label: kz.label,
      sollEur: kz.sollEur ?? null,
      ...(kz.differenzAus ? { differenzAus: [kz.differenzAus[0], kz.differenzAus[1]] } : {}),
    })),
    toleranzEur: x.toleranzEur,
    faelligNachTagen: x.faelligNachTagen,
    design: x.design,
    designVon: x.designVon,
    designAm: iso(x.designAm),
    designBegruendung: x.designBegruendung,
    risikoIds: [...x.risikoIds],
    risikoCodes: [...x.risikoCodes],
    ableitung: structuredClone(x.ableitung),
    frequenz: { ...x.frequenz },
    gt: x.gt,
    betrieb: x.betrieb,
    letzte: x.letzte ? durchfuehrungKurz(x.letzte, fj) : null,
    naechste: x.naechste ? durchfuehrungKurz(x.naechste, fj) : null,
    pflichtattributeOk: x.pflichtattributeOk,
  };
}

function personenDerKontrolle(x: KontrolleEintrag): (string | null)[] {
  return [
    x.durchfuehrendId,
    x.vertretungId,
    x.gegenzeichnerId,
    x.designVon,
    x.abweichung?.freigegebenVon ?? null,
    x.abweichung?.beantragtVon ?? null,
    x.letzte?.durchgefuehrtVon ?? null,
    x.letzte?.gegengezeichnetVon ?? null,
  ];
}

/** Kontrollmatrix zum Stichtag: berechnete Frequenz, Abweichungen mit Antrag, Betrieb. */
export async function ladeKontrollen(
  ctx: DienstKontext,
  eingabe: KontrollenLesen,
): Promise<KontrollenListe> {
  const e = pruefeEingabe(KontrollenLesenSchema, eingabe);
  const k = await kontextFuerStaff(ctx, kanonisch(e.mandantId), e.stand);
  const ende = tagesende(k.stand);
  const [fj, staende] = await Promise.all([
    feststellungenJeDurchfuehrung(ctx.tx, k),
    kontrollStaende(
      ctx.tx,
      k.kontrollen.filter((x) => x.abweichung).map((x) => x.id),
      ende,
    ),
  ]);
  const kontrollen = k.kontrollen.map((x) => kontrolleEintrag(x, staende.get(x.id) ?? [], fj));
  return {
    ...lesestand(k),
    wirksamAb: iso(k.programm?.wirksamAb),
    kontrollen,
    namen: await namenFuer(ctx, kontrollen.flatMap(personenDerKontrolle)),
  };
}

/** Eine Kontrolle mit Stand-Historie, Durchführungen und Audit-Spur zum Stichtag. */
export async function ladeKontrolle(
  ctx: DienstKontext,
  eingabe: KontrolleLesen,
): Promise<KontrolleDetail> {
  const e = pruefeEingabe(KontrolleLesenSchema, eingabe);
  const k = await kontextFuerStaff(ctx, kanonisch(e.mandantId), e.stand);
  const x = k.kontrollen.find((c) => c.id === e.kontrolleId);
  if (!x || !k.programm) throw new DienstFehler('NICHT_GEFUNDEN');
  const ende = tagesende(k.stand);
  const [fj, staendeJe, audit] = await Promise.all([
    feststellungenJeDurchfuehrung(ctx.tx, k),
    kontrollStaende(ctx.tx, [x.id], ende),
    auditSpur(ctx.tx, k, 'Kontrolle', x.id),
  ]);
  const roh = staendeJe.get(x.id) ?? [];
  const kontrolle = kontrolleEintrag(x, roh, fj);
  const staende = roh
    .map((s, i) => ({
      id: s.id,
      version: s.version,
      gueltigAb: s.gueltigAb.toISOString(),
      gueltigBis:
        s.gueltigBis && s.gueltigBis.getTime() <= ende.getTime()
          ? s.gueltigBis.toISOString()
          : null,
      erstelltVon: s.erstelltVon,
      design: s.design,
      designVon: s.designVon,
      designAm: iso(s.designAm),
      designBegruendung: s.designBegruendung,
      durchfuehrendId: s.durchfuehrendId,
      vertretungId: s.vertretungId,
      gegenzeichnerId: s.gegenzeichnerId,
      gegenzeichnungMandant: s.gegenzeichnungMandant,
      abweichung:
        s.abweichungTurnus != null
          ? {
              turnus: s.abweichungTurnus,
              anlass: s.abweichungAnlass ?? false,
              begruendung: s.abweichungBegruendung,
              freigegebenVon: s.abweichungFreigegebenVon,
            }
          : null,
      aenderungen: aenderungenGegen(roh[i - 1], s),
    }))
    .reverse();
  const durchfuehrungen = k.durchfuehrungen
    .filter((d) => d.kontrolleId === x.id)
    .sort((a, b) => a.faelligAm.getTime() - b.faelligAm.getTime())
    .map((d) => durchfuehrungKurz(d, fj));
  return {
    ...lesestand(k),
    kontrolle,
    staende,
    durchfuehrungen,
    audit,
    namen: await namenFuer(ctx, [
      ...personenDerKontrolle(kontrolle),
      ...staende.flatMap((s) => [
        s.erstelltVon,
        s.designVon,
        s.durchfuehrendId,
        s.vertretungId,
        s.gegenzeichnerId,
        s.abweichung?.freigegebenVon ?? null,
      ]),
      ...durchfuehrungen.flatMap((d) => [d.durchgefuehrtVon, d.gegengezeichnetVon]),
      ...audit.map((a) => a.actorId),
    ]),
  };
}

// -----------------------------------------------------------------------------
// Geschäftsprofil
// -----------------------------------------------------------------------------

/**
 * Profilstände, Katalogvorschläge des zum Stichtag gültigen Profils (mit Grund)
 * und Risikoentscheidungen eines Mandanten. Ohne Programm: leere Listen.
 */
export async function ladeProfil(ctx: DienstKontext, eingabe: ProfilLesen): Promise<ProfilDaten> {
  const e = pruefeEingabe(ProfilLesenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeStaffLesen(ctx.akteur, mandantId);
  const mandant = await ctx.tx.mandant.findUnique({
    where: { id: mandantId },
    select: { id: true },
  });
  if (!mandant) throw new DienstFehler('NICHT_GEFUNDEN');
  const heute = heuteDatum(ctx.uhr);
  const { stand, historisch } = leseStand(e.stand, heute);
  const ende = tagesende(stand);
  const programm = await ctx.tx.tcmsProgramm.findFirst({
    where: { mandantId },
    select: {
      id: true,
      version1Am: true,
      // Bis zum Stichtag erfasste Stände, auch im Voraus erfasste (künftig gültige).
      profile: {
        where: { createdAt: { lte: ende } },
        orderBy: [{ gueltigAb: 'asc' }, { createdAt: 'asc' }],
      },
      risiken: {
        where: { createdAt: { lte: ende } },
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          kern: true,
          entscheidung: true,
          vorschlagsgrund: true,
          ablehnungsgrund: true,
          inaktivAb: true,
          neuBewerten: true,
          createdAt: true,
        },
      },
    },
  });
  const basis = {
    mandantId,
    programmId: programm?.id ?? null,
    heute: tag(heute),
    stand: tag(stand),
    historisch,
    version1Am: iso(programm?.version1Am),
  };
  if (!programm) return { ...basis, staende: [], vorschlaege: [], risiken: [], namen: {} };

  const staende = programm.profile.map((s) => ({
    id: s.id,
    version: s.version,
    antworten: s.antworten as unknown as Geschaeftsprofil,
    gueltigAb: s.gueltigAb.toISOString(),
    gueltigBis:
      s.gueltigBis && s.gueltigBis.getTime() <= ende.getTime() ? s.gueltigBis.toISOString() : null,
    erstelltVon: s.erstelltVon,
    createdAt: s.createdAt.toISOString(),
  }));
  const gueltig = [...programm.profile]
    .filter((s) => !s.gueltigBis || s.gueltigBis.getTime() > ende.getTime())
    .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
  const risikoJe = new Map(programm.risiken.map((r) => [r.code, r]));
  const vorschlaege = gueltig
    ? schlageRisikenVor(gueltig.antworten as unknown as Geschaeftsprofil).map((v) => {
        const r = risikoJe.get(v.code);
        const entscheidung =
          !r || r.entscheidung === 'VORGESCHLAGEN'
            ? ('OFFEN' as const)
            : r.entscheidung === 'ABGELEHNT'
              ? ('ABGELEHNT' as const)
              : r.inaktivAb && r.inaktivAb.getTime() <= ende.getTime()
                ? ('DEAKTIVIERT' as const)
                : ('UEBERNOMMEN' as const);
        return {
          code: v.code,
          kern: v.kern,
          grund: v.grund,
          frage: v.frage,
          entscheidung,
          risikoId: r?.id ?? null,
        };
      })
    : [];
  return {
    ...basis,
    staende,
    vorschlaege,
    risiken: programm.risiken.map((r) => ({
      ...r,
      inaktivAb: iso(r.inaktivAb),
      createdAt: r.createdAt.toISOString(),
    })),
    namen: await namenFuer(
      ctx,
      staende.map((s) => s.erstelltVon),
    ),
  };
}
