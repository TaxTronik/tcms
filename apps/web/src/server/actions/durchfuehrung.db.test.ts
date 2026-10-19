// =============================================================================
// Demo der Kontrolldurchführung Ende-zu-Ende gegen PostgreSQL (DB_TESTS=1):
// Sitzung → Demo-Akteur mit Bezug auf den Mandanten des Formulars →
// @tcms/service → Audit. Prüft die Anbindung der Demo (Formularfeld
// `mandant`, Ablage als kanzleikonsole, Verweis an den Service) und die
// Rechte der Download-Route (TS-03). Erwartet eine geseedete Wegwerf-
// Datenbank; legt eine eigene Durchführung an. Next-Module sind Attrappen.
// =============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { mitTenant } from '@tcms/db';

const AKTIV = process.env['DB_TESTS'] === '1';

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
    throw new Error(`Umleitung nach ${ziel}`);
  },
  notFound: () => {
    throw new Error('404');
  },
}));

process.env['TCMS_DEMO_TODAY'] = '2026-10-16';
const ABLAGE = mkdtempSync(join(tmpdir(), 'tcms-durchfuehrung-'));
process.env['TCMS_STORAGE_DIR'] = ABLAGE;

const { erzeugeCookie } = await import('../sitzung-regeln');
const A = await import('./durchfuehrung');
const { GET } = await import('../../app/api/nachweise/[id]/route');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};
const form = (felder: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return fd;
};
const imDemo = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(DEMO_TENANT_ID, fn);

describe.skipIf(!AKTIV)('Demo der Kontrolldurchführung gegen PostgreSQL', () => {
  const talwind = DEMO_IDS.talwind;
  let did = '';
  let nachweisId = '';
  const inhalt = `Nachweis ${randomBytes(8).toString('hex')}\n`;
  const basis = () => ({ id: did, mandant: talwind, stand: '' });
  const vollstaendig = () => ({
    ...basis(),
    schritt_0_erledigt: 'on',
    schritt_1_erledigt: 'on',
    schritt_2_erledigt: 'on',
    wert_fernverkaeufe_lfd: '8.500,00',
    wert_fernverkaeufe_vj: '7.250,00',
    ergebnis: 'OHNE_BEFUND',
    absicht: 'einreichen',
  });

  beforeAll(async () => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
    // Eigene Durchführung der Kanzlei-Kontrolle K-EC-01 (Talwind; durchführend Leon, Gegenzeichnung Anna).
    did = await imDemo(async (tx) => {
      const k = await tx.kontrolle.findFirstOrThrow({
        where: { code: 'K-EC-01', programm: { mandantId: talwind } },
        include: { staende: { where: { gueltigBis: null } } },
      });
      const d = await tx.durchfuehrung.create({
        data: {
          kontrolleId: k.id,
          kontrolleStandId: k.staende[0]!.id,
          periodeLabel: `Test ${randomBytes(3).toString('hex')}`,
          periodeVon: new Date('2026-09-01T00:00:00Z'),
          periodeBis: new Date('2026-09-30T00:00:00Z'),
          faelligAm: new Date('2026-10-30T00:00:00Z'),
        },
      });
      return d.id;
    });
  });

  beforeEach(() => {
    sitzung = '';
  });

  afterAll(() => {
    rmSync(ABLAGE, { recursive: true, force: true });
  });

  it('Bindung an den Mandanten des Formulars: fremder Mandant → „nicht gefunden"', async () => {
    als(DEMO_IDS.leon);
    const r = await A.beginneDurchfuehrung(null, form({ ...basis(), mandant: DEMO_IDS.seestern }));
    expect(r).toEqual({ fehler: 'Durchführung nicht gefunden.' });
  });

  it('Speichern mit Einreichen: Entwurf bleibt, Mängel werden genannt', async () => {
    als(DEMO_IDS.leon);
    const r = await A.speichereDurchfuehrung(null, form(vollstaendig()));
    expect(r).toEqual({
      fehler: 'Entwurf gespeichert, aber noch nicht eingereicht: Nachweise: 0 von mindestens 1.',
    });
    const d = await imDemo((tx) => tx.durchfuehrung.findUniqueOrThrow({ where: { id: did } }));
    expect(d.status).toBe('IN_DURCHFUEHRUNG');
    expect(d.werte).toMatchObject({ fernverkaeufe_lfd: { wert: 8500 } });
  });

  it('Upload: Datei in der Demo-Ablage, Verweis mit UUID im Service, Doppel übersprungen', async () => {
    als(DEMO_IDS.leon);
    const datei = () => {
      const fd = form(basis());
      fd.append('dateien', new File([inhalt], 'Fernverkäufe\u202e.csv', { type: 'text/csv' }));
      return fd;
    };
    expect(await A.ladeNachweisHoch(null, datei())).toEqual({ ok: '1 Datei hochgeladen.' });
    const r2 = await A.ladeNachweisHoch(null, datei());
    expect(r2).toEqual({ fehler: 'Bereits vorhanden: Fernverkäufe.csv.' });
    const n = await imDemo((tx) =>
      tx.nachweis.findFirstOrThrow({ where: { durchfuehrungId: did } }),
    );
    expect(n.dokumentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Richtungszeichen entfernt (Dateinamen-Spoofing).
    expect(n.dateiname).toBe('Fernverkäufe.csv');
    nachweisId = n.id;
  });

  it('Download-Route: nur mit Bezug zum Mandanten des Nachweises, sonst 404 (TS-03)', async () => {
    const lade = (mandant: string | null) =>
      GET(
        new Request(
          `http://demo.test/api/nachweise/${nachweisId}${mandant ? `?mandant=${mandant}` : ''}`,
        ),
        { params: Promise.resolve({ id: nachweisId }) },
      );
    expect((await lade(talwind)).status).toBe(401);
    als(DEMO_IDS.anna);
    const ok = await lade(talwind);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(inhalt);
    expect(ok.headers.get('content-disposition')).toContain('attachment');
    for (const m of [DEMO_IDS.seestern, null, 'kein-uuid'])
      expect((await lade(m)).status).toBe(404);
    // Portal-Personen: Kanzlei-Kontrolle des eigenen Mandanten bzw. fremder Mandant.
    for (const p of [DEMO_IDS.jana, DEMO_IDS.clara]) {
      als(p);
      expect((await lade(talwind)).status).toBe(404);
    }
  });

  it('Einreichen, Vier-Augen beim Gegenzeichnen, Gegenzeichnung durch die zweite Person', async () => {
    als(DEMO_IDS.leon);
    expect(await A.speichereDurchfuehrung(null, form(vollstaendig()))).toEqual({
      ok: 'Zur Gegenzeichnung eingereicht. Die Nachweise sind jetzt gesperrt.',
    });
    const r = await A.gegenzeichneDurchfuehrung(null, form(basis()));
    expect(r?.fehler).toMatch(/Vier-Augen/);
    als(DEMO_IDS.anna);
    expect(await A.gegenzeichneDurchfuehrung(null, form(basis()))).toEqual({
      ok: 'Gegengezeichnet – abgeschlossen ohne Befund.',
    });
    const ev = await imDemo((tx) =>
      tx.auditEvent.findMany({ where: { objektId: did }, orderBy: { pos: 'asc' } }),
    );
    expect(ev.map((e) => e.aktion)).toEqual([
      'tcms.durchfuehrung.begonnen',
      'tcms.durchfuehrung.gespeichert',
      'tcms.durchfuehrung.gespeichert',
      'tcms.durchfuehrung.eingereicht',
      'tcms.durchfuehrung.gegengezeichnet',
    ]);
    expect(ev.at(-1)).toMatchObject({ actorId: DEMO_IDS.anna, actorName: 'StB Dr. Anna Roth' });
  });

  it('historischer Stand: keine Änderung', async () => {
    als(DEMO_IDS.anna);
    const r = await A.legeNachtragAn(
      null,
      form({ ...basis(), stand: '2026-01-31', begruendung: 'x'.repeat(40) }),
    );
    expect(r).toEqual({ fehler: 'Änderungen nur im aktuellen Stand möglich' });
  });
});
