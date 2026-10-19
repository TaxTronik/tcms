'use server';

import { z } from 'zod';
import { type Prisma, type Tx } from '@tcms/db';
import {
  brutto,
  BEWERTUNGSMODELL_VERSION,
  ereignisErledigt,
  fmtDatum,
  frequenzLabel,
  gleicheFrequenz,
  GOVERNANCE_LABEL,
  isoDatum,
  KLASSE_LABEL,
  mindestensSoStreng,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  type Klasse,
} from '@tcms/domain';
import { db, personImMandat, type KanzleiAkteur } from '../demo';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { ladeKontext } from '../kontext';
import {
  aktuelleRisikenDerKontrolle,
  effektiveFrequenz,
  neuerKontrollStand,
  planeDurchfuehrungenNeu,
  type Neuplanung,
} from '../kontrollen-daten';
import { kannBearbeiten, zweitePerson } from '../berechtigung';
import { NUR_AKTUELL } from '../seite';
import { brauchtKanzlei } from '../sitzung';
import { heute, leseStand } from '../zeit';

// =============================================================================
// Server Actions Risikoinventar (S4) und Risikodetail (S5).
// Bewertungen werden berechnet, nie gespeichert-überschrieben (Regel 2);
// Neubewertung schließt den Risikostand und legt einen neuen an (Regel 3);
// Übersteuerung und Inventarfreigabe im Vier-Augen-Prinzip (Regel 4).
// =============================================================================

const KLASSEN = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const;

/** Der offene Risikostand wurde parallel geschlossen (TS-05). */
class StandKonflikt extends Error {}
const ZWEITE_PERSON =
  'Die Entscheidung trifft eine zweite Person – nicht die beantragende bzw. einreichende Person.';

function historisch(fd: FormData): boolean {
  const s = fd.get('stand');
  return typeof s === 'string' && s !== '' && leseStand(s).historisch;
}

function felder(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !(k in out)) out[k] = v;
  return out;
}

async function ladeRisiko(id: string) {
  return db.risiko.findUnique({
    where: { id },
    include: { programm: { include: { mandant: true } }, staende: { where: { gueltigBis: null } } },
  });
}

type RisikoMitProgramm = NonNullable<Awaited<ReturnType<typeof ladeRisiko>>>;

function pruefeRisiko(
  nutzer: KanzleiAkteur,
  r: RisikoMitProgramm | null,
  jetzt: Date,
): string | null {
  if (!r) return 'Risiko nicht gefunden.';
  if (!kannBearbeiten(nutzer, r.programm.mandant)) return KEIN_RECHT;
  if (r.entscheidung !== 'UEBERNOMMEN' || (r.inaktivAb && r.inaktivAb.getTime() <= jetzt.getTime()))
    return 'Das Risiko ist nicht aktiv im Inventar.';
  return null;
}

/** Aktuelle Bewertung eines Risikos aus dem (aktuellen) Kontext. */
async function aktuelleSicht(mandantId: string, risikoId: string) {
  const ctx = await ladeKontext(mandantId, isoDatum(heute()), false);
  return { ctx, risiko: ctx?.risiken.find((r) => r.id === risikoId) ?? null };
}

// -----------------------------------------------------------------------------
// Neu bewerten
// -----------------------------------------------------------------------------

const NeuBewertenSchema = z.object({
  id: z.string().min(1),
  s: z.enum(['N', 'M', 'H']),
  w: z.enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG']),
  r: z.coerce.number().int().min(1).max(3),
  gt: z.enum(['FP', 'FF', 'IN']),
  begruendung: z.string().trim().min(30),
});

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
  const protokolle: Protokoll[] = [];
  for (const f of folgen) {
    await tx.ereignisFolge.update({
      where: { id: f.id },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt, objektId: standId },
    });
  }
  for (const ereignisId of new Set(folgen.map((f) => f.ereignisId))) {
    const e = await tx.ereignis.findUniqueOrThrow({
      where: { id: ereignisId },
      include: { folgen: true },
    });
    protokolle.push({
      aktion: 'tcms.ereignis.folge_erledigt',
      objektTyp: 'Ereignis',
      objektId: e.id,
      programmId,
      detail: { nummer: e.nummer, folge: 'RISIKO_NEU_BEWERTEN', ziel: code, durch: 'Neubewertung' },
    });
    if (e.status === 'IN_TRIAGE' && ereignisErledigt(e.folgen)) {
      await tx.ereignis.update({ where: { id: e.id }, data: { status: 'ERLEDIGT' } });
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

export async function risikoNeuBewerten(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = NeuBewertenSchema.safeParse(felder(fd));
  if (!p.success)
    return {
      fehler: 'Bitte S, W, R, Governance-Typ und eine Begründung (mindestens 30 Zeichen) angeben.',
    };
  const { id, s, w, gt, begruendung } = p.data;
  const r = p.data.r as 1 | 2 | 3;
  const risiko = await ladeRisiko(id);
  const fehler = pruefeRisiko(nutzer, risiko, heute());
  if (fehler || !risiko) return { fehler: fehler ?? 'Risiko nicht gefunden.' };
  const alt = risiko.staende[0];
  if (!alt) return { fehler: 'Kein gültiger Risikostand vorhanden.' };
  const geaendert = alt.s !== s || alt.w !== w || alt.r !== r || alt.gt !== gt;
  const bruttoAlt = brutto(alt.s, alt.w, alt.r as 1 | 2 | 3).klasse;
  const bruttoNeu = brutto(s, w, r).klasse;
  const neueFreigabe = geaendert
    ? 'BEWERTET'
    : risiko.freigabe === 'IDENTIFIZIERT'
      ? 'BEWERTET'
      : risiko.freigabe;
  const programm = risiko.programm;
  const tag = heute();

  const ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const protokolle: Protokoll[] = [];
    // Frequenzen der verknüpften Kontrollen vor der Änderung.
    const links = await tx.risikoKontrolle.findMany({
      where: { risikoId: id },
      select: { kontrolleId: true },
    });
    const kontrollen = await tx.kontrolle.findMany({
      where: {
        id: { in: links.map((l) => l.kontrolleId) },
        OR: [{ entfallenAb: null }, { entfallenAb: { gt: zeitpunkt } }],
      },
      include: { staende: { where: { gueltigBis: null } } },
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

    // TS-05: nur den noch offenen Stand schließen (bedingtes Update); hat ihn eine
    // parallele Neubewertung bereits geschlossen, bricht die Transaktion ab.
    const zu = await tx.risikoStand.updateMany({
      where: { id: alt.id, gueltigBis: null },
      data: { gueltigBis: zeitpunkt },
    });
    if (zu.count !== 1) throw new StandKonflikt();
    const neu = await tx.risikoStand.create({
      data: {
        risikoId: id,
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
        erstelltVon: nutzer.id,
        createdAt: zeitpunkt,
      },
    });
    await tx.risiko.update({
      where: { id },
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
      objektId: id,
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
    const planungen: Neuplanung[] = [];
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
            nutzer.id,
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
          heute: tag,
        });
        if (plan) {
          planungen.push(plan);
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
    return { wert: { planungen, frequenzHinweise }, protokoll: protokolle };
  }).catch((e: unknown) => {
    if (e instanceof StandKonflikt) return null;
    throw e;
  });
  if (!ergebnis)
    return { fehler: 'Das Risiko wurde inzwischen neu bewertet. Bitte die Seite neu laden.' };

  aktualisiereMandant(programm.mandantId);
  const teile = [
    geaendert
      ? `${risiko.code} neu bewertet: Brutto ${KLASSE_LABEL[bruttoAlt]} → ${KLASSE_LABEL[bruttoNeu]}.${risiko.freigabe !== 'IDENTIFIZIERT' ? ' Die geänderte Bewertung braucht eine Freigabe durch eine zweite Person.' : ''}`
      : `${risiko.code}: Bewertung unverändert bestätigt.`,
  ];
  if (ergebnis.frequenzHinweise.length)
    teile.push(`Frequenz: ${ergebnis.frequenzHinweise.join('; ')}.`);
  for (const pl of ergebnis.planungen)
    teile.push(
      `${pl.code} neu geplant (${pl.angelegt.length} angelegt, ${pl.entfernt.length} entfernt).`,
    );
  return { ok: teile.join(' ') };
}

// -----------------------------------------------------------------------------
// Übersteuerung (Vier-Augen)
// -----------------------------------------------------------------------------

const UebersteuerungSchema = z.object({
  id: z.string().min(1),
  sicht: z.enum(['DESIGN', 'BETRIEB']),
  klasse: z.enum(KLASSEN),
  begruendung: z.string().trim().min(30),
});

export async function uebersteuerungBeantragen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = UebersteuerungSchema.safeParse(felder(fd));
  if (!p.success)
    return {
      fehler: 'Bitte Sicht, Zielklasse und eine Begründung (mindestens 30 Zeichen) angeben.',
    };
  const { id, sicht, klasse, begruendung } = p.data;
  const risiko = await ladeRisiko(id);
  const fehler = pruefeRisiko(nutzer, risiko, heute());
  if (fehler || !risiko) return { fehler: fehler ?? 'Risiko nicht gefunden.' };
  const offen = await db.uebersteuerung.count({
    where: { risikoId: id, sicht, status: 'BEANTRAGT' },
  });
  if (offen > 0) return { fehler: 'Für diese Sicht ist bereits eine Übersteuerung beantragt.' };
  const { risiko: sichtR } = await aktuelleSicht(risiko.programm.mandantId, id);
  if (!sichtR) return { fehler: 'Das Risiko ist zum aktuellen Stand nicht im Inventar.' };
  const berechnet: Klasse =
    sicht === 'DESIGN' ? sichtR.bewertung.nettoDesign.klasse : sichtR.bewertung.nettoBetrieb.klasse;
  const wirksam: Klasse =
    sicht === 'DESIGN' ? sichtR.bewertung.wirksamDesign : sichtR.bewertung.wirksamBetrieb;
  if (klasse === berechnet)
    return {
      fehler: `Die Zielklasse entspricht dem berechneten Wert (${KLASSE_LABEL[berechnet]}).`,
    };
  if (klasse === wirksam)
    return { fehler: `Die Zielklasse ist bereits wirksam (${KLASSE_LABEL[wirksam]}).` };

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const u = await tx.uebersteuerung.create({
      data: {
        risikoId: id,
        sicht,
        klasse,
        berechnet,
        begruendung,
        status: 'BEANTRAGT',
        beantragtVon: nutzer.id,
        beantragtAm: zeitpunkt,
      },
    });
    return {
      wert: u.id,
      protokoll: {
        aktion: 'tcms.risiko.uebersteuerung_beantragt',
        objektTyp: 'Risiko',
        objektId: id,
        programmId: risiko.programmId,
        detail: {
          code: risiko.code,
          uebersteuerungId: u.id,
          sicht,
          klasse,
          berechnet,
          begruendung,
        },
      },
    };
  });
  aktualisiereMandant(risiko.programm.mandantId);
  return {
    ok: `Übersteuerung beantragt (${sicht === 'DESIGN' ? 'Netto Design' : 'Netto Betrieb'}: ${KLASSE_LABEL[berechnet]} → ${KLASSE_LABEL[klasse]}). Gilt erst nach Freigabe durch eine zweite Person.`,
  };
}

const EntscheidungSchema = z.object({
  id: z.string().min(1),
  entscheidung: z.enum(['freigeben', 'ablehnen']),
  begruendung: z.string().trim().optional(),
});

export async function uebersteuerungEntscheiden(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = EntscheidungSchema.safeParse(felder(fd));
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const { id, entscheidung } = p.data;
  const begruendung = p.data.begruendung ?? '';
  if (entscheidung === 'ablehnen' && begruendung.length < 30)
    return { fehler: 'Die Ablehnung braucht eine Begründung (mindestens 30 Zeichen).' };
  const u = await db.uebersteuerung.findUnique({
    where: { id },
    include: { risiko: { include: { programm: { include: { mandant: true } } } } },
  });
  if (!u) return { fehler: 'Übersteuerung nicht gefunden.' };
  if (!kannBearbeiten(nutzer, u.risiko.programm.mandant)) return { fehler: KEIN_RECHT };
  if (u.status !== 'BEANTRAGT')
    return { fehler: 'Über diese Übersteuerung wurde bereits entschieden.' };
  if (!zweitePerson(nutzer, u.beantragtVon)) return { fehler: ZWEITE_PERSON };

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    await tx.uebersteuerung.update({
      where: { id },
      data: {
        status: entscheidung === 'freigeben' ? 'FREIGEGEBEN' : 'ABGELEHNT',
        entschiedenVon: nutzer.id,
        entschiedenAm: zeitpunkt,
      },
    });
    return {
      wert: null,
      protokoll: {
        aktion:
          entscheidung === 'freigeben'
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
          ...(begruendung ? { begruendung } : {}),
        },
      },
    };
  });
  aktualisiereMandant(u.risiko.programm.mandantId);
  return {
    ok:
      entscheidung === 'freigeben'
        ? 'Übersteuerung freigegeben. Der berechnete Wert bleibt sichtbar.'
        : 'Übersteuerung abgelehnt.',
  };
}

// -----------------------------------------------------------------------------
// Freigabe-Workflow des Inventars: IDENTIFIZIERT → BEWERTET → ZUR_FREIGABE → FREIGEGEBEN
// -----------------------------------------------------------------------------

export async function risikenFreigabeSchritt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const ids = [
    ...new Set(fd.getAll('ids').filter((x): x is string => typeof x === 'string' && x.length > 0)),
  ];
  const aktion = fd.get('aktion');
  if (ids.length === 0) return { fehler: 'Bitte mindestens ein Risiko auswählen.' };
  if (aktion !== 'einreichen' && aktion !== 'freigeben') return { fehler: 'Unbekannter Schritt.' };
  const risiken = await db.risiko.findMany({
    where: { id: { in: ids } },
    include: { programm: { include: { mandant: true } } },
  });
  if (risiken.length !== ids.length) return { fehler: 'Risiko nicht gefunden.' };
  const mandantIds = new Set(risiken.map((r) => r.programm.mandantId));
  if (mandantIds.size !== 1) return { fehler: 'Bitte nur Risiken eines Mandanten auswählen.' };
  const mandant = risiken[0]!.programm.mandant;
  if (!kannBearbeiten(nutzer, mandant)) return { fehler: KEIN_RECHT };

  const ok: typeof risiken = [];
  const uebersprungen: string[] = [];
  for (const r of risiken) {
    if (r.entscheidung !== 'UEBERNOMMEN') uebersprungen.push(`${r.code} (nicht im Inventar)`);
    else if (aktion === 'einreichen' && r.freigabe !== 'BEWERTET')
      uebersprungen.push(`${r.code} (Status ${r.freigabe.toLowerCase().replace('_', ' ')})`);
    else if (aktion === 'freigeben' && r.freigabe !== 'ZUR_FREIGABE')
      uebersprungen.push(`${r.code} (nicht zur Freigabe eingereicht)`);
    else if (aktion === 'freigeben' && !zweitePerson(nutzer, r.freigabeEingereichtVon))
      uebersprungen.push(`${r.code} (von dir eingereicht – zweite Person erforderlich)`);
    else ok.push(r);
  }
  if (ok.length === 0) return { fehler: `Kein Risiko bearbeitet: ${uebersprungen.join(', ')}.` };

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const protokolle: Protokoll[] = [];
    for (const r of ok) {
      if (aktion === 'einreichen') {
        await tx.risiko.update({
          where: { id: r.id },
          data: { freigabe: 'ZUR_FREIGABE', freigabeEingereichtVon: nutzer.id },
        });
      } else {
        await tx.risiko.update({
          where: { id: r.id },
          data: { freigabe: 'FREIGEGEBEN', freigegebenVon: nutzer.id, freigegebenAm: zeitpunkt },
        });
      }
      protokolle.push({
        aktion: aktion === 'einreichen' ? 'tcms.risiko.zur_freigabe' : 'tcms.risiko.freigegeben',
        objektTyp: 'Risiko',
        objektId: r.id,
        programmId: r.programmId,
        detail: {
          code: r.code,
          ...(aktion === 'freigeben' ? { eingereichtVon: r.freigabeEingereichtVon } : {}),
        },
      });
    }
    return { wert: null, protokoll: protokolle };
  });
  aktualisiereMandant(mandant.id);
  const text = aktion === 'einreichen' ? 'zur Freigabe eingereicht' : 'freigegeben';
  return {
    ok: `${ok.length === 1 ? ok[0]!.code : `${ok.length} Risiken`} ${text}.${uebersprungen.length ? ` Übersprungen: ${uebersprungen.join(', ')}.` : ''}`,
  };
}

const ZurueckweisenSchema = z.object({
  id: z.string().min(1),
  begruendung: z.string().trim().min(30),
});

export async function risikoFreigabeZurueckweisen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = ZurueckweisenSchema.safeParse(felder(fd));
  if (!p.success)
    return { fehler: 'Die Zurückweisung braucht eine Begründung (mindestens 30 Zeichen).' };
  const risiko = await ladeRisiko(p.data.id);
  const fehler = pruefeRisiko(nutzer, risiko, heute());
  if (fehler || !risiko) return { fehler: fehler ?? 'Risiko nicht gefunden.' };
  if (risiko.freigabe !== 'ZUR_FREIGABE')
    return { fehler: 'Das Risiko ist nicht zur Freigabe eingereicht.' };
  if (!zweitePerson(nutzer, risiko.freigabeEingereichtVon)) return { fehler: ZWEITE_PERSON };
  await mitAudit(nutzer, async (tx) => {
    await tx.risiko.update({
      where: { id: risiko.id },
      data: { freigabe: 'BEWERTET', freigabeEingereichtVon: null },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.risiko.zurueckgewiesen',
        objektTyp: 'Risiko',
        objektId: risiko.id,
        programmId: risiko.programmId,
        detail: {
          code: risiko.code,
          eingereichtVon: risiko.freigabeEingereichtVon,
          begruendung: p.data.begruendung,
        },
      },
    };
  });
  aktualisiereMandant(risiko.programm.mandantId);
  return { ok: `${risiko.code} zurückgewiesen – Status wieder „bewertet".` };
}

// -----------------------------------------------------------------------------
// Risikoakzeptanz beim Mandanten anfordern (Fachkonzept §8, §13)
// -----------------------------------------------------------------------------

const AkzeptanzSchema = z.object({
  id: z.string().min(1),
  empfaengerId: z.string().min(1),
  begruendung: z.string().trim().min(30),
});

export async function risikoakzeptanzAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = AkzeptanzSchema.safeParse(felder(fd));
  if (!p.success)
    return { fehler: 'Bitte Empfänger:in und eine Erläuterung (mindestens 30 Zeichen) angeben.' };
  const { id, empfaengerId, begruendung } = p.data;
  const risiko = await ladeRisiko(id);
  const fehler = pruefeRisiko(nutzer, risiko, heute());
  if (fehler || !risiko) return { fehler: fehler ?? 'Risiko nicht gefunden.' };
  const empf = await personImMandat(empfaengerId, risiko.programm.mandantId);
  if (!empf || !empf.rollen.includes('GESETZLICHER_VERTRETER')) {
    return {
      fehler: 'Die Risikoakzeptanz geben nur gesetzliche Vertreter:innen des Mandanten frei.',
    };
  }
  const { ctx, risiko: sichtR } = await aktuelleSicht(risiko.programm.mandantId, id);
  if (!ctx || !sichtR) return { fehler: 'Das Risiko ist zum aktuellen Stand nicht im Inventar.' };
  if (!sichtR.ueberAppetit)
    return {
      fehler: 'Eine Risikoakzeptanz ist nur für Risiken über dem Risikoappetit vorgesehen.',
    };
  const offen = await db.freigabe.count({
    where: { art: 'RISIKOAKZEPTANZ', refId: id, status: 'OFFEN' },
  });
  if (offen > 0)
    return { fehler: 'Für dieses Risiko ist bereits eine Risikoakzeptanz angefordert.' };

  const b = sichtR.bewertung;
  const sichtText =
    ctx.programm?.wirksamAb && ctx.programm.wirksamAb.getTime() <= ctx.stand.getTime()
      ? 'Netto (Betrieb)'
      : 'Netto (Design)';
  const kontrollen = ctx.kontrollen
    .filter((k) => sichtR.kontrollIds.includes(k.id))
    .map((k) => `${k.code} ${k.titel}`);
  const titel = `Risikoakzeptanz ${risiko.code} · ${sichtR.titel}`;
  const inhalt = [
    `Risikoakzeptanz – ${risiko.code} ${sichtR.titel}`,
    '',
    `Fehlerquelle: ${sichtR.fehlerquelle}`,
    `Folge: ${sichtR.folge}`,
    '',
    `Bewertung zum ${fmtDatum(ctx.stand)} (Modell ${b.modell}): Schadensintensität ${SCHADEN_LABEL[sichtR.s]}, Wahrscheinlichkeit ${WAHRSCHEINLICHKEIT_LABEL[sichtR.w]}, Reichweite ${REICHWEITE_LABEL[sichtR.r]}, ${GOVERNANCE_LABEL[sichtR.gt]}.`,
    `Brutto ${KLASSE_LABEL[b.brutto.klasse]} · Netto (Design) ${KLASSE_LABEL[b.wirksamDesign]} · Netto (Betrieb) ${KLASSE_LABEL[b.wirksamBetrieb]}.`,
    `Der in den Compliance-Zielen festgelegte Risikoappetit ist „${KLASSE_LABEL[ctx.appetit]}". Die maßgebliche Nettoklasse (${sichtText}: ${KLASSE_LABEL[sichtR.netto]}) liegt darüber.`,
    '',
    `Zugeordnete Kontrollen: ${kontrollen.length ? kontrollen.join('; ') : 'keine'}.`,
    '',
    `Erläuterung der Kanzlei: ${begruendung}`,
    '',
    'Liegt ein Risiko über dem Risikoappetit, ist eine Maßnahme oder eine Risikoakzeptanz durch die gesetzlichen Vertreter erforderlich. Mit Ihrer Freigabe akzeptieren Sie dieses Risiko in der genannten Höhe bis zur nächsten Neubewertung. Ihre Entscheidung wird mit Name und Zeitpunkt protokolliert.',
  ].join('\n');

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const f = await tx.freigabe.create({
      data: {
        programmId: risiko.programmId,
        art: 'RISIKOAKZEPTANZ',
        refId: id,
        titel,
        inhalt,
        angefordertVon: nutzer.id,
        angefordertAm: zeitpunkt,
        empfaengerId: empf.id,
        status: 'OFFEN',
      },
    });
    await tx.nachricht.create({
      data: {
        an: empf.name,
        betreff: `Freigabe angefordert: ${titel}`,
        text: `Im Portal wartet eine Risikoakzeptanz (${risiko.code}) auf Ihre Entscheidung. Den Bestätigungscode erhalten Sie beim Freigeben.`,
        createdAt: zeitpunkt,
      },
    });
    return {
      wert: f.id,
      protokoll: {
        aktion: 'tcms.risiko.akzeptanz_angefordert',
        objektTyp: 'Risiko',
        objektId: id,
        programmId: risiko.programmId,
        detail: {
          code: risiko.code,
          freigabeId: f.id,
          empfaenger: empf.name,
          netto: sichtR.netto,
          appetit: ctx.appetit,
          begruendung,
        },
      },
    };
  });
  aktualisiereMandant(risiko.programm.mandantId);
  return {
    ok: `Risikoakzeptanz bei ${empf.name} angefordert (Portal, Bestätigung per E-Mail-Code).`,
  };
}
