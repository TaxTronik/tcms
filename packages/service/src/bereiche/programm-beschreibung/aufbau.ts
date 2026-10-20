// =============================================================================
// Aufbau eines Tax-CMS-Programms aus Profil, Katalog und Entscheidungen (bisher
// apps/web/src/server/programm-aufbau.ts) für den Einrichtungsassistenten
// (Plan und Version 1). Vorbelegung, Kontrollstände und Durchführungen aus
// `kern/kontroll-vorlage.ts` (gemeinsam mit der Risikoaufnahme im Bereich
// risiken-kontrollen, die allein die Neuplanung trägt). Vorlage ist
// `baueProgramm` im Seed.
//
// Personen sind IDs der kanzleikonsole. Zuständige Berufsträger:in und
// Hauptbearbeitung kennt das Tax-CMS nicht (ADR 0001 §5): Sie kommen als
// ausdrückliche Eingabe (`AufbauUmfeld.mandant`) und dienen nur der
// Vorbelegung und Prüfung von Zuständigkeiten, nie Rechten.
// =============================================================================

import type { MandantRolle } from '../../rechte';
import { Prisma, type Tx } from '@tcms/db';
import {
  addTage,
  BEWERTUNGSMODELL_VERSION,
  brutto as berechneBrutto,
  fmtEurGanz,
  hoeher,
  katalogRisiko,
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KLASSE_LABEL,
  leiteFrequenzAb,
  monatSchluessel,
  PAKET,
  perioden,
  pruflast,
  schlageRisikenVor,
  ueber,
  type BruttoErgebnis,
  type FrequenzAbleitung,
  type KatalogKontrolle,
  type KatalogRisiko,
  type Klasse,
  type Periode,
  type Pruflast,
  type RisikoFuerFrequenz,
  type Turnus,
} from '@tcms/domain';
import type { EntwurfKontrolle, SetupEntwurf } from '@tcms/contract';
import type { Protokoll } from '../../audit';
import {
  geplanteDurchfuehrung,
  kontrollStandDaten,
  mandantSeiteVorbelegen,
  standardKontrollZustaendigkeit,
  type VorbelegteZustaendigkeit,
  type VorbelegungsRollen,
} from '../../kern/kontroll-vorlage';
import { risikoEntscheidung } from './entwurf';
import { legeNachrichtAn } from './nachrichten';

/** Person im Umfeld: Kanzleiperson oder Mandantenkontakt mit (erster) aktiver Rolle. */
export interface AufbauPerson {
  id: string;
  mandantRolle?: MandantRolle | null;
}

export interface AufbauUmfeld {
  /** `berufstraegerId`/`bearbeitungId`: Eingabe der kanzleikonsole, `null` wenn unbekannt. */
  mandant: {
    id: string;
    name: string;
    berufstraegerId: string | null;
    bearbeitungId: string | null;
  };
  kanzlei: readonly AufbauPerson[];
  mandantPersonen: readonly AufbauPerson[];
  heute: Date;
}

/** Personen für die Vorbelegung (gemeinsamer Kern, `kern/kontroll-vorlage.ts`). */
export type AufbauRollen = VorbelegungsRollen;

export function aufbauRollen(u: AufbauUmfeld): AufbauRollen {
  const bt = u.mandant.berufstraegerId;
  const hb = u.mandant.bearbeitungId;
  const kanzleiVertretung = u.kanzlei.find((p) => p.id !== bt && p.id !== hb)?.id ?? null;
  return {
    bt,
    hb,
    kanzleiVertretung,
    ...mandantSeiteVorbelegen(u.mandantPersonen.map((p) => ({ id: p.id, rolle: p.mandantRolle }))),
  };
}

export type AufbauZustaendigkeit = VorbelegteZustaendigkeit;
export { standardKontrollZustaendigkeit };

function zustaendigkeitAus(
  kat: KatalogKontrolle,
  wahl: EntwurfKontrolle | undefined,
  u: AufbauUmfeld,
  r: AufbauRollen,
): AufbauZustaendigkeit {
  if (!wahl) return standardKontrollZustaendigkeit(kat, r);
  const bekannt = (id: string | null) =>
    id && (u.kanzlei.some((p) => p.id === id) || u.mandantPersonen.some((p) => p.id === id))
      ? id
      : null;
  const gegenzeichnerId = bekannt(wahl.gegenzeichnerId);
  return {
    partei: wahl.partei,
    durchfuehrendId: bekannt(wahl.durchfuehrendId),
    vertretungId: bekannt(wahl.vertretungId),
    gegenzeichnerId,
    gegenzeichnungMandant:
      gegenzeichnerId != null && u.mandantPersonen.some((p) => p.id === gegenzeichnerId),
  };
}

// ---------------------------------------------------------------------------
// Plan (rein, ohne I/O): Grundlage für Vorschau in Schritt 4/5 und für Version 1
// ---------------------------------------------------------------------------

export interface AufbauPlanRisiko {
  code: string;
  kat: KatalogRisiko;
  kern: boolean;
  grund: string;
  frage: string;
  uebernehmen: boolean;
  begruendung: string;
  brutto: BruttoErgebnis;
  /** Bruttoklasse über dem Risikoappetit → braucht eine Kontrolle mit Designbeurteilung (Phase 3). */
  ueberAppetit: boolean;
}

export interface AufbauPlanKontrolle {
  code: string;
  kat: KatalogKontrolle;
  risikoCodes: string[];
  /** Risiko, unter dem die Kontrolle im Assistenten konfiguriert wird (bestimmt die Frequenz). */
  primaer: string | null;
  ableitung: FrequenzAbleitung;
  zust: AufbauZustaendigkeit;
  perioden: Periode[];
}

export interface AufbauPlan {
  risiken: AufbauPlanRisiko[];
  nichtVorgeschlagen: KatalogRisiko[];
  kontrollen: AufbauPlanKontrolle[];
  appetit: Klasse;
  zeitraum: { stichtag: Date; ab: Date; bis: Date } | null;
  prueflast: Pruflast[];
  durchfuehrungen: number;
}

function isoTag(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function appetitAusZielen(
  ziele: readonly { risikoappetit: Klasse; aktiv?: boolean }[],
): Klasse {
  const aktiv = ziele.filter((z) => z.aktiv !== false);
  if (aktiv.length === 0) return 'MITTEL';
  return aktiv.reduce<Klasse>((a, z) => hoeher(a, z.risikoappetit), 'GERING');
}

function monatePlus(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export function berechnePlan(e: SetupEntwurf, u: AufbauUmfeld): AufbauPlan {
  const r = aufbauRollen(u);
  const appetit = appetitAusZielen(e.ziele);
  const vorschlaege = schlageRisikenVor(e.profil);
  const vorgeschlagen = new Set(vorschlaege.map((v) => v.code));
  const risiken: AufbauPlanRisiko[] = vorschlaege.map((v) => {
    const kat = katalogRisiko(v.code)!;
    const b = berechneBrutto(kat.s, kat.w, kat.r);
    const ent = risikoEntscheidung(e, v.code, v.kern);
    return {
      code: v.code,
      kat,
      kern: v.kern,
      grund: v.grund,
      frage: v.frage,
      uebernehmen: ent.uebernehmen,
      begruendung: ent.begruendung,
      brutto: b,
      ueberAppetit: ueber(b.klasse, appetit),
    };
  });
  const bruttoJe = new Map<string, RisikoFuerFrequenz>(
    risiken
      .filter((x) => x.uebernehmen)
      .map((x) => [x.code, { code: x.code, gt: x.kat.gt, brutto: x.brutto.klasse }]),
  );
  const stichtag = isoTag(e.zeitraum.angemessenheitStichtag);
  const ab = isoTag(e.zeitraum.wirksamAb);
  const bis = isoTag(e.zeitraum.wirksamBis);
  const zeitraum =
    stichtag && ab && bis && bis.getTime() > ab.getTime() ? { stichtag, ab, bis } : null;
  const turnus = e.zeitraum.erklaerungsTurnus as Turnus;

  const kontrollen: AufbauPlanKontrolle[] = [];
  for (const kat of KATALOG_KONTROLLEN) {
    const verknuepft = kat.risiken.filter((c) => bruttoJe.has(c));
    if (verknuepft.length === 0 && kat.code !== 'K-EC-22') continue;
    const ableitung = leiteFrequenzAb(
      kat.frequenz,
      verknuepft.map((c) => bruttoJe.get(c)!),
      turnus,
    );
    kontrollen.push({
      code: kat.code,
      kat,
      risikoCodes: verknuepft,
      primaer: ableitung.quelle?.code ?? verknuepft[0] ?? null,
      ableitung,
      zust: zustaendigkeitAus(kat, e.kontrollen[kat.code], u, r),
      perioden: zeitraum
        ? perioden(ableitung.effektiv.turnus, addTage(zeitraum.ab, -1), zeitraum.bis)
        : [],
    });
  }

  const last = kontrollen.flatMap((k) =>
    k.perioden.map((p) => ({
      faelligAm: addTage(p.bis, k.kat.faelligNachTagen),
      gt: k.ableitung.gt,
      ausserplanmaessig: false,
      entfallen: false,
    })),
  );
  const prueflast = zeitraum
    ? Array.from({ length: 6 }, (_, i) =>
        pruflast(last, monatSchluessel(monatePlus(zeitraum.ab, i))),
      )
    : [];

  return {
    risiken,
    nichtVorgeschlagen: KATALOG_RISIKEN.filter((k) => !vorgeschlagen.has(k.code)),
    kontrollen,
    appetit,
    zeitraum,
    prueflast,
    durchfuehrungen: last.length,
  };
}

/** Prüfung von Schritt 5: Zuständigkeiten je Kontrolle (Pflichtattribute laut Fachkonzept § 6). */
export function pruefeKontrollZustaendigkeiten(plan: AufbauPlan, u: AufbauUmfeld): string[] {
  const f: string[] = [];
  const kanzlei = new Set(u.kanzlei.map((p) => p.id));
  const mandant = new Set(u.mandantPersonen.map((p) => p.id));
  for (const k of plan.kontrollen) {
    const z = k.zust;
    const pool = z.partei === 'KANZLEI' ? kanzlei : mandant;
    if (!z.durchfuehrendId) f.push(`${k.code}: durchführende Person zuordnen.`);
    else if (!pool.has(z.durchfuehrendId))
      f.push(
        `${k.code}: Die durchführende Person gehört nicht zur Partei ${z.partei === 'KANZLEI' ? 'Kanzlei' : 'Mandant'}.`,
      );
    if (z.vertretungId && z.vertretungId === z.durchfuehrendId)
      f.push(`${k.code}: Vertretung und durchführende Person müssen verschieden sein.`);
    if (z.vertretungId && !pool.has(z.vertretungId))
      f.push(
        `${k.code}: Die Vertretung gehört nicht zur Partei ${z.partei === 'KANZLEI' ? 'Kanzlei' : 'Mandant'}.`,
      );
    if (k.kat.schluessel && !z.gegenzeichnerId)
      f.push(`${k.code}: Schlüsselkontrolle – Gegenzeichnung ist Pflicht.`);
    if (z.gegenzeichnerId && z.gegenzeichnerId === z.durchfuehrendId)
      f.push(`${k.code}: Die durchführende Person zeichnet nicht selbst gegen.`);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Schreiben: Version 1
// ---------------------------------------------------------------------------

type Nutzer = { id: string };

export interface AufbauVersion1Ergebnis {
  protokolle: Protokoll[];
  risiken: number;
  abgelehnt: number;
  kontrollen: number;
  durchfuehrungen: number;
  ziele: number;
  /** Freigabe der Ziele (falls angefordert). */
  freigabeId: string | null;
}

export async function schreibeVersion1(
  tx: Tx,
  a: {
    programmId: string;
    e: SetupEntwurf;
    plan: AufbauPlan;
    u: AufbauUmfeld;
    nutzer: Nutzer;
    zeitpunkt: Date;
  },
): Promise<AufbauVersion1Ergebnis> {
  const { programmId, e, plan, u, nutzer, zeitpunkt } = a;
  if (!plan.zeitraum) throw new Error('Zeitraum fehlt');
  const r = aufbauRollen(u);
  const protokolle: Protokoll[] = [];

  await tx.tcmsProgramm.update({
    where: { id: programmId },
    data: {
      paketId: PAKET.id,
      paketVersion: PAKET.version,
      status: 'AKTIV',
      erklaerungsTurnus: e.zeitraum.erklaerungsTurnus,
      angemessenheitStichtag: plan.zeitraum.stichtag,
      wirksamAb: plan.zeitraum.ab,
      wirksamBis: plan.zeitraum.bis,
      version1Am: zeitpunkt,
      setupEntwurf: Prisma.DbNull,
    },
  });

  const tb = await tx.teilbereich.create({
    data: {
      programmId,
      name: e.teilbereich.name,
      abgrenzung: e.teilbereich.abgrenzung.trim(),
      einschluesse: e.teilbereich.einschluesse.filter(Boolean),
      ausschluesse: e.teilbereich.ausschluesse.filter(Boolean),
      createdAt: zeitpunkt,
    },
  });

  const ziele = e.ziele.filter((z) => z.aktiv);
  const anfordern = e.freigabe.anfordern && e.freigabe.empfaengerId != null;
  for (const z of ziele) {
    await tx.complianceZiel.create({
      data: {
        teilbereichId: tb.id,
        text: z.text.trim(),
        wesentlichkeitEur: z.wesentlichkeitEur,
        risikoappetit: z.risikoappetit,
        freigabe: anfordern ? 'AUSSTEHEND' : 'ENTWURF',
        createdAt: zeitpunkt,
      },
    });
  }

  const profil = await tx.profilStand.create({
    data: {
      programmId,
      version: 1,
      antworten: e.profil as unknown as Prisma.InputJsonValue,
      gueltigAb: zeitpunkt,
      erstelltVon: nutzer.id,
      createdAt: zeitpunkt,
    },
  });

  const risikoIds = new Map<string, string>();
  let abgelehnt = 0;
  for (const pr of plan.risiken) {
    const k = pr.kat;
    const risiko = await tx.risiko.create({
      data: {
        programmId,
        code: k.code,
        kern: k.kern,
        entscheidung: pr.uebernehmen ? 'UEBERNOMMEN' : 'ABGELEHNT',
        vorschlagsgrund: pr.grund,
        ablehnungsgrund: pr.uebernehmen ? null : pr.begruendung.trim(),
        freigabe: pr.uebernehmen ? 'BEWERTET' : 'IDENTIFIZIERT',
        ownerId: pr.uebernehmen ? r.tcb : null,
        aktivAb: zeitpunkt,
        createdAt: zeitpunkt,
        ...(pr.uebernehmen
          ? {
              staende: {
                create: {
                  version: 1,
                  titel: k.titel,
                  fehlerquelle: k.fehlerquelle,
                  folge: k.folge,
                  normanker: k.normanker as unknown as Prisma.InputJsonValue,
                  s: k.s,
                  w: k.w,
                  r: k.r,
                  gt: k.gt,
                  modell: BEWERTUNGSMODELL_VERSION,
                  gueltigAb: zeitpunkt,
                  erstelltVon: nutzer.id,
                  createdAt: zeitpunkt,
                },
              },
            }
          : {}),
      },
    });
    if (pr.uebernehmen) risikoIds.set(k.code, risiko.id);
    else {
      abgelehnt++;
      protokolle.push({
        aktion: 'tcms.risiko.abgelehnt',
        objektTyp: 'Risiko',
        objektId: risiko.id,
        programmId,
        detail: { code: k.code, vorschlagsgrund: pr.grund, begruendung: pr.begruendung.trim() },
      });
    }
  }

  const durchf: Prisma.DurchfuehrungCreateManyInput[] = [];
  for (const pk of plan.kontrollen) {
    const kat = pk.kat;
    const k = await tx.kontrolle.create({
      data: {
        programmId,
        code: kat.code,
        aktivAb: zeitpunkt,
        createdAt: zeitpunkt,
        staende: { create: kontrollStandDaten(kat, pk.zust, nutzer.id, zeitpunkt) },
        risiken: { create: pk.risikoCodes.map((c) => ({ risikoId: risikoIds.get(c)! })) },
      },
      include: { staende: { select: { id: true }, orderBy: [{ version: 'asc' }, { id: 'asc' }] } },
    });
    for (const p of pk.perioden)
      durchf.push(
        geplanteDurchfuehrung(k.id, k.staende[0]!.id, kat.faelligNachTagen, p, zeitpunkt),
      );
  }
  if (durchf.length) await tx.durchfuehrung.createMany({ data: durchf });

  let freigabeId: string | null = null;
  if (anfordern) {
    // TS-06: Empfänger über die ID; die Prüfung von Schritt 3 hat sie gegen die
    // aktiven gesetzlichen Vertretungen des Mandanten geprüft.
    const empfaengerId = e.freigabe.empfaengerId!.toLowerCase();
    const inhalt = [
      `Compliance-Ziele für den Teilbereich „${tb.name}"`,
      '',
      ...ziele.map(
        (z, i) =>
          `${i + 1}. ${z.text.trim()} (Wesentlichkeitsgrenze ${fmtEurGanz(z.wesentlichkeitEur)}, Risikoappetit ${KLASSE_LABEL[z.risikoappetit]})`,
      ),
    ].join('\n');
    const titel = `Compliance-Ziele · ${tb.name}`;
    const fr = await tx.freigabe.create({
      data: {
        programmId,
        art: 'ZIELE',
        refId: tb.id,
        titel,
        inhalt,
        angefordertVon: nutzer.id,
        angefordertAm: zeitpunkt,
        empfaengerId,
      },
    });
    freigabeId = fr.id;
    await legeNachrichtAn(tx, {
      mandantId: u.mandant.id,
      empfaengerId,
      zweck: 'FREIGABE_ANGEFORDERT',
      daten: { freigabeId: fr.id, art: 'ZIELE', titel, version: null },
      betreff: 'Freigabe angefordert: Compliance-Ziele',
      text: `Im Portal warten die Compliance-Ziele der ${u.mandant.name} auf Ihre Freigabe. Den Bestätigungscode erhalten Sie beim Freigeben.`,
    });
    protokolle.push({
      aktion: 'tcms.ziele.freigabe_angefordert',
      objektTyp: 'Teilbereich',
      objektId: tb.id,
      programmId,
      detail: { freigabeId: fr.id, empfaengerId, anzahl: ziele.length },
    });
  }

  protokolle.unshift({
    aktion: 'tcms.programm.version1_angelegt',
    objektTyp: 'TcmsProgramm',
    objektId: programmId,
    programmId,
    detail: {
      paket: `${PAKET.name} ${PAKET.version}`,
      teilbereich: tb.name,
      profilStandId: profil.id,
      angemessenheitStichtag: e.zeitraum.angemessenheitStichtag,
      wirksamkeitszeitraum: `${e.zeitraum.wirksamAb} – ${e.zeitraum.wirksamBis}`,
      erklaerungsTurnus: e.zeitraum.erklaerungsTurnus,
      ziele: ziele.length,
      risiken: [...risikoIds.keys()],
      abgelehnt: plan.risiken.filter((x) => !x.uebernehmen).map((x) => x.code),
      kontrollen: plan.kontrollen.map((k) => k.code),
      durchfuehrungen: durchf.length,
    },
  });

  return {
    protokolle,
    risiken: risikoIds.size,
    abgelehnt,
    kontrollen: plan.kontrollen.length,
    durchfuehrungen: durchf.length,
    ziele: ziele.length,
    freigabeId,
  };
}
