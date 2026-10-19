// =============================================================================
// Postausgang gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app): nur der
// Systemakteur der kanzleikonsole (Stufe 4), tenantweit (RLS), Adressierung
// über IDs (TS-06), Abruf protokolliert (Systemakteur erkennbar), Zustellung
// idempotent (auch gleichzeitig): `zugestelltAm` gesetzt, Text geleert;
// unbekannte oder fremde ID → NICHT_GEFUNDEN.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NachrichtenOffenSchema } from '@tcms/contract';
import type { PrismaClient } from '@tcms/db';
import type { DienstKontext, SystemKontext } from '../../kontext';
import { codeAblaufAb, codeHash } from './code';
import {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  legeNachrichtAn,
} from './nachrichten';
import {
  baueWelt,
  btA,
  fehlerVon,
  gleichzeitig,
  hbA,
  im,
  imSystem,
  inWelt,
  kanzlei,
  kontakt,
  system,
  SYSTEM_ID,
  TEST_CODES,
  zweiteVerbindung,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Postausgang (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;
  const admin = () => kanzlei(w, randomUUID(), null, { admin: true });
  let ids: string[] = [];

  /** Vorlagendaten je Zweck (gültig laut Vertrag). */
  const datenAngefordert = (freigabeId = 'ckfreigabe0000000000000a') => ({
    freigabeId,
    art: 'ZIELE' as const,
    titel: 'Compliance-Ziele · Umsatzsteuer',
    version: null,
  });
  /** Echte Freigabe mit aktivem Code 123456 (sonst verwürfe der Abruf die Code-Nachricht). */
  let codeFreigabe = '';
  let gueltigBis = '';
  const datenCode = (code = '123456') => ({
    freigabeId: codeFreigabe,
    art: 'BESCHREIBUNG' as const,
    titel: 'CMS-Beschreibung v1.2',
    version: '1.2',
    code,
    gueltigBis,
    sha256: 'a'.repeat(64),
  });

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
    await inWelt(w, async (tx) => {
      const p = await tx.tcmsProgramm.create({
        data: { mandantId: w.mandantA, paketId: 'ecommerce', paketVersion: '1.0' },
      });
      const f = await tx.freigabe.create({
        data: {
          programmId: p.id,
          art: 'BESCHREIBUNG',
          refId: randomUUID(),
          titel: 'CMS-Beschreibung v1.2',
          angefordertVon: w.bt,
          empfaengerId: w.gv,
        },
      });
      const ablauf = codeAblaufAb(new Date());
      await tx.freigabe.update({
        where: { id: f.id },
        data: { ...codeHash(TEST_CODES, f.id, '123456'), codeAblauf: ablauf },
      });
      codeFreigabe = f.id;
      gueltigBis = ablauf.toISOString();
    });
    ids = await inWelt(w, async (tx) => {
      const a = await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        daten: datenCode(),
        betreff: 'B1',
        text: 'Code 123456',
      });
      const b = await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.tcb,
        zweck: 'FREIGABE_ANGEFORDERT',
        daten: datenAngefordert(),
        betreff: 'B2',
        text: 'T2',
      });
      const c = await legeNachrichtAn(tx, {
        mandantId: w.mandantB,
        empfaengerId: w.gvB,
        zweck: 'FREIGABE_NEU_ADRESSIERT',
        daten: { ...datenAngefordert(), art: 'KENNTNISNAHME' },
        betreff: 'B3',
        text: 'T3',
      });
      return [a, b, c];
    });
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('Anlage nur mit Personen- und Mandanten-ID, bekanntem Zweck und gültigen Vorlagendaten (fail closed)', async () => {
    const basis = {
      mandantId: w.mandantA,
      empfaengerId: randomUUID(),
      zweck: 'FREIGABE_ANGEFORDERT',
      daten: datenAngefordert(),
      betreff: 'x',
      text: 'x',
    };
    for (const [over, meldung] of [
      [{ empfaengerId: 'Jana Weller' }, /Empfänger/],
      [{ empfaengerId: `${randomUUID()}x` }, /Empfänger/],
      [{ mandantId: 'Testmandant A GmbH' }, /Mandanten/],
      [{ zweck: 'UNBEKANNT' }, /Nachrichtenzweck/],
      [{ daten: { ...datenAngefordert(), titel: '' } }, /Vorlagendaten/],
      [{ daten: { ...datenAngefordert(), name: 'Jana Weller' } }, /Vorlagendaten/],
      [{ zweck: 'FREIGABE_CODE', daten: { ...datenCode(), code: '12345' } }, /Vorlagendaten/],
      [{ zweck: 'FREIGABE_CODE', daten: datenAngefordert() }, /Vorlagendaten/],
      [{ zweck: 'EREIGNIS_GEMELDET', daten: datenAngefordert() }, /Vorlagendaten/],
    ] as const) {
      const fehler = await inWelt(w, (tx) =>
        legeNachrichtAn(tx, { ...basis, ...over } as never),
      ).catch((e: unknown) => e as Error);
      expect((fehler as Error).message, JSON.stringify(over)).toMatch(meldung);
      // Meldung ohne Werte (kein Code, kein Name).
      expect((fehler as Error).message).not.toMatch(/12345|Jana/);
    }
    // Mandant eines anderen Tenants bzw. unbekannter Mandant: Fremdschlüssel (tenant_id, id).
    await expect(
      inWelt(w, (tx) => legeNachrichtAn(tx, { ...basis, mandantId: randomUUID() } as never)),
    ).rejects.toThrow();
    // Schreibweise der IDs wird kanonisch gespeichert; Empfängerart folgt aus dem Zweck.
    const id = randomUUID();
    const nid = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.mandantA.toUpperCase(),
        empfaengerId: id.toUpperCase(),
        zweck: 'EREIGNIS_GEMELDET',
        daten: {
          ereignisId: 'ckereignis000000000000a',
          nummer: '2026-E-0001',
          titel: 'Neuer Marktplatz',
          typ: 'Marktplatz',
          gemeldetVonId: w.gv,
        },
        betreff: 'K',
        text: 'K',
      }),
    );
    const z = await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: nid } }));
    expect(z).toMatchObject({
      empfaengerId: id,
      mandantId: w.mandantA,
      empfaengerArt: 'KANZLEI',
      code: null,
    });
    await inWelt(w, (tx) => tx.nachricht.delete({ where: { id: nid } }));
  });

  it('Code steht nur in der Spalte code, nie in daten', async () => {
    const z = await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: ids[0] } }));
    expect(z.code).toBe('123456');
    expect(z.empfaengerArt).toBe('KONTAKT');
    expect(JSON.stringify(z.daten)).not.toContain('123456');
    expect(z.daten).toEqual({
      freigabeId: codeFreigabe,
      art: 'BESCHREIBUNG',
      titel: 'CMS-Beschreibung v1.2',
      version: '1.2',
      gueltigBis,
      sha256: 'a'.repeat(64),
    });
  });

  it('die Datenbank erzwingt Empfängerart, Codeformat und leeren Klartext nach der Zustellung', async () => {
    const roh = (data: Record<string, unknown>) =>
      inWelt(w, (tx) =>
        tx.nachricht.create({
          data: {
            mandantId: w.mandantA,
            empfaengerId: randomUUID(),
            empfaengerArt: 'KONTAKT',
            zweck: 'FREIGABE_ANGEFORDERT',
            betreff: 'b',
            text: 't',
            daten: {},
            ...data,
          } as never,
        }),
      );
    for (const [name, data] of [
      ['Ereignis an Kontakt', { zweck: 'EREIGNIS_GEMELDET' }],
      ['Freigabe an Kanzlei', { empfaengerArt: 'KANZLEI' }],
      ['Code bei anderem Zweck', { code: '123456' }],
      ['Code nicht sechs Ziffern', { zweck: 'FREIGABE_CODE', code: '12a456' }],
      ['offene Code-Nachricht ohne Code', { zweck: 'FREIGABE_CODE' }],
      ['daten kein Objekt', { daten: ['x'] }],
      ['zugestellt mit Text', { zugestelltAm: new Date() }],
      [
        'verworfen mit Code',
        { zweck: 'FREIGABE_CODE', code: '123456', text: '', verworfenAm: new Date() },
      ],
    ] as const) {
      await expect(roh(data), name).rejects.toThrow();
    }
    await expect(
      inWelt(w, (tx) =>
        tx.nachricht.update({ where: { id: ids[0] }, data: { zugestelltAm: new Date() } }),
      ),
    ).rejects.toThrow();
  });

  it('liefert offene Nachrichten nach Alter, begrenzt; Abruf im Audit (Systemakteur erkennbar, ohne Text)', async () => {
    const r = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(NachrichtenOffenSchema.parse(r)).toEqual(r);
    expect(r.nachrichten.map((n) => n.id)).toEqual(ids);
    expect(r.nachrichten[0]).toEqual({
      id: ids[0],
      mandantId: w.mandantA,
      empfaengerId: w.gv,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_CODE',
      daten: datenCode(),
      betreff: 'B1',
      text: 'Code 123456',
      erstelltAm: expect.any(String),
    });
    expect(r.nachrichten[1]).toMatchObject({
      mandantId: w.mandantA,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_ANGEFORDERT',
      daten: datenAngefordert(),
    });
    expect(r.nachrichten[2]).toMatchObject({
      mandantId: w.mandantB,
      zweck: 'FREIGABE_NEU_ADRESSIERT',
      daten: { art: 'KENNTNISNAHME' },
    });
    const zwei = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, { limit: 2 }));
    expect(zwei.nachrichten).toHaveLength(2);
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.findMany({
        where: { aktion: 'tcms.nachricht.abgerufen' },
        orderBy: { pos: 'asc' },
      }),
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]!.detail).toEqual({ anzahl: 3, ids, systemakteur: true });
    expect(audit[0]).toMatchObject({
      actorId: SYSTEM_ID,
      actorName: 'System: Zustellung kanzleikonsole',
    });
    expect(JSON.stringify(audit.map((a) => a.detail))).not.toContain('123456');
    for (const limit of [0, 101, 1.5]) {
      expect(
        (await fehlerVon(imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, { limit })))).code,
      ).toBe('UNGUELTIG');
    }
  });

  it('nur der Systemakteur: Personen (auch Admins) → NICHT_GEFUNDEN, ohne Datenzugriff und Audit', async () => {
    const vorher = await inWelt(w, (tx) => tx.auditEvent.count());
    const btOhneAdmin = kanzlei(w, w.bt, w.mandantA, { bt: true, zustaendig: true });
    const personen = [admin(), btA(w), hbA(w), btOhneAdmin, kontakt(w, w.gv, w.mandantA)];
    for (const a of personen) {
      // Über den Systemdienst: schon vor der Transaktion abgewiesen.
      expect((await fehlerVon(imSystem(a, (ctx) => ladeOffeneNachrichten(ctx, {})))).code).toBe(
        'NICHT_GEFUNDEN',
      );
      // Untergeschobener Personenkontext: die Operation selbst weist ab (auch bei
      // ungültiger Eingabe kein 400, das die Operation verriete).
      const alsSystem = (ctx: DienstKontext) => ctx as unknown as SystemKontext;
      const laeufe: ((ctx: DienstKontext) => Promise<unknown>)[] = [
        (ctx: DienstKontext) => ladeOffeneNachrichten(alsSystem(ctx), {}),
        (ctx: DienstKontext) => ladeOffeneNachrichten(alsSystem(ctx), { limit: 0 }),
        (ctx: DienstKontext) =>
          bestaetigeNachrichtZustellung(alsSystem(ctx), { nachrichtId: ids[1]! }),
        (ctx: DienstKontext) =>
          bestaetigeNachrichtZustellung(alsSystem(ctx), { nachrichtId: 'x y' }),
      ];
      for (const lauf of laeufe) {
        expect((await fehlerVon(im(a, lauf))).code).toBe('NICHT_GEFUNDEN');
      }
    }
    expect(
      await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: ids[1] } })),
    ).toMatchObject({ zugestelltAm: null, text: 'T2' });
    expect(await inWelt(w, (tx) => tx.auditEvent.count())).toBe(vorher);
  });

  it('fremder Tenant: sieht nichts, Zustellung fremder IDs → NICHT_GEFUNDEN', async () => {
    const fremd = system(w, randomUUID());
    expect(await imSystem(fremd, (ctx) => ladeOffeneNachrichten(ctx, {}))).toEqual({
      nachrichten: [],
    });
    expect(
      (
        await fehlerVon(
          imSystem(fremd, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[1]! })),
        )
      ).code,
    ).toBe('NICHT_GEFUNDEN');
    expect(
      await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: ids[1] } })),
    ).toMatchObject({ zugestelltAm: null, text: 'T2' });
  });

  it('Zustellung setzt zugestelltAm und leert den Text (Code verlässt das Tax-CMS), idempotent, Audit einmal', async () => {
    const a = system(w);
    const r = await imSystem(a, (ctx) =>
      bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[0]! }),
    );
    expect(r).toEqual({ nachrichtId: ids[0], zugestellt: true });
    expect(
      await imSystem(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[0]! })),
    ).toEqual(r);
    expect(
      (
        await fehlerVon(
          imSystem(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: 'unbekannt' })),
        )
      ).code,
    ).toBe('NICHT_GEFUNDEN');
    const [zeile, audit] = await inWelt(w, async (tx) => [
      await tx.nachricht.findUniqueOrThrow({ where: { id: ids[0] } }),
      await tx.auditEvent.findMany({
        where: { aktion: 'tcms.nachricht.zugestellt', objektId: ids[0] },
      }),
    ]);
    const offen = await imSystem(a, (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(zeile.zugestelltAm).not.toBeNull();
    expect(zeile.text).toBe('');
    expect(zeile.code).toBeNull();
    expect(JSON.stringify(zeile.daten)).not.toContain('123456');
    expect(offen.nachrichten.map((n) => n.id)).not.toContain(ids[0]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).not.toContain('123456');
    expect(audit[0]!.detail).toEqual({
      zweck: 'FREIGABE_CODE',
      empfaengerId: w.gv,
      systemakteur: true,
    });
    expect(audit[0]!.actorName).toBe('System: Zustellung kanzleikonsole');
    expect(
      (
        await fehlerVon(
          imSystem(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: 'x y' })),
        )
      ).code,
    ).toBe('UNGUELTIG');
  });

  it('gleichzeitige Zustellbestätigung: beide „zugestellt", genau ein Audit-Eintrag', async () => {
    const id = ids[2]!;
    const e = await gleichzeitig(w, [
      () => imSystem(system(w), (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: id })),
      () =>
        imSystem(
          system(w),
          (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: id }),
          zweite,
        ),
    ]);
    expect(e.every((x) => x.status === 'fulfilled')).toBe(true);
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.count({ where: { aktion: 'tcms.nachricht.zugestellt', objektId: id } }),
    );
    expect(audit).toBe(1);
  });
});
