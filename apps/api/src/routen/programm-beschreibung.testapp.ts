// =============================================================================
// Nur für Tests der Endpunkte „programm-beschreibung": App mit echter
// Datenbank (`mitTenant` aus @tcms/db, Laufzeitrolle tcms_app), eigener Tenant
// je Testdatei, signierte Akteursbestätigungen (Hilfen aus __tests__/hilfen)
// und eine Tabelle der Negativfälle je Endpunkt: falscher Mandant (404),
// Mandantenperson auf Staff- bzw. Kanzleiperson auf Portal-Endpunkt (404),
// ungültige Eingabe (400).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { AkteurClaims } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { describe, expect, it } from 'vitest';
import {
  aufbau,
  bestaetigtSenden,
  json,
  SYSTEM_ID,
  TEST_CODES,
  type Aufbau,
} from '../__tests__/hilfen';
import type { Routen } from '../routen';
import { registriereProgrammBeschreibung } from './programm-beschreibung';

export type C = Partial<AkteurClaims>;

export interface ApiWelt {
  T: string;
  A: string;
  B: string;
  BT: string;
  HB: string;
  DRITTE: string;
  ADMIN: string;
  GV: string;
  TCB: string;
  t: Aufbau;
}

export function neueApiWelt(): ApiWelt {
  return {
    T: randomUUID(),
    A: randomUUID(),
    B: randomUUID(),
    BT: randomUUID(),
    HB: randomUUID(),
    DRITTE: randomUUID(),
    ADMIN: randomUUID(),
    GV: randomUUID(),
    TCB: randomUUID(),
    t: aufbau({
      routen: (r: Routen<unknown>) =>
        registriereProgrammBeschreibung(r as unknown as Routen<Tx>, TEST_CODES),
      daten: {
        mitTenant: (tenantId, fn) => mitTenant(tenantId, fn as (tx: Tx) => Promise<never>),
        ping: async () => undefined,
      },
    }),
  };
}

/** Mandanten A und B mit GV und TCB bei A (im Tenant der Welt). */
export async function legeMandantenAn(w: ApiWelt): Promise<void> {
  await mitTenant(w.T, async (tx) => {
    await tx.mandant.create({ data: { id: w.A, name: 'API-Mandant A GmbH', rechtsform: 'KapG' } });
    await tx.mandant.create({ data: { id: w.B, name: 'API-Mandant B GmbH', rechtsform: 'KapG' } });
    await tx.mandantKontaktRolle.create({
      data: { mandantId: w.A, kontaktId: w.GV, rolle: 'GESETZLICHER_VERTRETER' },
    });
    await tx.mandantKontaktRolle.create({
      data: { mandantId: w.A, kontaktId: w.TCB, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
    });
  });
}

export function akteure(w: ApiWelt) {
  const kanzlei = (
    sub: string,
    cli: string | null,
    o: { adm?: boolean; bt?: boolean; zbt?: boolean; hb?: boolean } = {},
  ): C => ({
    tnt: w.T,
    sub,
    knd: 'KANZLEI',
    rol: { adm: o.adm ?? false, bt: o.bt ?? false },
    cli: cli ? { id: cli, bt: o.zbt ?? false, hb: o.hb ?? false } : undefined,
  });
  const kontakt = (sub: string, cli: string): C => ({
    tnt: w.T,
    sub,
    knd: 'MANDANT',
    rol: undefined,
    cli: { id: cli, bt: false, hb: false },
  });
  /** Systemakteur der kanzleikonsole (Zustell-Worker): ohne `rol` und `cli`. */
  const system = (tnt = w.T): C => ({
    tnt,
    sub: SYSTEM_ID,
    knd: 'SYSTEM',
    nam: 'Zustellung kanzleikonsole',
    rol: undefined,
    cli: undefined,
  });
  return {
    kanzlei,
    kontakt,
    system,
    bt: (m = w.A) => kanzlei(w.BT, m, { adm: true, bt: true, zbt: true }),
    hb: (m = w.A) => kanzlei(w.HB, m, { hb: true }),
    admin: () => kanzlei(w.ADMIN, null, { adm: true }),
  };
}

export function senden(w: ApiWelt, methode: string, ziel: string, claims: C, body?: unknown) {
  return bestaetigtSenden(w.t.app, {
    methode,
    ziel,
    claims,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Erwartet Erfolg (Status, no-store) und liefert `daten`. */
export async function ok(r: Response, status = 200): Promise<Record<string, unknown>> {
  const j = await json(r);
  expect(r.status, JSON.stringify(j)).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  return j['daten'] as Record<string, unknown>;
}

export const mandantPfad = (mandantId: string) => `/v1/mandanten/${mandantId}`;

export function personen(w: ApiWelt) {
  return { berufstraegerId: w.BT, bearbeitungId: w.HB, kanzlei: [w.BT, w.HB, w.DRITTE] };
}

/** Geschäftsprofil P1–P12 (Struktur laut Vertrag; apps/api hängt nicht von @tcms/domain ab). */
export const PROFIL = {
  p1: { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] },
  p2: { eigenversandDE: true, lager: [] },
  p3: { laender: ['DE', 'FR'], b2bAnteilProzent: 0, b2bEU: false, b2bInland: false },
  p4: { warengruppen: [{ name: 'Outdoor', abweichenderSatz: false }], gebrauchtware: false },
  p5: { drittlandImport: false, laender: [], zollabwicklung: '' },
  p6: { zahlungswege: ['PayPal'] },
  p7: { gutscheine: false, abos: false, bundles: false },
  p8: { systeme: [] },
  p9: { ossSeit: null, ioss: false, lokaleUstNr: [], dauerfrist: false },
  p10: { vorjahresumsatzEur: 0, euFernverkaeufeVorjahrEur: 0, euFernverkaeufeLfdEur: 0 },
  p11: { vorhanden: false, anbieter: [] },
  p12: { buchhaltung: 'KANZLEI' },
};

/** Zeiträume weit in der Zukunft: unabhängig von der echten Uhr des Dienstes. */
export const SCHRITT1 = {
  teilbereich: {
    name: 'Umsatzsteuer E-Commerce',
    abgrenzung: 'Umsatzsteuerliche Pflichten aus dem Onlinehandel einschließlich Marktplätzen.',
    einschluesse: [],
    ausschluesse: [],
  },
  zeitraum: {
    angemessenheitStichtag: '2099-12-31',
    wirksamAb: '2100-01-01',
    wirksamBis: '2100-06-30',
    erklaerungsTurnus: 'MONATLICH',
  },
};

export const ZIELE = [
  {
    key: 'ust-erklaerung',
    text: 'Vollständige und fristgerechte Erfüllung der umsatzsteuerlichen Pflichten.',
    wesentlichkeitEur: 5000,
    risikoappetit: 'MITTEL',
    aktiv: true,
    eigen: false,
  },
];

/** Richtet Mandant A über die Endpunkte ein (Schritte 1–4, Version 1); Ziele zur Freigabe an GV. */
export async function richteEinUeberHttp(w: ApiWelt): Promise<void> {
  const a = akteure(w);
  const m = mandantPfad(w.A);
  const schritt = (n: number, daten: unknown) =>
    senden(w, 'POST', `${m}/einrichtung/entwurf`, a.hb(), {
      schritt: n,
      ziel: 'weiter',
      daten,
      personen: personen(w),
    });
  await ok(await schritt(1, SCHRITT1));
  await ok(await schritt(2, { profil: PROFIL }));
  await ok(await schritt(3, { ziele: ZIELE, freigabe: { anfordern: true, empfaengerId: w.GV } }));
  await ok(await schritt(4, { risiken: {} }));
  await ok(
    await senden(w, 'POST', `${m}/einrichtung/anlegen`, a.bt(), {
      daten: { kontrollen: {} },
      personen: personen(w),
    }),
    201,
  );
}

export interface Endpunkt {
  name: string;
  methode: 'GET' | 'POST';
  pfad: (mandantId: string) => string;
  body?: unknown;
  /** ungültige Anfrage: Query-Zusatz oder Body */
  ungueltig: { query?: string; body?: unknown };
  portal?: boolean;
}

/** Negativfälle je Endpunkt (404 Mandant, 404 falsche Personenart, 400 Eingabe). */
export function pruefeEndpunkte(w: ApiWelt, endpunkte: Endpunkt[]): void {
  for (const e of endpunkte) {
    describe(`${e.methode} ${e.name}`, () => {
      it('falscher Mandant → 404 (Mandantenbindung)', async () => {
        const a = akteure(w);
        const wer = e.portal ? a.kontakt(w.GV, w.A) : a.bt();
        const r = await senden(w, e.methode, e.pfad(w.B), wer, e.body);
        expect(r.status).toBe(404);
        expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
      });
      it(
        e.portal
          ? 'Kanzleiperson auf Portal-Endpunkt → 404'
          : 'Mandantenperson auf Staff-Endpunkt → 404',
        async () => {
          const a = akteure(w);
          const wer = e.portal ? a.bt() : a.kontakt(w.GV, w.A);
          const r = await senden(w, e.methode, e.pfad(w.A), wer, e.body);
          expect(r.status).toBe(404);
          expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
        },
      );
      it('ungültige Eingabe → 400', async () => {
        const a = akteure(w);
        const wer = e.portal ? a.kontakt(w.GV, w.A) : a.bt();
        const r = await senden(
          w,
          e.methode,
          `${e.pfad(w.A)}${e.ungueltig.query ?? ''}`,
          wer,
          e.ungueltig.query ? e.body : e.ungueltig.body,
        );
        expect(r.status).toBe(400);
        expect(((await json(r))['fehler'] as { code: string }).code).toBe('UNGUELTIG');
      });
    });
  }
}
