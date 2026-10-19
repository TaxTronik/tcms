// =============================================================================
// Testwelt für die DB-Tests des Bereichs (nur Tests, nicht exportiert): zwei
// zufällige Tenants, im Tenant A zwei Mandanten mit je einem Programm (Risiko,
// Kontrolle mit Stand, Durchführung), im Tenant B ein weiterer Mandant. Die
// Mandanten-ID ist global eindeutig (Primärschlüssel), ein fremder Tenant kann
// dieselbe ID also nicht haben. Akteure decken alle Rechte ab. Alles läuft als
// Laufzeitrolle tcms_app über `mitTenant` (RLS aktiv).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { DienstFehler, type Akteur } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { verweisAblage } from '../../ablage';
import { imDienst, type DienstKontext, type PersonenVerzeichnis, type Uhr } from '../../kontext';

export const HEUTE = '2026-10-16';
export const UHR: Uhr = { jetzt: () => new Date(`${HEUTE}T10:00:00Z`), heute: () => HEUTE };
const PERSONEN: PersonenVerzeichnis = {
  namen: async (ids) => new Map(ids.map((id) => [id, `Person ${id.slice(-4)}`])),
};
export const PORTS = { uhr: UHR, personen: PERSONEN, ablage: verweisAblage };

let zaehler = 0;
const lauf = randomUUID().slice(0, 6);
export const eindeutig = (p: string) => `${p}-${lauf}-${++zaehler}`;

export interface Welt {
  tenant: string;
  tenantB: string;
  mandant: string;
  fremd: string;
  mandantB: string;
  programm: string;
  programmFremd: string;
  programmB: string;
  risiko: string;
  risikoInaktiv: string;
  risikoFremd: string;
  kontrolle: string;
  kontrolleFremd: string;
  durchfuehrung: string;
  durchfuehrungFremd: string;
  p: {
    zbt: string;
    admin: string;
    adminOhneBt: string;
    hb: string;
    leser: string;
    gv: string;
    tcb: string;
    ma: string;
    ohneRolle: string;
    gvFremd: string;
  };
}

async function baueProgramm(tx: Tx, mandantId: string, name: string) {
  await tx.mandant.create({ data: { id: mandantId, name, rechtsform: 'KapG' } });
  const programm = await tx.tcmsProgramm.create({
    data: { mandantId, paketId: 'ecommerce', paketVersion: '1.0', status: 'AKTIV' },
  });
  const aktivAb = new Date('2026-01-01T00:00:00Z');
  const risiko = await tx.risiko.create({
    data: { programmId: programm.id, code: 'EC-UST-02', aktivAb, entscheidung: 'UEBERNOMMEN' },
  });
  const risikoInaktiv = await tx.risiko.create({
    data: { programmId: programm.id, code: 'EC-UST-13', aktivAb, entscheidung: 'VORGESCHLAGEN' },
  });
  const kontrolle = await tx.kontrolle.create({
    data: { programmId: programm.id, code: 'K-EC-02', aktivAb },
  });
  const stand = await tx.kontrolleStand.create({
    data: {
      kontrolleId: kontrolle.id,
      version: 1,
      titel: 'Steuersätze prüfen',
      ziel: 'Steuersätze aktuell',
      art: 'D',
      ausfuehrung: 'M',
      vorlageTurnus: 'QUARTALSWEISE',
      vorlageAnlass: false,
      partei: 'KANZLEI',
      schluessel: false,
      nachweis: 'Protokoll',
      mindestNachweise: 1,
      schritte: [],
      kennzahlen: [],
      faelligNachTagen: 10,
      gueltigAb: aktivAb,
    },
  });
  const d = await tx.durchfuehrung.create({
    data: {
      kontrolleId: kontrolle.id,
      kontrolleStandId: stand.id,
      periodeLabel: 'Q3 2026',
      periodeVon: new Date('2026-07-01T00:00:00Z'),
      periodeBis: new Date('2026-09-30T00:00:00Z'),
      faelligAm: new Date('2026-10-10T00:00:00Z'),
    },
  });
  return {
    programm: programm.id,
    risiko: risiko.id,
    risikoInaktiv: risikoInaktiv.id,
    kontrolle: kontrolle.id,
    durchfuehrung: d.id,
  };
}

export async function baueWelt(): Promise<Welt> {
  const tenant = randomUUID();
  const tenantB = randomUUID();
  const mandant = randomUUID();
  const fremd = randomUUID();
  const mandantB = randomUUID();
  const p = {
    zbt: randomUUID(),
    admin: randomUUID(),
    adminOhneBt: randomUUID(),
    hb: randomUUID(),
    leser: randomUUID(),
    gv: randomUUID(),
    tcb: randomUUID(),
    ma: randomUUID(),
    ohneRolle: randomUUID(),
    gvFremd: randomUUID(),
  };
  const [a, f] = await mitTenant(tenant, async (tx) => {
    const a = await baueProgramm(tx, mandant, 'Mandant A');
    const f = await baueProgramm(tx, fremd, 'Mandant F');
    await tx.mandantKontaktRolle.createMany({
      data: [
        { mandantId: mandant, kontaktId: p.gv, rolle: 'GESETZLICHER_VERTRETER' },
        { mandantId: mandant, kontaktId: p.tcb, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
        { mandantId: mandant, kontaktId: p.ma, rolle: 'MITARBEITER' },
        {
          mandantId: mandant,
          kontaktId: p.ohneRolle,
          rolle: 'GESETZLICHER_VERTRETER',
          aktiv: false,
        },
        { mandantId: fremd, kontaktId: p.gvFremd, rolle: 'GESETZLICHER_VERTRETER' },
      ],
    });
    return [a, f] as const;
  });
  // Fremder Tenant: RLS muss seine Objekte verbergen.
  const b = await mitTenant(tenantB, (tx) => baueProgramm(tx, mandantB, 'Mandant B'));
  return {
    tenant,
    tenantB,
    mandant,
    fremd,
    mandantB,
    programm: a.programm,
    programmFremd: f.programm,
    programmB: b.programm,
    risiko: a.risiko,
    risikoInaktiv: a.risikoInaktiv,
    risikoFremd: f.risiko,
    kontrolle: a.kontrolle,
    kontrolleFremd: f.kontrolle,
    durchfuehrung: a.durchfuehrung,
    durchfuehrungFremd: f.durchfuehrung,
    p,
  };
}

// ---------------------------------------------------------------------------
// Akteure
// ---------------------------------------------------------------------------

export function kanzlei(
  tenant: string,
  id: string,
  mandantId: string | null,
  r: { admin?: boolean; bt?: boolean; zustaendig?: boolean; hb?: boolean } = {},
): Akteur {
  return {
    art: 'KANZLEI',
    tenantId: tenant,
    id,
    name: `Kanzlei ${id.slice(-4)}`,
    istAdmin: r.admin ?? false,
    istBerufstraeger: r.bt ?? false,
    mandant: mandantId
      ? {
          id: mandantId,
          zustaendigBerufstraeger: r.zustaendig ?? false,
          hauptbearbeitung: r.hb ?? false,
        }
      : null,
  };
}

export function kontakt(tenant: string, id: string, mandantId: string): Akteur {
  return { art: 'MANDANT', tenantId: tenant, id, name: `Kontakt ${id.slice(-4)}`, mandantId };
}

/** Alle Akteure der Welt, bezogen auf `mandant` (wie `cli` der kanzleikonsole). */
export function akteure(w: Welt) {
  const t = w.tenant;
  const m = w.mandant;
  return {
    /** zuständige Berufsträgerin: bearbeiten und würdigen */
    zbt: kanzlei(t, w.p.zbt, m, { bt: true, zustaendig: true }),
    /** Admin und Berufsträger: bearbeiten und würdigen */
    admin: kanzlei(t, w.p.admin, m, { admin: true, bt: true }),
    /** Admin ohne Berufsträgerschaft: bearbeiten, nicht würdigen */
    adminOhneBt: kanzlei(t, w.p.adminOhneBt, m, { admin: true }),
    /** Hauptbearbeitung: bearbeiten, nicht würdigen */
    hb: kanzlei(t, w.p.hb, m, { hb: true }),
    /** Berufsträger ohne Zuständigkeit: nur lesen */
    leser: kanzlei(t, w.p.leser, m, { bt: true }),
    /** Kanzleiperson ohne bestätigten Mandantenbezug, sogar Admin-BT */
    ohneBezug: kanzlei(t, w.p.admin, null, { admin: true, bt: true }),
    /** Bezug zu einem anderen Mandanten desselben Tenants */
    fremdBezug: kanzlei(t, w.p.admin, w.fremd, { admin: true, bt: true, zustaendig: true }),
    /** Bezug auf den Mandanten, aber Akteur eines anderen Tenants (der Daten hat) */
    fremdTenant: kanzlei(w.tenantB, w.p.zbt, m, { admin: true, bt: true, zustaendig: true }),
    /** Bezug stimmt, aber Tenant ohne Daten */
    leerTenant: kanzlei(randomUUID(), w.p.zbt, m, { bt: true, zustaendig: true }),
    gv: kontakt(t, w.p.gv, m),
    tcb: kontakt(t, w.p.tcb, m),
    ma: kontakt(t, w.p.ma, m),
    ohneRolle: kontakt(t, w.p.ohneRolle, m),
    gvFremd: kontakt(t, w.p.gvFremd, w.fremd),
  };
}

export function im<T>(a: Akteur, fn: (ctx: DienstKontext) => Promise<T>): Promise<T> {
  return imDienst(a, PORTS, fn, { timeoutMs: 20_000, maxWaitMs: 10_000 });
}

/** Erwarteter Dienstfehler; andere Fehler und Erfolg lassen den Test scheitern. */
export async function fehlerVon(p: Promise<unknown>): Promise<DienstFehler> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DienstFehler) return e;
    throw e;
  }
  throw new Error('Kein Fehler, obwohl einer erwartet war');
}

/**
 * Öffnet mehrere Verbindungen des Laufzeit-Pools, damit gleichzeitige
 * Aufrufe in den Tests wirklich parallel laufen (eine kalte zweite Verbindung
 * würde den zweiten Aufruf sonst so verzögern, dass er den ersten nie
 * überlappt und ein fehlender Schutz unentdeckt bliebe).
 */
export async function aufwaermen(w: Welt): Promise<void> {
  await Promise.all(
    [1, 2, 3, 4].map(() => mitTenant(w.tenant, (tx) => tx.$executeRaw`SELECT pg_sleep(0.05)`)),
  );
}

/** Zwei gleichzeitige Aufrufe über zwei Verbindungen: Ergebnisse als settled. */
export async function gleichzeitig<T>(a: () => Promise<T>, b: () => Promise<T>) {
  return Promise.allSettled([a(), b()]);
}

/** Genau ein Erfolg und genau ein KONFLIKT. */
export function genauEinerKonflikt(r: PromiseSettledResult<unknown>[]): boolean {
  const ok = r.filter((x) => x.status === 'fulfilled').length;
  const konflikt = r.filter(
    (x) =>
      x.status === 'rejected' && x.reason instanceof DienstFehler && x.reason.code === 'KONFLIKT',
  ).length;
  return ok === 1 && konflikt === 1;
}

// ---------------------------------------------------------------------------
// Objekte direkt anlegen (Ausgangslage der Tests)
// ---------------------------------------------------------------------------

export function inTenant<T>(w: Welt, fn: (tx: Tx) => Promise<T>, tenant = w.tenant): Promise<T> {
  return mitTenant(tenant, fn);
}

export interface FeststellungRoh {
  programmId?: string;
  status?:
    | 'ERFASST'
    | 'IN_WUERDIGUNG'
    | 'MASSNAHMEN_OFFEN'
    | 'NACHKONTROLLE'
    | 'GESCHLOSSEN'
    | 'VERWORFEN';
  auswirkung?: 'JA' | 'NEIN' | 'UNKLAR';
  vertraulich?: boolean;
  erfasstVon?: string;
  p153Entscheidung?: 'BERICHTIGUNG' | 'KEINE_PFLICHT' | 'WEITERE_KLAERUNG' | 'UEBERGABE' | null;
  verwerfenBeantragtVon?: string | null;
  titel?: string;
}

export async function neueFeststellung(w: Welt, f: FeststellungRoh = {}, tenant = w.tenant) {
  return inTenant(
    w,
    (tx) =>
      tx.feststellung.create({
        data: {
          programmId: f.programmId ?? w.programm,
          nummer: eindeutig('F'),
          titel: f.titel ?? 'Restsaldo auf dem Klarna-Clearingkonto',
          sachverhalt: 'Clearingkonto Klarna mit Restsaldo seit August.',
          quelle: 'HINWEIS',
          quelleText: 'Hinweis Buchhaltung',
          klasse: 'STEUERLICHER_FEHLER',
          schwere: 'MITTEL',
          auswirkung: f.auswirkung ?? 'JA',
          status: f.status ?? 'ERFASST',
          vertraulich: f.vertraulich ?? false,
          erfasstVon: f.erfasstVon ?? w.p.hb,
          erfasstAm: new Date('2026-10-01T09:00:00Z'),
          p153Entscheidung: f.p153Entscheidung ?? null,
          p153EntschiedenVon: f.p153Entscheidung ? w.p.zbt : null,
          p153EntschiedenAm: f.p153Entscheidung ? new Date('2026-10-02T09:00:00Z') : null,
          verwerfenBeantragtVon: f.verwerfenBeantragtVon ?? null,
          verwerfenBegruendung: f.verwerfenBeantragtVon
            ? 'Doppelt erfasst, siehe andere Feststellung zum selben Konto.'
            : null,
        },
      }),
    tenant,
  );
}

export async function neueMassnahme(
  w: Welt,
  feststellungId: string,
  verantwortlich: string,
  status: 'OFFEN' | 'ERLEDIGT' = 'OFFEN',
) {
  return inTenant(w, async (tx) =>
    tx.massnahme.create({
      data: {
        feststellungId,
        wiedervorlageNr: 500_000 + ++zaehler,
        beschreibung: 'Clearingkonto abstimmen',
        verantwortlich,
        frist: new Date('2026-11-30T00:00:00Z'),
        status,
        createdAt: new Date('2026-10-03T09:00:00Z'),
        ...(status === 'ERLEDIGT'
          ? { erledigtAm: new Date('2026-10-04T09:00:00Z'), erledigtVon: verantwortlich }
          : {}),
      },
    }),
  );
}

/** Zahl der Audit-Einträge zu einem Objekt (im Tenant der Welt). */
export async function auditZahl(w: Welt, objektId: string, aktion?: string): Promise<number> {
  return inTenant(w, (tx) =>
    tx.auditEvent.count({ where: { objektId, ...(aktion ? { aktion } : {}) } }),
  );
}
