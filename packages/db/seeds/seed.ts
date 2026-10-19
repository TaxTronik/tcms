// =============================================================================
// Demo-Daten für das Tax-CMS (fiktiv). Bildet den Stand des Fachkonzepts
// Abschnitt 11 ab: Talwind Outdoor GmbH im Wirksamkeitszeitraum (Monat 4 von 6,
// Stand 16.10.2026) und drei weitere Mandanten im Portfolio.
//
// Aufruf: pnpm db:seed (leert alle Tabellen vorher). Läuft als Eigentümerrolle
// (`DATABASE_OWNER_URL`) im festen Demo-Tenant: RLS gilt auch hier (FORCE), der
// Tenant steht für jede Verbindung des Seeds als Sitzungswert fest.
// Personen kommen aus dem statischen Demo-Verzeichnis (`seeds/demo.ts`).
// =============================================================================

import { createHash } from 'node:crypto';
import {
  ABSCHNITTE,
  addTage,
  brutto as berechneBrutto,
  katalogKontrolle,
  katalogRisiko,
  KATALOG_KONTROLLEN,
  leeresProfil,
  leiteFrequenzAb,
  perioden,
  schlageRisikenVor,
  TEILBEREICH_VORLAGE,
  utc,
  ZIEL_VORLAGEN,
  ereignistyp,
  type Abschnitt,
  type BausteinArt,
  type Geschaeftsprofil,
  type KatalogKontrolle,
  type Turnus,
} from '@tcms/domain';
import { kanonisch } from '@tcms/domain/audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { haengeAuditAn } from '../src/audit';
import { speichereDatei } from '../src/storage';
import { TENANT_EINSTELLUNG } from '../src/tenant';
import { DEMO_IDS, DEMO_MANDANTEN, DEMO_PERSONEN, DEMO_TENANT_ID, type DemoPerson } from './demo';

if (process.env['NODE_ENV'] === 'production') {
  // Der Seed leert alle Tabellen; nie gegen eine Produktionsumgebung.
  throw new Error('[seed] Abbruch: NODE_ENV=production.');
}
const OWNER_URL = process.env['DATABASE_OWNER_URL'];
if (!OWNER_URL) throw new Error('[seed] DATABASE_OWNER_URL fehlt. Siehe .env.example.');

// Jede Verbindung des Seeds startet im Demo-Tenant (RLS ist auch für den
// Eigentümer erzwungen); die Laufzeit setzt den Tenant dagegen je Transaktion.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: OWNER_URL,
    options: `-c ${TENANT_EINSTELLUNG}=${DEMO_TENANT_ID}`,
  }),
});

const HEUTE = process.env['TCMS_DEMO_TODAY']
  ? new Date(`${process.env['TCMS_DEMO_TODAY']}T00:00:00Z`)
  : new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    );

const zeit = (d: Date, stunde: number, minute = 0) =>
  new Date(d.getTime() + (stunde * 60 + minute) * 60_000);

// ---------------------------------------------------------------------------
// Personen
// ---------------------------------------------------------------------------

async function leeren() {
  const tabellen = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tabellen.length === 0) return;
  const liste = tabellen.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${liste} RESTART IDENTITY CASCADE`);
}

type P = { id: string; name: string };

const person = (id: string): P => {
  const p = DEMO_PERSONEN.find((x) => x.id === id);
  if (!p) throw new Error(`[seed] Demo-Person fehlt: ${id}`);
  return { id: p.id, name: p.name };
};

async function audit(
  actor: P | null,
  aktion: string,
  objektTyp: string,
  objektId: string,
  programmId: string | null,
  at: Date,
  detail: Record<string, unknown> = {},
) {
  // Rückdatierte Demo-Historie; die Laufzeit schreibt immer die echte Zeit.
  await prisma.$transaction((tx) =>
    haengeAuditAn(
      tx,
      {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? 'System',
        aktion,
        objektTyp,
        objektId,
        programmId,
        detail,
      },
      at,
    ),
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function talwindProfil(mitCZ: boolean): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon', 'eBay'] };
  p.p2 = {
    eigenversandDE: true,
    lager: [
      { land: 'DE', seit: '2021-04', art: 'FBA' },
      { land: 'PL', seit: '2025-03', art: 'PAN-EU' },
      ...(mitCZ ? [{ land: 'CZ', seit: '2026-08', art: 'PAN-EU' as const }] : []),
    ],
  };
  p.p3 = {
    laender: ['DE', 'AT', 'BE', 'CZ', 'ES', 'FR', 'IT', 'NL', 'PL'],
    b2bAnteilProzent: 7,
    b2bEU: true,
    b2bInland: false,
  };
  p.p4 = {
    warengruppen: [
      { name: 'Zelte und Schlafsäcke', abweichenderSatz: false },
      { name: 'Outdoor-Bekleidung', abweichenderSatz: false },
      { name: 'Kocher und Zubehör', abweichenderSatz: false },
    ],
    gebrauchtware: false,
  };
  p.p5 = {
    drittlandImport: true,
    laender: ['CN', 'VN'],
    zollabwicklung: 'Spediteur mit indirekter Vertretung',
  };
  p.p6 = { zahlungswege: ['PayPal', 'Stripe', 'Klarna', 'Amazon Pay', 'Vorkasse'] };
  p.p7 = { gutscheine: true, abos: false, bundles: false };
  p.p8 = {
    systeme: [
      { art: 'Shop', name: 'Shopware', version: '6.6' },
      { art: 'Marktplatz-Tool', name: 'Amazon Seller Central', version: '—' },
      { art: 'Warenwirtschaft', name: 'Standard-WaWi', version: '2026.1' },
      { art: 'FiBu', name: 'DATEV (Kanzlei)', version: '—' },
    ],
  };
  p.p9 = { ossSeit: '2021-07', ioss: false, lokaleUstNr: ['PL'], dauerfrist: true };
  p.p10 = {
    vorjahresumsatzEur: 4_800_000,
    euFernverkaeufeVorjahrEur: 1_260_000,
    euFernverkaeufeLfdEur: 1_089_300,
  };
  p.p11 = {
    vorhanden: true,
    anbieter: ['Amazon EU S.à r.l.', 'Google Ireland', 'Meta Platforms Ireland'],
  };
  p.p12 = { buchhaltung: 'KANZLEI' };
  return p;
}

function seesternProfil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopify', marktplaetze: ['Otto', 'Kaufland'] };
  p.p2 = { eigenversandDE: true, lager: [] };
  p.p3 = { laender: ['DE', 'AT', 'NL'], b2bAnteilProzent: 0, b2bEU: false, b2bInland: false };
  p.p4 = {
    warengruppen: [{ name: 'Wohnaccessoires', abweichenderSatz: false }],
    gebrauchtware: false,
  };
  p.p6 = { zahlungswege: ['PayPal', 'Klarna'] };
  p.p7 = { gutscheine: true, abos: false, bundles: true };
  p.p9 = { ossSeit: '2022-01', ioss: false, lokaleUstNr: [], dauerfrist: true };
  p.p10 = {
    vorjahresumsatzEur: 1_900_000,
    euFernverkaeufeVorjahrEur: 180_000,
    euFernverkaeufeLfdEur: 142_000,
  };
  return p;
}

function kleinwerkProfil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'WooCommerce', marktplaetze: ['Etsy'] };
  p.p3 = { laender: ['DE', 'AT', 'FR'], b2bAnteilProzent: 0, b2bEU: false, b2bInland: false };
  p.p4 = {
    warengruppen: [{ name: 'Handgefertigte Lederwaren', abweichenderSatz: false }],
    gebrauchtware: false,
  };
  p.p6 = { zahlungswege: ['PayPal', 'Vorkasse'] };
  p.p10 = {
    vorjahresumsatzEur: 310_000,
    euFernverkaeufeVorjahrEur: 6_900,
    euFernverkaeufeLfdEur: 8_420,
  };
  return p;
}

function pixelhafenProfil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] };
  p.p2 = { eigenversandDE: false, lager: [{ land: 'DE', seit: '2019-02', art: '3PL' }] };
  p.p3 = { laender: ['DE', 'AT', 'FR', 'IT'], b2bAnteilProzent: 30, b2bEU: true, b2bInland: true };
  p.p4 = {
    warengruppen: [{ name: 'Unterhaltungselektronik', abweichenderSatz: false }],
    gebrauchtware: true,
  };
  p.p5 = { drittlandImport: true, laender: ['CN'], zollabwicklung: 'eigene Zollanmeldung' };
  p.p6 = { zahlungswege: ['PayPal', 'Rechnung'] };
  p.p9 = { ossSeit: '2021-07', ioss: false, lokaleUstNr: [], dauerfrist: true };
  p.p10 = {
    vorjahresumsatzEur: 7_200_000,
    euFernverkaeufeVorjahrEur: 410_000,
    euFernverkaeufeLfdEur: 355_000,
  };
  p.p11 = { vorhanden: true, anbieter: ['Amazon EU S.à r.l.'] };
  return p;
}

// ---------------------------------------------------------------------------
// Beschreibung
// ---------------------------------------------------------------------------

function abschnitte(mandant: string, kulturLeer = false): Abschnitt[] {
  const t = (text: string) => ({ typ: 'text' as const, text });
  const b = (art: BausteinArt) => ({ typ: 'baustein' as const, art });
  const inhalt: Record<string, Abschnitt['bloecke']> = {
    teilbereich: [
      t(
        `Die gesetzlichen Vertreter der ${mandant} grenzen den Teilbereich „Umsatzsteuer & Erlös-Datenkette E-Commerce" ab. Er umfasst die umsatzsteuerlichen Pflichten aus Online-Verkäufen im Inland und in allen Ländern mit Steuerpflicht sowie die Datenkette vom Shop bis zur Finanzbuchhaltung.`,
      ),
      b('TEILBEREICH'),
    ],
    kultur: kulturLeer
      ? [t('')]
      : [
          t(
            'Die Geschäftsführung bekennt sich in der Steuerrichtlinie zur vollständigen und fristgerechten Erfüllung steuerlicher Pflichten. Verstöße werden nicht toleriert; Hinweise auf Fehler sind ausdrücklich erwünscht und haben keine Nachteile für die meldende Person.',
          ),
        ],
    ziele: [
      t(
        'Die Compliance-Ziele und der Risikoappetit sind von den gesetzlichen Vertretern freigegeben. Risiken oberhalb des Appetits erfordern eine Maßnahme oder eine dokumentierte Risikoakzeptanz.',
      ),
      b('ZIELE'),
    ],
    risiken: [
      t(
        'Die Kanzlei bewertet die risikorelevanten Prozesse jährlich und anlassbezogen. Die Bewertung folgt der dokumentierten Methodik aus Schadensintensität, Eintrittswahrscheinlichkeit und Reichweite; Ergebnisse und Begründungen sind im Risikoinventar hinterlegt.',
      ),
      b('RISIKOINVENTAR'),
    ],
    programm: [
      t(
        'Jedem Risiko sind Kontrollen mit Ziel, Schritten, Nachweisanforderung, Toleranz und Frequenz zugeordnet. Die Mindestfrequenz folgt aus Governance-Typ und Bruttoklasse; Schlüsselkontrollen werden im Vier-Augen-Prinzip gegengezeichnet.',
      ),
      b('KONTROLLMATRIX'),
    ],
    organisation: [
      t(
        'Verantwortlich für das Tax-CMS ist die Geschäftsführung. Die operative Steuerung liegt beim Tax-Compliance-Beauftragten; die Kanzlei führt die ihr übertragenen Kontrollen durch und würdigt Feststellungen fachlich.',
      ),
      b('VERANTWORTUNG'),
    ],
    kommunikation: [
      t(
        'Die Steuerrichtlinie und die Arbeitsanweisungen werden allen Beteiligten zur Kenntnis gegeben. Veränderungen im Geschäftsmodell meldet der Mandant über das Portal als Ereignis; die Kanzlei triagiert jede Meldung.',
      ),
    ],
    ueberwachung: [
      t(
        'Abweichungen aus Kontrollen, Ereignissen und Stichproben werden als Feststellungen erfasst und bis zur Nachkontrolle verfolgt. Erkannte steuerliche Fehler würdigt ein Berufsträger im Hinblick auf § 153 AO.',
      ),
      b('FESTSTELLUNGEN'),
    ],
    anhang: [
      t('Die länderspezifischen Besonderheiten der Fernverkäufe werden im Länder-Monitor geführt.'),
      b('LAENDER'),
    ],
  };
  return ABSCHNITTE.map((a) => ({ key: a.key, bloecke: inhalt[a.key] ?? [] }));
}

// ---------------------------------------------------------------------------
// Programm-Bausteine
// ---------------------------------------------------------------------------

interface ProgrammCfg {
  mandantId: string;
  bt: P;
  hb: P;
  vertretung: P;
  mandantDurchfuehrend: P;
  mandantVertretung: P;
  gv: P;
  profil: Geschaeftsprofil;
  angelegt: Date;
  version1Am: Date;
  zieleFreigegeben: boolean;
  /** Kontrollen ohne Designbeurteilung. */
  ohneDesign: string[] | 'alle';
  angemessenheit: Date | null;
  wirksamAb: Date | null;
  wirksamBis: Date | null;
  durchfuehrungenBis: Date | null;
}

interface Aufgebaut {
  programmId: string;
  risiken: Map<string, string>;
  kontrollen: Map<
    string,
    {
      id: string;
      standId: string;
      kat: KatalogKontrolle;
      durchfuehrend: P;
      gegenzeichner: P;
      partei: 'KANZLEI' | 'MANDANT';
    }
  >;
}

async function baueProgramm(cfg: ProgrammCfg): Promise<Aufgebaut> {
  const programm = await prisma.tcmsProgramm.create({
    data: {
      mandantId: cfg.mandantId,
      paketId: 'ecommerce',
      paketVersion: '1.0',
      status: 'AKTIV',
      erklaerungsTurnus: 'MONATLICH',
      angemessenheitStichtag: cfg.angemessenheit,
      wirksamAb: cfg.wirksamAb,
      wirksamBis: cfg.wirksamBis,
      version1Am: cfg.version1Am,
      createdAt: cfg.angelegt,
    },
  });
  await audit(
    cfg.hb,
    'tcms.programm.angelegt',
    'TcmsProgramm',
    programm.id,
    programm.id,
    cfg.angelegt,
    { paket: 'E-Commerce 1.0' },
  );

  const tb = await prisma.teilbereich.create({
    data: {
      programmId: programm.id,
      name: TEILBEREICH_VORLAGE.name,
      abgrenzung: TEILBEREICH_VORLAGE.abgrenzung,
      einschluesse: [...TEILBEREICH_VORLAGE.einschluesse],
      ausschluesse: [...TEILBEREICH_VORLAGE.ausschluesse],
      createdAt: cfg.angelegt,
    },
  });

  for (const z of ZIEL_VORLAGEN) {
    await prisma.complianceZiel.create({
      data: {
        teilbereichId: tb.id,
        text: z.text,
        wesentlichkeitEur: z.wesentlichkeitEur,
        risikoappetit: z.risikoappetit,
        freigabe: cfg.zieleFreigegeben ? 'FREIGEGEBEN' : 'AUSSTEHEND',
        freigegebenAm: cfg.zieleFreigegeben ? addTage(cfg.version1Am, 4) : null,
        freigegebenVon: cfg.zieleFreigegeben ? cfg.gv.id : null,
        createdAt: cfg.angelegt,
      },
    });
  }
  if (cfg.zieleFreigegeben) {
    await audit(
      cfg.gv,
      'tcms.ziele.freigegeben',
      'Teilbereich',
      tb.id,
      programm.id,
      addTage(cfg.version1Am, 4),
      { anzahl: ZIEL_VORLAGEN.length },
    );
  }

  await prisma.profilStand.create({
    data: {
      programmId: programm.id,
      version: 1,
      antworten: cfg.profil as unknown as Prisma.InputJsonValue,
      gueltigAb: cfg.angelegt,
      erstelltVon: cfg.hb.id,
    },
  });

  const vorschlaege = schlageRisikenVor(cfg.profil);
  const risiken = new Map<string, string>();
  const bruttoJe = new Map<
    string,
    { gt: 'FP' | 'FF' | 'IN'; brutto: ReturnType<typeof berechneBrutto>['klasse'] }
  >();
  for (const v of vorschlaege) {
    const k = katalogRisiko(v.code)!;
    const r = await prisma.risiko.create({
      data: {
        programmId: programm.id,
        code: k.code,
        kern: k.kern,
        entscheidung: 'UEBERNOMMEN',
        vorschlagsgrund: v.grund,
        freigabe: 'FREIGEGEBEN',
        freigabeEingereichtVon: cfg.hb.id,
        freigegebenVon: cfg.bt.id,
        freigegebenAm: addTage(cfg.version1Am, 6),
        ownerId: cfg.mandantDurchfuehrend.id,
        aktivAb: cfg.version1Am,
        createdAt: cfg.version1Am,
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
            gueltigAb: cfg.version1Am,
            erstelltVon: cfg.hb.id,
          },
        },
      },
    });
    risiken.set(k.code, r.id);
    bruttoJe.set(k.code, { gt: k.gt, brutto: berechneBrutto(k.s, k.w, k.r).klasse });
  }
  await audit(
    cfg.bt,
    'tcms.risiken.freigegeben',
    'TcmsProgramm',
    programm.id,
    programm.id,
    addTage(cfg.version1Am, 6),
    {
      anzahl: risiken.size,
    },
  );

  const kontrollen: Aufgebaut['kontrollen'] = new Map();
  for (const kat of KATALOG_KONTROLLEN) {
    const verknuepft = kat.risiken.filter((c) => risiken.has(c));
    if (verknuepft.length === 0 && kat.code !== 'K-EC-22') continue;
    const mandantSeite = kat.partei === 'MANDANT';
    const durchfuehrend =
      kat.code === 'K-EC-20' || kat.code === 'K-EC-24'
        ? cfg.bt
        : mandantSeite
          ? cfg.mandantDurchfuehrend
          : cfg.hb;
    const vertretung = mandantSeite
      ? cfg.mandantVertretung
      : kat.code === 'K-EC-20'
        ? cfg.vertretung
        : cfg.vertretung;
    const gegenzeichnungMandant = kat.code === 'K-EC-23';
    const gegenzeichner = gegenzeichnungMandant
      ? cfg.mandantVertretung
      : durchfuehrend.id === cfg.bt.id
        ? cfg.vertretung
        : cfg.bt;
    const ohneDesign = cfg.ohneDesign === 'alle' || cfg.ohneDesign.includes(kat.code);
    const k = await prisma.kontrolle.create({
      data: {
        programmId: programm.id,
        code: kat.code,
        aktivAb: cfg.version1Am,
        createdAt: cfg.version1Am,
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
            durchfuehrendId: durchfuehrend.id,
            vertretungId: vertretung.id,
            gegenzeichnerId: gegenzeichner.id,
            gegenzeichnungMandant,
            nachweis: kat.nachweis,
            mindestNachweise: kat.mindestNachweise,
            schritte: kat.schritte as unknown as Prisma.InputJsonValue,
            kennzahlen: kat.kennzahlen as unknown as Prisma.InputJsonValue,
            toleranzEur: kat.toleranzEur,
            faelligNachTagen: kat.faelligNachTagen,
            design: ohneDesign ? 'NICHT_BEURTEILT' : 'ANGEMESSEN',
            designVon: ohneDesign ? null : cfg.bt.id,
            designAm: ohneDesign ? null : addTage(cfg.version1Am, 10),
            designBegruendung: ohneDesign
              ? null
              : 'Kontrolle adressiert die Fehlerquelle direkt; Schritte, Nachweis und Toleranz sind festgelegt.',
            gueltigAb: cfg.version1Am,
            erstelltVon: cfg.hb.id,
          },
        },
        risiken: { create: verknuepft.map((code) => ({ risikoId: risiken.get(code)! })) },
      },
      include: { staende: true },
    });
    kontrollen.set(kat.code, {
      id: k.id,
      standId: k.staende[0]!.id,
      kat,
      durchfuehrend,
      gegenzeichner,
      partei: kat.partei,
    });
  }
  await audit(
    cfg.bt,
    'tcms.kontrollen.design',
    'TcmsProgramm',
    programm.id,
    programm.id,
    addTage(cfg.version1Am, 10),
    {
      beurteilt: cfg.ohneDesign === 'alle' ? 0 : kontrollen.size - cfg.ohneDesign.length,
    },
  );

  // Durchführungen aus der effektiven Frequenz planen.
  if (cfg.wirksamAb && cfg.durchfuehrungenBis) {
    for (const k of kontrollen.values()) {
      const risikenK = k.kat.risiken
        .filter((c) => bruttoJe.has(c))
        .map((c) => ({ code: c, ...bruttoJe.get(c)! }));
      const ableitung = leiteFrequenzAb(k.kat.frequenz, risikenK, 'MONATLICH' as Turnus);
      for (const p of perioden(
        ableitung.effektiv.turnus,
        addTage(cfg.wirksamAb, -1),
        cfg.durchfuehrungenBis,
      )) {
        const faelligAm = addTage(p.bis, k.kat.faelligNachTagen);
        const vorHeute = faelligAm.getTime() < HEUTE.getTime();
        const d = await prisma.durchfuehrung.create({
          data: {
            kontrolleId: k.id,
            kontrolleStandId: k.standId,
            periodeLabel: p.label,
            periodeVon: p.von,
            periodeBis: p.bis,
            faelligAm,
            status: vorHeute ? 'OHNE_BEFUND' : 'GEPLANT',
            ...(vorHeute ? abgeschlossen(k, faelligAm) : {}),
          },
        });
        if (vorHeute) await nachweiseFuer(d.id, k, p.label, faelligAm);
      }
    }
  }

  return { programmId: programm.id, risiken, kontrollen };
}

function werteFuer(
  kat: KatalogKontrolle,
  saat: number,
): Record<string, { wert: number | null; bemerkung: string; erklaert: boolean }> {
  const out: Record<string, { wert: number | null; bemerkung: string; erklaert: boolean }> = {};
  const basis = 360_000 + ((saat * 7919) % 60_000);
  for (const kz of kat.kennzahlen) {
    if (kz.differenzAus) continue;
    let wert: number;
    if (kz.sollEur === 0) wert = 0;
    else if (kz.key === 'zdl' || kz.key === 'korrekturen' || kz.key === 'erloeskonten')
      wert = basis - ((saat * 37) % 180);
    else if (kz.key.startsWith('fernverkaeufe')) wert = 900_000 + saat * 1000;
    else wert = basis;
    out[kz.key] = { wert: Math.round(wert * 100) / 100, bemerkung: '', erklaert: false };
  }
  return out;
}

function abgeschlossen(
  k: Aufgebaut['kontrollen'] extends Map<string, infer V> ? V : never,
  faelligAm: Date,
) {
  const eingereicht = zeit(addTage(faelligAm, -2), 15, 20);
  return {
    schritte: k.kat.schritte.map(() => ({
      erledigt: true,
      kommentar: '',
    })) as Prisma.InputJsonValue,
    werte: werteFuer(k.kat, faelligAm.getUTCMonth() + 3) as unknown as Prisma.InputJsonValue,
    ergebnis: 'OHNE_BEFUND' as const,
    durchgefuehrtVon: k.durchfuehrend.id,
    begonnenAm: zeit(addTage(faelligAm, -4), 9, 30),
    eingereichtAm: eingereicht,
    mandantBestaetigtVon: null,
    gegengezeichnetVon: k.gegenzeichner.id,
    abgeschlossenAm: zeit(addTage(faelligAm, -1), 10, 5),
  };
}

let dateiZaehler = 0;
async function nachweiseFuer(
  durchfuehrungId: string,
  k: { kat: KatalogKontrolle; durchfuehrend: P },
  periode: string,
  faelligAm: Date,
  namen?: string[],
) {
  const anzahl = Math.max(k.kat.mindestNachweise, namen?.length ?? 0);
  for (let i = 0; i < anzahl; i++) {
    dateiZaehler++;
    const name =
      namen?.[i] ?? `${k.kat.code}_${periode.replace(/\s+/g, '_')}${i ? `_${i + 1}` : ''}.csv`;
    const inhalt = Buffer.from(
      `Kontrolle;Periode;Nachweis;Erzeugt\n${k.kat.code};${periode};${k.kat.nachweis};${faelligAm.toISOString().slice(0, 10)}\n# Demo-Nachweis ${dateiZaehler} (fiktiv)\n`,
      'utf8',
    );
    const gespeichert = await speichereDatei(inhalt);
    await prisma.nachweis.create({
      data: {
        durchfuehrungId,
        dateiname: name,
        mime: 'text/csv',
        groesse: gespeichert.groesse,
        sha256: gespeichert.sha256,
        dokumentId: gespeichert.speicherpfad,
        gesperrt: true,
        hochgeladenVon: k.durchfuehrend.id,
        hochgeladenAm: zeit(addTage(faelligAm, -3), 11, 0),
      },
    });
  }
}

async function durchfuehrungZu(kontrolleId: string, periodeLabel: string) {
  return prisma.durchfuehrung.findFirstOrThrow({ where: { kontrolleId, periodeLabel } });
}

// ---------------------------------------------------------------------------
// Hauptablauf
// ---------------------------------------------------------------------------

async function main() {
  await leeren();
  console.log(`Seed mit Stichtag ${HEUTE.toISOString().slice(0, 10)} …`);

  const anna = person(DEMO_IDS.anna);
  const leon = person(DEMO_IDS.leon);
  const thomas = person(DEMO_IDS.thomas);

  // Mandanten mit den festen IDs des Demo-Verzeichnisses; Zuständigkeiten (BT,
  // Hauptbearbeitung) stehen nur dort (in der kanzleikonsole: cli.bt / cli.hb).
  const mandant = async (id: string) => {
    const m = DEMO_MANDANTEN.find((x) => x.id === id)!;
    const neu = await prisma.mandant.create({
      data: { id: m.id, name: m.name, rechtsform: m.rechtsform, datevNr: m.datevNr },
    });
    const kontakte = DEMO_PERSONEN.filter(
      (p): p is DemoPerson & { rolle: NonNullable<DemoPerson['rolle']> } =>
        p.art === 'MANDANT' && p.mandantId === m.id && p.rolle !== null,
    );
    await prisma.mandantKontaktRolle.createMany({
      data: kontakte.map((p) => ({
        mandantId: m.id,
        kontaktId: p.id,
        rolle: p.rolle,
        funktion: p.funktion,
      })),
    });
    return neu;
  };

  // ------------------------------------------------------------- Talwind --
  const talwind = await mandant(DEMO_IDS.talwind);
  const jana = person(DEMO_IDS.jana);
  const murat = person(DEMO_IDS.murat);
  const sabine = person(DEMO_IDS.sabine);

  const tw = await baueProgramm({
    mandantId: talwind.id,
    bt: anna,
    hb: leon,
    vertretung: thomas,
    mandantDurchfuehrend: murat,
    mandantVertretung: sabine,
    gv: jana,
    profil: talwindProfil(false),
    angelegt: utc(2026, 2, 15),
    version1Am: utc(2026, 3, 1),
    zieleFreigegeben: true,
    ohneDesign: ['K-EC-22'],
    angemessenheit: utc(2026, 6, 30),
    wirksamAb: utc(2026, 7, 1),
    wirksamBis: utc(2026, 12, 31),
    durchfuehrungenBis: utc(2026, 12, 31),
  });
  const K = (code: string) => tw.kontrollen.get(code)!;

  // Profiländerung: Lager CZ (gültig ab 01.10.2026, aus Ereignis T-02).
  // Versionierung: bisherigen Stand schließen, neuen anlegen (AGENTS.md Regel 3).
  await prisma.profilStand.updateMany({
    where: { programmId: tw.programmId, gueltigBis: null },
    data: { gueltigBis: utc(2026, 10, 1) },
  });
  await prisma.profilStand.create({
    data: {
      programmId: tw.programmId,
      version: 2,
      antworten: talwindProfil(true) as unknown as Prisma.InputJsonValue,
      gueltigAb: utc(2026, 10, 1),
      erstelltVon: leon.id,
      createdAt: zeit(utc(2026, 10, 1), 10),
    },
  });
  await audit(
    leon,
    'tcms.profil.geaendert',
    'TcmsProgramm',
    tw.programmId,
    tw.programmId,
    zeit(utc(2026, 10, 1), 10),
    { frage: 'P2', aenderung: 'Lager CZ seit 08/2026' },
  );

  // EC-UST-05: Stand 1 bis 12.10.2026 mit Reichweite 2, danach Reichweite 3 und W wahrscheinlich.
  {
    const rid = tw.risiken.get('EC-UST-05')!;
    const s1 = await prisma.risikoStand.findFirstOrThrow({ where: { risikoId: rid } });
    await prisma.risikoStand.update({
      where: { id: s1.id },
      data: { r: 2, w: 'MOEGLICH', gueltigBis: zeit(utc(2026, 10, 12), 11, 40) },
    });
    await prisma.risikoStand.create({
      data: {
        risikoId: rid,
        version: s1.version + 1,
        titel: s1.titel,
        fehlerquelle: s1.fehlerquelle,
        folge: s1.folge,
        normanker: s1.normanker as Prisma.InputJsonValue,
        s: 'H',
        w: 'WAHRSCHEINLICH',
        r: 3,
        gt: 'FF',
        modell: 'ec-1.0',
        gueltigAb: zeit(utc(2026, 10, 12), 11, 40),
        erstelltVon: anna.id,
      },
    });
    await audit(
      anna,
      'tcms.risiko.neu_bewertet',
      'Risiko',
      rid,
      tw.programmId,
      zeit(utc(2026, 10, 12), 11, 40),
      {
        code: 'EC-UST-05',
        vorher: { w: 'MOEGLICH', r: 2 },
        nachher: { w: 'WAHRSCHEINLICH', r: 3 },
        anlass: 'Ereignis 2026-T-0329',
      },
    );
  }

  // Sonderfälle der Durchführungen (Fachkonzept Abschnitt 11).
  const offenSetzen = async (code: string, periode: string) => {
    const d = await durchfuehrungZu(K(code).id, periode);
    await prisma.nachweis.deleteMany({ where: { durchfuehrungId: d.id } });
    await prisma.durchfuehrung.update({
      where: { id: d.id },
      data: {
        status: 'GEPLANT',
        schritte: [],
        werte: {},
        ergebnis: null,
        durchgefuehrtVon: null,
        begonnenAm: null,
        eingereichtAm: null,
        gegengezeichnetVon: null,
        abgeschlossenAm: null,
      },
    });
    return d;
  };

  // K-EC-10 September: überfällig. K-EC-23 Q3: überfällig (Mandant).
  await offenSetzen('K-EC-10', 'September 2026');
  await offenSetzen('K-EC-23', 'Q3 2026');
  {
    // Teilweise Uploads des Mandanten (1 Bericht fehlt noch).
    const d = await durchfuehrungZu(K('K-EC-23').id, 'Q3 2026');
    await prisma.durchfuehrung.update({
      where: { id: d.id },
      data: {
        status: 'IN_DURCHFUEHRUNG',
        begonnenAm: zeit(utc(2026, 10, 8), 14),
        durchgefuehrtVon: murat.id,
        schritte: [
          { erledigt: true, kommentar: 'Amazon und Shopware exportiert' },
          { erledigt: false, kommentar: '' },
        ],
      },
    });
    await nachweiseFuer(
      d.id,
      { kat: K('K-EC-23').kat, durchfuehrend: murat },
      'Q3 2026',
      utc(2026, 10, 11),
      ['Amazon_VAT_Transactions_Q3-2026.csv', 'Shopware_Bestellexport_Q3-2026.csv'],
    );
    await prisma.nachweis.updateMany({
      where: { durchfuehrungId: d.id },
      data: { gesperrt: false },
    });
  }

  // Zur Gegenzeichnung: K-EC-11, K-EC-08, K-EC-12 (September).
  for (const code of ['K-EC-11', 'K-EC-08', 'K-EC-12']) {
    const d = await durchfuehrungZu(K(code).id, 'September 2026');
    await prisma.durchfuehrung.update({
      where: { id: d.id },
      data: {
        status: 'ZUR_GEGENZEICHNUNG',
        gegengezeichnetVon: null,
        abgeschlossenAm: null,
        eingereichtAm: zeit(utc(2026, 10, 9), 16, 12),
      },
    });
  }
  {
    // S8-Beispiel: Werte mit erklärter Differenz und benannten Nachweisen.
    const d = await durchfuehrungZu(K('K-EC-11').id, 'September 2026');
    await prisma.nachweis.deleteMany({ where: { durchfuehrungId: d.id } });
    await prisma.durchfuehrung.update({
      where: { id: d.id },
      data: {
        werte: {
          shop: { wert: 412380.15, bemerkung: '', erklaert: false },
          zdl: { wert: 409912.4, bemerkung: '', erklaert: false },
          differenz: {
            wert: null,
            bemerkung: 'Klarna-Auszahlung vom 30.09. mit Valuta 01.10.',
            erklaert: true,
          },
          clearing_paypal: { wert: 0, bemerkung: '', erklaert: false },
          clearing_stripe: { wert: 0, bemerkung: '', erklaert: false },
          clearing_amazonpay: { wert: 0, bemerkung: '', erklaert: false },
        },
      },
    });
    await nachweiseFuer(d.id, K('K-EC-11'), 'September 2026', utc(2026, 10, 12), [
      'Abstimmung_2026-09.csv',
      'Saldenliste_Clearingkonten_2026-09.csv',
    ]);
    await audit(
      leon,
      'tcms.durchfuehrung.eingereicht',
      'Durchfuehrung',
      d.id,
      tw.programmId,
      zeit(utc(2026, 10, 9), 16, 12),
      {
        kontrolle: 'K-EC-11',
        periode: 'September 2026',
      },
    );
  }

  // Mit Befund: K-EC-11 Juni (geschlossen), K-EC-04 Q2 (F-2026-006), K-EC-05 September (F-2026-007).
  const mitBefund = async (
    code: string,
    periode: string,
    kommentar: string,
    abgeschlossenAm: Date,
  ) => {
    const d = await durchfuehrungZu(K(code).id, periode);
    await prisma.durchfuehrung.update({
      where: { id: d.id },
      data: {
        status: 'MIT_BEFUND',
        ergebnis: 'MIT_BEFUND',
        ergebnisKommentar: kommentar,
        abgeschlossenAm,
      },
    });
    return d;
  };
  const dJuni = await mitBefund(
    'K-EC-11',
    'Juni 2026',
    'Clearingkonto Klarna mit Restsaldo 1.214,30 €',
    zeit(utc(2026, 7, 9), 10),
  );
  const dQ2 = await mitBefund(
    'K-EC-04',
    'Q2 2026',
    'Erstattungen FR/IT aus Q2 nicht im OSS korrigiert',
    zeit(utc(2026, 7, 28), 9, 30),
  );
  const dSep05 = await mitBefund(
    'K-EC-05',
    'September 2026',
    'Bestand in CZ seit 08/2026 ohne lokale Registrierung',
    zeit(utc(2026, 10, 12), 11, 5),
  );

  // Außerplanmäßige Aufklärung (IN) aus F-2026-007.
  const aufklaerung = await prisma.durchfuehrung.create({
    data: {
      kontrolleId: K('K-EC-24').id,
      kontrolleStandId: K('K-EC-24').standId,
      periodeLabel: 'außerplanmäßig (Lager CZ)',
      periodeVon: utc(2026, 10, 12),
      periodeBis: utc(2026, 10, 12),
      faelligAm: utc(2026, 11, 15),
      ausserplanmaessig: true,
      anlass: 'Feststellung F-2026-007',
    },
  });

  // Feststellungen
  const f004 = await prisma.feststellung.create({
    data: {
      programmId: tw.programmId,
      nummer: 'F-2026-004',
      titel: 'Clearingkonto Klarna mit Restsaldo im Juni',
      sachverhalt:
        'Die Dreifach-Abstimmung Juni zeigte einen Restsaldo von 1.214,30 € auf dem Clearingkonto Klarna. Ursache war eine doppelt gebuchte Auszahlung.',
      quelle: 'KONTROLLE',
      quelleText: 'K-EC-11 Juni 2026',
      durchfuehrungId: dJuni.id,
      klasse: 'DURCHFUEHRUNGSMANGEL',
      schwere: 'GERING',
      auswirkung: 'NEIN',
      ursache: 'Doppelte Verbuchung einer Auszahlung',
      status: 'GESCHLOSSEN',
      nachkontrolleId: (await durchfuehrungZu(K('K-EC-11').id, 'Juli 2026')).id,
      erfasstVon: leon.id,
      erfasstAm: zeit(utc(2026, 7, 9), 11),
      geschlossenAm: zeit(utc(2026, 8, 10), 9),
      risiken: { create: [{ risikoId: tw.risiken.get('EC-GOB-01')! }] },
      massnahmen: {
        create: [
          {
            wiedervorlageNr: 104,
            beschreibung: 'Doppelbuchung stornieren und Saldo ausgleichen',
            verantwortlich: leon.id,
            frist: utc(2026, 7, 20),
            status: 'ERLEDIGT',
            erledigtAm: zeit(utc(2026, 7, 14), 10),
            erledigtVon: leon.id,
          },
        ],
      },
    },
  });
  await audit(
    leon,
    'tcms.feststellung.erfasst',
    'Feststellung',
    f004.id,
    tw.programmId,
    zeit(utc(2026, 7, 9), 11),
    { nummer: 'F-2026-004' },
  );
  await audit(
    anna,
    'tcms.feststellung.geschlossen',
    'Feststellung',
    f004.id,
    tw.programmId,
    zeit(utc(2026, 8, 10), 9),
    { nummer: 'F-2026-004' },
  );

  const f006 = await prisma.feststellung.create({
    data: {
      programmId: tw.programmId,
      nummer: 'F-2026-006',
      titel: 'Erstattungen FR/IT nicht im OSS korrigiert',
      sachverhalt:
        'Bei der OSS-Abstimmung Q2 fiel auf, dass Erstattungen aus Amazon-Verkäufen nach Frankreich und Italien nicht als Entgeltminderung im OSS berücksichtigt wurden (rund 1.380 € Bemessungsgrundlage).',
      quelle: 'KONTROLLE',
      quelleText: 'K-EC-04 Q2 2026',
      durchfuehrungId: dQ2.id,
      klasse: 'STEUERLICHER_FEHLER',
      schwere: 'GERING',
      auswirkung: 'JA',
      ursache: 'Erstattungsreport der Plattform nicht in die OSS-Vorbereitung übernommen',
      status: 'NACHKONTROLLE',
      p153Entscheidung: 'BERICHTIGUNG',
      p153Begruendung:
        'Korrektur der Bemessungsgrundlagen FR/IT mit der OSS-Erklärung Q3; Betrag gering, Korrekturweg über spätere Erklärung vorgesehen.',
      p153Frist: utc(2026, 10, 31),
      p153EntschiedenVon: anna.id,
      p153EntschiedenAm: zeit(utc(2026, 8, 5), 14, 10),
      nachkontrolleId: (await durchfuehrungZu(K('K-EC-04').id, 'Q3 2026')).id,
      erfasstVon: leon.id,
      erfasstAm: zeit(utc(2026, 7, 28), 10),
      risiken: {
        create: [
          { risikoId: tw.risiken.get('EC-UST-09')! },
          { risikoId: tw.risiken.get('EC-UST-03')! },
        ],
      },
      erklaerungen: {
        create: [
          { steuerart: 'USt (OSS)', land: 'FR', zeitraum: 'Q2 2026', auswirkungEur: 820 },
          { steuerart: 'USt (OSS)', land: 'IT', zeitraum: 'Q2 2026', auswirkungEur: 560 },
        ],
      },
      massnahmen: {
        create: [
          {
            wiedervorlageNr: 118,
            beschreibung: 'Erstattungen FR/IT in der OSS-Erklärung Q3 korrigieren',
            verantwortlich: leon.id,
            frist: utc(2026, 10, 31),
            status: 'ERLEDIGT',
            erledigtAm: zeit(utc(2026, 10, 9), 15),
            erledigtVon: leon.id,
          },
          {
            wiedervorlageNr: 119,
            beschreibung: 'Erstattungsreport fest in die OSS-Vorbereitung aufnehmen',
            verantwortlich: murat.id,
            frist: utc(2026, 9, 30),
            status: 'ERLEDIGT',
            erledigtAm: zeit(utc(2026, 9, 18), 11),
            erledigtVon: murat.id,
          },
        ],
      },
    },
  });
  await audit(
    leon,
    'tcms.feststellung.erfasst',
    'Feststellung',
    f006.id,
    tw.programmId,
    zeit(utc(2026, 7, 28), 10),
    { nummer: 'F-2026-006' },
  );
  await audit(
    anna,
    'tcms.feststellung.p153_entschieden',
    'Feststellung',
    f006.id,
    tw.programmId,
    zeit(utc(2026, 8, 5), 14, 10),
    {
      nummer: 'F-2026-006',
      entscheidung: 'BERICHTIGUNG',
    },
  );

  const f007 = await prisma.feststellung.create({
    data: {
      programmId: tw.programmId,
      nummer: 'F-2026-007',
      titel: 'Lager CZ ohne Registrierung und ohne Verbringensmeldung',
      sachverhalt:
        'Der Lagerland-Monitor September zeigt Bestand in Tschechien seit 08/2026 (PAN-EU). Eine lokale USt-Registrierung in CZ liegt nicht vor; das Verbringen nach CZ ist in der ZM 08/2026 nicht enthalten.',
      quelle: 'KONTROLLE',
      quelleText: 'K-EC-05 September 2026',
      durchfuehrungId: dSep05.id,
      klasse: 'STEUERLICHER_FEHLER',
      schwere: 'HOCH',
      auswirkung: 'JA',
      ursache: 'Automatische Lagerverteilung durch PAN-EU ohne Meldung an die Kanzlei',
      status: 'IN_WUERDIGUNG',
      erfasstVon: leon.id,
      erfasstAm: zeit(utc(2026, 10, 12), 11, 20),
      risiken: {
        create: [
          { risikoId: tw.risiken.get('EC-UST-05')! },
          { risikoId: tw.risiken.get('EC-UST-04')! },
        ],
      },
      erklaerungen: {
        create: [
          { steuerart: 'ZM', land: 'DE', zeitraum: '08/2026', auswirkungEur: null },
          { steuerart: 'USt (ig. Erwerb)', land: 'CZ', zeitraum: '08/2026', auswirkungEur: null },
          { steuerart: 'USt (ig. Erwerb)', land: 'CZ', zeitraum: '09/2026', auswirkungEur: null },
        ],
      },
      massnahmen: {
        create: [
          {
            wiedervorlageNr: 121,
            beschreibung: 'Registrierung in CZ beauftragen',
            verantwortlich: anna.id,
            frist: utc(2026, 10, 31),
          },
          {
            wiedervorlageNr: 122,
            beschreibung: 'ZM 08/2026 auf Verbringen nach CZ prüfen',
            verantwortlich: leon.id,
            frist: utc(2026, 10, 23),
          },
          {
            wiedervorlageNr: 123,
            beschreibung: 'Risikoaufklärung Betriebsstätte CZ (K-EC-24) einholen',
            verantwortlich: anna.id,
            frist: utc(2026, 11, 15),
          },
        ],
      },
    },
  });
  await audit(
    leon,
    'tcms.feststellung.erfasst',
    'Feststellung',
    f007.id,
    tw.programmId,
    zeit(utc(2026, 10, 12), 11, 20),
    { nummer: 'F-2026-007' },
  );
  await audit(
    leon,
    'tcms.feststellung.status',
    'Feststellung',
    f007.id,
    tw.programmId,
    zeit(utc(2026, 10, 12), 11, 25),
    { nach: 'IN_WUERDIGUNG' },
  );

  // Ereignisse
  await prisma.ereignis.create({
    data: {
      programmId: tw.programmId,
      nummer: '2026-T-0329',
      typ: 'T-02',
      titel: 'Neues Lager CZ (PAN-EU) seit 08/2026',
      beschreibung:
        'Der Lagerland-Monitor zeigt erstmals Bestand in Tschechien. Amazon hat Ware im Rahmen von PAN-EU nach CZ verteilt.',
      quelle: 'KONTROLLE',
      gemeldetVon: murat.id,
      gemeldetAm: zeit(utc(2026, 9, 30), 16, 40),
      ereignisDatum: utc(2026, 8, 1),
      status: 'ERLEDIGT',
      triagiertVon: anna.id,
      triagiertAm: zeit(utc(2026, 10, 12), 11, 0),
      folgen: {
        create: [
          {
            art: 'RISIKO_NEU_BEWERTEN',
            ziel: 'EC-UST-05',
            text: 'Ausländisches Lager ohne Registrierung neu bewerten',
            zustaendig: anna.id,
            status: 'ERLEDIGT',
            erledigtAm: zeit(utc(2026, 10, 12), 11, 40),
          },
          {
            art: 'FESTSTELLUNG_ANLEGEN',
            text: 'Feststellung mit §-153-Pfad anlegen',
            zustaendig: leon.id,
            status: 'ERLEDIGT',
            objektId: f007.id,
            erledigtAm: zeit(utc(2026, 10, 12), 11, 20),
          },
          {
            art: 'PROFIL_AENDERN',
            text: 'P2 Lagerorte um CZ ergänzen',
            zustaendig: leon.id,
            status: 'ERLEDIGT',
            erledigtAm: zeit(utc(2026, 10, 1), 10),
          },
        ],
      },
    },
  });
  for (const e of [
    {
      nummer: '2026-T-0342',
      typ: 'T-05',
      titel: 'Neue Warengruppe „Outdoor-Kochbücher" ab 11/2026',
      beschreibung:
        'Ab November nehmen wir Outdoor-Kochbücher ins Sortiment (Shop und Amazon). Bitte prüfen, welche Steuersätze in den Zielländern gelten.',
      am: zeit(utc(2026, 10, 12), 9, 14),
      datum: utc(2026, 11, 1),
    },
    {
      nummer: '2026-T-0345',
      typ: 'T-01',
      titel: 'Start auf Kaufland.de zum 01.12.2026',
      beschreibung:
        'Wir starten zum 01.12.2026 auf dem Marktplatz Kaufland.de, zunächst nur Versand nach Deutschland.',
      am: zeit(utc(2026, 10, 14), 13, 2),
      datum: utc(2026, 12, 1),
    },
  ]) {
    const kat = ereignistyp(e.typ)!;
    const ev = await prisma.ereignis.create({
      data: {
        programmId: tw.programmId,
        nummer: e.nummer,
        typ: e.typ,
        titel: e.titel,
        beschreibung: e.beschreibung,
        quelle: 'PORTAL',
        gemeldetVon: murat.id,
        gemeldetAm: e.am,
        ereignisDatum: e.datum,
        status: 'NEU',
        folgen: {
          create: kat.folgen.map((f) => ({ art: f.art, ziel: f.ziel ?? null, text: f.text })),
        },
      },
    });
    await audit(murat, 'tcms.ereignis.gemeldet', 'Ereignis', ev.id, tw.programmId, e.am, {
      nummer: e.nummer,
      typ: e.typ,
    });
  }

  // Länder-Monitor (Stand 30.06. und 30.09.2026)
  const laender: [
    string,
    number,
    number,
    number,
    string | null,
    boolean,
    boolean,
    boolean,
    Date | null,
  ][] = [
    ['FR', 241_900, 156_000, 281_000, null, true, false, false, utc(2026, 3, 12)],
    ['IT', 198_300, 128_400, 230_000, null, true, false, false, utc(2026, 3, 12)],
    ['AT', 186_400, 121_000, 218_000, null, true, false, false, utc(2026, 3, 12)],
    ['PL', 143_800, 92_500, 166_000, '2025-03', true, true, true, utc(2026, 3, 12)],
    ['NL', 122_700, 79_900, 140_000, null, true, false, false, utc(2026, 3, 12)],
    ['ES', 96_100, 61_200, 112_000, null, true, false, false, null],
    ['CZ', 61_200, 0, 41_000, '2026-08', true, false, true, utc(2026, 3, 12)],
    ['BE', 38_900, 25_100, 72_000, null, true, false, false, utc(2026, 3, 12)],
  ];
  for (const [land, lfd, lfdJuni, vj, lager, oss, ust, zm, geprueft] of laender) {
    await prisma.landStand.create({
      data: {
        programmId: tw.programmId,
        land,
        fernverkaeufeLfdEur: lfdJuni,
        fernverkaeufeVorjahrEur: vj,
        lagerSeit: land === 'CZ' ? null : lager,
        oss,
        lokaleUstNr: ust,
        zmRelevant: land === 'PL',
        steuersaetzeGeprueftAm: geprueft,
        stand: utc(2026, 6, 30),
        erfasstVon: leon.id,
        createdAt: zeit(utc(2026, 7, 3), 9),
      },
    });
    await prisma.landStand.create({
      data: {
        programmId: tw.programmId,
        land,
        fernverkaeufeLfdEur: lfd,
        fernverkaeufeVorjahrEur: vj,
        lagerSeit: lager,
        oss,
        lokaleUstNr: ust,
        zmRelevant: zm,
        steuersaetzeGeprueftAm: geprueft,
        stand: utc(2026, 9, 30),
        erfasstVon: leon.id,
        createdAt: zeit(utc(2026, 10, 2), 9),
      },
    });
  }
  await audit(
    leon,
    'tcms.laender.erfasst',
    'TcmsProgramm',
    tw.programmId,
    tw.programmId,
    zeit(utc(2026, 10, 2), 9),
    { stand: '2026-09-30', laender: laender.length },
  );

  // CMS-Beschreibung: v1.0 abgelöst, v1.1 freigegeben, v1.2 beim Mandanten, v1.3 Entwurf.
  const snap = (nummer: string, abs: Abschnitt[]) => {
    const snapshot = { nummer, mandant: talwind.name, abschnitte: abs, eingefroren: true };
    return {
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotSha256: createHash('sha256').update(kanonisch(snapshot)).digest('hex'),
    };
  };
  const abs = abschnitte(talwind.name) as unknown as Prisma.InputJsonValue;
  await prisma.beschreibungVersion.create({
    data: {
      programmId: tw.programmId,
      nummer: '1.0',
      status: 'ABGELOEST',
      abschnitte: abs,
      createdAt: utc(2026, 3, 1),
      erstelltVon: leon.id,
      reviewVon: anna.id,
      reviewAm: utc(2026, 3, 9),
      freigegebenVon: jana.id,
      freigegebenAm: utc(2026, 3, 12),
      ...snap('1.0', abschnitte(talwind.name)),
    },
  });
  const v11 = await prisma.beschreibungVersion.create({
    data: {
      programmId: tw.programmId,
      nummer: '1.1',
      status: 'FREIGEGEBEN',
      abschnitte: abs,
      createdAt: utc(2026, 6, 20),
      erstelltVon: leon.id,
      reviewAngefordertVon: leon.id,
      reviewAngefordertAm: utc(2026, 6, 25),
      reviewVon: anna.id,
      reviewAm: zeit(utc(2026, 6, 27), 16),
      freigabeAngefordertAm: zeit(utc(2026, 6, 28), 9),
      freigegebenVon: jana.id,
      freigegebenAm: zeit(utc(2026, 6, 30), 11, 12),
      ...snap('1.1', abschnitte(talwind.name)),
    },
  });
  await audit(
    jana,
    'tcms.beschreibung.freigegeben',
    'BeschreibungVersion',
    v11.id,
    tw.programmId,
    zeit(utc(2026, 6, 30), 11, 12),
    { nummer: '1.1', bestaetigung: 'E-Mail-Code' },
  );
  const v12 = await prisma.beschreibungVersion.create({
    data: {
      programmId: tw.programmId,
      nummer: '1.2',
      status: 'BEIM_MANDANTEN',
      abschnitte: abs,
      createdAt: utc(2026, 9, 22),
      erstelltVon: leon.id,
      reviewAngefordertVon: leon.id,
      reviewAngefordertAm: utc(2026, 9, 25),
      reviewVon: anna.id,
      reviewAm: zeit(utc(2026, 9, 29), 17),
      freigabeAngefordertAm: zeit(utc(2026, 9, 30), 8, 45),
      // Beim Mandanten liegt nur eingefrorener Inhalt (Freigabe prüft den SHA-256).
      ...snap('1.2', abschnitte(talwind.name)),
    },
  });
  await prisma.beschreibungVersion.create({
    data: {
      programmId: tw.programmId,
      nummer: '1.3',
      status: 'ENTWURF',
      abschnitte: abs,
      createdAt: zeit(HEUTE, 8, 30),
      erstelltVon: leon.id,
    },
  });
  await prisma.freigabe.create({
    data: {
      programmId: tw.programmId,
      art: 'BESCHREIBUNG',
      refId: v12.id,
      titel: 'CMS-Beschreibung v1.2',
      angefordertVon: anna.id,
      angefordertAm: zeit(utc(2026, 9, 30), 8, 45),
      empfaengerId: jana.id,
    },
  });
  await prisma.freigabe.create({
    data: {
      programmId: tw.programmId,
      art: 'KENNTNISNAHME',
      refId: 'steuerrichtlinie-1.1',
      titel: 'Steuerrichtlinie v1.1',
      inhalt:
        'Steuerrichtlinie der Talwind Outdoor GmbH (Fassung 1.1)\n\n1. Wir erfüllen unsere steuerlichen Pflichten vollständig und fristgerecht.\n2. Änderungen an Verkaufskanälen, Lagern, Zielländern, Sortiment, Zahlungswegen oder Systemen melden wir der Kanzlei vor dem Start über das Portal.\n3. Fehler werden unverzüglich gemeldet; niemand erleidet dadurch Nachteile.\n4. Kontrollen werden nach Plan durchgeführt und mit Nachweisen belegt.',
      angefordertVon: anna.id,
      angefordertAm: zeit(utc(2026, 9, 30), 9),
      empfaengerId: murat.id,
    },
  });
  await audit(
    anna,
    'tcms.beschreibung.freigabe_angefordert',
    'BeschreibungVersion',
    v12.id,
    tw.programmId,
    zeit(utc(2026, 9, 30), 8, 45),
    { nummer: '1.2', empfaenger: jana.name },
  );
  await audit(
    leon,
    'tcms.beschreibung.version_angelegt',
    'BeschreibungVersion',
    v12.id,
    tw.programmId,
    zeit(HEUTE, 8, 30),
    { nummer: '1.3' },
  );

  // ------------------------------------------------------------- Seestern --
  const seestern = await mandant(DEMO_IDS.seestern);
  const clara = person(DEMO_IDS.clara);
  const ole = person(DEMO_IDS.ole);
  const ss = await baueProgramm({
    mandantId: seestern.id,
    bt: thomas,
    hb: leon,
    vertretung: anna,
    mandantDurchfuehrend: ole,
    mandantVertretung: clara,
    gv: clara,
    profil: seesternProfil(),
    angelegt: utc(2026, 6, 2),
    version1Am: utc(2026, 7, 1),
    zieleFreigegeben: true,
    ohneDesign: [],
    angemessenheit: null,
    wirksamAb: null,
    wirksamBis: null,
    durchfuehrungenBis: null,
  });
  // Ein Risiko mit Brutto hoch ohne zweite Kontrolle bleibt über Appetit (Design).
  await prisma.beschreibungVersion.create({
    data: {
      programmId: ss.programmId,
      nummer: '1.0',
      status: 'KANZLEI_REVIEW',
      abschnitte: abschnitte(seestern.name, true) as unknown as Prisma.InputJsonValue,
      createdAt: utc(2026, 9, 28),
      erstelltVon: leon.id,
      reviewAngefordertVon: leon.id,
      reviewAngefordertAm: zeit(utc(2026, 10, 6), 15),
    },
  });
  await prisma.landStand.createMany({
    data: [
      {
        programmId: ss.programmId,
        land: 'AT',
        fernverkaeufeLfdEur: 98_000,
        fernverkaeufeVorjahrEur: 121_000,
        oss: true,
        lokaleUstNr: false,
        steuersaetzeGeprueftAm: utc(2026, 7, 2),
        stand: utc(2026, 9, 30),
        erfasstVon: leon.id,
      },
      {
        programmId: ss.programmId,
        land: 'NL',
        fernverkaeufeLfdEur: 44_000,
        fernverkaeufeVorjahrEur: 59_000,
        oss: true,
        lokaleUstNr: false,
        steuersaetzeGeprueftAm: utc(2026, 7, 2),
        stand: utc(2026, 9, 30),
        erfasstVon: leon.id,
      },
    ],
  });
  await prisma.feststellung.create({
    data: {
      programmId: ss.programmId,
      nummer: 'F-2026-001',
      titel: 'Bundle-Angebote mit gemischten Steuersätzen',
      sachverhalt:
        'Bundles aus Kerzen und Lebensmittelgeschenken werden einheitlich mit 19 % abgerechnet.',
      quelle: 'HINWEIS',
      quelleText: 'Hinweis aus Einrichtung',
      klasse: 'DESIGNMANGEL',
      schwere: 'MITTEL',
      auswirkung: 'UNKLAR',
      status: 'ERFASST',
      erfasstVon: leon.id,
      erfasstAm: utc(2026, 9, 18),
    },
  });

  // ------------------------------------------------------------- Kleinwerk --
  const kleinwerk = await mandant(DEMO_IDS.kleinwerk);
  const jonas = person(DEMO_IDS.jonas);
  const kw = await baueProgramm({
    mandantId: kleinwerk.id,
    bt: anna,
    hb: leon,
    vertretung: thomas,
    mandantDurchfuehrend: jonas,
    mandantVertretung: jonas,
    gv: jonas,
    profil: kleinwerkProfil(),
    angelegt: utc(2026, 8, 20),
    version1Am: utc(2026, 9, 15),
    zieleFreigegeben: true,
    ohneDesign: 'alle',
    angemessenheit: null,
    wirksamAb: null,
    wirksamBis: null,
    durchfuehrungenBis: null,
  });
  await prisma.landStand.createMany({
    data: [
      {
        programmId: kw.programmId,
        land: 'AT',
        fernverkaeufeLfdEur: 5_310,
        fernverkaeufeVorjahrEur: 4_200,
        oss: false,
        lokaleUstNr: false,
        stand: utc(2026, 9, 30),
        erfasstVon: leon.id,
      },
      {
        programmId: kw.programmId,
        land: 'FR',
        fernverkaeufeLfdEur: 3_110,
        fernverkaeufeVorjahrEur: 2_700,
        oss: false,
        lokaleUstNr: false,
        stand: utc(2026, 9, 30),
        erfasstVon: leon.id,
      },
    ],
  });
  await prisma.ereignis.create({
    data: {
      programmId: kw.programmId,
      nummer: '2026-T-0340',
      typ: 'T-04',
      titel: 'Lieferschwelle 84 % erreicht (8.420 € von 10.000 €)',
      beschreibung:
        'Die kumulierten EU-Fernverkäufe 2026 liegen bei 8.420 € und damit über der Warnstufe von 80 %.',
      quelle: 'KONTROLLE',
      gemeldetVon: leon.id,
      gemeldetAm: zeit(utc(2026, 10, 7), 10),
      ereignisDatum: utc(2026, 9, 30),
      status: 'NEU',
      folgen: {
        create: [
          { art: 'HINWEIS', text: 'Berufsträger über den Schwellenstand informieren' },
          {
            art: 'RISIKO_NEU_BEWERTEN',
            ziel: 'EC-UST-01',
            text: 'Lieferschwellenrisiko neu bewerten',
          },
        ],
      },
    },
  });

  // ------------------------------------------------------------ Pixelhafen --
  const pixel = await mandant(DEMO_IDS.pixelhafen);
  const pia = person(DEMO_IDS.pia);
  const henrik = person(DEMO_IDS.henrik);
  const px = await baueProgramm({
    mandantId: pixel.id,
    bt: thomas,
    hb: leon,
    vertretung: anna,
    mandantDurchfuehrend: henrik,
    mandantVertretung: pia,
    gv: pia,
    profil: pixelhafenProfil(),
    angelegt: utc(2025, 1, 10),
    version1Am: utc(2025, 2, 1),
    zieleFreigegeben: true,
    ohneDesign: [],
    angemessenheit: utc(2025, 6, 30),
    wirksamAb: utc(2025, 7, 1),
    wirksamBis: utc(2025, 12, 31),
    durchfuehrungenBis: utc(2026, 12, 31),
  });
  await prisma.beschreibungVersion.create({
    data: {
      programmId: px.programmId,
      nummer: '1.0',
      status: 'FREIGEGEBEN',
      abschnitte: abschnitte(pixel.name) as unknown as Prisma.InputJsonValue,
      createdAt: utc(2025, 5, 2),
      erstelltVon: leon.id,
      reviewVon: thomas.id,
      reviewAm: utc(2025, 6, 10),
      freigegebenVon: pia.id,
      freigegebenAm: utc(2025, 6, 20),
      ...snap('1.0', abschnitte(pixel.name)),
    },
  });
  await prisma.landStand.createMany({
    data: ['AT', 'FR', 'IT'].map((land, i) => ({
      programmId: px.programmId,
      land,
      fernverkaeufeLfdEur: [151_000, 122_000, 82_000][i]!,
      fernverkaeufeVorjahrEur: [170_000, 140_000, 100_000][i]!,
      oss: true,
      lokaleUstNr: false,
      steuersaetzeGeprueftAm: utc(2026, 1, 20),
      stand: utc(2026, 9, 30),
      erfasstVon: leon.id,
    })),
  });

  // Mandant ohne Tax-CMS: Ausgangspunkt für den Einrichtungsassistenten (S3).
  await mandant(DEMO_IDS.bergkamm);

  // Postausgang: Hinweis an die adressierte gesetzliche Vertreterin (Personen-ID, TS-06).
  await prisma.nachricht.create({
    data: {
      empfaengerId: jana.id,
      zweck: 'FREIGABE_ANGEFORDERT',
      betreff: 'Freigabe angefordert: CMS-Beschreibung v1.2',
      text: 'Im Portal wartet die CMS-Beschreibung v1.2 auf Ihre Freigabe. Den Bestätigungscode erhalten Sie beim Freigeben.',
      createdAt: zeit(utc(2026, 9, 30), 8, 46),
    },
  });

  await datiereErstellzeitpunkte();

  const zahl = await prisma.durchfuehrung.count();
  const audits = await prisma.auditEvent.count();
  console.log(
    `Fertig: 5 Mandanten (4 mit Tax-CMS), ${zahl} Durchführungen, ${audits} Audit-Einträge, ${dateiZaehler} Nachweisdateien.`,
  );
}

/**
 * Erstellzeitpunkte auf die fachlichen Daten legen. Ohne das trägt `createdAt` die
 * Laufzeit des Seeds; weil der Demotag fest ist (TCMS_DEMO_TODAY), lägen Objekte bei
 * einem späteren Seed-Lauf sonst „in der Zukunft“ und fehlten in Stichtagsansichten.
 */
async function datiereErstellzeitpunkte() {
  const grenze = zeit(HEUTE, 7);
  await prisma.$executeRaw`UPDATE "Massnahme" m SET "createdAt" = f."erfasstAm" FROM "Feststellung" f WHERE m."feststellungId" = f.id`;
  await prisma.$executeRaw`UPDATE "LandStand" SET "createdAt" = "stand" + interval '2 days 9 hours' WHERE "createdAt" > ${grenze}`;
  await prisma.$executeRaw`UPDATE "ProfilStand" SET "createdAt" = "gueltigAb" + interval '9 hours' WHERE "createdAt" > ${grenze}`;
  await prisma.$executeRaw`
    UPDATE "Durchfuehrung" d
       SET "createdAt" = CASE
             WHEN d."ausserplanmaessig" THEN LEAST(COALESCE(d."begonnenAm", d."periodeVon"::timestamp), ${grenze})
             ELSE COALESCE(p."version1Am", p."createdAt")
           END
      FROM "Kontrolle" k JOIN "TcmsProgramm" p ON p.id = k."programmId"
     WHERE d."kontrolleId" = k.id AND d."createdAt" > ${grenze}`;
  const tabellen = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'createdAt'`;
  for (const { table_name } of tabellen) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_name}" SET "createdAt" = $1 WHERE "createdAt" > $1`,
      grenze,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
