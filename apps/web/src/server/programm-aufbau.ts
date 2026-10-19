import 'server-only';
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
  kontrollenFuerRisiko,
  leiteFrequenzAb,
  monatSchluessel,
  PAKET,
  perioden,
  pruflast,
  schlageRisikenVor,
  ueber,
  type BruttoErgebnis,
  type FrequenzAbleitung,
  type GovernanceTyp,
  type KatalogKontrolle,
  type KatalogRisiko,
  type Klasse,
  type Periode,
  type Pruflast,
  type RisikoFuerFrequenz,
  type Turnus,
} from '@tcms/domain';
import { entscheidung, type EntwurfKontrolle, type SetupEntwurf } from '@/components/setup/entwurf';
import type { Protokoll } from './aktion';
import type { PersonKurz } from './kontext';

// =============================================================================
// Aufbau eines Tax-CMS-Programms aus Profil, Katalog und Entscheidungen.
// Wird vom Einrichtungsassistenten (Version 1) und vom Profil-Tab
// („Risiko aufnehmen") genutzt. Vorlage für Stände, Verknüpfungen und
// Durchführungen ist `baueProgramm` im Seed.
// =============================================================================

export interface Umfeld {
  mandant: { id: string; name: string; berufstraegerId: string; bearbeitungId: string };
  kanzlei: PersonKurz[];
  mandantPersonen: PersonKurz[];
  heute: Date;
}

export interface Rollen {
  bt: string;
  hb: string;
  /** Dritte Kanzleiperson als Vertretung (nicht Berufsträger:in, nicht Hauptbearbeitung des Mandats). */
  kanzleiVertretung: string | null;
  tcb: string | null;
  mandantVertretung: string | null;
  gv: string | null;
}

export function rollen(u: Umfeld): Rollen {
  const bt = u.mandant.berufstraegerId;
  const hb = u.mandant.bearbeitungId;
  const mp = u.mandantPersonen;
  const gv = mp.find((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER')?.id ?? null;
  const tcb =
    mp.find((p) => p.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER')?.id ??
    mp.find((p) => p.mandantRolle === 'MITARBEITER')?.id ??
    gv;
  const mandantVertretung =
    mp.find((p) => p.id !== tcb && p.mandantRolle === 'MITARBEITER')?.id ??
    mp.find((p) => p.id !== tcb && p.mandantRolle === 'GESETZLICHER_VERTRETER')?.id ??
    null;
  const kanzleiVertretung = u.kanzlei.find((p) => p.id !== bt && p.id !== hb)?.id ?? null;
  return { bt, hb, kanzleiVertretung, tcb, mandantVertretung, gv };
}

export interface Zustaendigkeit {
  partei: 'KANZLEI' | 'MANDANT';
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
}

/** Startbelegung wie im Seed: Kanzleikontrollen Hauptbearbeitung, Mandantenkontrollen TCB, Gegenzeichnung Berufsträger:in. */
export function standardZustaendigkeit(kat: KatalogKontrolle, r: Rollen): Zustaendigkeit {
  const mandantSeite = kat.partei === 'MANDANT';
  const durchfuehrend =
    kat.code === 'K-EC-20' || kat.code === 'K-EC-24' ? r.bt : mandantSeite ? r.tcb : r.hb;
  const vertretung = mandantSeite ? r.mandantVertretung : r.kanzleiVertretung;
  const gegenzeichnungMandant = kat.code === 'K-EC-23' && r.mandantVertretung != null;
  const gegenzeichner = gegenzeichnungMandant
    ? r.mandantVertretung
    : durchfuehrend === r.bt
      ? r.kanzleiVertretung
      : r.bt;
  return {
    partei: kat.partei,
    durchfuehrendId: durchfuehrend,
    vertretungId: vertretung,
    gegenzeichnerId: gegenzeichner,
    gegenzeichnungMandant,
  };
}

function zustaendigkeitAus(
  kat: KatalogKontrolle,
  wahl: EntwurfKontrolle | undefined,
  u: Umfeld,
  r: Rollen,
): Zustaendigkeit {
  if (!wahl) return standardZustaendigkeit(kat, r);
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

export interface PlanRisiko {
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

export interface PlanKontrolle {
  code: string;
  kat: KatalogKontrolle;
  risikoCodes: string[];
  /** Risiko, unter dem die Kontrolle im Assistenten konfiguriert wird (bestimmt die Frequenz). */
  primaer: string | null;
  ableitung: FrequenzAbleitung;
  zust: Zustaendigkeit;
  perioden: Periode[];
}

export interface Plan {
  risiken: PlanRisiko[];
  nichtVorgeschlagen: KatalogRisiko[];
  kontrollen: PlanKontrolle[];
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

export function appetitAus(ziele: readonly { risikoappetit: Klasse; aktiv?: boolean }[]): Klasse {
  const aktiv = ziele.filter((z) => z.aktiv !== false);
  if (aktiv.length === 0) return 'MITTEL';
  return aktiv.reduce<Klasse>((a, z) => hoeher(a, z.risikoappetit), 'GERING');
}

function monatePlus(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export function berechnePlan(e: SetupEntwurf, u: Umfeld): Plan {
  const r = rollen(u);
  const appetit = appetitAus(e.ziele);
  const vorschlaege = schlageRisikenVor(e.profil);
  const vorgeschlagen = new Set(vorschlaege.map((v) => v.code));
  const risiken: PlanRisiko[] = vorschlaege.map((v) => {
    const kat = katalogRisiko(v.code)!;
    const b = berechneBrutto(kat.s, kat.w, kat.r);
    const ent = entscheidung(e, v.code, v.kern);
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

  const kontrollen: PlanKontrolle[] = [];
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
export function pruefeKontrollen(plan: Plan, u: Umfeld): string[] {
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

type Nutzer = { id: string; name: string };

export interface Version1Ergebnis {
  protokolle: Protokoll[];
  risiken: number;
  abgelehnt: number;
  kontrollen: number;
  durchfuehrungen: number;
  ziele: number;
  freigabeAn: string | null;
}

export async function schreibeVersion1(
  tx: Tx,
  a: {
    programmId: string;
    e: SetupEntwurf;
    plan: Plan;
    u: Umfeld;
    nutzer: Nutzer;
    zeitpunkt: Date;
  },
): Promise<Version1Ergebnis> {
  const { programmId, e, plan, u, nutzer, zeitpunkt } = a;
  if (!plan.zeitraum) throw new Error('Zeitraum fehlt');
  const r = rollen(u);
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
      include: { staende: { select: { id: true } } },
    });
    for (const p of pk.perioden)
      durchf.push(durchfuehrungDaten(k.id, k.staende[0]!.id, kat, p, zeitpunkt));
  }
  if (durchf.length) await tx.durchfuehrung.createMany({ data: durchf });

  let freigabeAn: string | null = null;
  if (anfordern) {
    const empfaenger = u.mandantPersonen.find((p) => p.id === e.freigabe.empfaengerId);
    freigabeAn = empfaenger?.name ?? null;
    const inhalt = [
      `Compliance-Ziele für den Teilbereich „${tb.name}"`,
      '',
      ...ziele.map(
        (z, i) =>
          `${i + 1}. ${z.text.trim()} (Wesentlichkeitsgrenze ${fmtEurGanz(z.wesentlichkeitEur)}, Risikoappetit ${KLASSE_LABEL[z.risikoappetit]})`,
      ),
    ].join('\n');
    const fr = await tx.freigabe.create({
      data: {
        programmId,
        art: 'ZIELE',
        refId: tb.id,
        titel: `Compliance-Ziele · ${tb.name}`,
        inhalt,
        angefordertVon: nutzer.id,
        angefordertAm: zeitpunkt,
        empfaengerId: e.freigabe.empfaengerId!,
      },
    });
    await tx.nachricht.create({
      data: {
        an: freigabeAn ?? 'Gesetzliche Vertretung',
        betreff: 'Freigabe angefordert: Compliance-Ziele',
        text: `Im Portal warten die Compliance-Ziele der ${u.mandant.name} auf Ihre Freigabe. Den Bestätigungscode erhalten Sie beim Freigeben.`,
        createdAt: zeitpunkt,
      },
    });
    protokolle.push({
      aktion: 'tcms.ziele.freigabe_angefordert',
      objektTyp: 'Teilbereich',
      objektId: tb.id,
      programmId,
      detail: { freigabeId: fr.id, empfaenger: freigabeAn, anzahl: ziele.length },
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
    freigabeAn,
  };
}

function kontrollStandDaten(
  kat: KatalogKontrolle,
  z: Zustaendigkeit,
  von: string,
  zeitpunkt: Date,
) {
  return {
    version: 1,
    titel: kat.titel,
    ziel: kat.ziel,
    art: kat.art,
    ausfuehrung: kat.ausfuehrung,
    vorlageTurnus: kat.frequenz.turnus,
    vorlageAnlass: kat.frequenz.anlass,
    partei: z.partei,
    schluessel: kat.schluessel,
    durchfuehrendId: z.durchfuehrendId,
    vertretungId: z.vertretungId,
    gegenzeichnerId: z.gegenzeichnerId,
    gegenzeichnungMandant: z.gegenzeichnungMandant,
    nachweis: kat.nachweis,
    mindestNachweise: kat.mindestNachweise,
    schritte: kat.schritte as unknown as Prisma.InputJsonValue,
    kennzahlen: kat.kennzahlen as unknown as Prisma.InputJsonValue,
    toleranzEur: kat.toleranzEur,
    faelligNachTagen: kat.faelligNachTagen,
    design: 'NICHT_BEURTEILT' as const,
    gueltigAb: zeitpunkt,
    erstelltVon: von,
    createdAt: zeitpunkt,
  };
}

function durchfuehrungDaten(
  kontrolleId: string,
  standId: string,
  kat: KatalogKontrolle,
  p: Periode,
  zeitpunkt: Date,
): Prisma.DurchfuehrungCreateManyInput {
  return {
    kontrolleId,
    kontrolleStandId: standId,
    periodeLabel: p.label,
    periodeVon: p.von,
    periodeBis: p.bis,
    faelligAm: addTage(p.bis, kat.faelligNachTagen),
    status: 'GEPLANT',
    createdAt: zeitpunkt,
  };
}

// ---------------------------------------------------------------------------
// Schreiben: einzelnes Risiko aus dem Profilvorschlag aufnehmen (Profil-Tab)
// ---------------------------------------------------------------------------

export class AufbauFehler extends Error {}

export interface AufnahmeErgebnis {
  risikoId: string;
  neueKontrollen: string[];
  verknuepft: string[];
  neuGeplant: {
    code: string;
    vorher: string;
    nachher: string;
    entfernt: number;
    angelegt: number;
  }[];
  durchfuehrungen: number;
  protokolle: Protokoll[];
}

function gueltigerStand<T extends { gueltigAb: Date; gueltigBis: Date | null }>(
  liste: T[],
  zeitpunkt: Date,
): T | undefined {
  return liste
    .filter(
      (s) =>
        s.gueltigAb.getTime() <= zeitpunkt.getTime() &&
        (s.gueltigBis == null || s.gueltigBis.getTime() > zeitpunkt.getTime()),
    )
    .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
}

export async function nimmRisikoAuf(
  tx: Tx,
  a: {
    programmId: string;
    code: string;
    grund: string;
    u: Umfeld;
    nutzer: Nutzer;
    zeitpunkt: Date;
  },
): Promise<AufnahmeErgebnis> {
  const { programmId, code, grund, u, nutzer, zeitpunkt } = a;
  const kat = katalogRisiko(code);
  if (!kat) throw new AufbauFehler('Unbekanntes Katalogrisiko.');
  const r = rollen(u);
  const programm = await tx.tcmsProgramm.findUniqueOrThrow({
    where: { id: programmId },
    include: {
      risiken: { include: { staende: true } },
      kontrollen: {
        include: {
          staende: true,
          risiken: true,
          durchfuehrungen: {
            include: {
              _count: {
                select: { nachweise: true, feststellungen: true, nachkontrolleFuer: true },
              },
            },
          },
        },
      },
    },
  });
  const protokolle: Protokoll[] = [];

  // --- Risiko anlegen oder Ablehnung aufheben ---
  const vorhanden = programm.risiken.find((x) => x.code === code);
  if (vorhanden && vorhanden.entscheidung === 'UEBERNOMMEN') {
    throw new AufbauFehler(
      vorhanden.inaktivAb
        ? `${code} ist deaktiviert; eine Reaktivierung erfolgt im Risikoinventar.`
        : `${code} ist bereits im Risikoinventar.`,
    );
  }
  const standDaten = {
    titel: kat.titel,
    fehlerquelle: kat.fehlerquelle,
    folge: kat.folge,
    normanker: kat.normanker as unknown as Prisma.InputJsonValue,
    s: kat.s,
    w: kat.w,
    r: kat.r,
    gt: kat.gt,
    modell: BEWERTUNGSMODELL_VERSION,
    gueltigAb: zeitpunkt,
    erstelltVon: nutzer.id,
    createdAt: zeitpunkt,
  };
  let risikoId: string;
  if (vorhanden) {
    await tx.risiko.update({
      where: { id: vorhanden.id },
      data: {
        entscheidung: 'UEBERNOMMEN',
        vorschlagsgrund: grund,
        freigabe: 'BEWERTET',
        ownerId: vorhanden.ownerId ?? r.tcb,
        aktivAb: zeitpunkt,
      },
    });
    if (!gueltigerStand(vorhanden.staende, zeitpunkt))
      await tx.risikoStand.create({ data: { risikoId: vorhanden.id, ...standDaten } });
    risikoId = vorhanden.id;
  } else {
    const neu = await tx.risiko.create({
      data: {
        programmId,
        code,
        kern: kat.kern,
        entscheidung: 'UEBERNOMMEN',
        vorschlagsgrund: grund,
        freigabe: 'BEWERTET',
        ownerId: r.tcb,
        aktivAb: zeitpunkt,
        createdAt: zeitpunkt,
        staende: { create: standDaten },
      },
    });
    risikoId = neu.id;
  }
  protokolle.push({
    aktion: 'tcms.risiko.aufgenommen',
    objektTyp: 'Risiko',
    objektId: risikoId,
    programmId,
    detail: {
      code,
      vorschlagsgrund: grund,
      vorher: vorhanden ? vorhanden.entscheidung : null,
      quelle: 'Profilvorschlag',
    },
  });

  // --- Bruttoklassen der aktiven Risiken (mit dem neuen) ---
  const bruttoJe = new Map<string, RisikoFuerFrequenz>();
  const risikoIdJe = new Map<string, string>([[code, risikoId]]);
  for (const x of programm.risiken) {
    if (
      x.entscheidung !== 'UEBERNOMMEN' ||
      (x.inaktivAb && x.inaktivAb.getTime() <= zeitpunkt.getTime())
    )
      continue;
    const s = gueltigerStand(x.staende, zeitpunkt);
    if (!s) continue;
    bruttoJe.set(x.code, {
      code: x.code,
      gt: s.gt as GovernanceTyp,
      brutto: berechneBrutto(s.s, s.w, s.r as 1 | 2 | 3).klasse,
    });
    risikoIdJe.set(x.code, x.id);
  }
  const ohneNeues = new Map(bruttoJe);
  bruttoJe.set(code, { code, gt: kat.gt, brutto: berechneBrutto(kat.s, kat.w, kat.r).klasse });

  // --- Planungshorizont für Durchführungen ---
  const heute = u.heute;
  const start =
    programm.wirksamAb && addTage(programm.wirksamAb, -1).getTime() > heute.getTime()
      ? addTage(programm.wirksamAb, -1)
      : heute;
  let ende: Date | null = programm.wirksamBis;
  for (const k of programm.kontrollen) {
    for (const d of k.durchfuehrungen) {
      if (!d.ausserplanmaessig && (!ende || d.periodeBis.getTime() > ende.getTime()))
        ende = d.periodeBis;
    }
  }
  const turnus = programm.erklaerungsTurnus as Turnus;

  const neueKontrollen: string[] = [];
  const verknuepft: string[] = [];
  const neuGeplant: AufnahmeErgebnis['neuGeplant'] = [];
  let anzahlDurchf = 0;

  for (const kk of kontrollenFuerRisiko(code)) {
    const bestehend = programm.kontrollen.find(
      (k) =>
        k.code === kk.code && !(k.entfallenAb && k.entfallenAb.getTime() <= zeitpunkt.getTime()),
    );
    if (bestehend) {
      if (!bestehend.risiken.some((x) => x.risikoId === risikoId)) {
        await tx.risikoKontrolle.create({ data: { risikoId, kontrolleId: bestehend.id } });
        verknuepft.push(kk.code);
      }
      const stand = gueltigerStand(bestehend.staende, zeitpunkt);
      if (!stand) continue;
      const vorlage = { turnus: stand.vorlageTurnus as Turnus, anlass: stand.vorlageAnlass };
      const idZuCode = new Map([...risikoIdJe.entries()].map(([c, id]) => [id, c]));
      const verkn = (m: Map<string, RisikoFuerFrequenz>) =>
        [...new Set([...bestehend.risiken.map((x) => idZuCode.get(x.risikoId)), code])]
          .filter((c): c is string => !!c && m.has(c))
          .map((c) => m.get(c)!);
      const vorher = leiteFrequenzAb(vorlage, verkn(ohneNeues), turnus).effektiv;
      const nachher = leiteFrequenzAb(vorlage, verkn(bruttoJe), turnus).effektiv;
      if (stand.abweichungTurnus == null && vorher.turnus !== nachher.turnus && ende) {
        const ergebnis = await planeKuenftigNeu(tx, {
          kontrolle: bestehend,
          standId: stand.id,
          faelligNachTagen: stand.faelligNachTagen,
          turnus: nachher.turnus,
          start,
          ende,
          heute,
          zeitpunkt,
        });
        neuGeplant.push({
          code: kk.code,
          vorher: vorher.turnus,
          nachher: nachher.turnus,
          ...ergebnis,
        });
        anzahlDurchf += ergebnis.angelegt;
      }
      continue;
    }
    // Neue Kontrolle aus dem Katalog, verknüpft mit allen aktiven Risiken, die sie abdeckt.
    const codes = kk.risiken.filter((c) => bruttoJe.has(c));
    const z = standardZustaendigkeit(kk, r);
    const k = await tx.kontrolle.create({
      data: {
        programmId,
        code: kk.code,
        aktivAb: zeitpunkt,
        createdAt: zeitpunkt,
        staende: { create: kontrollStandDaten(kk, z, nutzer.id, zeitpunkt) },
        risiken: { create: codes.map((c) => ({ risikoId: risikoIdJe.get(c)! })) },
      },
      include: { staende: { select: { id: true } } },
    });
    neueKontrollen.push(kk.code);
    const ableitung = leiteFrequenzAb(
      kk.frequenz,
      codes.map((c) => bruttoJe.get(c)!),
      turnus,
    );
    if (ende && ende.getTime() >= start.getTime()) {
      const daten = perioden(ableitung.effektiv.turnus, start, ende).map((p) =>
        durchfuehrungDaten(k.id, k.staende[0]!.id, kk, p, zeitpunkt),
      );
      if (daten.length) await tx.durchfuehrung.createMany({ data: daten });
      anzahlDurchf += daten.length;
    }
    protokolle.push({
      aktion: 'tcms.kontrolle.angelegt',
      objektTyp: 'Kontrolle',
      objektId: k.id,
      programmId,
      detail: {
        code: kk.code,
        risiken: codes,
        frequenz: ableitung.effektiv,
        anlass: `Risiko ${code} aufgenommen`,
      },
    });
  }
  if (neuGeplant.length) {
    protokolle.push({
      aktion: 'tcms.durchfuehrungen.neu_geplant',
      objektTyp: 'TcmsProgramm',
      objektId: programmId,
      programmId,
      detail: { anlass: `Risiko ${code} aufgenommen`, kontrollen: neuGeplant },
    });
  }
  return {
    risikoId,
    neueKontrollen,
    verknuepft,
    neuGeplant,
    durchfuehrungen: anzahlDurchf,
    protokolle,
  };
}

/**
 * Plant künftige Durchführungen einer Kontrolle nach einem neuen Turnus.
 * Entfernt werden nur geplante, noch nicht begonnene Perioden ohne Nachweise
 * und ohne Bezug zu Feststellungen; laufende und abgeschlossene bleiben.
 */
async function planeKuenftigNeu(
  tx: Tx,
  a: {
    kontrolle: {
      id: string;
      durchfuehrungen: {
        id: string;
        status: string;
        ausserplanmaessig: boolean;
        periodeVon: Date;
        periodeBis: Date;
        begonnenAm: Date | null;
        _count: { nachweise: number; feststellungen: number; nachkontrolleFuer: number };
      }[];
    };
    standId: string;
    faelligNachTagen: number;
    turnus: Turnus;
    start: Date;
    ende: Date;
    heute: Date;
    zeitpunkt: Date;
  },
): Promise<{ entfernt: number; angelegt: number }> {
  const entfernbar = a.kontrolle.durchfuehrungen.filter(
    (d) =>
      d.status === 'GEPLANT' &&
      !d.ausserplanmaessig &&
      d.begonnenAm == null &&
      d.periodeVon.getTime() > a.heute.getTime() &&
      d._count.nachweise === 0 &&
      d._count.feststellungen === 0 &&
      d._count.nachkontrolleFuer === 0,
  );
  if (entfernbar.length)
    await tx.durchfuehrung.deleteMany({ where: { id: { in: entfernbar.map((d) => d.id) } } });
  const ids = new Set(entfernbar.map((d) => d.id));
  const bleibend = a.kontrolle.durchfuehrungen.filter(
    (d) => !ids.has(d.id) && !d.ausserplanmaessig,
  );
  const letztesEnde = bleibend.reduce<Date | null>(
    (m, d) => (!m || d.periodeBis.getTime() > m.getTime() ? d.periodeBis : m),
    null,
  );
  const ab =
    letztesEnde && addTage(letztesEnde, 1).getTime() > a.start.getTime()
      ? addTage(letztesEnde, 1)
      : a.start;
  const neu = perioden(a.turnus, ab, a.ende).filter(
    (p) =>
      p.von.getTime() >= ab.getTime() ||
      (letztesEnde == null && p.bis.getTime() >= a.start.getTime()),
  );
  if (neu.length) {
    await tx.durchfuehrung.createMany({
      data: neu.map((p) => ({
        kontrolleId: a.kontrolle.id,
        kontrolleStandId: a.standId,
        periodeLabel: p.label,
        periodeVon: p.von,
        periodeBis: p.bis,
        faelligAm: addTage(p.bis, a.faelligNachTagen),
        status: 'GEPLANT' as const,
        createdAt: a.zeitpunkt,
      })),
    });
  }
  return { entfernt: entfernbar.length, angelegt: neu.length };
}
