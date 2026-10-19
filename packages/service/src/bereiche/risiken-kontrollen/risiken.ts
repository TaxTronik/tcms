// =============================================================================
// Fachoperationen Risikoinventar (S4) und Risikodetail (S5), bisher
// apps/web/src/server/actions/risiken.ts.
//
// - Bewertungen werden berechnet, nie gespeichert-überschrieben (Regel 2):
//   Eingaben sind S, W, R und GT; Klassen leitet `@tcms/domain` ab.
// - Neubewertung schließt den Risikostand und legt einen neuen an (Regel 3).
// - Übersteuerung, Inventarfreigabe und Zurückweisung im Vier-Augen-Prinzip
//   (Regel 4); Entscheidungen nur aus dem erwarteten Status.
// - TS-05: Jede Operation sperrt das Risiko (SELECT … FOR UPDATE) in der
//   Transaktion von `mitAudit` und liest den Zustand erst unter der Sperre;
//   Zustandswechsel zusätzlich als bedingtes Update mit count-Prüfung.
// =============================================================================

import {
  DienstFehler,
  RisikenFreigabeSchrittSchema,
  RisikoakzeptanzAnfordernSchema,
  RisikoBestaetigenSchema,
  RisikoNeuBewertenSchema,
  RisikoZurueckweisenSchema,
  UebersteuerungBeantragenSchema,
  UebersteuerungEntscheidenSchema,
  type FreigabeSchrittErgebnis,
  type KontrollNeuplanung,
  type NeuBewertungErgebnis,
  type RisikenFreigabeSchritt,
  type RisikoakzeptanzAnfordern,
  type RisikoakzeptanzAngefordert,
  type RisikoBestaetigen,
  type RisikoNeuBewerten,
  type RisikoZurueckgewiesen,
  type RisikoZurueckweisen,
  type UebersteuerungBeantragen,
  type UebersteuerungBeantragt,
  type UebersteuerungEntscheiden,
  type UebersteuerungEntschieden,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import {
  brutto,
  BEWERTUNGSMODELL_VERSION,
  ereignisErledigt,
  fmtDatum,
  frequenzLabel,
  gleicheFrequenz,
  GOVERNANCE_LABEL,
  KLASSE_LABEL,
  mindestensSoStreng,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  type GovernanceTyp,
  type Klasse,
  type Schaden,
  type Wahrscheinlichkeit,
} from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import { ladeKontext } from '../../kern/tcms-kontext';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { zweitePerson } from '../../rechte';
import { legeNachrichtAn } from '../programm-beschreibung/nachrichten';
import {
  kanonisch,
  konflikt,
  konfliktSicher,
  pruefeBearbeiten,
  pruefeEingabe,
  programmDes,
  sperreKontrollen,
  sperreRisiken,
  ZWEITE_PERSON,
} from './gemeinsam';
import {
  aktuelleRisikenDerKontrolle,
  effektiveFrequenz,
  neuerKontrollStand,
  planeDurchfuehrungenNeu,
} from './planung';

// -----------------------------------------------------------------------------
// Hilfen
// -----------------------------------------------------------------------------

/**
 * Sperrt das Risiko (nur, wenn es zum Programm des Mandanten gehört) und
 * liest es unter der Sperre mit offenem Stand und Programm.
 */
async function risikoUnterSperre(tx: Tx, mandantId: string, risikoId: string) {
  const programm = await programmDes(tx, mandantId);
  await sperreRisiken(tx, programm.id, [risikoId]);
  const r = await tx.risiko.findFirst({
    where: { id: risikoId, programmId: programm.id },
    include: {
      staende: { where: { gueltigBis: null } },
      programm: { select: { id: true, mandantId: true, erklaerungsTurnus: true } },
    },
  });
  if (!r) throw new DienstFehler('NICHT_GEFUNDEN');
  return r;
}

type RisikoMitStand = Awaited<ReturnType<typeof risikoUnterSperre>>;

/** Nur aktive Risiken des Inventars sind änderbar (Status hat sich sonst geändert). */
function pruefeAktiv(r: RisikoMitStand, jetzt: Date): void {
  if (
    r.entscheidung !== 'UEBERNOMMEN' ||
    r.aktivAb.getTime() > jetzt.getTime() ||
    (r.inaktivAb && r.inaktivAb.getTime() <= jetzt.getTime())
  ) {
    throw konflikt('Das Risiko ist nicht aktiv im Inventar.');
  }
}

/** Bewertung eines Risikos im aktuellen Stand (unter der bereits gehaltenen Sperre). */
async function aktuelleSicht(ctx: DienstKontext, mandantId: string, risikoId: string) {
  const k = await ladeKontext(ctx, { mandantId });
  const risiko = k.risiken.find((r) => r.id === risikoId);
  if (!risiko) throw konflikt('Das Risiko ist zum aktuellen Stand nicht im Inventar.');
  return { k, risiko };
}

/** Ereignisfolgen „Risiko neu bewerten" (in der Triage angelegt) mit der Neubewertung erledigen. */
async function erledigeEreignisFolgen(
  tx: Tx,
  programmId: string,
  code: string,
  standId: string,
  zeitpunkt: Date,
): Promise<Protokoll[]> {
  const folgen = await tx.ereignisFolge.findMany({
    where: {
      art: 'RISIKO_NEU_BEWERTEN',
      ziel: code,
      status: 'ANGELEGT',
      ereignis: { programmId, status: { in: ['NEU', 'IN_TRIAGE'] } },
    },
    select: { id: true, ereignisId: true },
  });
  const erledigt: typeof folgen = [];
  for (const f of folgen) {
    // Bedingt: eine parallel verworfene oder erledigte Folge bleibt unberührt.
    const u = await tx.ereignisFolge.updateMany({
      where: { id: f.id, status: 'ANGELEGT' },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt, objektId: standId },
    });
    if (u.count === 1) erledigt.push(f);
  }
  const protokolle: Protokoll[] = [];
  for (const ereignisId of new Set(erledigt.map((f) => f.ereignisId))) {
    const e = await tx.ereignis.findFirst({
      where: { id: ereignisId, programmId },
      include: { folgen: true },
    });
    if (!e) continue;
    protokolle.push({
      aktion: 'tcms.ereignis.folge_erledigt',
      objektTyp: 'Ereignis',
      objektId: e.id,
      programmId,
      detail: { nummer: e.nummer, folge: 'RISIKO_NEU_BEWERTEN', ziel: code, durch: 'Neubewertung' },
    });
    if (e.status === 'IN_TRIAGE' && ereignisErledigt(e.folgen)) {
      const u = await tx.ereignis.updateMany({
        where: { id: e.id, status: 'IN_TRIAGE' },
        data: { status: 'ERLEDIGT' },
      });
      if (u.count === 1)
        protokolle.push({
          aktion: 'tcms.ereignis.erledigt',
          objektTyp: 'Ereignis',
          objektId: e.id,
          programmId,
          detail: { nummer: e.nummer, grund: 'alle Folgen erledigt oder verworfen' },
        });
    }
  }
  return protokolle;
}

// -----------------------------------------------------------------------------
// Neu bewerten / Bewertung bestätigen
// -----------------------------------------------------------------------------

interface Werte {
  s: Schaden;
  w: Wahrscheinlichkeit;
  r: 1 | 2 | 3;
  gt: GovernanceTyp;
}

async function bewerte(
  ctx: DienstKontext,
  mandantId: string,
  risikoId: string,
  standId: string,
  werteNeu: Werte | 'BESTAETIGEN',
  begruendung: string,
): Promise<NeuBewertungErgebnis> {
  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const risiko = await risikoUnterSperre(tx, mandantId, risikoId);
    pruefeAktiv(risiko, zeitpunkt);
    const alt = risiko.staende[0];
    if (!alt) throw konflikt('Kein gültiger Risikostand vorhanden.');
    // TS-05: nur auf dem Stand, den die Person gesehen hat.
    if (alt.id !== standId) throw konflikt('Das Risiko wurde inzwischen neu bewertet.');
    const { s, w, r, gt }: Werte =
      werteNeu === 'BESTAETIGEN'
        ? { s: alt.s, w: alt.w, r: alt.r as 1 | 2 | 3, gt: alt.gt }
        : werteNeu;
    const geaendert = alt.s !== s || alt.w !== w || alt.r !== r || alt.gt !== gt;
    const bruttoAlt = brutto(alt.s, alt.w, alt.r as 1 | 2 | 3).klasse;
    const bruttoNeu = brutto(s, w, r).klasse;
    const neueFreigabe =
      geaendert || risiko.freigabe === 'IDENTIFIZIERT' ? 'BEWERTET' : risiko.freigabe;
    const programm = risiko.programm;
    const heute = heuteDatum(ctx.uhr);
    const protokolle: Protokoll[] = [];

    // Verknüpfte, nicht entfallene Kontrollen sperren (Reihenfolge Risiko → Kontrollen)
    // und ihre Frequenzen vor der Änderung unter der Sperre bestimmen.
    const links = await tx.risikoKontrolle.findMany({
      where: { risikoId },
      select: { kontrolleId: true },
    });
    await sperreKontrollen(
      tx,
      programm.id,
      links.map((l) => l.kontrolleId),
    );
    const kontrollen = await tx.kontrolle.findMany({
      where: {
        id: { in: links.map((l) => l.kontrolleId) },
        programmId: programm.id,
        OR: [{ entfallenAb: null }, { entfallenAb: { gt: zeitpunkt } }],
      },
      include: { staende: { where: { gueltigBis: null } } },
      orderBy: { code: 'asc' },
    });
    const vorher = new Map<string, ReturnType<typeof effektiveFrequenz>>();
    for (const k of kontrollen) {
      const ks = k.staende[0];
      if (ks)
        vorher.set(
          k.id,
          effektiveFrequenz(
            ks,
            await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt),
            programm.erklaerungsTurnus,
          ),
        );
    }

    // TS-05: nur den noch offenen Stand schließen (bedingtes Update).
    const zu = await tx.risikoStand.updateMany({
      where: { id: alt.id, gueltigBis: null },
      data: { gueltigBis: zeitpunkt },
    });
    if (zu.count !== 1) throw konflikt('Das Risiko wurde inzwischen neu bewertet.');
    const neu = await tx.risikoStand.create({
      data: {
        risikoId,
        version: alt.version + 1,
        titel: alt.titel,
        fehlerquelle: alt.fehlerquelle,
        folge: alt.folge,
        normanker: (alt.normanker ?? []) as Prisma.InputJsonValue,
        s,
        w,
        r,
        gt,
        modell: BEWERTUNGSMODELL_VERSION,
        gueltigAb: zeitpunkt,
        erstelltVon: ctx.akteur.id,
        createdAt: zeitpunkt,
      },
    });
    await tx.risiko.update({
      where: { id: risikoId },
      data: {
        neuBewerten: false,
        freigabe: neueFreigabe,
        ...(geaendert && risiko.freigabe !== 'IDENTIFIZIERT'
          ? { freigabeEingereichtVon: null }
          : {}),
      },
    });
    protokolle.push({
      aktion: geaendert ? 'tcms.risiko.neu_bewertet' : 'tcms.risiko.bewertung_bestaetigt',
      objektTyp: 'Risiko',
      objektId: risikoId,
      programmId: programm.id,
      detail: {
        code: risiko.code,
        vorher: { s: alt.s, w: alt.w, r: alt.r, gt: alt.gt, brutto: bruttoAlt },
        nachher: { s, w, r, gt, brutto: bruttoNeu },
        modell: BEWERTUNGSMODELL_VERSION,
        begruendung,
        freigabe: { vorher: risiko.freigabe, nachher: neueFreigabe },
        standId: neu.id,
      },
    });
    protokolle.push(
      ...(await erledigeEreignisFolgen(tx, programm.id, risiko.code, neu.id, zeitpunkt)),
    );

    // Folgen für die Kontrollhäufigkeit (GT × Bruttoklasse).
    const neuplanungen: KontrollNeuplanung[] = [];
    const frequenzHinweise: string[] = [];
    for (const k of kontrollen) {
      let ks = k.staende[0];
      const vor = vorher.get(k.id);
      if (!ks || !vor) continue;
      const risikenNeu = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      let jetzt = effektiveFrequenz(ks, risikenNeu, programm.erklaerungsTurnus);
      // Eine freigegebene Abweichung unter der Matrixfrequenz wurde gegen die bisherige
      // Mindestfrequenz freigegeben. Ändert sich diese, deckt die Freigabe sie nicht mehr.
      if (
        ks.abweichungTurnus != null &&
        ks.abweichungFreigegebenVon &&
        !gleicheFrequenz(vor.ableitung.mindest, jetzt.ableitung.mindest)
      ) {
        const abw = { turnus: ks.abweichungTurnus, anlass: ks.abweichungAnlass ?? false };
        if (!mindestensSoStreng(abw, jetzt.ableitung.mindest)) {
          ks = await neuerKontrollStand(
            tx,
            ks,
            {
              abweichungTurnus: null,
              abweichungAnlass: null,
              abweichungBegruendung: null,
              abweichungFreigegebenVon: null,
            },
            zeitpunkt,
            ctx.akteur.id,
          );
          jetzt = effektiveFrequenz(ks, risikenNeu, programm.erklaerungsTurnus);
          protokolle.push({
            aktion: 'tcms.kontrolle.abweichung_aufgehoben',
            objektTyp: 'Kontrolle',
            objektId: k.id,
            programmId: programm.id,
            detail: {
              code: k.code,
              abweichung: frequenzLabel(abw),
              mindest: frequenzLabel(jetzt.ableitung.mindest),
              grund: `Neubewertung ${risiko.code}`,
            },
          });
          frequenzHinweise.push(
            `${k.code}: Abweichung unter der geänderten Mindestfrequenz aufgehoben – bei Bedarf neu beantragen`,
          );
        }
      }
      if (!gleicheFrequenz(vor.frequenz, jetzt.frequenz)) {
        protokolle.push({
          aktion: 'tcms.kontrolle.frequenz_geaendert',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: programm.id,
          detail: {
            code: k.code,
            vorher: frequenzLabel(vor.frequenz),
            nachher: frequenzLabel(jetzt.frequenz),
            grund: jetzt.ableitung.begruendung,
            anlass: `Neubewertung ${risiko.code}`,
          },
        });
        frequenzHinweise.push(
          `${k.code}: ${frequenzLabel(vor.frequenz)} → ${frequenzLabel(jetzt.frequenz)}`,
        );
      }
      if (vor.frequenz.turnus !== jetzt.frequenz.turnus) {
        const plan = await planeDurchfuehrungenNeu(tx, {
          programmId: programm.id,
          kontrolleId: k.id,
          code: k.code,
          standId: ks.id,
          faelligNachTagen: ks.faelligNachTagen,
          turnusVorher: vor.frequenz.turnus,
          turnusNachher: jetzt.frequenz.turnus,
          heute,
          zeitpunkt,
        });
        if (plan) {
          neuplanungen.push(plan);
          protokolle.push({
            aktion: 'tcms.kontrolle.neu_geplant',
            objektTyp: 'Kontrolle',
            objektId: k.id,
            programmId: programm.id,
            detail: { ...plan, anlass: `Neubewertung ${risiko.code}` },
          });
        }
      }
    }
    return {
      wert: {
        risikoId,
        code: risiko.code,
        standId: neu.id,
        version: neu.version,
        geaendert,
        brutto: { vorher: bruttoAlt, nachher: bruttoNeu },
        freigabe: { vorher: risiko.freigabe, nachher: neueFreigabe },
        frequenzHinweise,
        neuplanungen,
      },
      protokoll: protokolle,
    };
  });
}

/**
 * Bewertet ein Risiko neu (S, W, R, GT; Begründung ≥ 30 Zeichen). Gleiche
 * Werte gelten als Bestätigung der Bewertung. Eine geänderte Bewertung eines
 * bereits eingereichten oder freigegebenen Risikos braucht eine neue Freigabe.
 * Verknüpfte Kontrollen erhalten ihre Frequenz neu (berechnet), künftige
 * Durchführungen werden neu geplant.
 */
export async function risikoNeuBewerten(
  ctx: DienstKontext,
  eingabe: RisikoNeuBewerten,
): Promise<NeuBewertungErgebnis> {
  const e = pruefeEingabe(RisikoNeuBewertenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    bewerte(
      ctx,
      mandantId,
      e.risikoId,
      e.standId,
      { s: e.s, w: e.w, r: e.r, gt: e.gt },
      e.begruendung,
    ),
  );
}

/** Bestätigt die aktuelle Bewertung unverändert (neuer Stand, gleiche Werte). */
export async function risikoBewertungBestaetigen(
  ctx: DienstKontext,
  eingabe: RisikoBestaetigen,
): Promise<NeuBewertungErgebnis> {
  const e = pruefeEingabe(RisikoBestaetigenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    bewerte(ctx, mandantId, e.risikoId, e.standId, 'BESTAETIGEN', e.begruendung),
  );
}

// -----------------------------------------------------------------------------
// Übersteuerung (Vier-Augen)
// -----------------------------------------------------------------------------

/**
 * Beantragt eine Übersteuerung der Nettoklasse (Design oder Betrieb). Der
 * berechnete Wert bleibt erhalten und sichtbar; wirksam wird die Übersteuerung
 * erst mit der Freigabe durch eine zweite Person. Je Risiko und Sicht
 * höchstens ein offener Antrag.
 */
export async function uebersteuerungBeantragen(
  ctx: DienstKontext,
  eingabe: UebersteuerungBeantragen,
): Promise<UebersteuerungBeantragt> {
  const e = pruefeEingabe(UebersteuerungBeantragenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const risiko = await risikoUnterSperre(tx, mandantId, e.risikoId);
      pruefeAktiv(risiko, zeitpunkt);
      const offen = await tx.uebersteuerung.count({
        where: { risikoId: risiko.id, sicht: e.sicht, status: 'BEANTRAGT' },
      });
      if (offen > 0) throw konflikt('Für diese Sicht ist bereits eine Übersteuerung beantragt.');
      const { risiko: sicht } = await aktuelleSicht(ctx, mandantId, risiko.id);
      const b = sicht.bewertung;
      const berechnet: Klasse = e.sicht === 'DESIGN' ? b.nettoDesign.klasse : b.nettoBetrieb.klasse;
      const wirksam: Klasse = e.sicht === 'DESIGN' ? b.wirksamDesign : b.wirksamBetrieb;
      if (e.klasse === berechnet) {
        throw new DienstFehler(
          'UNGUELTIG',
          `Die Zielklasse entspricht dem berechneten Wert (${KLASSE_LABEL[berechnet]}).`,
          { klasse: ['entspricht dem berechneten Wert'] },
        );
      }
      if (e.klasse === wirksam) {
        throw new DienstFehler(
          'UNGUELTIG',
          `Die Zielklasse ist bereits wirksam (${KLASSE_LABEL[wirksam]}).`,
          { klasse: ['bereits wirksam'] },
        );
      }
      const u = await tx.uebersteuerung.create({
        data: {
          risikoId: risiko.id,
          sicht: e.sicht,
          klasse: e.klasse,
          berechnet,
          begruendung: e.begruendung,
          status: 'BEANTRAGT',
          beantragtVon: ctx.akteur.id,
          beantragtAm: zeitpunkt,
        },
      });
      return {
        wert: { uebersteuerungId: u.id, sicht: e.sicht, klasse: e.klasse, berechnet },
        protokoll: {
          aktion: 'tcms.risiko.uebersteuerung_beantragt',
          objektTyp: 'Risiko',
          objektId: risiko.id,
          programmId: risiko.programmId,
          detail: {
            code: risiko.code,
            uebersteuerungId: u.id,
            sicht: e.sicht,
            klasse: e.klasse,
            berechnet,
            begruendung: e.begruendung,
          },
        },
      };
    }),
  );
}

/**
 * Entscheidet über eine beantragte Übersteuerung. Nur eine zweite Person
 * (≠ beantragend); Ablehnung mit Begründung. Genau eine von gleichzeitigen
 * Entscheidungen wirkt, jede weitere erhält KONFLIKT.
 */
export async function uebersteuerungEntscheiden(
  ctx: DienstKontext,
  eingabe: UebersteuerungEntscheiden,
): Promise<UebersteuerungEntschieden> {
  const e = pruefeEingabe(UebersteuerungEntscheidenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const programm = await programmDes(tx, mandantId);
      const ref = await tx.uebersteuerung.findFirst({
        where: { id: e.uebersteuerungId, risiko: { programmId: programm.id } },
        select: { risikoId: true },
      });
      if (!ref) throw new DienstFehler('NICHT_GEFUNDEN');
      await sperreRisiken(tx, programm.id, [ref.risikoId]);
      const u = await tx.uebersteuerung.findFirst({
        where: { id: e.uebersteuerungId, risikoId: ref.risikoId },
        include: { risiko: { select: { code: true, programmId: true } } },
      });
      if (!u) throw new DienstFehler('NICHT_GEFUNDEN');
      if (u.status !== 'BEANTRAGT') {
        throw konflikt('Über diese Übersteuerung wurde bereits entschieden.');
      }
      if (!zweitePerson(ctx.akteur, u.beantragtVon)) {
        throw new DienstFehler('NICHT_BERECHTIGT', ZWEITE_PERSON);
      }
      const status = e.entscheidung === 'FREIGEBEN' ? 'FREIGEGEBEN' : 'ABGELEHNT';
      const z = await tx.uebersteuerung.updateMany({
        where: { id: u.id, status: 'BEANTRAGT' },
        data: { status, entschiedenVon: ctx.akteur.id, entschiedenAm: zeitpunkt },
      });
      if (z.count !== 1) throw konflikt('Über diese Übersteuerung wurde bereits entschieden.');
      return {
        wert: { uebersteuerungId: u.id, risikoId: u.risikoId, status },
        protokoll: {
          aktion:
            status === 'FREIGEGEBEN'
              ? 'tcms.risiko.uebersteuerung_freigegeben'
              : 'tcms.risiko.uebersteuerung_abgelehnt',
          objektTyp: 'Risiko',
          objektId: u.risikoId,
          programmId: u.risiko.programmId,
          detail: {
            code: u.risiko.code,
            uebersteuerungId: u.id,
            sicht: u.sicht,
            klasse: u.klasse,
            berechnet: u.berechnet,
            beantragtVon: u.beantragtVon,
            ...(e.begruendung ? { begruendung: e.begruendung } : {}),
          },
        },
      };
    }),
  );
}

// -----------------------------------------------------------------------------
// Freigabe-Workflow des Inventars: BEWERTET → ZUR_FREIGABE → FREIGEGEBEN
// -----------------------------------------------------------------------------

type Schritt = 'EINREICHEN' | 'FREIGEBEN';

async function freigabeSchritt(
  ctx: DienstKontext,
  eingabe: RisikenFreigabeSchritt,
  schritt: Schritt,
): Promise<FreigabeSchrittErgebnis> {
  const e = pruefeEingabe(RisikenFreigabeSchrittSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const programm = await programmDes(tx, mandantId);
      // Alle Risiken der Auswahl gehören zu diesem Mandanten, sonst NICHT_GEFUNDEN.
      await sperreRisiken(tx, programm.id, e.risikoIds);
      const risiken = await tx.risiko.findMany({
        where: { id: { in: e.risikoIds }, programmId: programm.id },
        orderBy: { code: 'asc' },
      });
      const bearbeitet: FreigabeSchrittErgebnis['bearbeitet'] = [];
      const uebersprungen: FreigabeSchrittErgebnis['uebersprungen'] = [];
      let nurVierAugen = true;
      const ueberspringe = (r: (typeof risiken)[number], grund: string, vierAugen = false) => {
        uebersprungen.push({ risikoId: r.id, code: r.code, grund });
        if (!vierAugen) nurVierAugen = false;
      };
      const protokolle: Protokoll[] = [];
      for (const r of risiken) {
        const aktiv =
          r.entscheidung === 'UEBERNOMMEN' &&
          r.aktivAb.getTime() <= zeitpunkt.getTime() &&
          !(r.inaktivAb && r.inaktivAb.getTime() <= zeitpunkt.getTime());
        if (!aktiv) ueberspringe(r, 'nicht im Inventar');
        else if (schritt === 'EINREICHEN' && r.freigabe !== 'BEWERTET')
          ueberspringe(r, `Status ${r.freigabe.toLowerCase().replace('_', ' ')}`);
        else if (schritt === 'FREIGEBEN' && r.freigabe !== 'ZUR_FREIGABE')
          ueberspringe(r, 'nicht zur Freigabe eingereicht');
        else if (schritt === 'FREIGEBEN' && !zweitePerson(ctx.akteur, r.freigabeEingereichtVon))
          ueberspringe(r, 'selbst eingereicht – zweite Person erforderlich', true);
        else {
          const z = await tx.risiko.updateMany({
            where: {
              id: r.id,
              freigabe: schritt === 'EINREICHEN' ? 'BEWERTET' : 'ZUR_FREIGABE',
            },
            data:
              schritt === 'EINREICHEN'
                ? { freigabe: 'ZUR_FREIGABE', freigabeEingereichtVon: ctx.akteur.id }
                : {
                    freigabe: 'FREIGEGEBEN',
                    freigegebenVon: ctx.akteur.id,
                    freigegebenAm: zeitpunkt,
                  },
          });
          if (z.count !== 1) throw konflikt('Der Freigabestatus hat sich inzwischen geändert.');
          bearbeitet.push({ risikoId: r.id, code: r.code });
          protokolle.push({
            aktion:
              schritt === 'EINREICHEN' ? 'tcms.risiko.zur_freigabe' : 'tcms.risiko.freigegeben',
            objektTyp: 'Risiko',
            objektId: r.id,
            programmId: programm.id,
            detail: {
              code: r.code,
              ...(schritt === 'FREIGEBEN' ? { eingereichtVon: r.freigabeEingereichtVon } : {}),
            },
          });
        }
      }
      if (bearbeitet.length === 0) {
        const text = `Kein Risiko bearbeitet: ${uebersprungen.map((u) => `${u.code} (${u.grund})`).join(', ')}.`;
        if (nurVierAugen) throw new DienstFehler('NICHT_BERECHTIGT', `${ZWEITE_PERSON} ${text}`);
        throw konflikt(text);
      }
      return { wert: { bearbeitet, uebersprungen }, protokoll: protokolle };
    }),
  );
}

/** Reicht bewertete Risiken zur Freigabe ein; andere Status werden übersprungen. */
export function risikenZurFreigabe(
  ctx: DienstKontext,
  eingabe: RisikenFreigabeSchritt,
): Promise<FreigabeSchrittErgebnis> {
  return freigabeSchritt(ctx, eingabe, 'EINREICHEN');
}

/** Gibt eingereichte Risiken frei – nur eine zweite Person (≠ einreichend). */
export function risikenFreigeben(
  ctx: DienstKontext,
  eingabe: RisikenFreigabeSchritt,
): Promise<FreigabeSchrittErgebnis> {
  return freigabeSchritt(ctx, eingabe, 'FREIGEBEN');
}

/** Weist ein eingereichtes Risiko zurück (zweite Person, Begründung); Status wieder „bewertet". */
export async function risikoZurueckweisen(
  ctx: DienstKontext,
  eingabe: RisikoZurueckweisen,
): Promise<RisikoZurueckgewiesen> {
  const e = pruefeEingabe(RisikoZurueckweisenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const risiko = await risikoUnterSperre(tx, mandantId, e.risikoId);
      pruefeAktiv(risiko, zeitpunkt);
      if (risiko.freigabe !== 'ZUR_FREIGABE') {
        throw konflikt('Das Risiko ist nicht zur Freigabe eingereicht.');
      }
      if (!zweitePerson(ctx.akteur, risiko.freigabeEingereichtVon)) {
        throw new DienstFehler('NICHT_BERECHTIGT', ZWEITE_PERSON);
      }
      const z = await tx.risiko.updateMany({
        where: { id: risiko.id, freigabe: 'ZUR_FREIGABE' },
        data: { freigabe: 'BEWERTET', freigabeEingereichtVon: null },
      });
      if (z.count !== 1) throw konflikt('Der Freigabestatus hat sich inzwischen geändert.');
      return {
        wert: { risikoId: risiko.id, code: risiko.code, freigabe: 'BEWERTET' as const },
        protokoll: {
          aktion: 'tcms.risiko.zurueckgewiesen',
          objektTyp: 'Risiko',
          objektId: risiko.id,
          programmId: risiko.programmId,
          detail: {
            code: risiko.code,
            eingereichtVon: risiko.freigabeEingereichtVon,
            begruendung: e.begruendung,
          },
        },
      };
    }),
  );
}

// -----------------------------------------------------------------------------
// Risikoakzeptanz beim Mandanten anfordern (Fachkonzept §8, §13)
// -----------------------------------------------------------------------------

/**
 * Fordert bei einer gesetzlichen Vertretung des Mandanten (aktive Rolle) die
 * Akzeptanz eines Risikos über dem Risikoappetit an. Je Risiko höchstens eine
 * offene Anforderung. Adressiert über die Kontakt-ID (TS-06), nie über Namen.
 */
export async function risikoakzeptanzAnfordern(
  ctx: DienstKontext,
  eingabe: RisikoakzeptanzAnfordern,
): Promise<RisikoakzeptanzAngefordert> {
  const e = pruefeEingabe(RisikoakzeptanzAnfordernSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  const empfaengerId = kanonisch(e.empfaengerId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const risiko = await risikoUnterSperre(tx, mandantId, e.risikoId);
      pruefeAktiv(risiko, zeitpunkt);
      const gv = await tx.mandantKontaktRolle.findFirst({
        where: {
          mandantId,
          kontaktId: empfaengerId,
          rolle: 'GESETZLICHER_VERTRETER',
          aktiv: true,
        },
        select: { kontaktId: true },
      });
      if (!gv) {
        throw new DienstFehler(
          'UNGUELTIG',
          'Die Risikoakzeptanz geben nur gesetzliche Vertreter:innen des Mandanten frei.',
          { empfaengerId: ['keine gesetzliche Vertretung dieses Mandanten'] },
        );
      }
      const offen = await tx.freigabe.count({
        where: { art: 'RISIKOAKZEPTANZ', refId: risiko.id, status: 'OFFEN' },
      });
      if (offen > 0)
        throw konflikt('Für dieses Risiko ist bereits eine Risikoakzeptanz angefordert.');
      const { k, risiko: sicht } = await aktuelleSicht(ctx, mandantId, risiko.id);
      if (!sicht.ueberAppetit) {
        throw konflikt(
          'Eine Risikoakzeptanz ist nur für Risiken über dem Risikoappetit vorgesehen.',
        );
      }
      const b = sicht.bewertung;
      const sichtText =
        k.programm?.wirksamAb && k.programm.wirksamAb.getTime() <= k.stand.getTime()
          ? 'Netto (Betrieb)'
          : 'Netto (Design)';
      const kontrollen = k.kontrollen
        .filter((x) => sicht.kontrollIds.includes(x.id))
        .map((x) => `${x.code} ${x.titel}`);
      const titel = `Risikoakzeptanz ${risiko.code} · ${sicht.titel}`;
      const inhalt = [
        `Risikoakzeptanz – ${risiko.code} ${sicht.titel}`,
        '',
        `Fehlerquelle: ${sicht.fehlerquelle}`,
        `Folge: ${sicht.folge}`,
        '',
        `Bewertung zum ${fmtDatum(k.stand)} (Modell ${b.modell}): Schadensintensität ${SCHADEN_LABEL[sicht.s]}, Wahrscheinlichkeit ${WAHRSCHEINLICHKEIT_LABEL[sicht.w]}, Reichweite ${REICHWEITE_LABEL[sicht.r]}, ${GOVERNANCE_LABEL[sicht.gt]}.`,
        `Brutto ${KLASSE_LABEL[b.brutto.klasse]} · Netto (Design) ${KLASSE_LABEL[b.wirksamDesign]} · Netto (Betrieb) ${KLASSE_LABEL[b.wirksamBetrieb]}.`,
        `Der in den Compliance-Zielen festgelegte Risikoappetit ist „${KLASSE_LABEL[k.appetit]}". Die maßgebliche Nettoklasse (${sichtText}: ${KLASSE_LABEL[sicht.netto]}) liegt darüber.`,
        '',
        `Zugeordnete Kontrollen: ${kontrollen.length ? kontrollen.join('; ') : 'keine'}.`,
        '',
        `Erläuterung der Kanzlei: ${e.begruendung}`,
        '',
        'Liegt ein Risiko über dem Risikoappetit, ist eine Maßnahme oder eine Risikoakzeptanz durch die gesetzlichen Vertreter erforderlich. Mit Ihrer Freigabe akzeptieren Sie dieses Risiko in der genannten Höhe bis zur nächsten Neubewertung. Ihre Entscheidung wird mit Name und Zeitpunkt protokolliert.',
      ].join('\n');
      const f = await tx.freigabe.create({
        data: {
          programmId: risiko.programmId,
          art: 'RISIKOAKZEPTANZ',
          refId: risiko.id,
          titel,
          inhalt,
          angefordertVon: ctx.akteur.id,
          angefordertAm: zeitpunkt,
          empfaengerId,
          status: 'OFFEN',
        },
      });
      // TS-06: Empfänger als Kontakt-ID; die kanzleikonsole stellt zu und löst Namen auf.
      await legeNachrichtAn(tx, {
        empfaengerId,
        zweck: 'FREIGABE_ANGEFORDERT',
        betreff: `Freigabe angefordert: ${titel}`,
        text: `Im Portal wartet eine Risikoakzeptanz (${risiko.code}) auf Ihre Entscheidung. Den Bestätigungscode erhalten Sie beim Freigeben.`,
        erstelltAm: zeitpunkt,
      });
      return {
        wert: { risikoId: risiko.id, freigabeId: f.id, empfaengerId },
        protokoll: {
          aktion: 'tcms.risiko.akzeptanz_angefordert',
          objektTyp: 'Risiko',
          objektId: risiko.id,
          programmId: risiko.programmId,
          detail: {
            code: risiko.code,
            freigabeId: f.id,
            empfaengerId,
            netto: sicht.netto,
            appetit: k.appetit,
            begruendung: e.begruendung,
          },
        },
      };
    }),
  );
}
