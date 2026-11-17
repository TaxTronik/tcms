// =============================================================================
// Länder-Monitor gegen PostgreSQL (DB_TESTS=1): Rechte, Mandanten- und
// Tenant-Trennung, Historie (neue Stände statt Änderung), ausgelöste
// Ereignisse (T-02, T-04), TS-05 (gleichzeitige Aufnahme desselben Landes →
// genau eine) und keine vertraulichen Feststellungen im Länderbezug.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { LaenderSchema, type Akteur, type LandEingabe } from '@tcms/contract';
import { ladeKontext } from '../../kern/tcms-kontext';
import { fuegeLandHinzu, ladeLaender, speichereLandStaende } from './laender';
import {
  akteure,
  baueWelt,
  eindeutig,
  fehlerVon,
  genauEinerKonflikt,
  kanzlei,
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
  /** ID des jüngsten Stands eines Landes (wie `historie[].staende[0].id`), sonst ein Platzhalter. */
  const juengster = async (code: string) => {
    const s = await inTenant(w, (tx) =>
      tx.landStand.findFirst({
        where: { programmId: w.programm, land: code },
        orderBy: [{ stand: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      }),
    );
    return s?.id ?? 'cunbekannt000000000000000';
  };
  /** Neue Stände auf dem jeweils jüngsten Stand (ohne `gesehenerStandId` aus der Datenbank). */
  const staende = async (
    a: Akteur,
    laender: (LandEingabe & { gesehenerStandId?: string })[],
    datenstand = '2026-10-10',
  ) => {
    const mitStand = await Promise.all(
      laender.map(async (l) => ({
        ...l,
        gesehenerStandId: l.gesehenerStandId ?? (await juengster(l.land)),
      })),
    );
    return im(a, (ctx) =>
      speichereLandStaende(ctx, { mandantId: w.mandant, datenstand, laender: mitStand }),
    );
  };

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
    for (const p of [hinzu(A.leser, land('AT')), staende(A.leser, [land('AT')])]) {
      expect(await fehlerVon(p)).toMatchObject({ code: 'NICHT_BERECHTIGT', grund: 'BEARBEITEN' });
    }
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

  it('TS-05: Stände nur auf dem gesehenen Stand – ein inzwischen erfasster wird nicht ungesehen überschrieben', async () => {
    await hinzu(A.hb, land('EE'));
    const gesehen = await juengster('EE');
    // A und B sehen denselben Stand; A speichert zuerst.
    await staende(A.hb, [
      { ...land('EE', { fernverkaeufeLfdEur: 700 }), gesehenerStandId: gesehen },
    ]);
    const x = await fehlerVon(
      staende(A.zbt, [{ ...land('EE', { fernverkaeufeLfdEur: 550 }), gesehenerStandId: gesehen }]),
    );
    expect(x.code).toBe('KONFLIKT');
    const alle = await inTenant(w, (tx) =>
      tx.landStand.findMany({ where: { programmId: w.programm, land: 'EE' } }),
    );
    expect(alle.map((s) => Number(s.fernverkaeufeLfdEur)).sort((a, b) => a - b)).toEqual([
      700, 1200,
    ]);
    // Auf dem neuen Stand gelingt es; „jüngster Stand“ ist der zuletzt geschriebene.
    await staende(A.zbt, [land('EE', { fernverkaeufeLfdEur: 550 })]);
    const l = await im(A.zbt, (ctx) => ladeLaender(ctx, { mandantId: w.mandant }));
    expect(l.historie.find((h) => h.land === 'EE')?.staende[0]?.fernverkaeufeLfdEur).toBe(550);
  });

  it('Schwellenwechsel der EU-Fernverkäufe löst T-04 aus', async () => {
    await hinzu(A.zbt, land('NL', { fernverkaeufeLfdEur: 100 }));
    const r = await staende(A.zbt, [land('NL', { fernverkaeufeLfdEur: 20_000 })]);
    const typen = await inTenant(w, (tx) =>
      tx.ereignis.findMany({ where: { nummer: { in: r.ereignisse } }, select: { typ: true } }),
    );
    expect(typen.map((t) => t.typ)).toContain('T-04');
  });

  it('Lieferschwelle genau 10.000,00 €: auf den Cent summiert, nicht überschritten (Befund 83)', async () => {
    // Eigene Welt: nur diese drei EU-Länder. Als Gleitkommasumme 10000.000000000002.
    const v = await baueWelt();
    const B = akteure(v);
    for (const code of ['AT', 'FR', 'PL'])
      await im(B.hb, (ctx) =>
        fuegeLandHinzu(ctx, {
          mandantId: v.mandant,
          datenstand: '2026-10-01',
          land: land(code, { fernverkaeufeLfdEur: 100, fernverkaeufeVorjahrEur: 0 }),
        }),
      );
    const gesehen = async (code: string) =>
      (
        await inTenant(v, (tx) =>
          tx.landStand.findFirstOrThrow({
            where: { land: code, programm: { mandantId: v.mandant } },
            orderBy: [{ stand: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
          }),
        )
      ).id;
    const r = await im(B.hb, async (ctx) =>
      speichereLandStaende(ctx, {
        mandantId: v.mandant,
        datenstand: '2026-10-10',
        laender: [
          {
            ...land('AT', { fernverkaeufeLfdEur: 4_885.13, fernverkaeufeVorjahrEur: 0 }),
            gesehenerStandId: await gesehen('AT'),
          },
          {
            ...land('FR', { fernverkaeufeLfdEur: 3_513.34, fernverkaeufeVorjahrEur: 0 }),
            gesehenerStandId: await gesehen('FR'),
          },
          {
            ...land('PL', { fernverkaeufeLfdEur: 1_601.53, fernverkaeufeVorjahrEur: 0 }),
            gesehenerStandId: await gesehen('PL'),
          },
        ],
      }),
    );
    const t04 = await inTenant(v, (tx) =>
      tx.ereignis.findMany({
        where: { nummer: { in: r.ereignisse }, typ: 'T-04' },
        select: { titel: true },
      }),
    );
    expect(t04.map((e) => e.titel)).toEqual([
      expect.stringMatching(/^Lieferschwelle 100 % erreicht/),
    ]);
    const k = await im(B.hb, (ctx) => ladeKontext(ctx, { mandantId: v.mandant }));
    expect(k?.fernverkaeufeLfd).toBe(10_000);
    expect(k?.schwelle.status).toBe('WARNUNG');
  });

  it('Lesen: Historie zum Stichtag, keine vertraulichen Feststellungen; vertragskonform', async () => {
    await hinzu(A.hb, land('SK'));
    await hinzu(A.hb, land('IT'));
    const mitErklaerung = async (titel: string, vertraulich: boolean, landCode?: string) => {
      const f = await neueFeststellung(w, { titel, vertraulich });
      if (landCode) {
        await inTenant(w, (tx) =>
          tx.betroffeneErklaerung.create({
            data: { feststellungId: f.id, steuerart: 'USt', land: landCode, zeitraum: '2026' },
          }),
        );
      }
      return f;
    };
    await mitErklaerung('Registrierung in der Slowakei fehlt', false, 'SK');
    await mitErklaerung('Selbstanzeige geheime Sache', true, 'SK');
    // Ländercode nur im Titel (gängige Abkürzung): kein Länderbezug.
    await mitErklaerung('Ausfall der IT-Schnittstelle zum Shop', false);
    const l = await im(A.leser, (ctx) => ladeLaender(ctx, { mandantId: w.mandant }));
    expect(LaenderSchema.parse(l)).toEqual(l);
    expect(l.historie.find((h) => h.land === 'SK')?.staende).toHaveLength(1);
    const sk = l.feststellungen.find((x) => x.land === 'SK')?.eintraege ?? [];
    expect(sk.map((x) => x.titel)).toEqual(['Registrierung in der Slowakei fehlt']);
    expect(l.feststellungen.find((x) => x.land === 'IT')).toBeUndefined();
    expect(JSON.stringify(l)).not.toMatch(/geheime/);
    const alt = await im(A.leser, (ctx) =>
      ladeLaender(ctx, { mandantId: w.mandant, stand: '2026-09-01' }),
    );
    expect(alt.historie).toEqual([]);
    expect(alt.historisch).toBe(true);
  });

  it('Länderbezüge: aktive Risiken mit Grund, Kontrollen daran, Ereignisse, die das Land nennen', async () => {
    const aktivAb = new Date('2026-01-01T00:00:00Z');
    const ereignis = (titel: string, beschreibung: string, gemeldetAm: string) =>
      inTenant(w, (tx) =>
        tx.ereignis.create({
          data: {
            programmId: w.programm,
            nummer: eindeutig('E'),
            typ: 'SONST',
            titel,
            beschreibung,
            quelle: 'MANUELL',
            gemeldetVon: w.p.hb,
            gemeldetAm: new Date(gemeldetAm),
            ereignisDatum: new Date(gemeldetAm),
            status: 'NEU',
          },
          select: { id: true },
        }),
      );
    const [code, name, fremd, spaet] = await Promise.all([
      // Nur der Code (könnte eine Abkürzung sein): kein Bezug.
      ereignis('Neue Rechnungsregeln LU', 'Hinweis der Steuerverwaltung', '2026-10-05T09:00:00Z'),
      ereignis('Hinweis', 'Lager in Luxemburg geplant', '2026-10-06T09:00:00Z'),
      ereignis(
        'LUX-Anbindung',
        'Schnittstelle LUXOR, Luxemburgerin im Team',
        '2026-10-07T09:00:00Z',
      ),
      ereignis('Luxemburg nach dem Stichtag', 'später', '2026-10-15T09:00:00Z'),
    ]);
    await inTenant(w, async (tx) => {
      // EC-UST-02 (Steuersätze) aktiv mit Stand und Kontrolle K-EC-02 daran.
      await tx.risikoStand.create({
        data: {
          risikoId: w.risiko,
          version: 1,
          titel: 'Falscher Steuersatz',
          fehlerquelle: 'Stammdaten',
          folge: 'Nachzahlung',
          normanker: [],
          s: 'M',
          w: 'MOEGLICH',
          r: 2,
          gt: 'FF',
          modell: 'test',
          gueltigAb: aktivAb,
        },
      });
      await tx.risikoKontrolle.create({ data: { risikoId: w.risiko, kontrolleId: w.kontrolle } });
      // EC-UST-03 (OSS) passt zum Land, ist aber erst 2027 aktiv: kein Bezug.
      const spaeter = await tx.risiko.create({
        data: {
          programmId: w.programm,
          code: 'EC-UST-03',
          aktivAb: new Date('2027-01-01T00:00:00Z'),
          entscheidung: 'UEBERNOMMEN',
        },
      });
      await tx.risikoStand.create({
        data: {
          risikoId: spaeter.id,
          version: 1,
          titel: 'OSS',
          fehlerquelle: 'Meldung',
          folge: 'Nachzahlung',
          normanker: [],
          s: 'M',
          w: 'MOEGLICH',
          r: 2,
          gt: 'FF',
          modell: 'test',
          gueltigAb: new Date('2027-01-01T00:00:00Z'),
        },
      });
    });
    // Länderstand LU (OSS, ohne Lager), am 01.10. erfasst – auch im Stand vom 10.10. sichtbar.
    await inTenant(w, (tx) =>
      tx.landStand.create({
        data: {
          programmId: w.programm,
          land: 'LU',
          fernverkaeufeLfdEur: 1200,
          fernverkaeufeVorjahrEur: 800,
          lagerSeit: null,
          oss: true,
          lokaleUstNr: false,
          zmRelevant: false,
          steuersaetzeGeprueftAm: new Date('2026-09-30T00:00:00Z'),
          stand: new Date('2026-10-01T00:00:00Z'),
          quelle: 'MANUELL',
          erfasstVon: w.p.hb,
          createdAt: new Date('2026-10-01T09:00:00Z'),
        },
      }),
    );
    const lies = (stand?: string) =>
      im(A.leser, (ctx) => ladeLaender(ctx, { mandantId: w.mandant, ...(stand ? { stand } : {}) }));
    const l = await lies();
    expect(LaenderSchema.parse(l)).toEqual(l);
    const lu = l.bezuege.find((b) => b.land === 'LU')!;
    expect(lu.risiken).toEqual([{ code: 'EC-UST-02', grund: 'Steuersätze in Luxemburg' }]);
    expect(lu.kontrollen).toEqual(['K-EC-02']);
    expect(lu.ereignisse.sort()).toEqual([name.id, spaet.id].sort());
    expect(lu.ereignisse).not.toContain(fremd.id);
    expect(lu.ereignisse).not.toContain(code.id);
    // Jedes Land im Monitor hat genau einen Eintrag.
    expect(l.bezuege.map((b) => b.land).sort()).toEqual(l.historie.map((h) => h.land).sort());
    // Stichtag: Ereignisse erst bis zum Ende des Stichtags.
    const frueher = (await lies('2026-10-10')).bezuege.find((b) => b.land === 'LU')!;
    expect(frueher.ereignisse).toEqual([name.id]);

    // RT-01: Eine vertrauliche Feststellung zum Land ändert keine Ausgabe – weder
    // `feststellungen` noch die Bezüge (kein Inhalt, keine Zahl, kein Orakel).
    const vorher = await lies();
    const geheim = await neueFeststellung(w, {
      titel: 'LU Betriebsstätte geheim',
      vertraulich: true,
    });
    await inTenant(w, (tx) =>
      tx.betroffeneErklaerung.create({
        data: { feststellungId: geheim.id, steuerart: 'USt', land: 'LU', zeitraum: '2026' },
      }),
    );
    const nachher = await lies();
    expect(nachher).toEqual(vorher);
    expect(JSON.stringify(nachher)).not.toContain(geheim.id);
  });

  it('rechte.bearbeiten = Ergebnis der Schreiboperation (Stände erfassen); historisch und ohne Programm false', async () => {
    await hinzu(A.hb, land('MT'), '2026-10-01');
    const gesehen = new Set<boolean>();
    for (const [wer, a] of Object.entries({
      zbt: A.zbt,
      admin: A.admin,
      adminOhneBt: A.adminOhneBt,
      hb: A.hb,
      leser: A.leser,
    })) {
      const l = await im(a, (ctx) => ladeLaender(ctx, { mandantId: w.mandant }));
      let tatsaechlich = true;
      try {
        await staende(a, [land('MT')], '2026-10-16');
      } catch (e) {
        expect(await fehlerVon(Promise.reject(e))).toMatchObject({
          code: 'NICHT_BERECHTIGT',
          grund: 'BEARBEITEN',
        });
        tatsaechlich = false;
      }
      expect(l.rechte.bearbeiten, wer).toBe(tatsaechlich);
      gesehen.add(tatsaechlich);
    }
    expect(gesehen).toEqual(new Set([true, false]));
    const alt = await im(A.zbt, (ctx) =>
      ladeLaender(ctx, { mandantId: w.mandant, stand: '2026-09-01' }),
    );
    expect(alt.rechte).toEqual({ bearbeiten: false });
    // Mandant ohne Programm: nichts zu erfassen (Schreiben → NICHT_GEFUNDEN).
    const ohne = randomUUID();
    await inTenant(w, (tx) =>
      tx.mandant.create({ data: { id: ohne, name: 'Ohne Programm', rechtsform: 'KapG' } }),
    );
    const zbtOhne = kanzlei(w.tenant, w.p.zbt, ohne, { bt: true, zustaendig: true });
    const leer = await im(zbtOhne, (ctx) => ladeLaender(ctx, { mandantId: ohne }));
    expect(leer).toMatchObject({ programmId: null, rechte: { bearbeiten: false } });
    expect(
      (
        await fehlerVon(
          im(zbtOhne, (ctx) =>
            fuegeLandHinzu(ctx, { mandantId: ohne, datenstand: '2026-10-01', land: land('MT') }),
          ),
        )
      ).code,
    ).toBe('NICHT_GEFUNDEN');
  });
});
