// =============================================================================
// Demo-Actions des Bereichs „programm-beschreibung" Ende-zu-Ende gegen
// PostgreSQL (DB_TESTS=1, geseedete Wegwerf-Datenbank): Die Actions sind dünne
// Hüllen um @tcms/service (Formular → Eingabe → Service → Meldung). Geprüft
// werden Einrichtung (Bergkamm), Beschreibung mit Vier-Augen-Review,
// Freigabe-Code über den Entwicklungs-Postausgang und Freigeben im Portal.
// Vor und nach dem Lauf wird Bergkamm auf „ohne Tax-CMS" zurückgesetzt
// (Eigentümerrolle, `DATABASE_OWNER_URL`): zwei Läufe hintereinander sind grün.
// Next-Module (Cookies, Revalidierung, Redirect) sind durch Attrappen ersetzt.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { mitTenant } from '@tcms/db';
import { setzeMandantOhneTcmsZurueck } from '../../test/demo-daten';

const AKTIV = process.env['DB_TESTS'] === '1';

class Umleitung extends Error {
  constructor(readonly ziel: string) {
    super(`Umleitung nach ${ziel}`);
  }
}
let sitzung = '';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (sitzung ? { value: sitzung } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (ziel: string) => {
    throw new Umleitung(ziel);
  },
  notFound: () => {
    throw new Umleitung('404');
  },
}));

const { erzeugeCookie } = await import('../sitzung-regeln');
const { speichereSchritt } = await import('./setup');
const beschreibung = await import('./beschreibung');
const freigaben = await import('./freigaben');
const { ladeEinrichtung } = await import('../setup-daten');
const { ladeBeschreibungsDaten } = await import('../beschreibung-daten');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};
const form = (felder: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return fd;
};
const umleitung = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Umleitung) return e.ziel;
    throw e;
  }
  throw new Error('Keine Umleitung');
};
const imDemo = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(DEMO_TENANT_ID, fn);
const M = DEMO_IDS.bergkamm;

describe.skipIf(!AKTIV)('Demo-Actions Einrichtung, Beschreibung, Freigaben', () => {
  beforeAll(async () => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
    await setzeMandantOhneTcmsZurueck(M);
  });
  afterAll(async () => {
    // Seed-Zustand für andere Suiten (Portfolio: Bergkamm ohne Programm).
    await setzeMandantOhneTcmsZurueck(M);
  });
  beforeEach(() => {
    sitzung = '';
  });

  it('Einrichtungsassistent: Schritte 1–4 und Version 1 über die Actions', async () => {
    als(DEMO_IDS.leon);
    const v = await ladeEinrichtung(M);
    expect(v?.eingerichtet).toBe(false);
    const e = v!.entwurf!;
    const schritt = (n: number, daten: unknown, ziel = 'weiter') =>
      speichereSchritt(
        null,
        form({ mandantId: M, schritt: String(n), ziel, daten: JSON.stringify(daten) }),
      );
    // Unvollständig: Meldung mit Prüfpunkten, kein Weiter.
    const kurz = await schritt(1, {
      teilbereich: { ...e.teilbereich, abgrenzung: 'kurz' },
      zeitraum: e.zeitraum,
    });
    expect(kurz).toMatchObject({ fehler: expect.stringContaining('Abgrenzungstext') });
    expect(
      await umleitung(schritt(1, { teilbereich: e.teilbereich, zeitraum: e.zeitraum })),
    ).toContain('schritt=2');
    const profil = {
      ...e.profil,
      p1: { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: [] },
      p4: { warengruppen: [{ name: 'Kaffee', abweichenderSatz: true }], gebrauchtware: false },
      p6: { zahlungswege: ['PayPal'] },
    };
    expect(await umleitung(schritt(2, { profil }))).toContain('schritt=3');
    expect(await umleitung(schritt(3, { ziele: e.ziele, freigabe: e.freigabe }))).toContain(
      'schritt=4',
    );
    expect(await umleitung(schritt(4, { risiken: {} }))).toContain('schritt=5');
    // Ohne Bearbeitungsrecht (Thomas: Berufsträger ohne Zuständigkeit bei Bergkamm).
    als(DEMO_IDS.thomas);
    expect(await schritt(5, { kontrollen: {} }, 'anlegen')).toEqual({
      fehler: 'Dieser Schritt ist zuständigen Personen vorbehalten.',
    });
    als(DEMO_IDS.anna);
    expect(await umleitung(schritt(5, { kontrollen: {} }, 'anlegen'))).toBe(
      `/staff/clients/${M}/tcms`,
    );
    const programm = await imDemo((tx) =>
      tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: M } }),
    );
    expect(programm.status).toBe('AKTIV');
    expect(
      await schritt(1, { teilbereich: e.teilbereich, zeitraum: e.zeitraum }, 'speichern'),
    ).toMatchObject({
      fehler: expect.stringContaining('bereits ein Tax-CMS'),
    });
  });

  it('Beschreibung: Version, Abschnitt, Review (zweite Person), Freigabe anfordern', async () => {
    als(DEMO_IDS.leon);
    const ziel = await umleitung(beschreibung.neueVersion(null, form({ mandantId: M })));
    const versionId = new URL(ziel, 'http://x').searchParams.get('version')!;
    const struktur = JSON.stringify([{ typ: 'text' }, { typ: 'baustein', art: 'ZIELE' }]);
    expect(
      await beschreibung.speichereAbschnitt(
        null,
        form({
          mandantId: M,
          versionId,
          key: 'ziele',
          struktur,
          text_0: 'Unsere Ziele.',
          entfernen_1: 'on',
        }),
      ),
    ).toEqual({ ok: 'Abschnitt in v1.0 gespeichert.' });
    const ids = { mandantId: M, versionId };
    expect(await beschreibung.zurReview(null, form(ids))).toEqual({
      ok: 'v1.0 liegt zur Kanzlei-Review vor.',
    });
    expect(await beschreibung.reviewAbschliessen(null, form(ids))).toMatchObject({
      fehler: expect.stringContaining('zweite Person'),
    });
    als(DEMO_IDS.anna);
    expect(await beschreibung.reviewAbschliessen(null, form(ids))).toEqual({
      ok: 'Kanzlei-Review für v1.0 abgeschlossen.',
    });
    expect(await beschreibung.freigabeAnfordern(null, form(ids))).toMatchObject({
      ok: expect.stringContaining('Freigabe bei Lea Berg angefordert'),
    });
    const daten = await ladeBeschreibungsDaten(M, new Date().toISOString().slice(0, 10));
    const v = daten!.versionen.find((x) => x.id === versionId)!;
    expect(v).toMatchObject({
      status: 'BEIM_MANDANTEN',
      snapshotGeprueft: true,
      letzteBearbeitung: DEMO_IDS.leon,
    });
    const ziele = v.abschnitte.find((a) => a.key === 'ziele')!;
    expect(ziele.bloecke).toEqual([{ typ: 'text', text: 'Unsere Ziele.' }]);
  });

  it('Portal: Code im Postausgang (ID-Adresse), falscher Code zählt, richtiger Code gibt frei', async () => {
    const f = await imDemo((tx) =>
      tx.freigabe.findFirstOrThrow({
        where: { art: 'BESCHREIBUNG', status: 'OFFEN', programm: { mandantId: M } },
      }),
    );
    als(DEMO_IDS.nils); // TCB: sieht, darf aber nicht freigeben
    expect(await freigaben.codeAnfordern(null, form({ freigabeId: f.id }))).toEqual({
      fehler: 'Freigaben sind der gesetzlichen Vertretung vorbehalten.',
    });
    als(DEMO_IDS.lea);
    expect(await freigaben.codeAnfordern(null, form({ freigabeId: f.id }))).toMatchObject({
      ok: expect.stringContaining('lea.berg@bergkamm.example'),
    });
    const n = await imDemo((tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { empfaengerId: DEMO_IDS.lea, zweck: 'FREIGABE_CODE' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const code = /Bestätigungscode: (\d{6})/.exec(n.text)![1]!;
    const falsch = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(await freigaben.freigeben(null, form({ freigabeId: f.id, code: falsch }))).toEqual({
      fehler: 'Der Code stimmt nicht. Noch 4 Versuche.',
    });
    expect(await umleitung(freigaben.freigeben(null, form({ freigabeId: f.id, code })))).toBe(
      `/portal/tcms/freigaben?erledigt=${f.id}`,
    );
    const danach = await imDemo((tx) => tx.freigabe.findUniqueOrThrow({ where: { id: f.id } }));
    expect(danach).toMatchObject({ status: 'FREIGEGEBEN', codeHash: null });
  });
});
