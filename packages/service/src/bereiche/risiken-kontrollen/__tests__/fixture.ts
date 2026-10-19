// =============================================================================
// Testaufbau für DB-Tests des Bereichs „risiken-kontrollen": eigene, zufällige
// Tenants mit Mandanten, Kontaktrollen und einem Programm wie im Seed
// (`baueProgramm`), damit die Tests unabhängig von den Demodaten und beliebig
// oft wiederholbar sind. Läuft als Laufzeitrolle tcms_app über `mitTenant`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Akteur } from '@tcms/contract';
import { mitTenant, type Prisma, type PrismaClient } from '@tcms/db';
import {
  addTage,
  brutto,
  katalogRisiko,
  KATALOG_KONTROLLEN,
  kontrollenFuerRisiko,
  leeresProfil,
  leiteFrequenzAb,
  perioden,
  schlageRisikenVor,
  TEILBEREICH_VORLAGE,
  ZIEL_VORLAGEN,
  type Geschaeftsprofil,
  type Klasse,
} from '@tcms/domain';
import { verweisAblage } from '../../../ablage';
import { imDienst, type DienstKontext, type PersonenVerzeichnis, type Uhr } from '../../../kontext';

/** „Heute" der Tests; fachliche Zeitpunkte laufen je Aufruf um eine Sekunde weiter. */
export const HEUTE = '2026-10-16';
let takt = Date.parse(`${HEUTE}T08:00:00.000Z`);
export const UHR: Uhr = {
  jetzt: () => new Date((takt += 1000)),
  heute: () => HEUTE,
};
export const NAMEN: PersonenVerzeichnis = {
  namen: async (ids) => new Map(ids.map((id) => [id, `Person ${id.slice(0, 4)}`])),
};
export const PORTS = { uhr: UHR, personen: NAMEN, ablage: verweisAblage };

export const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';

/** Profil mit EU-B2C, Lagern im Ausland, Drittlandimport (viele Katalogvorschläge). */
export function testProfil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] };
  p.p2 = {
    eigenversandDE: true,
    lager: [
      { land: 'DE', seit: '2021-04', art: 'FBA' },
      { land: 'PL', seit: '2025-03', art: 'PAN-EU' },
    ],
  };
  p.p3 = { laender: ['DE', 'AT', 'FR', 'PL'], b2bAnteilProzent: 5, b2bEU: true, b2bInland: false };
  p.p4 = {
    warengruppen: [{ name: 'Outdoor-Bekleidung', abweichenderSatz: false }],
    gebrauchtware: false,
  };
  p.p5 = { drittlandImport: true, laender: ['CN'], zollabwicklung: 'Spediteur' };
  p.p6 = { zahlungswege: ['PayPal', 'Klarna'] };
  p.p7 = { gutscheine: true, abos: false, bundles: false };
  p.p8 = { systeme: [{ art: 'Shop', name: 'Shopware', version: '6.6' }] };
  p.p9 = { ossSeit: '2021-07', ioss: false, lokaleUstNr: ['PL'], dauerfrist: true };
  p.p10 = {
    vorjahresumsatzEur: 4_000_000,
    euFernverkaeufeVorjahrEur: 900_000,
    euFernverkaeufeLfdEur: 700_000,
  };
  p.p11 = { vorhanden: true, anbieter: ['Amazon EU S.à r.l.'] };
  return p;
}

export interface Personen {
  bt: string;
  hb: string;
  vertretung: string;
  /** Kanzleiperson mit Mandatsbezug, aber ohne Bearbeitungsrecht. */
  leser: string;
  gv: string;
  tcb: string;
  ma: string;
  /** Kontakt mit inaktiver Rolle. */
  ehemals: string;
}

export interface Programm {
  tenantId: string;
  mandantId: string;
  programmId: string;
  personen: Personen;
  risiken: Map<string, string>;
  kontrollen: Map<string, string>;
  /** Vorgeschlagener, nicht übernommener Katalogcode (für „aufnehmen"). */
  offenerVorschlag: string;
  profil: Geschaeftsprofil;
}

function personen(): Personen {
  return {
    bt: randomUUID(),
    hb: randomUUID(),
    vertretung: randomUUID(),
    leser: randomUUID(),
    gv: randomUUID(),
    tcb: randomUUID(),
    ma: randomUUID(),
    ehemals: randomUUID(),
  };
}

/**
 * Legt Mandant, Kontaktrollen und ein aktives Programm an: alle
 * Profilvorschläge außer einem übernommen (freigegeben), Kontrollen aus dem
 * Katalog mit Designbeurteilung, Durchführungen im Wirksamkeitszeitraum
 * (vergangene abgeschlossen, künftige geplant). Appetit „gering", damit
 * Risiken über dem Appetit liegen.
 */
export async function legeProgrammAn(
  tenantId: string,
  opts: { appetit?: Klasse; client?: PrismaClient } = {},
): Promise<Programm> {
  const mandantId = randomUUID();
  const p = personen();
  const profil = testProfil();
  const heute = new Date(`${HEUTE}T00:00:00.000Z`);
  const version1Am = addTage(heute, -200);
  const wirksamAb = new Date('2026-04-01T00:00:00.000Z');
  const wirksamBis = new Date('2027-03-31T00:00:00.000Z');
  const vorschlaege = schlageRisikenVor(profil);
  const offen = vorschlaege.find((v) => !v.kern && kontrollenFuerRisiko(v.code).length > 0);
  if (!offen) throw new Error('Testprofil ohne passenden offenen Vorschlag');

  return mitTenant(
    tenantId,
    async (tx) => {
      await tx.mandant.create({ data: { id: mandantId, name: 'Test GmbH', rechtsform: 'KapG' } });
      await tx.mandantKontaktRolle.createMany({
        data: [
          { mandantId, kontaktId: p.gv, rolle: 'GESETZLICHER_VERTRETER' },
          { mandantId, kontaktId: p.tcb, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
          { mandantId, kontaktId: p.ma, rolle: 'MITARBEITER' },
          { mandantId, kontaktId: p.ehemals, rolle: 'MITARBEITER', aktiv: false },
        ],
      });
      const programm = await tx.tcmsProgramm.create({
        data: {
          mandantId,
          paketId: 'ecommerce',
          paketVersion: '1.0',
          status: 'AKTIV',
          erklaerungsTurnus: 'MONATLICH',
          angemessenheitStichtag: addTage(wirksamAb, -1),
          wirksamAb,
          wirksamBis,
          version1Am,
          createdAt: version1Am,
        },
      });
      const tb = await tx.teilbereich.create({
        data: {
          programmId: programm.id,
          name: TEILBEREICH_VORLAGE.name,
          abgrenzung: TEILBEREICH_VORLAGE.abgrenzung,
          einschluesse: [...TEILBEREICH_VORLAGE.einschluesse],
          ausschluesse: [...TEILBEREICH_VORLAGE.ausschluesse],
          createdAt: version1Am,
        },
      });
      for (const z of ZIEL_VORLAGEN) {
        await tx.complianceZiel.create({
          data: {
            teilbereichId: tb.id,
            text: z.text,
            wesentlichkeitEur: z.wesentlichkeitEur,
            risikoappetit: opts.appetit ?? 'GERING',
            freigabe: 'FREIGEGEBEN',
            freigegebenAm: version1Am,
            freigegebenVon: p.gv,
            createdAt: version1Am,
          },
        });
      }
      await tx.profilStand.create({
        data: {
          programmId: programm.id,
          version: 1,
          antworten: profil as unknown as Prisma.InputJsonValue,
          gueltigAb: version1Am,
          erstelltVon: p.hb,
          createdAt: version1Am,
        },
      });
      const risiken = new Map<string, string>();
      const bruttoJe = new Map<string, { gt: 'FP' | 'FF' | 'IN'; brutto: Klasse }>();
      for (const v of vorschlaege) {
        if (v.code === offen.code) continue;
        const k = katalogRisiko(v.code)!;
        const r = await tx.risiko.create({
          data: {
            programmId: programm.id,
            code: k.code,
            kern: k.kern,
            entscheidung: 'UEBERNOMMEN',
            vorschlagsgrund: v.grund,
            freigabe: 'FREIGEGEBEN',
            freigabeEingereichtVon: p.hb,
            freigegebenVon: p.bt,
            freigegebenAm: version1Am,
            ownerId: p.tcb,
            aktivAb: version1Am,
            createdAt: version1Am,
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
                modell: 'ec-1.0',
                gueltigAb: version1Am,
                erstelltVon: p.hb,
                createdAt: version1Am,
              },
            },
          },
        });
        risiken.set(k.code, r.id);
        bruttoJe.set(k.code, { gt: k.gt, brutto: brutto(k.s, k.w, k.r).klasse });
      }
      const kontrollen = new Map<string, string>();
      for (const kat of KATALOG_KONTROLLEN) {
        const verknuepft = kat.risiken.filter((c) => risiken.has(c));
        if (verknuepft.length === 0 && kat.code !== 'K-EC-22') continue;
        const mandantSeite = kat.partei === 'MANDANT';
        const durchfuehrend = mandantSeite ? p.tcb : p.hb;
        const vertretung = mandantSeite ? p.ma : p.vertretung;
        const k = await tx.kontrolle.create({
          data: {
            programmId: programm.id,
            code: kat.code,
            aktivAb: version1Am,
            createdAt: version1Am,
            staende: {
              create: {
                version: 1,
                titel: kat.titel,
                ziel: kat.ziel,
                art: kat.art,
                ausfuehrung: kat.ausfuehrung,
                vorlageTurnus: kat.frequenz.turnus,
                vorlageAnlass: kat.frequenz.anlass,
                partei: kat.partei,
                schluessel: kat.schluessel,
                durchfuehrendId: durchfuehrend,
                vertretungId: vertretung,
                gegenzeichnerId: p.bt,
                gegenzeichnungMandant: false,
                nachweis: kat.nachweis,
                mindestNachweise: kat.mindestNachweise,
                schritte: kat.schritte as unknown as Prisma.InputJsonValue,
                kennzahlen: kat.kennzahlen as unknown as Prisma.InputJsonValue,
                toleranzEur: kat.toleranzEur,
                faelligNachTagen: kat.faelligNachTagen,
                design: 'ANGEMESSEN',
                designVon: p.bt,
                designAm: version1Am,
                designBegruendung: BEGRUENDUNG,
                gueltigAb: version1Am,
                erstelltVon: p.hb,
                createdAt: version1Am,
              },
            },
            risiken: { create: verknuepft.map((c) => ({ risikoId: risiken.get(c)! })) },
          },
          include: { staende: true },
        });
        kontrollen.set(kat.code, k.id);
        const ableitung = leiteFrequenzAb(
          kat.frequenz,
          verknuepft.map((c) => ({ code: c, ...bruttoJe.get(c)! })),
          'MONATLICH',
        );
        const daten: Prisma.DurchfuehrungCreateManyInput[] = perioden(
          ableitung.effektiv.turnus,
          addTage(wirksamAb, -1),
          wirksamBis,
        ).map((per) => {
          const faelligAm = addTage(per.bis, kat.faelligNachTagen);
          const vorbei = faelligAm.getTime() < heute.getTime();
          return {
            kontrolleId: k.id,
            kontrolleStandId: k.staende[0]!.id,
            periodeLabel: per.label,
            periodeVon: per.von,
            periodeBis: per.bis,
            faelligAm,
            status: vorbei ? 'OHNE_BEFUND' : 'GEPLANT',
            ...(vorbei
              ? {
                  durchgefuehrtVon: durchfuehrend,
                  begonnenAm: per.bis,
                  eingereichtAm: per.bis,
                  gegengezeichnetVon: p.bt,
                  abgeschlossenAm: faelligAm,
                  ergebnis: 'OHNE_BEFUND' as const,
                }
              : {}),
            createdAt: version1Am,
          };
        });
        if (daten.length) await tx.durchfuehrung.createMany({ data: daten });
      }
      return {
        tenantId,
        mandantId,
        programmId: programm.id,
        personen: p,
        risiken,
        kontrollen,
        offenerVorschlag: offen.code,
        profil,
      };
    },
    { timeoutMs: 60_000, ...(opts.client ? { client: opts.client } : {}) },
  );
}

// -----------------------------------------------------------------------------
// Akteure
// -----------------------------------------------------------------------------

export function kanzlei(
  tenantId: string,
  id: string,
  mandantId: string | null,
  p: { admin?: boolean; bt?: boolean; zustaendig?: boolean; hb?: boolean } = {},
): Akteur {
  return {
    art: 'KANZLEI',
    tenantId,
    id,
    name: 'Kanzleiperson',
    istAdmin: p.admin ?? false,
    istBerufstraeger: p.bt ?? false,
    mandant: mandantId
      ? {
          id: mandantId,
          zustaendigBerufstraeger: p.zustaendig ?? false,
          hauptbearbeitung: p.hb ?? false,
        }
      : null,
  };
}

export function kontakt(tenantId: string, id: string, mandantId: string): Akteur {
  return { art: 'MANDANT', tenantId, id, name: 'Kontakt', mandantId };
}

/** Akteure eines Programms: BT (zuständig), Hauptbearbeitung, Leser ohne Bearbeitungsrecht. */
export function akteureVon(x: Programm) {
  return {
    bt: kanzlei(x.tenantId, x.personen.bt, x.mandantId, { bt: true, zustaendig: true }),
    hb: kanzlei(x.tenantId, x.personen.hb, x.mandantId, { hb: true }),
    /** Admin ohne Zuständigkeit (zweite Person mit Bearbeitungsrecht). */
    admin: kanzlei(x.tenantId, randomUUID(), x.mandantId, { admin: true }),
    leser: kanzlei(x.tenantId, x.personen.leser, x.mandantId),
    gv: kontakt(x.tenantId, x.personen.gv, x.mandantId),
  };
}

// -----------------------------------------------------------------------------
// Aufrufe und Fehler
// -----------------------------------------------------------------------------

/** Schranke für gleichzeitige Aufrufe (siehe `gleichzeitig`). */
let aktiveSchranke: (() => Promise<void>) | null = null;

export function rufe<T>(
  a: Akteur,
  fn: (ctx: DienstKontext) => Promise<T>,
  client?: PrismaClient,
): Promise<T> {
  const schranke = aktiveSchranke;
  return imDienst(
    a,
    PORTS,
    async (ctx) => {
      if (schranke) await schranke();
      return fn(ctx);
    },
    client ? { client } : undefined,
  );
}

export async function fehlerVon(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (
      e &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { name?: string }).name === 'DienstFehler'
    )
      return e as {
        code: string;
        message: string;
        felder?: Record<string, string[]>;
        grund?: string;
      };
    throw e;
  }
  throw new Error('Kein Fehler, obwohl einer erwartet war');
}

/** Lässt alle Aufrufe erst weiterlaufen, wenn jeder seine Transaktion geöffnet hat. */
function schranke(anzahl: number): () => Promise<void> {
  let angekommen = 0;
  let frei: () => void = () => {};
  const offen = new Promise<void>((r) => {
    frei = r;
    // Sicherheitsnetz: nie länger als 5 s warten (z. B. Fehler vor der Transaktion).
    setTimeout(r, 5000).unref();
  });
  return async () => {
    if (++angekommen >= anzahl) frei();
    await offen;
  };
}

/**
 * Startet die Aufrufe gleichzeitig (eigene Transaktionen, je nach Aufruf eigene
 * Verbindung). Eine Schranke sorgt dafür, dass alle Transaktionen offen sind,
 * bevor eine die Fachoperation beginnt – das Rennen ist damit echt und nicht
 * vom Verbindungsaufbau abhängig. Liefert Anzahl Erfolge und Fehlercodes.
 */
export async function gleichzeitig(...laeufe: (() => Promise<unknown>)[]) {
  aktiveSchranke = schranke(laeufe.length);
  let versprechen: Promise<unknown>[];
  try {
    versprechen = laeufe.map((l) => l());
  } finally {
    aktiveSchranke = null;
  }
  const r = await Promise.allSettled(versprechen);
  const erfolge = r.filter((x) => x.status === 'fulfilled').length;
  const codes = r
    .filter((x): x is PromiseRejectedResult => x.status === 'rejected')
    .map((x) => {
      const e = x.reason as { code?: string; name?: string; message?: string };
      return e?.name === 'DienstFehler' ? e.code : `UNERWARTET:${e?.message ?? String(e)}`;
    });
  return { erfolge, codes };
}
