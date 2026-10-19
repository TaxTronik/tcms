// =============================================================================
// Demo des Bereichs „feststellungen-ereignisse" Ende-zu-Ende gegen PostgreSQL
// (DB_TESTS=1, geseedete Wegwerf-Datenbank, DATABASE_URL = tcms_app): Actions
// als dünne Hüllen um @tcms/service, Portal-Meldung mit Datei (Demo-Ablage,
// Verweis im Audit), Download der Anlage über den Service mit SHA-256-Prüfung
// (TS-09), Folgen aus dem Formular (TS-04 auf dem Demo-Weg), Länder-Formular.
// Wiederholbar: verbrauchte Demodaten (Länderstand) räumt der Test wieder ab.
// Next-Module (Cookies, Revalidierung, Redirect) sind durch Attrappen ersetzt.
// =============================================================================

import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { mitTenant } from '@tcms/db';

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

const ablage = mkdtempSync(join(tmpdir(), 'tcms-fest-ablage-'));
process.env['TCMS_STORAGE_DIR'] = ablage;

const { erzeugeCookie } = await import('../sitzung-regeln');
const { meldeEreignis } = await import('./portal-ereignis');
const { legeFolgenAn, erledigeFolge } = await import('./ereignisse');
const { landHinzufuegen } = await import('./laender');
const { setzeVertraulich } = await import('./feststellungen');
const { ladeFeststellungDetail } = await import('../feststellungen-daten');
const { GET: anlageHolen } = await import('@/app/staff/clients/[id]/tcms/ereignisse/anlage/route');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};
const imDemo = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(DEMO_TENANT_ID, fn);
const T = DEMO_IDS.talwind;

async function umleitungVon(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Umleitung) return e.ziel;
    throw e;
  }
  throw new Error('keine Umleitung');
}

function meldung(datei?: File): FormData {
  const fd = new FormData();
  fd.set('typ', 'T-02');
  fd.set('titel', 'Neues Lager in Polen');
  fd.set('beschreibung', 'Ab November lagern wir Ware in Posen.');
  fd.set('datum', '2026-10-12');
  fd.set('zusage', '1');
  if (datei) fd.append('anlagen', datei);
  return fd;
}

const anfrage = (mandantId: string, e: string, h: string) =>
  anlageHolen(
    new Request(`http://demo.test/staff/clients/${mandantId}/tcms/ereignisse/anlage?e=${e}&h=${h}`),
    { params: Promise.resolve({ id: mandantId }) },
  );

describe.skipIf(!AKTIV)('Demo feststellungen-ereignisse gegen PostgreSQL', () => {
  const inhalt = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(64)]);
  let ereignisId = '';
  let sha = '';

  beforeAll(() => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
  });
  beforeEach(() => {
    sitzung = '';
  });

  it('Portal: Mitarbeiterin darf nicht melden – keine Datei wird angenommen', async () => {
    als(DEMO_IDS.sabine);
    let ergebnis: unknown;
    try {
      ergebnis = await meldeEreignis(
        null,
        meldung(new File([inhalt], 'Vertrag.pdf', { type: 'application/pdf' })),
      );
    } catch (e) {
      // Ein anderer Test deaktiviert Sabines Rolle: dann kein Portal-Zugang (auch gut).
      if (!(e instanceof Umleitung)) throw e;
      ergebnis = e.ziel;
    }
    expect(
      ergebnis === '/anmelden?fehler=rolle' ||
        /Geschäftsführung/.test((ergebnis as { fehler?: string } | null)?.fehler ?? ''),
    ).toBe(true);
    expect(readdirSync(ablage)).toEqual([]);
  });

  it('Portal: GV meldet mit Anlage; der Service speichert nur den Verweis', async () => {
    als(DEMO_IDS.jana);
    const ziel = await umleitungVon(
      meldeEreignis(null, meldung(new File([inhalt], 'Vertrag.pdf', { type: 'application/pdf' }))),
    );
    const nummer = decodeURIComponent(ziel.split('gemeldet=')[1] ?? '');
    const e = await imDemo((tx) => tx.ereignis.findFirstOrThrow({ where: { nummer } }));
    ereignisId = e.id;
    const audit = await imDemo((tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { objektId: e.id, aktion: 'tcms.ereignis.gemeldet' },
      }),
    );
    const anlagen = (audit.detail as { anlagen: { sha256: string; dokumentId: string }[] }).anlagen;
    expect(anlagen).toHaveLength(1);
    sha = anlagen[0]!.sha256;
    expect(anlagen[0]!.dokumentId).toBe(`${sha.slice(0, 2)}/${sha}`);
    // Nicht zulässiger Dateityp wird abgewiesen, bevor etwas gespeichert wird.
    const r = await meldeEreignis(
      null,
      meldung(new File(['<script>'], 'x.html', { type: 'text/html' })),
    );
    expect(r?.fehler).toMatch(/nicht unterstützt/);
  });

  it('TS-09 Download: über den Service, mit Integritätsprüfung, als Download ausgeliefert', async () => {
    als(DEMO_IDS.anna);
    const ok = await anfrage(T, ereignisId, sha);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(inhalt)).toBe(true);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-security-policy')).toMatch(/sandbox/);
    // Anderer Mandant im Pfad, unbekannter Hash, ungültiger Hash, Mandantenkontakt.
    expect((await anfrage(DEMO_IDS.seestern, ereignisId, sha)).status).toBe(404);
    expect((await anfrage(T, ereignisId, 'b'.repeat(64))).status).toBe(404);
    expect((await anfrage(T, ereignisId, 'kaputt')).status).toBe(400);
    als(DEMO_IDS.jana);
    expect((await anfrage(T, ereignisId, sha)).status).toBe(401);
    // Manipulierte Datei: Integritätsprüfung schlägt an.
    als(DEMO_IDS.anna);
    writeFileSync(join(ablage, sha.slice(0, 2), sha), 'manipuliert');
    expect((await anfrage(T, ereignisId, sha)).status).toBe(410);
  });

  it('Folgen aus dem Formular: Feststellung mit „NEIN" durch Bearbeitung wird „UNKLAR" (TS-04)', async () => {
    const folgen = await imDemo(async (tx) => {
      const f = await tx.ereignisFolge.create({
        data: { ereignisId, art: 'FESTSTELLUNG_ANLEGEN', text: 'Feststellung prüfen' },
      });
      const h = await tx.ereignisFolge.create({
        data: { ereignisId, art: 'HINWEIS', text: 'Hinweis an BT' },
      });
      return { f: f.id, h: h.id };
    });
    als(DEMO_IDS.leon);
    const fd = new FormData();
    fd.set('mandantId', T);
    fd.set('ereignisId', ereignisId);
    fd.append('folge', folgen.f);
    fd.append('folge', folgen.h);
    fd.set(`ftitel_${folgen.f}`, 'Lager ohne Registrierung');
    fd.set(`fklasse_${folgen.f}`, 'STEUERLICHER_FEHLER');
    fd.set(`fschwere_${folgen.f}`, 'HOCH');
    fd.set(`fauswirkung_${folgen.f}`, 'NEIN');
    fd.set(`zustaendig_${folgen.h}`, DEMO_IDS.leon);
    expect(await legeFolgenAn(null, fd)).toEqual({ ok: '2 Folgen angelegt.' });
    const fs = await imDemo((tx) => tx.feststellung.findFirstOrThrow({ where: { ereignisId } }));
    expect(fs.auswirkung).toBe('UNKLAR');
    const erledige = new FormData();
    erledige.set('mandantId', T);
    erledige.set('ereignisId', ereignisId);
    erledige.set('id', folgen.h);
    expect(await erledigeFolge(null, erledige)).toEqual({ ok: 'Folge erledigt.' });
    // Folge eines Ereignisses unter falschem Ereignis: nicht gefunden.
    erledige.set('ereignisId', fs.id);
    expect((await erledigeFolge(null, erledige))?.fehler).toBeTruthy();
  });

  it('Länder-Formular: Betrag in deutscher Schreibweise, neuer Stand, Umleitung', async () => {
    // Malta ist nicht im Seed: Stände früherer Läufe entfernen (wiederholbar).
    const entferneMalta = () =>
      imDemo((tx) =>
        tx.landStand.deleteMany({ where: { land: 'MT', programm: { mandantId: T } } }),
      );
    await entferneMalta();
    als(DEMO_IDS.leon);
    const fd = new FormData();
    fd.set('mandantId', T);
    fd.set('land', 'mt');
    fd.set('stand', '2026-10-01');
    fd.set('fernverkaeufeLfdEur', '1.200,50');
    fd.set('fernverkaeufeVorjahrEur', '0');
    fd.set('oss', 'on');
    expect(await umleitungVon(landHinzufuegen(null, fd))).toBe(
      `/staff/clients/${T}/tcms/laender?land=MT`,
    );
    const s = await imDemo((tx) => tx.landStand.findFirstOrThrow({ where: { land: 'MT' } }));
    expect(Number(s.fernverkaeufeLfdEur)).toBe(1200.5);
    expect(s.oss).toBe(true);
    fd.set('fernverkaeufeLfdEur', 'viel');
    expect((await landHinzufuegen(null, fd))?.fehler).toMatch(/Betrag/);
    await entferneMalta();
  });

  it('Vertraulich: Detail für Nicht-Beteiligte maskiert (Service), Schalter nur für BT', async () => {
    const f = await imDemo((tx) =>
      tx.feststellung.findFirstOrThrow({
        where: { nummer: 'F-2026-004', programm: { mandantId: T } },
      }),
    );
    const fd = new FormData();
    fd.set('mandantId', T);
    fd.set('id', f.id);
    fd.set('wert', '1');
    als(DEMO_IDS.leon);
    expect((await setzeVertraulich(null, fd))?.fehler).toMatch(/Berufsträger/);
    als(DEMO_IDS.anna);
    expect((await setzeVertraulich(null, fd))?.ok).toMatch(/vertraulich/);
    als(DEMO_IDS.thomas);
    const d = await ladeFeststellungDetail(T, f.id, '2026-10-16');
    expect(d).toEqual({ maskiert: true, id: f.id, nummer: 'F-2026-004' });
    fd.set('wert', '0');
    als(DEMO_IDS.anna);
    expect((await setzeVertraulich(null, fd))?.ok).toMatch(/aufgehoben/);
  });
});
