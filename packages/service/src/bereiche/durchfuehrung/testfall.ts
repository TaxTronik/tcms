// =============================================================================
// Testfall für die DB-Tests des Bereichs „durchfuehrung" (nur Tests): eigener
// Tenant je Fall mit zwei Mandanten, Kanzleipersonen, Mandantenkontakten,
// einer Kanzlei- und einer Mandanten-Kontrolle, verknüpftem Risiko und
// Durchführungen. Läuft als Laufzeitrolle tcms_app (DATABASE_URL) über
// `mitTenant`; zufällige IDs, daher kein Aufräumen nötig.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { DienstFehler, type Akteur } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { verweisAblage } from '../../ablage';
import { imDienst, keinPersonenVerzeichnis, type DienstKontext, type Uhr } from '../../kontext';

export const HEUTE = '2026-10-16';
export const UHR: Uhr = { jetzt: () => new Date(`${HEUTE}T10:00:00.000Z`), heute: () => HEUTE };
export const PORTS = { uhr: UHR, personen: keinPersonenVerzeichnis, ablage: verweisAblage };

const tag = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export interface Personen {
  /** Zuständige Berufsträgerin (cli.bt), Berufsträgerin der Kanzlei. */
  bt: string;
  /** Zweite Berufsträgerin, Admin (kannWuerdigen über rol.adm). */
  bt2: string;
  /** Hauptbearbeitung, durchführend bei K1. */
  bearbeiter: string;
  /** Vertretung bei K1, ohne weitere Rechte. */
  vertretung: string;
  /** Zugewiesene Gegenzeichnung bei K1, kein Berufsträger. */
  pruefer: string;
  /** Kanzleiperson mit Bezug, ohne Zuständigkeit oder Zuweisung. */
  kollege: string;
  /** Mandantenkontakte (A): GV, TCB, Mitarbeitende. */
  gv: string;
  tcb: string;
  /** durchführend bei K2 */
  ma: string;
  /** Vertretung bei K2 */
  ma2: string;
  /** Mitarbeiter ohne Zuweisung */
  ma3: string;
  /** Kontakt von A ohne aktive Rolle */
  ohneRolle: string;
  /** GV von Mandant B */
  gvB: string;
}

export interface Fall {
  tenant: string;
  mandant: string;
  mandantB: string;
  p: Personen;
  programm: string;
  programmB: string;
  k1: { id: string; standId: string };
  k2: { id: string; standId: string };
  kB: { id: string; standId: string };
  risiko: string;
  risikoB: string;
  /** Neue Durchführung (GEPLANT, Periode September 2026, fällig 30.10.2026). */
  durchfuehrung(k: 'k1' | 'k2' | 'kB', over?: Partial<DurchfuehrungDaten>): Promise<string>;
  kanzlei(id: string, opts?: KanzleiOpts): Akteur;
  kontakt(id: string, mandantId?: string): Akteur;
  /** Führt `fn` im Dienstkontext des Akteurs aus (eigene Transaktion). */
  dienst<T>(a: Akteur, fn: (ctx: DienstKontext) => Promise<T>): Promise<T>;
  /** Lesender/ändernder Testzugriff im Tenant des Falls (ohne Service). */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface KanzleiOpts {
  mandantId?: string | null;
  admin?: boolean;
  bt?: boolean;
  zustaendig?: boolean;
  hb?: boolean;
  tenant?: string;
}

interface DurchfuehrungDaten {
  periodeLabel: string;
  periodeVon: Date;
  periodeBis: Date;
  faelligAm: Date;
}

const SCHRITTE = [
  { titel: 'Saldenliste abrufen', hinweis: 'Stichtag Monatsende' },
  { titel: 'Abgleich durchführen', hinweis: 'Differenzen erläutern' },
];
const KENNZAHLEN = [
  { key: 'saldoShop', label: 'Saldo Shop', sollEur: null },
  { key: 'saldoFibu', label: 'Saldo FiBu', sollEur: null },
  { key: 'differenz', label: 'Differenz', sollEur: 0, differenzAus: ['saldoShop', 'saldoFibu'] },
];

export async function baueFall(): Promise<Fall> {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const mandantB = randomUUID();
  const p: Personen = {
    bt: randomUUID(),
    bt2: randomUUID(),
    bearbeiter: randomUUID(),
    vertretung: randomUUID(),
    pruefer: randomUUID(),
    kollege: randomUUID(),
    gv: randomUUID(),
    tcb: randomUUID(),
    ma: randomUUID(),
    ma2: randomUUID(),
    ma3: randomUUID(),
    ohneRolle: randomUUID(),
    gvB: randomUUID(),
  };
  const suffix = randomBytes(3).toString('hex');

  const ids = await mitTenant(tenant, async (tx) => {
    await tx.mandant.create({ data: { id: mandant, name: `A ${suffix}`, rechtsform: 'KapG' } });
    await tx.mandant.create({ data: { id: mandantB, name: `B ${suffix}`, rechtsform: 'KapG' } });
    await tx.mandantKontaktRolle.createMany({
      data: [
        { mandantId: mandant, kontaktId: p.gv, rolle: 'GESETZLICHER_VERTRETER' },
        { mandantId: mandant, kontaktId: p.tcb, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
        { mandantId: mandant, kontaktId: p.ma, rolle: 'MITARBEITER' },
        { mandantId: mandant, kontaktId: p.ma2, rolle: 'MITARBEITER' },
        { mandantId: mandant, kontaktId: p.ma3, rolle: 'MITARBEITER' },
        {
          mandantId: mandant,
          kontaktId: p.ohneRolle,
          rolle: 'GESETZLICHER_VERTRETER',
          aktiv: false,
        },
        { mandantId: mandantB, kontaktId: p.gvB, rolle: 'GESETZLICHER_VERTRETER' },
      ],
    });
    const programm = await tx.tcmsProgramm.create({
      data: { mandantId: mandant, paketId: 'ecommerce', paketVersion: '1.0', status: 'AKTIV' },
    });
    const programmB = await tx.tcmsProgramm.create({
      data: { mandantId: mandantB, paketId: 'ecommerce', paketVersion: '1.0', status: 'AKTIV' },
    });
    const kontrolle = async (
      programmId: string,
      code: string,
      stand: {
        partei: 'KANZLEI' | 'MANDANT';
        durchfuehrendId: string;
        vertretungId: string;
        gegenzeichnerId: string;
        gegenzeichnungMandant: boolean;
      },
    ) => {
      const k = await tx.kontrolle.create({
        data: { programmId, code, aktivAb: tag('2026-01-01') },
      });
      const s = await tx.kontrolleStand.create({
        data: {
          kontrolleId: k.id,
          version: 1,
          titel: `Kontrolle ${code}`,
          ziel: 'Abgleich der Salden',
          art: 'D',
          ausfuehrung: 'M',
          vorlageTurnus: 'MONATLICH',
          vorlageAnlass: false,
          schluessel: true,
          nachweis: 'Saldenliste',
          mindestNachweise: 1,
          schritte: SCHRITTE,
          kennzahlen: KENNZAHLEN,
          toleranzEur: 5,
          faelligNachTagen: 30,
          gueltigAb: tag('2026-01-01'),
          ...stand,
        },
      });
      return { id: k.id, standId: s.id };
    };
    const k1 = await kontrolle(programm.id, 'K-T-01', {
      partei: 'KANZLEI',
      durchfuehrendId: p.bearbeiter,
      vertretungId: p.vertretung,
      gegenzeichnerId: p.pruefer,
      gegenzeichnungMandant: false,
    });
    const k2 = await kontrolle(programm.id, 'K-T-02', {
      partei: 'MANDANT',
      durchfuehrendId: p.ma,
      vertretungId: p.ma2,
      gegenzeichnerId: p.gv,
      gegenzeichnungMandant: true,
    });
    const kB = await kontrolle(programmB.id, 'K-T-01', {
      partei: 'KANZLEI',
      durchfuehrendId: p.bearbeiter,
      vertretungId: p.vertretung,
      gegenzeichnerId: p.pruefer,
      gegenzeichnungMandant: false,
    });
    const risiko = async (programmId: string, kontrolleIds: string[]) => {
      const r = await tx.risiko.create({
        data: {
          programmId,
          code: 'R-UST-01',
          entscheidung: 'UEBERNOMMEN',
          aktivAb: tag('2026-01-01'),
        },
      });
      await tx.risikoStand.create({
        data: {
          risikoId: r.id,
          version: 1,
          titel: 'Falscher Steuersatz',
          fehlerquelle: 'Stammdaten',
          folge: 'Nachzahlung',
          normanker: [],
          s: 'M',
          w: 'MOEGLICH',
          r: 2,
          gt: 'FF',
          modell: 'test',
          gueltigAb: tag('2026-01-01'),
        },
      });
      for (const kontrolleId of kontrolleIds) {
        await tx.risikoKontrolle.create({ data: { risikoId: r.id, kontrolleId } });
      }
      return r.id;
    };
    return {
      programm: programm.id,
      programmB: programmB.id,
      k1,
      k2,
      kB,
      risiko: await risiko(programm.id, [k1.id, k2.id]),
      risikoB: await risiko(programmB.id, [kB.id]),
    };
  });

  const fall: Fall = {
    tenant,
    mandant,
    mandantB,
    p,
    ...ids,
    async durchfuehrung(k, over = {}) {
      const kontrolle = ids[k];
      return mitTenant(tenant, async (tx) => {
        const d = await tx.durchfuehrung.create({
          data: {
            kontrolleId: kontrolle.id,
            kontrolleStandId: kontrolle.standId,
            periodeLabel: 'September 2026',
            periodeVon: tag('2026-09-01'),
            periodeBis: tag('2026-09-30'),
            faelligAm: tag('2026-10-30'),
            createdAt: tag('2026-09-01'),
            ...over,
          },
        });
        return d.id;
      });
    },
    kanzlei(id, o = {}) {
      const mandantId = o.mandantId === undefined ? mandant : o.mandantId;
      return {
        art: 'KANZLEI',
        tenantId: o.tenant ?? tenant,
        id,
        name: 'Kanzleiperson',
        istAdmin: o.admin ?? false,
        istBerufstraeger: o.bt ?? false,
        mandant: mandantId
          ? {
              id: mandantId,
              zustaendigBerufstraeger: o.zustaendig ?? false,
              hauptbearbeitung: o.hb ?? false,
            }
          : null,
      };
    },
    kontakt(id, mandantId = mandant) {
      return { art: 'MANDANT', tenantId: tenant, id, name: 'Kontakt', mandantId };
    },
    dienst(a, fn) {
      return imDienst(a, PORTS, fn);
    },
    tx(fn) {
      return mitTenant(tenant, fn);
    },
  };
  return fall;
}

/** Akteure eines Falls mit ihren üblichen Flags. */
export function akteure(f: Fall) {
  return {
    bt: f.kanzlei(f.p.bt, { bt: true, zustaendig: true }),
    bt2: f.kanzlei(f.p.bt2, { bt: true, admin: true }),
    bearbeiter: f.kanzlei(f.p.bearbeiter, { hb: true }),
    vertretung: f.kanzlei(f.p.vertretung),
    pruefer: f.kanzlei(f.p.pruefer),
    kollege: f.kanzlei(f.p.kollege),
    gv: f.kontakt(f.p.gv),
    tcb: f.kontakt(f.p.tcb),
    ma: f.kontakt(f.p.ma),
    ma2: f.kontakt(f.p.ma2),
    ma3: f.kontakt(f.p.ma3),
    ohneRolle: f.kontakt(f.p.ohneRolle),
  };
}

/** Gültiger Nachweis-Verweis mit frischer Dokument-ID und frischem Inhalt-Hash. */
export function verweis(over: Partial<Record<string, unknown>> = {}) {
  return {
    dokumentId: randomUUID(),
    dateiname: 'Saldenliste.pdf',
    mime: 'application/pdf',
    groesse: 2048,
    sha256: randomBytes(32).toString('hex'),
    ...over,
  };
}

/** Fängt einen DienstFehler (andere Fehler werden weitergeworfen). */
export async function fehlerVon(p: Promise<unknown>): Promise<DienstFehler> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DienstFehler) return e;
    throw e;
  }
  throw new Error('Kein Fehler, obwohl einer erwartet war');
}
