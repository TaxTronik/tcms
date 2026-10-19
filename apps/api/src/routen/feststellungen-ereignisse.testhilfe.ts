// =============================================================================
// Gemeinsame Hilfen der API-Tests des Bereichs „feststellungen-ereignisse"
// (DB_TESTS=1, DATABASE_URL = tcms_app): Testwelt je Testdatei (zufälliger
// Tenant mit zwei Mandanten), signierte Akteursbestätigungen und die
// Standardprüfung je Endpunkt: ungültiger Body bzw. Query (400), falscher
// Mandant (404), Mandantenperson auf Staff-Endpunkt bzw. Kontakt ohne Rolle
// auf Portal-Endpunkt (404), dann Erfolg. Alle Routen aller Bereiche werden
// gemeinsam eingetragen (keine mehrdeutigen Muster).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { AkteurClaims } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { expect } from 'vitest';
import { aufbau, bestaetigtSenden, json } from '../__tests__/hilfen';
import type { Routen } from '../routen';
import { registriereAlle } from './index';

export const AKTIV = process.env['DB_TESTS'] === '1';

export const T = randomUUID();
export const M = randomUUID();
export const F = randomUUID();
export const P = {
  zbt: randomUUID(),
  hb: randomUUID(),
  gv: randomUUID(),
  ma: randomUUID(),
};
export const FRIST = '2027-06-30';
export const BEGRUENDUNG =
  'Doppelt erfasst, der Sachverhalt ist bereits unter einer anderen Nummer.';

export interface Welt {
  programm: string;
  programmF: string;
  kontrolle: string;
  risiko: string;
}
export let w: Welt;

async function baueProgramm(tx: Tx, mandantId: string) {
  await tx.mandant.create({
    data: { id: mandantId, name: `Mandant ${mandantId.slice(0, 4)}`, rechtsform: 'KapG' },
  });
  const p = await tx.tcmsProgramm.create({
    data: { mandantId, paketId: 'ecommerce', paketVersion: '1.0' },
  });
  const aktivAb = new Date('2026-01-01T00:00:00Z');
  const r = await tx.risiko.create({
    data: { programmId: p.id, code: 'EC-UST-02', aktivAb, entscheidung: 'UEBERNOMMEN' },
  });
  const k = await tx.kontrolle.create({ data: { programmId: p.id, code: 'K-EC-02', aktivAb } });
  await tx.kontrolleStand.create({
    data: {
      kontrolleId: k.id,
      version: 1,
      titel: 'Steuersätze',
      ziel: 'aktuell',
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
  return { programm: p.id, kontrolle: k.id, risiko: r.id };
}

export const db = <T>(fn: (tx: Tx) => Promise<T>) => mitTenant(T, fn);
let nr = 0;
export const naechsteNr = () => ++nr;

export async function feststellung(x: Record<string, unknown> = {}, programmId = w.programm) {
  return db((tx) =>
    tx.feststellung.create({
      data: {
        programmId,
        nummer: `F-API-${++nr}`,
        titel: 'Restsaldo Clearingkonto',
        sachverhalt: 'Clearingkonto mit Restsaldo seit August.',
        quelle: 'HINWEIS',
        quelleText: 'Hinweis',
        klasse: 'STEUERLICHER_FEHLER',
        schwere: 'MITTEL',
        auswirkung: 'JA',
        status: 'ERFASST',
        erfasstVon: P.hb,
        erfasstAm: new Date('2026-10-01T09:00:00Z'),
        ...x,
      },
    }),
  );
}

export async function ereignis(
  programmId = w.programm,
  folgen: {
    art: 'HINWEIS' | 'FESTSTELLUNG_ANLEGEN';
    status?: 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT';
  }[] = [{ art: 'HINWEIS' }],
  x: Record<string, unknown> = {},
) {
  return db((tx) =>
    tx.ereignis.create({
      data: {
        programmId,
        nummer: `2026-T-A${String(++nr).padStart(4, '0')}`,
        typ: 'T-05',
        titel: 'Sonderprüfung angekündigt',
        beschreibung: 'Prüfungsanordnung liegt vor.',
        quelle: 'MANUELL',
        gemeldetVon: P.hb,
        gemeldetAm: new Date('2026-10-02T09:00:00Z'),
        ereignisDatum: new Date('2026-10-01T00:00:00Z'),
        folgen: {
          create: folgen.map((f) => ({
            art: f.art,
            text: 'Vorschlag',
            status: f.status ?? 'VORGESCHLAGEN',
          })),
        },
        ...x,
      },
      include: { folgen: true },
    }),
  );
}

// ---------------------------------------------------------------------------
// Akteure (Claims) und Senden
// ---------------------------------------------------------------------------

const kanzlei = (
  sub: string,
  cli: { id: string; bt: boolean; hb: boolean },
  adm = false,
  bt = false,
): Partial<AkteurClaims> => ({
  tnt: T,
  sub,
  knd: 'KANZLEI',
  nam: 'Kanzleiperson',
  rol: { adm, bt },
  cli,
});
export const ZBT = kanzlei(P.zbt, { id: M, bt: true, hb: false }, false, true);
export const HB = kanzlei(P.hb, { id: M, bt: false, hb: true });
/** Bestätigter Bezug zu einem anderen Mandanten (F), Pfad nennt M. */
export const FALSCH = kanzlei(P.zbt, { id: F, bt: true, hb: false }, true, true);
/** Mandantenkontakt: nur Teil-Claims (Bindung `req`, `jti` setzt die Testhilfe je Anfrage). */
export const kontaktClaims = (mandantId: string, sub: string): Partial<AkteurClaims> => ({
  tnt: T,
  sub,
  knd: 'MANDANT',
  nam: 'Kontakt',
  cli: { id: mandantId, bt: false, hb: false },
  rol: undefined,
});
export const GV = () => kontaktClaims(M, P.gv);

let app: ReturnType<typeof aufbau>['app'];

export async function rufe(
  c: Partial<AkteurClaims>,
  methode: string,
  ziel: string,
  body?: unknown,
) {
  const res = await bestaetigtSenden(app, {
    methode,
    ziel,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    claims: c,
  });
  return { status: res.status, json: await json(res) };
}

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

export interface Fall {
  name: string;
  methode: 'GET' | 'POST';
  /** Ziel und Body für einen frischen Ausgangszustand. */
  vorbereiten: () => Promise<{ pfad: string; body?: unknown; query?: string }>;
  akteur?: () => Partial<AkteurClaims>;
  erfolg: 200 | 201;
  portal?: boolean;
  /** Body ändern, sodass er ungültig ist (ohne Body-Schema: Body schicken). */
  ungueltig?: unknown;
}

export const B = `/v1/mandanten/${M}`;

const LAENDER = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR'];
let landIndex = 0;
export const naechstesLand = () => LAENDER[landIndex++ % LAENDER.length]!;
export const landEingabe = (land: string) => ({
  land,
  fernverkaeufeLfdEur: 100,
  fernverkaeufeVorjahrEur: 50,
  lagerSeit: null,
  oss: true,
  lokaleUstNr: false,
  zmRelevant: false,
  steuersaetzeGeprueftAm: null,
});
export function portalMeldung(anlagen: unknown[]) {
  return {
    typ: 'T-02',
    titel: 'Neues Lager in Polen',
    beschreibung: 'Ab November lagern wir Ware in Posen.',
    datum: '2026-10-12',
    anlagen,
    zusageAenderungen: true,
  };
}

function mitQuery(pfad: string, query?: string) {
  return query ? `${pfad}?${query}` : pfad;
}

/** Testwelt anlegen und App mit allen Routen aufbauen (einmal je Testdatei). */
export async function baueApiWelt(): Promise<void> {
  const [a, f] = await db(async (tx) => {
    const a = await baueProgramm(tx, M);
    const f = await baueProgramm(tx, F);
    await tx.mandantKontaktRolle.createMany({
      data: [
        { mandantId: M, kontaktId: P.gv, rolle: 'GESETZLICHER_VERTRETER' },
        { mandantId: M, kontaktId: P.ma, rolle: 'MITARBEITER' },
      ],
    });
    return [a, f] as const;
  });
  w = { programm: a.programm, programmF: f.programm, kontrolle: a.kontrolle, risiko: a.risiko };
  app = aufbau({
    daten: {
      mitTenant: <X>(t: string, fn: (tx: unknown) => Promise<X>) =>
        mitTenant(t, fn as (tx: Tx) => Promise<X>),
      ping: async () => undefined,
    },
    // Alle Bereiche gemeinsam: mehrdeutige Muster würden hier beim Start scheitern.
    routen: registriereAlle as unknown as (r: Routen<unknown>) => void,
  }).app;
}

/** Standardprüfung eines Endpunkts (siehe Kopf). */
export async function pruefeFall(f: Fall): Promise<void> {
  const v = await f.vorbereiten();
  const akteur = f.akteur?.() ?? HB;
  const ziel = mitQuery(v.pfad, v.query);

  // 400: ungültiger Body bzw. ungültige Query (vor jeder Änderung).
  if (f.methode === 'GET') {
    const sep = ziel.includes('?') ? '&' : '?';
    const r = await rufe(akteur, 'GET', `${ziel}${sep}unbekannt=1`);
    expect(r.status, `${f.name} 400`).toBe(400);
  } else {
    const ungueltig =
      f.ungueltig !== undefined
        ? f.ungueltig
        : { ...(v.body as Record<string, unknown>), zusatzfeld: 'nicht im Vertrag' };
    const r = await rufe(akteur, 'POST', ziel, ungueltig);
    expect(r.status, `${f.name} 400`).toBe(400);
    expect(r.json).toMatchObject({ ok: false, fehler: { code: 'UNGUELTIG' } });
  }

  // 404: Bestätigung für einen anderen Mandanten (cli ≠ Pfad).
  const falsch = f.portal ? kontaktClaims(F, P.gv) : FALSCH;
  const r404 = await rufe(falsch, f.methode, ziel, v.body);
  expect(r404.status, `${f.name} falscher Mandant`).toBe(404);
  expect(r404.json).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });

  // 404: Mandantenperson auf Staff-Endpunkt; auf Portal-Endpunkt: Mandantenkontakt ohne Rolle.
  const kontakt = f.portal ? kontaktClaims(M, randomUUID()) : GV();
  const rk = await rufe(kontakt, f.methode, ziel, v.body);
  expect(rk.status, `${f.name} Mandantenperson`).toBe(404);
  expect(rk.json).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });

  // Erfolg.
  const ok = await rufe(akteur, f.methode, ziel, v.body);
  expect(ok.status, `${f.name}: ${JSON.stringify(ok.json).slice(0, 300)}`).toBe(f.erfolg);
  expect(ok.json['ok']).toBe(true);
}
