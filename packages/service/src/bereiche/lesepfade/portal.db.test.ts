// =============================================================================
// Portal-Übersicht gegen PostgreSQL (DB_TESTS=1, Demo-Seed): nur
// Mandantenkontakte mit aktiver Rolle beim eigenen Mandanten; Mitarbeitende
// nur Eigenes (auch in Zählern); keine Kanzlei-Interna im Vertrag.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortalUebersichtAntwortSchema, type PortalUebersichtEingabe } from '@tcms/contract';
import { mitTenant, type Prisma } from '@tcms/db';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { DEMODATEN_FRIST_MS, sperreDemodaten } from '../../__tests__/demodaten-sperre';
import { listeKontrollaufgaben } from '../durchfuehrung/lesen';
import { ladePortalUebersicht } from './portal';
import { fehlerVon, im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const T = DEMO_IDS.talwind;
const lade = (a: Parameters<typeof im>[0], mandantId: string = T) =>
  im(a, (ctx) => ladePortalUebersicht(ctx, { mandantId }));

describe.skipIf(!AKTIV)('Portal-Übersicht gegen PostgreSQL', () => {
  let entsperren: (() => Promise<void>) | undefined;

  // Andere Testläufe auf derselben Wegwerf-DB deaktivieren Sabines Rolle (Web-Actions).
  beforeAll(async () => {
    entsperren = await sperreDemodaten();
    await mitTenant(DEMO_TENANT_ID, (tx) =>
      tx.mandantKontaktRolle.updateMany({
        where: { mandantId: T, kontaktId: DEMO_IDS.sabine },
        data: { aktiv: true },
      }),
    );
  }, DEMODATEN_FRIST_MS);
  afterAll(async () => {
    await entsperren?.();
  });

  it('GV: alle Mandantenaufgaben und Meldungen, vertragsgemäß ohne Kanzlei-Interna', async () => {
    const u = await lade(kontakt(DEMO_IDS.jana, T));
    expect(PortalUebersichtAntwortSchema.parse(u)).toEqual(u);
    expect(u.rechte).toEqual({ portalLesen: true, gesetzlicherVertreter: true, melden: true });
    expect(u.aufgaben.length).toBeGreaterThan(0);
    expect(u.aufgaben.some((a) => !a.eigene)).toBe(true);
    expect(u.meldungen.length).toBeGreaterThanOrEqual(2);
    expect(u.programm?.aktivePhase).toBeGreaterThan(0);
    // Der strenge Vertrag kennt keine Kanzlei-Interna (Nettoklassen, Feststellungen, §-153).
    expect(Object.keys(u).sort()).toEqual(
      ['aufgaben', 'heute', 'mandant', 'meldungen', 'programm', 'rechte'].sort(),
    );
  });

  it('Mitarbeitende: nur eigene Aufgaben und Meldungen, auch in den Zählern', async () => {
    const gv = await lade(kontakt(DEMO_IDS.jana, T));
    const ma = await lade(kontakt(DEMO_IDS.sabine, T));
    expect(ma.rechte).toEqual({ portalLesen: false, gesetzlicherVertreter: false, melden: false });
    expect(ma.aufgaben.length).toBeGreaterThan(0);
    expect(ma.aufgaben.every((a) => a.eigene)).toBe(true);
    expect(ma.aufgaben.length).toBeLessThanOrEqual(gv.aufgaben.length);
    expect(ma.meldungen).toEqual([]);
    const summe = (u: typeof gv) => (u.programm?.monate ?? []).reduce((s, m) => s + m.offen, 0);
    expect(summe(ma)).toBeLessThanOrEqual(summe(gv));
  });

  it('Mitarbeitende ohne Zuweisung: keine fremden Aufgaben, Meldungen oder offenen Monate', async () => {
    const neu = randomUUID();
    await mitTenant(DEMO_TENANT_ID, (tx) =>
      tx.mandantKontaktRolle.create({
        data: { mandantId: T, kontaktId: neu, rolle: 'MITARBEITER' },
      }),
    );
    try {
      const gv = await lade(kontakt(DEMO_IDS.jana, T));
      const ma = await lade(kontakt(neu, T));
      expect(gv.aufgaben.length).toBeGreaterThan(0);
      expect(gv.programm!.monate.some((m) => m.offen > 0)).toBe(true);
      expect(ma.aufgaben).toEqual([]);
      expect(ma.meldungen).toEqual([]);
      expect(ma.programm!.monate.every((m) => m.offen === 0)).toBe(true);
      // Phase und Zeitraum sieht jede Person mit aktiver Rolle.
      expect(ma.programm!.aktivePhase).toBe(gv.programm!.aktivePhase);
    } finally {
      await mitTenant(DEMO_TENANT_ID, (tx) =>
        tx.mandantKontaktRolle.updateMany({ where: { kontaktId: neu }, data: { aktiv: false } }),
      );
    }
  });

  it('eine Regel mit der Aufgabenliste (P2): dieselben Aufgaben, Art und eigene; bestätigte nicht mehr offen', async () => {
    // Nur gespeichert offene Durchführungen: Abgeschlossene mit Zeitpunkt nach der Testuhr
    // (Seed relativ zum echten Datum) wären nur für den Kontext offen – mit echter Uhr gibt
    // es sie nicht, und P2 liest gespeichert abgeschlossene gar nicht erst.
    const offen = new Set(
      (
        await mitTenant(DEMO_TENANT_ID, (t) =>
          t.durchfuehrung.findMany({
            where: {
              kontrolle: { programm: { mandantId: T } },
              status: {
                in: ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN', 'ZUR_GEGENZEICHNUNG'],
              },
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
        )
      ).map((x) => x.id),
    );
    const p1 = async (a: Parameters<typeof im>[0]) =>
      (await lade(a)).aufgaben
        .filter((x) => offen.has(x.durchfuehrungId))
        .map((x) => `${x.durchfuehrungId} ${x.art} ${x.eigene}`)
        .sort();
    const p2 = async (a: Parameters<typeof im>[0]) =>
      (await im(a, (ctx) => listeKontrollaufgaben(ctx, { mandantId: T }))).aufgaben
        .map((x) => `${x.id} ${x.art} ${x.eigene}`)
        .sort();
    const personen = [kontakt(DEMO_IDS.jana, T), kontakt(DEMO_IDS.sabine, T)];
    expect((await p2(personen[0]!)).length).toBeGreaterThan(0);
    for (const a of personen) expect(await p1(a)).toEqual(await p2(a));

    // Bestätigung beim Mandanten (K-EC-23): eingereicht → Aufgabe BESTAETIGEN; nach der
    // Bestätigung (Status bleibt bis zum Abschluss der Kanzlei) keine offene Aufgabe mehr.
    const d = await mitTenant(DEMO_TENANT_ID, (tx) =>
      tx.durchfuehrung.findFirstOrThrow({
        where: {
          kontrolle: { code: 'K-EC-23', programm: { mandantId: T } },
          kontrolleStand: { gegenzeichnungMandant: true },
          status: 'IN_DURCHFUEHRUNG',
        },
        orderBy: [{ faelligAm: 'asc' }, { id: 'asc' }],
      }),
    );
    const setze = (data: Prisma.DurchfuehrungUpdateInput) =>
      mitTenant(DEMO_TENANT_ID, (t) => t.durchfuehrung.update({ where: { id: d.id }, data }));
    const art = async (a: Parameters<typeof im>[0]) =>
      (await lade(a)).aufgaben.find((x) => x.durchfuehrungId === d.id)?.art ?? null;
    try {
      await setze({
        status: 'ZUR_GEGENZEICHNUNG',
        eingereichtAm: new Date('2026-10-15T09:00:00Z'),
      });
      expect(await art(personen[0]!)).toBe('BESTAETIGEN');
      for (const a of personen) expect(await p1(a)).toEqual(await p2(a));
      await setze({ mandantBestaetigtVon: DEMO_IDS.jana });
      expect(await art(personen[0]!)).toBeNull();
      for (const a of personen) expect(await p1(a)).toEqual(await p2(a));
    } finally {
      await setze({
        status: d.status,
        eingereichtAm: d.eingereichtAm,
        mandantBestaetigtVon: d.mandantBestaetigtVon,
      });
    }
  });

  it('fremder Mandant, ohne Rolle, deaktivierte Rolle, fremder Tenant: NICHT_GEFUNDEN', async () => {
    const faelle: (() => Promise<unknown>)[] = [
      () => lade(kontakt(DEMO_IDS.jana, T), DEMO_IDS.seestern),
      () => lade(kontakt(DEMO_IDS.clara, DEMO_IDS.seestern), T),
      () => lade(kontakt(randomUUID(), T)),
      () => lade(kontakt(DEMO_IDS.jana, T, randomUUID())),
    ];
    for (const f of faelle) expect((await fehlerVon(f())).code).toBe('NICHT_GEFUNDEN');

    await mitTenant(DEMO_TENANT_ID, (tx) =>
      tx.mandantKontaktRolle.updateMany({
        where: { mandantId: T, kontaktId: DEMO_IDS.sabine },
        data: { aktiv: false },
      }),
    );
    try {
      expect((await fehlerVon(lade(kontakt(DEMO_IDS.sabine, T)))).code).toBe('NICHT_GEFUNDEN');
    } finally {
      await mitTenant(DEMO_TENANT_ID, (tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { mandantId: T, kontaktId: DEMO_IDS.sabine },
          data: { aktiv: true },
        }),
      );
    }
  });

  it('Kanzleipersonen und ungültige Eingaben', async () => {
    const k = await fehlerVon(lade(kanzlei(DEMO_IDS.anna, T, { admin: true, zustaendig: true })));
    expect([k.code, k.grund]).toEqual(['NICHT_BERECHTIGT', 'PARTEI']);
    const f = await fehlerVon(
      im(kontakt(DEMO_IDS.jana, T), (ctx) =>
        ladePortalUebersicht(ctx, { mandantId: T, x: 1 } as unknown as PortalUebersichtEingabe),
      ),
    );
    expect(f.code).toBe('UNGUELTIG');
  });
});
