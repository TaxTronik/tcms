// =============================================================================
// Länder-Monitor gegen PostgreSQL (DB_TESTS=1): Rechte, Mandanten- und
// Tenant-Trennung, Historie (neue Stände statt Änderung), ausgelöste
// Ereignisse (T-02, T-04), TS-05 (gleichzeitige Aufnahme desselben Landes →
// genau eine) und keine vertraulichen Feststellungen im Länderbezug.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import { LaenderSchema, type Akteur, type LandEingabe } from '@tcms/contract';
import { fuegeLandHinzu, ladeLaender, speichereLandStaende } from './laender';
import {
  akteure,
  baueWelt,
  fehlerVon,
  genauEinerKonflikt,
  gleichzeitig,
  im,
  inTenant,
  neueFeststellung,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

const land = (code: string, x: Partial<LandEingabe> = {}): LandEingabe => ({
  land: code,
  fernverkaeufeLfdEur: 1200,
  fernverkaeufeVorjahrEur: 800,
  lagerSeit: null,
  oss: true,
  lokaleUstNr: false,
  zmRelevant: false,
  steuersaetzeGeprueftAm: '2026-09-30',
  ...x,
});

describe.skipIf(!AKTIV)('Länder-Monitor gegen PostgreSQL', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
  });

  const hinzu = (a: Akteur, l: LandEingabe, datenstand = '2026-10-01', mandantId = w.mandant) =>
    im(a, (ctx) => fuegeLandHinzu(ctx, { mandantId, datenstand, land: l }));
  const staende = (a: Akteur, laender: LandEingabe[], datenstand = '2026-10-10') =>
    im(a, (ctx) => speichereLandStaende(ctx, { mandantId: w.mandant, datenstand, laender }));

  it('Rechte: ohne Bezug, fremder Mandant/Tenant, Mandantenkontakte → NICHT_GEFUNDEN; Lesende → NICHT_BERECHTIGT', async () => {
    for (const a of [
      A.ohneBezug,
      A.fremdBezug,
      A.fremdTenant,
      A.leerTenant,
      A.gv,
      A.tcb,
      A.ma,
      A.ohneRolle,
    ]) {
      expect((await fehlerVon(hinzu(a, land('AT')))).code, a.id).toBe('NICHT_GEFUNDEN');
      expect((await fehlerVon(staende(a, [land('AT')]))).code).toBe('NICHT_GEFUNDEN');
      expect(
        (await fehlerVon(im(a, (ctx) => ladeLaender(ctx, { mandantId: w.mandant })))).code,
      ).toBe('NICHT_GEFUNDEN');
    }
    expect((await fehlerVon(hinzu(A.leser, land('AT')))).code).toBe('NICHT_BERECHTIGT');
    expect((await fehlerVon(staende(A.leser, [land('AT')]))).code).toBe('NICHT_BERECHTIGT');
    // Programm eines anderen Mandanten bleibt unberührt.
    expect(
      await inTenant(w, (tx) => tx.landStand.count({ where: { programmId: w.programmFremd } })),
    ).toBe(0);
  });

  it('Land hinzufügen: EU außer DE, einmalig, mit Audit; neues Lager löst T-02 aus', async () => {
    expect((await fehlerVon(hinzu(A.hb, land('DE')))).code).toBe('UNGUELTIG');
    expect((await fehlerVon(hinzu(A.hb, land('CH')))).code).toBe('UNGUELTIG');
    const r = await hinzu(A.hb, land('CZ', { lagerSeit: '2026-09' }));
    expect(r.staende).toHaveLength(1);
    expect(r.ereignisse).toHaveLength(1);
    const e = await inTenant(w, (tx) =>
      tx.ereignis.findFirstOrThrow({ where: { nummer: r.ereignisse[0]! } }),
    );
    expect(e).toMatchObject({ typ: 'T-02', programmId: w.programm, gemeldetVon: w.p.hb });
    expect(
      await inTenant(w, (tx) =>
        tx.auditEvent.count({
          where: { objektId: r.staende[0]!.id, aktion: 'tcms.laender.land_hinzugefuegt' },
        }),
      ),
    ).toBe(1);
    expect((await fehlerVon(hinzu(A.hb, land('CZ')))).code).toBe('KONFLIKT');
  });

  it('TS-05: dasselbe Land gleichzeitig hinzufügen → genau einmal', async () => {
    const r = await gleichzeitig(
      () => hinzu(A.hb, land('PL')),
      () => hinzu(A.zbt, land('PL')),
    );
    expect(genauEinerKonflikt(r)).toBe(true);
    expect(
      await inTenant(w, (tx) =>
        tx.landStand.count({ where: { programmId: w.programm, land: 'PL' } }),
      ),
    ).toBe(1);
  });

  it('Stände erfassen: neuer Stand, alter bleibt; nur Länder im Monitor; Datum nicht in der Zukunft, nicht vor dem letzten Stand', async () => {
    await hinzu(A.hb, land('FR'));
    const vorher = await inTenant(w, (tx) =>
      tx.landStand.findMany({ where: { programmId: w.programm, land: 'FR' } }),
    );
    await staende(A.hb, [land('FR', { fernverkaeufeLfdEur: 2500.256 })]);
    const nachher = await inTenant(w, (tx) =>
      tx.landStand.findMany({
        where: { programmId: w.programm, land: 'FR' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(nachher).toHaveLength(vorher.length + 1);
    expect(Number(nachher.at(-1)!.fernverkaeufeLfdEur)).toBe(2500.26);
    expect(Number(nachher[0]!.fernverkaeufeLfdEur)).toBe(1200);
    expect((await fehlerVon(staende(A.hb, [land('IT')]))).code).toBe('KONFLIKT');
    expect((await fehlerVon(staende(A.hb, [land('FR')], '2026-10-17'))).code).toBe('UNGUELTIG');
    expect((await fehlerVon(staende(A.hb, [land('FR')], '2026-09-01'))).code).toBe('UNGUELTIG');
    expect((await fehlerVon(staende(A.hb, [land('FR', { lagerSeit: '2026-11' })]))).code).toBe(
      'UNGUELTIG',
    );
    expect((await fehlerVon(staende(A.hb, [land('FR', { fernverkaeufeLfdEur: 1e12 })]))).code).toBe(
      'UNGUELTIG',
    );
    expect((await fehlerVon(staende(A.hb, [land('FR'), land('FR')]))).code).toBe('UNGUELTIG');
  });

  it('Schwellenwechsel der EU-Fernverkäufe löst T-04 aus', async () => {
    await hinzu(A.zbt, land('NL', { fernverkaeufeLfdEur: 100 }));
    const r = await staende(A.zbt, [land('NL', { fernverkaeufeLfdEur: 20_000 })]);
    const typen = await inTenant(w, (tx) =>
      tx.ereignis.findMany({ where: { nummer: { in: r.ereignisse } }, select: { typ: true } }),
    );
    expect(typen.map((t) => t.typ)).toContain('T-04');
  });

  it('Lesen: Historie zum Stichtag, keine vertraulichen Feststellungen; vertragskonform', async () => {
    await hinzu(A.hb, land('SK'));
    await neueFeststellung(w, { titel: 'SK Registrierung fehlt', vertraulich: false });
    await neueFeststellung(w, { titel: 'SK geheime Selbstanzeige', vertraulich: true });
    const l = await im(A.leser, (ctx) => ladeLaender(ctx, { mandantId: w.mandant }));
    expect(LaenderSchema.parse(l)).toEqual(l);
    expect(l.historie.find((h) => h.land === 'SK')?.staende).toHaveLength(1);
    const sk = l.feststellungen.find((x) => x.land === 'SK')?.eintraege ?? [];
    expect(sk.map((x) => x.titel)).toEqual(['SK Registrierung fehlt']);
    expect(JSON.stringify(l)).not.toMatch(/geheime/);
    const alt = await im(A.leser, (ctx) =>
      ladeLaender(ctx, { mandantId: w.mandant, stand: '2026-09-01' }),
    );
    expect(alt.historie).toEqual([]);
    expect(alt.historisch).toBe(true);
  });
});
