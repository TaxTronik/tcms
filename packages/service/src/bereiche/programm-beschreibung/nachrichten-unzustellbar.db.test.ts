// =============================================================================
// Unzustellbarkeit melden gegen PostgreSQL (DB_TESTS=1, DATABASE_URL =
// tcms_app): nur der Systemakteur (Stufe 4), tenantweit (RLS); setzt
// `unzustellbarAm`/`unzustellbarGrund`, leert Text und Code, die Nachricht wird
// nicht mehr ausgeliefert; idempotent mit demselben Grund; zugestellt und
// unzustellbar schließen sich aus (409, auch gleichzeitig, und CHECK); unbekannte
// oder fremde ID → NICHT_GEFUNDEN; Audit ohne Inhalte.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NachrichtZweck } from '@tcms/contract';
import type { PrismaClient } from '@tcms/db';
import type { DienstKontext, SystemKontext } from '../../kontext';
import {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  legeNachrichtAn,
  meldeNachrichtUnzustellbar,
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
  nurEinErfolg,
  system,
  SYSTEM_ID,
  zweiteVerbindung,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const CODE = '483920';
/** Code als eigenes Token (nicht als Ziffernfolge innerhalb einer ID). */
const alsToken = (code: string) => new RegExp(`(?<![0-9a-z])${code}(?![0-9a-z])`);

describe.skipIf(!AKTIV)('Unzustellbarkeit melden (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;

  /** Neue offene Nachricht an GV von Mandant A (Code-Nachricht mit Klartext-Code). */
  async function nachricht(zweck: NachrichtZweck = 'FREIGABE_CODE'): Promise<string> {
    const freigabe = {
      freigabeId: 'ckfreigabeunzustellbar01',
      art: 'BESCHREIBUNG' as const,
      titel: 'CMS-Beschreibung v1.3',
      version: '1.3',
    };
    return inWelt(w, (tx) =>
      zweck === 'FREIGABE_CODE'
        ? legeNachrichtAn(tx, {
            mandantId: w.mandantA,
            empfaengerId: w.gv,
            zweck,
            daten: {
              ...freigabe,
              code: CODE,
              gueltigBis: '2099-01-01T00:00:00.000Z',
              sha256: 'c'.repeat(64),
            },
            betreff: 'Bestätigungscode',
            text: `Ihr Bestätigungscode: ${CODE}`,
          })
        : legeNachrichtAn(tx, {
            mandantId: w.mandantA,
            empfaengerId: w.gv,
            zweck: 'FREIGABE_ANGEFORDERT',
            daten: freigabe,
            betreff: 'Freigabe angefordert',
            text: 'Im Portal wartet eine Freigabe.',
          }),
    );
  }
  const zeile = (id: string) =>
    inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id } }));
  const audit = (id: string) =>
    inWelt(w, (tx) =>
      tx.auditEvent.findMany({
        where: {
          objektId: id,
          aktion: { in: ['tcms.nachricht.unzustellbar', 'tcms.nachricht.zugestellt'] },
        },
        orderBy: { pos: 'asc' },
      }),
    );
  const melde = (id: string, grund: string, a = system(w), client?: PrismaClient) =>
    imSystem(
      a,
      (ctx) => meldeNachrichtUnzustellbar(ctx, { nachrichtId: id, grund } as never),
      client,
    );
  const zustellen = (id: string, client?: PrismaClient) =>
    imSystem(system(w), (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: id }), client);

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('setzt Status und Grund, leert Text und Code, liefert nicht mehr aus; Audit ohne Inhalte', async () => {
    const id = await nachricht();
    expect((await zeile(id)).code).toBe(CODE);
    const r = await melde(id, 'KEIN_PORTALZUGANG');
    expect(r).toEqual({ nachrichtId: id, unzustellbar: true, grund: 'KEIN_PORTALZUGANG' });
    const z = await zeile(id);
    expect(z).toMatchObject({
      unzustellbarGrund: 'KEIN_PORTALZUGANG',
      zugestelltAm: null,
      verworfenAm: null,
      code: null,
      text: '',
    });
    expect(z.unzustellbarAm).toEqual(new Date('2026-10-19T09:00:00.000Z'));
    // Nicht mehr ausgeliefert und nicht als offen behandelt (auch nicht verworfen) –
    // für Code-Nachrichten wie für Anforderungen ohne Code.
    const ohneCode = await nachricht('FREIGABE_ANGEFORDERT');
    await melde(ohneCode, 'ABGELAUFEN');
    const offen = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(offen.nachrichten.map((n) => n.id)).not.toContain(id);
    expect(offen.nachrichten.map((n) => n.id)).not.toContain(ohneCode);
    expect(await zeile(id)).toMatchObject({
      verworfenAm: null,
      unzustellbarGrund: 'KEIN_PORTALZUGANG',
    });
    expect(await zeile(ohneCode)).toMatchObject({
      verworfenAm: null,
      unzustellbarGrund: 'ABGELAUFEN',
    });
    const ev = await audit(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      aktion: 'tcms.nachricht.unzustellbar',
      objektTyp: 'Nachricht',
      actorId: SYSTEM_ID,
      actorName: 'System: Zustellung kanzleikonsole',
      programmId: null,
    });
    // Genau diese Felder: Zweck, Empfänger-ID, Grund – kein Text, kein Betreff, kein Code.
    expect(ev[0]!.detail).toEqual({
      zweck: 'FREIGABE_CODE',
      empfaengerId: w.gv,
      grund: 'KEIN_PORTALZUGANG',
      systemakteur: true,
    });
    expect(JSON.stringify(ev)).not.toMatch(alsToken(CODE));
    expect(JSON.stringify(ev)).not.toContain('Bestätigungscode');
  });

  it('idempotent mit demselben Grund (ein Audit); anderer Grund → KONFLIKT, Grund bleibt', async () => {
    const id = await nachricht('FREIGABE_ANGEFORDERT');
    const erst = await melde(id, 'ABGELAUFEN');
    const vorher = await zeile(id);
    expect(await melde(id, 'ABGELAUFEN')).toEqual(erst);
    const f = await fehlerVon(melde(id, 'EMPFAENGER_UNGUELTIG'));
    expect(f.code).toBe('KONFLIKT');
    expect(await zeile(id)).toEqual(vorher);
    expect(await audit(id)).toHaveLength(1);
  });

  it('zugestellt und unzustellbar schließen sich aus (KONFLIKT in beide Richtungen)', async () => {
    const a = await nachricht();
    await zustellen(a);
    const f1 = await fehlerVon(melde(a, 'SONSTIGES'));
    expect(f1.code).toBe('KONFLIKT');
    expect(await zeile(a)).toMatchObject({ unzustellbarAm: null, unzustellbarGrund: null });
    const b = await nachricht();
    await melde(b, 'SONSTIGES');
    const f2 = await fehlerVon(zustellen(b));
    expect(f2.code).toBe('KONFLIKT');
    expect(await zeile(b)).toMatchObject({ zugestelltAm: null, unzustellbarGrund: 'SONSTIGES' });
    expect((await audit(a)).map((e) => e.aktion)).toEqual(['tcms.nachricht.zugestellt']);
    expect((await audit(b)).map((e) => e.aktion)).toEqual(['tcms.nachricht.unzustellbar']);
  });

  it('eine verworfene Nachricht kann noch als unzustellbar gemeldet werden (vorher abgeholt)', async () => {
    const id = await nachricht();
    await inWelt(w, (tx) =>
      tx.nachricht.update({
        where: { id },
        data: { verworfenAm: new Date(), code: null, text: '' },
      }),
    );
    expect(await melde(id, 'ABGELAUFEN')).toMatchObject({ unzustellbar: true });
    expect(await zeile(id)).toMatchObject({ unzustellbarGrund: 'ABGELAUFEN', zugestelltAm: null });
  });

  it('unbekannte ID und fremder Tenant → NICHT_GEFUNDEN; ungültige Eingabe → UNGUELTIG', async () => {
    const id = await nachricht();
    for (const unbekannt of ['ckunbekannt0000000000000', 'n123']) {
      expect((await fehlerVon(melde(unbekannt, 'SONSTIGES'))).code).toBe('NICHT_GEFUNDEN');
    }
    const fremd = system(w, randomUUID());
    const f = await fehlerVon(melde(id, 'SONSTIGES', fremd));
    expect(f.code).toBe('NICHT_GEFUNDEN');
    expect(f.message).toBe('NICHT_GEFUNDEN');
    for (const [nachrichtId, grund] of [
      [id, 'Postfach voll'],
      [id, ''],
      ['x y', 'SONSTIGES'],
      ['a'.repeat(65), 'SONSTIGES'],
    ]) {
      expect((await fehlerVon(melde(nachrichtId!, grund!))).code, `${nachrichtId} ${grund}`).toBe(
        'UNGUELTIG',
      );
    }
    expect(await zeile(id)).toMatchObject({ unzustellbarAm: null, code: CODE });
    expect(await audit(id)).toEqual([]);
  });

  it('nur der Systemakteur: Personen (auch Admins) → NICHT_GEFUNDEN, ohne Datenzugriff und Audit', async () => {
    const id = await nachricht();
    const vorher = await inWelt(w, (tx) => tx.auditEvent.count());
    const personen = [
      kanzlei(w, randomUUID(), null, { admin: true }),
      kanzlei(w, w.bt, w.mandantA, { admin: true, bt: true, zustaendig: true }),
      btA(w),
      hbA(w),
      kontakt(w, w.gv, w.mandantA),
    ];
    const alsSystem = (ctx: DienstKontext) => ctx as unknown as SystemKontext;
    for (const a of personen) {
      // Über den Systemdienst: schon vor der Transaktion abgewiesen.
      expect((await fehlerVon(melde(id, 'SONSTIGES', a))).code, a.art).toBe('NICHT_GEFUNDEN');
      // Untergeschobener Personenkontext: die Operation selbst weist ab – auch bei
      // ungültiger Eingabe kein 400, das die Operation verriete.
      for (const eingabe of [
        { nachrichtId: id, grund: 'SONSTIGES' },
        { nachrichtId: 'x y', grund: 'frei' },
      ]) {
        const fehler = await fehlerVon(
          im(a, (ctx) => meldeNachrichtUnzustellbar(alsSystem(ctx), eingabe as never)),
        );
        expect(fehler.code, `${a.art} ${eingabe.nachrichtId}`).toBe('NICHT_GEFUNDEN');
      }
    }
    expect(await zeile(id)).toMatchObject({ unzustellbarAm: null, code: CODE });
    expect(await inWelt(w, (tx) => tx.auditEvent.count())).toBe(vorher);
  });

  it('gleichzeitig zugestellt und unzustellbar: genau eine Meldung wirkt, die andere KONFLIKT', async () => {
    for (const reihenfolge of ['zuerst-zugestellt', 'zuerst-unzustellbar'] as const) {
      const id = await nachricht();
      const laeufe = [
        () => zustellen(id) as Promise<unknown>,
        () => melde(id, 'EMPFAENGER_UNGUELTIG', system(w), zweite) as Promise<unknown>,
      ];
      const e = await gleichzeitig(
        w,
        reihenfolge === 'zuerst-zugestellt' ? laeufe : [...laeufe].reverse(),
      );
      expect(nurEinErfolg(e).fehlerCode, reihenfolge).toBe('KONFLIKT');
      const z = await zeile(id);
      // Genau ein Status gesetzt, Klartext geleert, genau ein Audit-Eintrag.
      expect([z.zugestelltAm !== null, z.unzustellbarAm !== null].filter(Boolean)).toHaveLength(1);
      expect(z.unzustellbarGrund === null).toBe(z.unzustellbarAm === null);
      expect(z).toMatchObject({ code: null, text: '' });
      expect(await audit(id)).toHaveLength(1);
    }
  });

  it('gleichzeitig zweimal unzustellbar mit demselben Grund: beide erfolgreich, ein Audit', async () => {
    const id = await nachricht();
    const e = await gleichzeitig(w, [
      () => melde(id, 'ABGELAUFEN'),
      () => melde(id, 'ABGELAUFEN', system(w), zweite),
    ]);
    expect(e.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await audit(id)).toHaveLength(1);
  });

  it('die Datenbank erzwingt Grund genau bei unzustellbar, Ausschluss und leeren Klartext', async () => {
    const roh = async (id: string, data: Record<string, unknown>) =>
      inWelt(w, (tx) => tx.nachricht.update({ where: { id }, data: data as never }));
    const leer = { code: null, text: '' };
    for (const [name, data] of [
      ['unzustellbar ohne Grund', { ...leer, unzustellbarAm: new Date() }],
      ['Grund ohne unzustellbar', { unzustellbarGrund: 'SONSTIGES' }],
      [
        'zugestellt und unzustellbar',
        {
          ...leer,
          zugestelltAm: new Date(),
          unzustellbarAm: new Date(),
          unzustellbarGrund: 'SONSTIGES',
        },
      ],
      [
        'unzustellbar mit Text',
        { code: null, unzustellbarAm: new Date(), unzustellbarGrund: 'SONSTIGES' },
      ],
      [
        'unzustellbar mit Code',
        { text: '', unzustellbarAm: new Date(), unzustellbarGrund: 'SONSTIGES' },
      ],
    ] as const) {
      const id = await nachricht();
      await expect(roh(id, data), name).rejects.toThrow(/violates check constraint/);
      expect(await zeile(id), name).toMatchObject({ unzustellbarAm: null, code: CODE });
    }
    // Zulässig: unzustellbar mit Grund, ohne Klartext (auch die Code-Nachricht ohne Code).
    const ok = await nachricht();
    await roh(ok, { ...leer, unzustellbarAm: new Date(), unzustellbarGrund: 'SONSTIGES' });
    // Danach lässt sich die Zustellung nicht zusätzlich setzen.
    await expect(roh(ok, { zugestelltAm: new Date() })).rejects.toThrow(
      /Nachricht_zustellung_check/,
    );
    // Unbekannter Grund: nur das Enum.
    const x = await nachricht();
    await expect(
      inWelt(
        w,
        (tx) =>
          tx.$executeRaw`UPDATE "Nachricht" SET "unzustellbarAm" = now(), "unzustellbarGrund" = 'FREI', code = NULL, text = '' WHERE id = ${x}`,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });
});
