// =============================================================================
// Endpunkte „risiken-kontrollen" über `erzeugeApp` mit echter Datenbank
// (DB_TESTS=1, DATABASE_URL = tcms_app) und signierten Akteursbestätigungen.
// Je Endpunkt: Erfolg, falscher Mandant (404), Mandantenperson auf dem
// Staff-Endpunkt (404), ungültiger Body bzw. Query (400); dazu Stichtag auf
// schreibenden Endpunkten (400, TS-07), fachliche Fehler (403/409) und
// Antwortformen nach Contract-Schema.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FreigabeSchrittErgebnisSchema,
  KontrolleDetailSchema,
  KontrolleGeaendertSchema,
  KontrollenListeSchema,
  NeuBewertungErgebnisSchema,
  ProfilDatenSchema,
  ProfilGeaendertSchema,
  RisikenListeSchema,
  RisikoakzeptanzAngefordertSchema,
  RisikoAufgenommenSchema,
  RisikoDetailSchema,
  RisikoZurueckgewiesenSchema,
  UebersteuerungBeantragtSchema,
  UebersteuerungEntschiedenSchema,
  antwortSchema,
  bodySha256,
  type AkteurClaims,
  type KontrollenListe,
  type RisikenListe,
} from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import type { z } from 'zod';
import type { Datenzugriff } from '../app';
import type { Routen } from '../routen';
import { registriereRisikenKontrollen } from '../routen/risiken-kontrollen';
import { aufbau, bestaetigtSenden, claims, json } from './hilfen';
// Testaufbau des Service-Bereichs (eigene, zufällige Tenants; nur in Tests).
import {
  BEGRUENDUNG,
  legeProgrammAn,
  type Programm,
} from '../../../../packages/service/src/bereiche/risiken-kontrollen/__tests__/fixture';

const AKTIV = process.env['DB_TESTS'] === '1';

const daten: Datenzugriff<Tx> = {
  mitTenant: (tenantId, fn) => mitTenant(tenantId, fn),
  ping: async () => {},
};

describe.skipIf(!AKTIV)('API risiken-kontrollen gegen PostgreSQL', () => {
  const tenant = randomUUID();
  let a: Programm;
  let b: Programm;
  let app: ReturnType<typeof aufbau>['app'];

  beforeAll(async () => {
    a = await legeProgrammAn(tenant);
    b = await legeProgrammAn(tenant);
    app = aufbau({
      daten: daten as Datenzugriff,
      routen: (r) => registriereRisikenKontrollen(r as unknown as Routen<Tx>),
    }).app;
  }, 120_000);

  type Rolle = 'bt' | 'hb' | 'leser' | 'kontakt';
  /** Claims der Personen von Programm `x`, Mandantenbezug auf `cli` (Standard: eigener Mandant). */
  function wer(x: Programm, rolle: Rolle, cli = x.mandantId): Partial<AkteurClaims> {
    if (rolle === 'kontakt') {
      return {
        knd: 'MANDANT',
        sub: x.personen.gv,
        tnt: x.tenantId,
        rol: undefined,
        cli: { id: cli, bt: false, hb: false },
      };
    }
    return {
      knd: 'KANZLEI',
      tnt: x.tenantId,
      sub: x.personen[rolle],
      rol: { adm: false, bt: rolle === 'bt' },
      cli: { id: cli, bt: rolle === 'bt', hb: rolle === 'hb' },
    };
  }

  async function rufe(
    methode: 'GET' | 'POST',
    ziel: string,
    wer: Partial<AkteurClaims>,
    body?: unknown,
  ) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const c = claims({
      ...wer,
      req: { m: methode, p: ziel, b: bodySha256(new TextEncoder().encode(text ?? '')) },
    });
    if (c.knd === 'MANDANT') delete c.rol;
    const r = await bestaetigtSenden(app, {
      methode,
      ziel,
      roheClaims: c,
      ...(text === undefined ? {} : { body: text }),
    });
    return { status: r.status, antwort: await json(r) };
  }

  /** Prüft den Umschlag und die Daten streng gegen das Contract-Schema. */
  function erwarte<T extends z.ZodType>(schema: T, antwort: unknown): z.output<T> {
    const p = antwortSchema(schema).parse(antwort) as
      | { ok: true; daten: z.output<T> }
      | { ok: false; fehler: unknown };
    if (!p.ok) throw new Error(`Fehler statt Daten: ${JSON.stringify(p.fehler)}`);
    return p.daten;
  }

  const p = (x: Programm, rest: string) => `/v1/mandanten/${x.mandantId}${rest}`;

  /** Falscher Mandant (Pfad ≠ cli.id) und Mandantenperson: beide 404 ohne Detail. */
  async function negativ(methode: 'GET' | 'POST', rest: string, body?: unknown) {
    const falsch = await rufe(methode, p(a, rest), wer(a, 'bt', b.mandantId), body);
    expect(falsch.status).toBe(404);
    expect(falsch.antwort).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    const kontakt = await rufe(methode, p(a, rest), wer(a, 'kontakt'), body);
    expect(kontakt.status).toBe(404);
    expect(kontakt.antwort).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
  }

  async function ungueltig(rest: string, body: unknown, rolle: Rolle = 'bt') {
    const r = await rufe('POST', p(a, rest), wer(a, rolle), body);
    expect(r.status).toBe(400);
    expect((r.antwort as { fehler: { code: string } }).fehler.code).toBe('UNGUELTIG');
  }

  async function risiken(): Promise<RisikenListe> {
    const r = await rufe('GET', p(a, '/risiken'), wer(a, 'bt'));
    return erwarte(RisikenListeSchema, r.antwort);
  }

  async function kontrollen(): Promise<KontrollenListe> {
    const r = await rufe('GET', p(a, '/kontrollen'), wer(a, 'bt'));
    return erwarte(KontrollenListeSchema, r.antwort);
  }

  // ---------------------------------------------------------------------------
  it('GET /risiken und /risiken/:risikoId', async () => {
    const l = await risiken();
    expect(l.risiken).toHaveLength(a.risiken.size);
    expect(l.namen).toEqual({});
    const id = l.risiken[0]!.id;
    const d = await rufe('GET', p(a, `/risiken/${id}?stand=2026-06-30`), wer(a, 'hb'));
    expect(d.status).toBe(200);
    expect(erwarte(RisikoDetailSchema, d.antwort).historisch).toBe(true);
    await negativ('GET', '/risiken');
    await negativ('GET', `/risiken/${id}`);
    const fremd = await rufe('GET', p(a, `/risiken/${[...b.risiken.values()][0]}`), wer(a, 'bt'));
    expect(fremd.status).toBe(404);
    for (const q of ['?stand=2026-02-30', '?stand=x&stand=y', '?foo=1']) {
      const r = await rufe('GET', p(a, `/risiken${q}`), wer(a, 'bt'));
      expect(r.status).toBe(400);
    }
  });

  it('POST /risiken/:risikoId/neu-bewerten und /bewertung-bestaetigen', async () => {
    const r = (await risiken()).risiken[0]!;
    const body = {
      standId: r.standId,
      s: r.s === 'H' ? 'N' : 'H',
      w: r.w,
      r: r.r,
      gt: r.gt,
      begruendung: BEGRUENDUNG,
    };
    await negativ('POST', `/risiken/${r.id}/neu-bewerten`, body);
    await ungueltig(`/risiken/${r.id}/neu-bewerten`, { ...body, brutto: 'GERING' });
    await ungueltig(`/risiken/${r.id}/neu-bewerten`, { ...body, mandantId: b.mandantId });
    await ungueltig(`/risiken/${r.id}/neu-bewerten`, { ...body, begruendung: 'kurz' });
    // TS-07: schreibende Endpunkte nehmen keinen Stichtag an.
    const mitStand = await rufe(
      'POST',
      p(a, `/risiken/${r.id}/neu-bewerten?stand=2026-01-01`),
      wer(a, 'hb'),
      body,
    );
    expect(mitStand.status).toBe(400);
    // Rolle fehlt: 403 mit fachlichem Grund.
    const leser = await rufe('POST', p(a, `/risiken/${r.id}/neu-bewerten`), wer(a, 'leser'), body);
    expect(leser.status).toBe(403);
    expect((leser.antwort as { fehler: { meldung?: string } }).fehler.meldung).toBeTruthy();
    expect(leser.antwort).toMatchObject({ fehler: { grund: 'BEARBEITEN' } });
    const ok = await rufe('POST', p(a, `/risiken/${r.id}/neu-bewerten`), wer(a, 'hb'), body);
    expect(ok.status).toBe(200);
    const e = erwarte(NeuBewertungErgebnisSchema, ok.antwort);
    expect(e.geaendert).toBe(true);
    // Derselbe Stand erneut → 409.
    const nochmal = await rufe('POST', p(a, `/risiken/${r.id}/neu-bewerten`), wer(a, 'hb'), body);
    expect(nochmal.status).toBe(409);
    const best = await rufe('POST', p(a, `/risiken/${r.id}/bewertung-bestaetigen`), wer(a, 'hb'), {
      standId: e.standId,
      begruendung: BEGRUENDUNG,
    });
    expect(erwarte(NeuBewertungErgebnisSchema, best.antwort).geaendert).toBe(false);
    await negativ('POST', `/risiken/${r.id}/bewertung-bestaetigen`, {
      standId: e.standId,
      begruendung: BEGRUENDUNG,
    });
    await ungueltig(`/risiken/${r.id}/bewertung-bestaetigen`, { standId: e.standId });
  });

  it('Übersteuerung beantragen und entscheiden (Vier-Augen 403, zweite Person 200)', async () => {
    const r = (await risiken()).risiken[1]!;
    const klasse = r.bewertung.nettoDesign.klasse === 'KRITISCH' ? 'HOCH' : 'KRITISCH';
    const body = { sicht: 'DESIGN', klasse, begruendung: BEGRUENDUNG };
    await negativ('POST', `/risiken/${r.id}/uebersteuerungen`, body);
    await ungueltig(`/risiken/${r.id}/uebersteuerungen`, { ...body, sicht: 'BRUTTO' });
    const antrag = await rufe(
      'POST',
      p(a, `/risiken/${r.id}/uebersteuerungen`),
      wer(a, 'hb'),
      body,
    );
    expect(antrag.status).toBe(201);
    const u = erwarte(UebersteuerungBeantragtSchema, antrag.antwort);
    const pfad = `/uebersteuerungen/${u.uebersteuerungId}/entscheiden`;
    await negativ('POST', pfad, { entscheidung: 'FREIGEBEN' });
    await ungueltig(pfad, { entscheidung: 'ABLEHNEN' });
    const selbst = await rufe('POST', p(a, pfad), wer(a, 'hb'), { entscheidung: 'FREIGEBEN' });
    expect(selbst.status).toBe(403);
    expect(selbst.antwort).toMatchObject({ fehler: { grund: 'VIER_AUGEN' } });
    const ok = await rufe('POST', p(a, pfad), wer(a, 'bt'), { entscheidung: 'FREIGEBEN' });
    expect(erwarte(UebersteuerungEntschiedenSchema, ok.antwort).status).toBe('FREIGEGEBEN');
  });

  it('Inventarfreigabe: einreichen, freigeben, zurückweisen', async () => {
    const l = await risiken();
    const [r1, r2] = [l.risiken[2]!, l.risiken[3]!];
    for (const r of [r1, r2]) {
      await rufe('POST', p(a, `/risiken/${r.id}/neu-bewerten`), wer(a, 'hb'), {
        standId: r.standId,
        s: r.s === 'H' ? 'M' : 'H',
        w: r.w,
        r: r.r,
        gt: r.gt,
        begruendung: BEGRUENDUNG,
      });
    }
    const body = { risikoIds: [r1.id, r2.id] };
    await negativ('POST', '/risiken-freigabe/einreichen', body);
    await ungueltig('/risiken-freigabe/einreichen', { risikoIds: [] });
    await ungueltig('/risiken-freigabe/einreichen', { risikoIds: [r1.id, r1.id] });
    const ein = await rufe('POST', p(a, '/risiken-freigabe/einreichen'), wer(a, 'hb'), body);
    expect(erwarte(FreigabeSchrittErgebnisSchema, ein.antwort).bearbeitet).toHaveLength(2);
    await negativ('POST', '/risiken-freigabe/freigeben', { risikoIds: [r1.id] });
    const selbst = await rufe('POST', p(a, '/risiken-freigabe/freigeben'), wer(a, 'hb'), {
      risikoIds: [r1.id],
    });
    expect(selbst.status).toBe(403);
    expect(selbst.antwort).toMatchObject({ fehler: { grund: 'VIER_AUGEN' } });
    const frei = await rufe('POST', p(a, '/risiken-freigabe/freigeben'), wer(a, 'bt'), {
      risikoIds: [r1.id],
    });
    expect(erwarte(FreigabeSchrittErgebnisSchema, frei.antwort).bearbeitet).toHaveLength(1);
    const zbody = { begruendung: BEGRUENDUNG };
    await negativ('POST', `/risiken/${r2.id}/zurueckweisen`, zbody);
    await ungueltig(`/risiken/${r2.id}/zurueckweisen`, {});
    const zw = await rufe('POST', p(a, `/risiken/${r2.id}/zurueckweisen`), wer(a, 'bt'), zbody);
    expect(erwarte(RisikoZurueckgewiesenSchema, zw.antwort).freigabe).toBe('BEWERTET');
    const nochmal = await rufe(
      'POST',
      p(a, `/risiken/${r2.id}/zurueckweisen`),
      wer(a, 'bt'),
      zbody,
    );
    expect(nochmal.status).toBe(409);
  });

  it('POST /risiken/:risikoId/akzeptanz-anfordern', async () => {
    const r = (await risiken()).risiken.find((x) => x.ueberAppetit && !x.akzeptanzen.length)!;
    const body = { empfaengerId: a.personen.gv, begruendung: BEGRUENDUNG };
    await negativ('POST', `/risiken/${r.id}/akzeptanz-anfordern`, body);
    await ungueltig(`/risiken/${r.id}/akzeptanz-anfordern`, { ...body, empfaengerId: 'Jana' });
    const falscherEmpfaenger = await rufe(
      'POST',
      p(a, `/risiken/${r.id}/akzeptanz-anfordern`),
      wer(a, 'hb'),
      { ...body, empfaengerId: b.personen.gv },
    );
    expect(falscherEmpfaenger.status).toBe(400);
    const ok = await rufe('POST', p(a, `/risiken/${r.id}/akzeptanz-anfordern`), wer(a, 'hb'), body);
    expect(ok.status).toBe(201);
    expect(erwarte(RisikoakzeptanzAngefordertSchema, ok.antwort).empfaengerId).toBe(a.personen.gv);
  });

  // ---------------------------------------------------------------------------
  it('GET /kontrollen und /kontrollen/:kontrolleId', async () => {
    const l = await kontrollen();
    expect(l.kontrollen).toHaveLength(a.kontrollen.size);
    const id = l.kontrollen[0]!.id;
    const d = await rufe('GET', p(a, `/kontrollen/${id}`), wer(a, 'hb'));
    expect(erwarte(KontrolleDetailSchema, d.antwort).kontrolle.id).toBe(id);
    await negativ('GET', '/kontrollen');
    await negativ('GET', `/kontrollen/${id}`);
    const fremd = await rufe(
      'GET',
      p(a, `/kontrollen/${[...b.kontrollen.values()][0]}`),
      wer(a, 'bt'),
    );
    expect(fremd.status).toBe(404);
    expect((await rufe('GET', p(a, '/kontrollen?stand=heute'), wer(a, 'bt'))).status).toBe(400);
  });

  it('POST /kontrollen/:kontrolleId/design und /verantwortliche', async () => {
    const k = (await kontrollen()).kontrollen.find((x) => x.partei === 'KANZLEI' && x.schluessel)!;
    const body = { standId: k.standId, design: 'MANGEL', begruendung: BEGRUENDUNG };
    await negativ('POST', `/kontrollen/${k.id}/design`, body);
    await ungueltig(`/kontrollen/${k.id}/design`, { ...body, design: 'NICHT_BEURTEILT' });
    const ok = await rufe('POST', p(a, `/kontrollen/${k.id}/design`), wer(a, 'bt'), body);
    const g = erwarte(KontrolleGeaendertSchema, ok.antwort);
    const vbody = {
      standId: g.standId,
      durchfuehrendId: a.personen.vertretung,
      vertretungId: a.personen.hb,
      gegenzeichnerId: a.personen.bt,
      gegenzeichnungMandant: false,
    };
    await negativ('POST', `/kontrollen/${k.id}/verantwortliche`, vbody);
    await ungueltig(`/kontrollen/${k.id}/verantwortliche`, { ...vbody, durchfuehrendId: 'leon' });
    await ungueltig(`/kontrollen/${k.id}/verantwortliche`, {
      ...vbody,
      durchfuehrendId: a.personen.gv,
    });
    const v = await rufe('POST', p(a, `/kontrollen/${k.id}/verantwortliche`), wer(a, 'hb'), vbody);
    expect(erwarte(KontrolleGeaendertSchema, v.antwort).version).toBe(g.version + 1);
  });

  it('Frequenzabweichung: beantragen, entscheiden, aufheben', async () => {
    const k = (await kontrollen()).kontrollen.find(
      (x) => x.partei === 'KANZLEI' && x.frequenz.turnus === 'MONATLICH' && x.risikoIds.length,
    )!;
    const body = {
      standId: k.standId,
      turnus: 'QUARTALSWEISE',
      anlass: false,
      begruendung: BEGRUENDUNG,
    };
    await negativ('POST', `/kontrollen/${k.id}/abweichung`, body);
    await ungueltig(`/kontrollen/${k.id}/abweichung`, { ...body, turnus: 'WOECHENTLICH' });
    const antrag = await rufe('POST', p(a, `/kontrollen/${k.id}/abweichung`), wer(a, 'hb'), body);
    const g = erwarte(KontrolleGeaendertSchema, antrag.antwort);
    const ebody = { standId: g.standId, entscheidung: 'FREIGEBEN' };
    await negativ('POST', `/kontrollen/${k.id}/abweichung/entscheiden`, ebody);
    await ungueltig(`/kontrollen/${k.id}/abweichung/entscheiden`, {
      ...ebody,
      entscheidung: 'ABLEHNEN',
    });
    const selbst = await rufe(
      'POST',
      p(a, `/kontrollen/${k.id}/abweichung/entscheiden`),
      wer(a, 'hb'),
      ebody,
    );
    expect(selbst.status).toBe(403);
    expect(selbst.antwort).toMatchObject({ fehler: { grund: 'VIER_AUGEN' } });
    const frei = await rufe(
      'POST',
      p(a, `/kontrollen/${k.id}/abweichung/entscheiden`),
      wer(a, 'bt'),
      ebody,
    );
    const f = erwarte(KontrolleGeaendertSchema, frei.antwort);
    expect(f.frequenz.turnus).toBe('QUARTALSWEISE');
    const abody = { standId: f.standId, begruendung: BEGRUENDUNG };
    await negativ('POST', `/kontrollen/${k.id}/abweichung/aufheben`, abody);
    await ungueltig(`/kontrollen/${k.id}/abweichung/aufheben`, { standId: f.standId });
    const auf = await rufe(
      'POST',
      p(a, `/kontrollen/${k.id}/abweichung/aufheben`),
      wer(a, 'hb'),
      abody,
    );
    expect(erwarte(KontrolleGeaendertSchema, auf.antwort).frequenz.turnus).toBe('MONATLICH');
  });

  // ---------------------------------------------------------------------------
  it('GET und POST /profil, POST /profil/risiko-aufnehmen', async () => {
    const d = await rufe('GET', p(a, '/profil'), wer(a, 'bt'));
    const profil = erwarte(ProfilDatenSchema, d.antwort);
    await negativ('GET', '/profil');
    const offen = profil.staende.find((s) => s.gueltigBis === null)!;
    const neu = structuredClone(offen.antworten);
    neu.p6.zahlungswege = [...neu.p6.zahlungswege, 'Rechnung'];
    const body = {
      profilStandId: offen.id,
      profil: neu,
      gueltigAb: new Date().toISOString().slice(0, 10),
      ereignisseAnlegen: true,
    };
    await negativ('POST', '/profil', body);
    await ungueltig('/profil', { ...body, profil: { ...neu, p13: {} } });
    await ungueltig('/profil', { ...body, gueltigAb: '01.01.2027' });
    const ok = await rufe('POST', p(a, '/profil'), wer(a, 'hb'), body);
    expect(ok.status).toBe(200);
    expect(erwarte(ProfilGeaendertSchema, ok.antwort).version).toBe(2);
    expect((await rufe('POST', p(a, '/profil'), wer(a, 'hb'), body)).status).toBe(409);

    const abody = {
      code: a.offenerVorschlag,
      verantwortliche: {
        berufstraeger: { id: a.personen.bt, name: 'StB' },
        hauptbearbeitung: { id: a.personen.hb, name: 'HB' },
        vertretung: null,
      },
    };
    await negativ('POST', '/profil/risiko-aufnehmen', abody);
    await ungueltig('/profil/risiko-aufnehmen', { ...abody, code: 'EC-UST' });
    const auf = await rufe('POST', p(a, '/profil/risiko-aufnehmen'), wer(a, 'hb'), abody);
    expect(auf.status).toBe(201);
    expect(erwarte(RisikoAufgenommenSchema, auf.antwort).code).toBe(a.offenerVorschlag);
  });
});
