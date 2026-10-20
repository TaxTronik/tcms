// =============================================================================
// Zustellstatus an Freigaben (Stufe 4) gegen PostgreSQL (DB_TESTS=1,
// DATABASE_URL = tcms_app): Freigabenhistorie und CMS-Beschreibung zeigen der
// Kanzlei je Freigabe den Status der jüngsten Nachricht an den aktuellen
// Empfänger (offen, zugestellt, unzustellbar mit Grund, verworfen) – ohne
// Inhalte der Nachricht. Nachrichten anderer Mandanten und an frühere bzw.
// andere Empfänger zählen nicht; im historischen Stand kein Status.
// Risikoakzeptanzen: risiken-kontrollen/__tests__/risiken.db.test.ts.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BeschreibungViewSchema,
  FreigabenHistorieSchema,
  type FreigabeZustellung,
} from '@tcms/contract';
import { ladeBeschreibung } from './beschreibung';
import { adressiereFreigabeNeu } from './freigaben';
import { ladeFreigabenHistorie } from './kommunikation';
import {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  legeNachrichtAn,
  meldeNachrichtUnzustellbar,
} from './nachrichten';
import { richteEin } from './testprogramm';
import {
  baueWelt,
  btA,
  im,
  imSystem,
  inWelt,
  ohneRechtA,
  system,
  TEST_UHR,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const CODE = '615243';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe.skipIf(!AKTIV)('Zustellstatus an Freigaben (Service, PostgreSQL)', () => {
  let w: Welt;
  let programmA = '';
  let ziele = '';
  let zieleNachricht = '';
  let beschreibung = '';
  let ohneNachricht = '';

  const historie = (stand?: string) =>
    im(btA(w), (ctx) =>
      ladeFreigabenHistorie(ctx, { mandantId: w.mandantA, ...(stand ? { stand } : {}) }),
    );
  async function zustellungIn(freigabeId: string): Promise<FreigabeZustellung | null> {
    const h = await historie();
    expect(FreigabenHistorieSchema.parse(h)).toEqual(h);
    const z = h.freigaben.find((f) => f.id === freigabeId);
    if (!z) throw new Error('Freigabe fehlt in der Historie');
    return z.zustellung;
  }
  const melde = (nachrichtId: string, grund: 'KEIN_PORTALZUGANG' | 'EMPFAENGER_UNGUELTIG') =>
    imSystem(system(w), (ctx) => meldeNachrichtUnzustellbar(ctx, { nachrichtId, grund }));
  const zustellen = (nachrichtId: string) =>
    imSystem(system(w), (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId }));

  beforeAll(async () => {
    w = await baueWelt();
    programmA = await richteEin(w);
    ({ ziele, zieleNachricht, beschreibung, ohneNachricht } = await inWelt(w, async (tx) => {
      const z = await tx.freigabe.findFirstOrThrow({
        where: { programmId: programmA, art: 'ZIELE' },
      });
      const n = await tx.nachricht.findFirstOrThrow({ where: { zweck: 'FREIGABE_ANGEFORDERT' } });
      const b = await tx.freigabe.create({
        data: {
          programmId: programmA,
          art: 'BESCHREIBUNG',
          refId: randomUUID(),
          titel: 'CMS-Beschreibung v1.0',
          angefordertVon: w.bt,
          // Fachliche Zeit wie beim Anlegen durch den Dienst (Uhr der Testwelt), nicht der
          // Tag des Testlaufs: Die Historie liest bis zum Stichtag der Uhr.
          angefordertAm: TEST_UHR.jetzt(),
          empfaengerId: w.gv,
        },
      });
      await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        daten: {
          freigabeId: b.id,
          art: 'BESCHREIBUNG',
          titel: 'CMS-Beschreibung v1.0',
          version: '1.0',
          code: CODE,
          gueltigBis: '2099-01-01T00:00:00.000Z',
          sha256: 'd'.repeat(64),
        },
        betreff: 'Bestätigungscode CMS-Beschreibung',
        text: `Ihr Bestätigungscode: ${CODE}`,
      });
      const o = await tx.freigabe.create({
        data: {
          programmId: programmA,
          art: 'KENNTNISNAHME',
          refId: randomUUID(),
          titel: 'Kenntnisnahme ohne Nachricht',
          angefordertVon: w.bt,
          angefordertAm: TEST_UHR.jetzt(),
          empfaengerId: w.tcb,
        },
      });
      return { ziele: z.id, zieleNachricht: n.id, beschreibung: b.id, ohneNachricht: o.id };
    }));
    expect(
      await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: zieleNachricht } })),
    ).toMatchObject({ empfaengerId: w.gv, daten: { freigabeId: ziele } });
  });

  it('offen: Zweck und Zeitpunkt der jüngsten Nachricht; ohne Nachricht null; keine Inhalte', async () => {
    const h = await historie();
    expect(FreigabenHistorieSchema.parse(h)).toEqual(h);
    const je = new Map(h.freigaben.map((f) => [f.id, f.zustellung]));
    expect(je.get(ziele)).toEqual({
      status: 'OFFEN',
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: expect.stringMatching(ISO),
    });
    expect(je.get(beschreibung)).toEqual({
      status: 'OFFEN',
      zweck: 'FREIGABE_CODE',
      erstelltAm: expect.stringMatching(ISO),
    });
    expect(je.get(ohneNachricht)).toBeNull();
    const roh = JSON.stringify(h);
    expect(roh).not.toContain(CODE);
    expect(roh).not.toContain('Bestätigungscode');
    expect(roh).not.toContain('Im Portal warten');
    expect(roh).not.toContain(zieleNachricht);
    // Jede Kanzleiperson mit Leserecht sieht den Status (wie die Historie selbst).
    const leser = await im(ohneRechtA(w), (ctx) =>
      ladeFreigabenHistorie(ctx, { mandantId: w.mandantA }),
    );
    expect(leser.freigaben.find((f) => f.id === ziele)?.zustellung).toMatchObject({
      status: 'OFFEN',
    });
  });

  it('unzustellbar mit Grund, zugestellt; CMS-Beschreibung zeigt dasselbe', async () => {
    await melde(zieleNachricht, 'KEIN_PORTALZUGANG');
    expect(await zustellungIn(ziele)).toEqual({
      status: 'UNZUSTELLBAR',
      grund: 'KEIN_PORTALZUGANG',
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: expect.stringMatching(ISO),
      am: '2026-10-19T09:00:00.000Z',
    });
    const codeNachricht = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({ where: { zweck: 'FREIGABE_CODE', empfaengerId: w.gv } }),
    );
    await zustellen(codeNachricht.id);
    expect(await zustellungIn(beschreibung)).toMatchObject({
      status: 'ZUGESTELLT',
      zweck: 'FREIGABE_CODE',
      am: '2026-10-19T09:00:00.000Z',
    });
    const b = await im(btA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }));
    expect(BeschreibungViewSchema.parse(b)).toEqual(b);
    expect(b.freigaben.map((f) => [f.id, f.zustellung?.status])).toEqual([
      [beschreibung, 'ZUGESTELLT'],
    ]);
    expect(JSON.stringify(b)).not.toContain(CODE);
  });

  it('nach Neuadressierung zählt nur die Nachricht an den neuen Empfänger', async () => {
    await im(btA(w), (ctx) =>
      adressiereFreigabeNeu(ctx, { mandantId: w.mandantA, freigabeId: ziele, empfaengerId: w.gv2 }),
    );
    expect(await zustellungIn(ziele)).toEqual({
      status: 'OFFEN',
      zweck: 'FREIGABE_NEU_ADRESSIERT',
      erstelltAm: expect.stringMatching(ISO),
    });
  });

  it('Nachrichten anderer Mandanten und an andere Empfänger zählen nicht (auch jüngere)', async () => {
    const spaeter = new Date(Date.now() + 3_600_000);
    const daten = { freigabeId: ziele, art: 'ZIELE' as const, titel: 'Ziele', version: null };
    const [fremderMandant, andererEmpfaenger] = await inWelt(w, async (tx) => [
      // Gleiche Freigabe-ID, gleicher (aktueller) Empfänger, aber Mandant B.
      await legeNachrichtAn(tx, {
        mandantId: w.mandantB,
        empfaengerId: w.gv2,
        zweck: 'FREIGABE_NEU_ADRESSIERT',
        daten,
        betreff: 'B',
        text: 'T',
        erstelltAm: spaeter,
      }),
      // Gleicher Mandant und Freigabe, aber nicht der aktuelle Empfänger.
      await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.tcb,
        zweck: 'FREIGABE_ANGEFORDERT',
        daten,
        betreff: 'B',
        text: 'T',
        erstelltAm: spaeter,
      }),
    ]);
    await zustellen(fremderMandant);
    await melde(andererEmpfaenger, 'EMPFAENGER_UNGUELTIG');
    expect(await zustellungIn(ziele)).toMatchObject({
      status: 'OFFEN',
      zweck: 'FREIGABE_NEU_ADRESSIERT',
    });
  });

  it('verworfene Code-Nachricht: VERWORFEN; eine spätere Meldung der kanzleikonsole gilt', async () => {
    const id = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        // Die Freigabe hat keinen aktiven Code: Der Abruf verwirft die Nachricht.
        daten: {
          freigabeId: beschreibung,
          art: 'BESCHREIBUNG',
          titel: 'CMS-Beschreibung v1.0',
          version: '1.0',
          code: '908172',
          gueltigBis: '2099-01-01T00:00:00.000Z',
          sha256: null,
        },
        betreff: 'B',
        text: 'Ihr Bestätigungscode: 908172',
        erstelltAm: new Date(Date.now() + 60_000),
      }),
    );
    // Ein früherer Abruf hatte sie ausgeliefert (H2: nur dann gilt eine spätere Meldung;
    // verworfen und nie ausgeliefert → 409, siehe nachrichten-lebensdauer.db.test.ts).
    await inWelt(w, (tx) =>
      tx.nachricht.update({ where: { id }, data: { abgerufenAm: new Date() } }),
    );
    await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(await zustellungIn(beschreibung)).toEqual({
      status: 'VERWORFEN',
      zweck: 'FREIGABE_CODE',
      erstelltAm: expect.stringMatching(ISO),
      am: expect.stringMatching(ISO),
    });
    await melde(id, 'EMPFAENGER_UNGUELTIG');
    expect(await zustellungIn(beschreibung)).toMatchObject({
      status: 'UNZUSTELLBAR',
      grund: 'EMPFAENGER_UNGUELTIG',
    });
  });

  it('historischer Stand: kein Zustellstatus (wie der Code-Status)', async () => {
    const alt = await inWelt(w, async (tx) => {
      const f = await tx.freigabe.create({
        data: {
          programmId: programmA,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: 'Risikoakzeptanz EC-UST-02',
          angefordertVon: w.bt,
          angefordertAm: new Date('2026-10-10T08:00:00Z'),
          empfaengerId: w.gv,
        },
      });
      await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_ANGEFORDERT',
        daten: { freigabeId: f.id, art: 'RISIKOAKZEPTANZ', titel: f.titel, version: null },
        betreff: 'B',
        text: 'T',
        erstelltAm: new Date('2026-10-10T08:00:00Z'),
      });
      return f.id;
    });
    expect(await zustellungIn(alt)).toMatchObject({ status: 'OFFEN' });
    const h = await historie('2026-10-15');
    expect(h.historisch).toBe(true);
    expect(h.freigaben.map((f) => [f.id, f.zustellung])).toEqual([[alt, null]]);
    const b = await im(btA(w), (ctx) =>
      ladeBeschreibung(ctx, { mandantId: w.mandantA, stand: '2026-10-15' }),
    );
    expect(b.freigaben.every((f) => f.zustellung === null)).toBe(true);
  });
});
