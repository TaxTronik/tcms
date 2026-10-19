// =============================================================================
// Endpunkte des Bereichs „durchfuehrung" über `erzeugeApp` mit echter
// Datenbank (DB_TESTS=1, DATABASE_URL = tcms_app) und signierten
// Bestätigungen: je Endpunkt Erfolg, falscher Mandant (404),
// Mandantenperson auf Staff-Endpunkt (404), ungültiger Body (400); dazu
// Fehlerabbildung (403 Vier-Augen, 409 Konflikt) und Antworten nach Vertrag.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import {
  DurchfuehrungDetailSchema,
  DurchfuehrungUebergangSchema,
  GegenzeichnenErgebnisSchema,
  KontrollaufgabeSchema,
  KontrollaufgabenSchema,
  NachtragErgebnisSchema,
  NachweisEntferntSchema,
  NachweisErgebnisSchema,
  DurchfuehrungSpeichernErgebnisSchema,
  type Akteur,
  type AkteurClaims,
} from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import {
  beantrageEntfallen,
  echteUhr,
  gegenzeichneDurchfuehrung,
  haengeNachweisAn,
  imDienst,
  keinPersonenVerzeichnis,
  reicheDurchfuehrungEin,
  speichereDurchfuehrung,
  verweisAblage,
  type DienstKontext,
} from '@tcms/service';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Routen } from '../routen';
import { aufbau, bestaetigtSenden, json, type Aufbau } from '../__tests__/hilfen';
import { registriereDurchfuehrung } from './durchfuehrung';

const AKTIV = process.env.DB_TESTS === '1';
const PORTS = { uhr: echteUhr, personen: keinPersonenVerzeichnis, ablage: verweisAblage };
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';
const tag = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const SPEICHERN = {
  schritte: [{ erledigt: true, kommentar: 'ok' }],
  werte: [{ key: 'saldo', wert: 0, bemerkung: '', erklaert: false }],
  ergebnis: 'OHNE_BEFUND',
  ergebnisKommentar: null,
};
const verweis = () => ({
  dokumentId: randomUUID(),
  dateiname: 'Saldenliste.pdf',
  mime: 'application/pdf',
  groesse: 1024,
  sha256: randomBytes(32).toString('hex'),
});

describe.skipIf(!AKTIV)('Endpunkte durchfuehrung (HTTP, echte Datenbank)', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const mandantB = randomUUID();
  const p = {
    bt: randomUUID(),
    bearbeiter: randomUUID(),
    pruefer: randomUUID(),
    gv: randomUUID(),
    ma: randomUUID(),
  };
  let k1 = { id: '', standId: '' };
  let k2 = { id: '', standId: '' };
  let t: Aufbau;

  const kanzlei = (sub: string, o: { mandantId?: string; bt?: boolean; hb?: boolean } = {}) =>
    ({
      tnt: tenant,
      sub,
      knd: 'KANZLEI',
      rol: { adm: false, bt: o.bt ?? false },
      cli: { id: o.mandantId ?? mandant, bt: o.bt ?? false, hb: o.hb ?? false },
    }) satisfies Partial<AkteurClaims>;
  const kontakt = (sub: string, mandantId = mandant) =>
    ({
      tnt: tenant,
      sub,
      knd: 'MANDANT',
      rol: undefined,
      cli: { id: mandantId, bt: false, hb: false },
    }) satisfies Partial<AkteurClaims>;
  const C = {
    bt: kanzlei(p.bt, { bt: true }),
    bearbeiter: kanzlei(p.bearbeiter, { hb: true }),
    pruefer: kanzlei(p.pruefer),
    gv: kontakt(p.gv),
    ma: kontakt(p.ma),
  };
  const alsAkteur = (c: Partial<AkteurClaims>): Akteur =>
    c.knd === 'MANDANT'
      ? { art: 'MANDANT', tenantId: tenant, id: c.sub!, name: 'Test', mandantId: c.cli!.id }
      : {
          art: 'KANZLEI',
          tenantId: tenant,
          id: c.sub!,
          name: 'Test',
          istAdmin: c.rol!.adm,
          istBerufstraeger: c.rol!.bt,
          mandant: {
            id: c.cli!.id,
            zustaendigBerufstraeger: c.cli!.bt,
            hauptbearbeitung: c.cli!.hb,
          },
        };
  const dienst = <T>(c: Partial<AkteurClaims>, fn: (ctx: DienstKontext) => Promise<T>) =>
    imDienst(alsAkteur(c), PORTS, fn);

  async function durchfuehrung(k: { id: string; standId: string }): Promise<string> {
    return mitTenant(tenant, async (tx) => {
      const d = await tx.durchfuehrung.create({
        data: {
          kontrolleId: k.id,
          kontrolleStandId: k.standId,
          periodeLabel: 'September 2026',
          periodeVon: tag('2026-09-01'),
          periodeBis: tag('2026-09-30'),
          faelligAm: tag('2026-12-31'),
        },
      });
      return d.id;
    });
  }
  async function eingereicht(k: 'k1' | 'k2' = 'k1'): Promise<string> {
    const did = await durchfuehrung(k === 'k1' ? k1 : k2);
    const wer = k === 'k1' ? C.bearbeiter : C.ma;
    const z = { mandantId: mandant, durchfuehrungId: did };
    await dienst(wer, (ctx) => speichereDurchfuehrung(ctx, { ...z, ...SPEICHERN } as never));
    await dienst(wer, (ctx) => haengeNachweisAn(ctx, { ...z, verweis: verweis() }));
    await dienst(wer, (ctx) => reicheDurchfuehrungEin(ctx, z));
    return did;
  }

  const senden = (methode: string, ziel: string, claims: Partial<AkteurClaims>, body?: unknown) =>
    bestaetigtSenden(t.app, {
      methode,
      ziel,
      claims,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  beforeAll(async () => {
    await mitTenant(tenant, async (tx: Tx) => {
      for (const id of [mandant, mandantB]) {
        await tx.mandant.create({ data: { id, name: 'M', rechtsform: 'KapG' } });
      }
      await tx.mandantKontaktRolle.createMany({
        data: [
          { mandantId: mandant, kontaktId: p.gv, rolle: 'GESETZLICHER_VERTRETER' },
          { mandantId: mandant, kontaktId: p.ma, rolle: 'MITARBEITER' },
        ],
      });
      const prog = await tx.tcmsProgramm.create({
        data: { mandantId: mandant, paketId: 'ecommerce', paketVersion: '1.0' },
      });
      const kontrolle = async (
        code: string,
        partei: 'KANZLEI' | 'MANDANT',
        durchfuehrendId: string,
        gegenzeichnerId: string,
      ) => {
        const k = await tx.kontrolle.create({
          data: { programmId: prog.id, code, aktivAb: tag('2026-01-01') },
        });
        const s = await tx.kontrolleStand.create({
          data: {
            kontrolleId: k.id,
            version: 1,
            titel: code,
            ziel: 'Ziel',
            art: 'D',
            ausfuehrung: 'M',
            vorlageTurnus: 'MONATLICH',
            vorlageAnlass: false,
            partei,
            schluessel: true,
            durchfuehrendId,
            vertretungId: randomUUID(),
            gegenzeichnerId,
            gegenzeichnungMandant: partei === 'MANDANT',
            nachweis: 'Saldenliste',
            mindestNachweise: 1,
            schritte: [{ titel: 'Abgleich', hinweis: '' }],
            kennzahlen: [{ key: 'saldo', label: 'Saldo', sollEur: 0 }],
            toleranzEur: 1,
            faelligNachTagen: 30,
            gueltigAb: tag('2026-01-01'),
          },
        });
        return { id: k.id, standId: s.id };
      };
      k1 = await kontrolle('K-A-01', 'KANZLEI', p.bearbeiter, p.pruefer);
      k2 = await kontrolle('K-A-02', 'MANDANT', p.ma, p.gv);
      const r = await tx.risiko.create({
        data: {
          programmId: prog.id,
          code: 'R-A-01',
          entscheidung: 'UEBERNOMMEN',
          aktivAb: tag('2026-01-01'),
        },
      });
      await tx.risikoKontrolle.create({ data: { risikoId: r.id, kontrolleId: k1.id } });
    });
    t = aufbau({
      routen: registriereDurchfuehrung as unknown as (r: Routen<unknown>) => void,
      daten: {
        mitTenant: (tnt, fn) => mitTenant(tnt, fn as (tx: Tx) => Promise<never>),
        ping: async () => undefined,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Je Endpunkt: Erfolg, falscher Mandant, Mandantenperson auf Staff-Endpunkt,
  // ungültiger Body
  // ---------------------------------------------------------------------------

  interface Fall {
    name: string;
    methode: 'GET' | 'POST';
    /** Bereitet den Zustand vor und liefert den Pfad. */
    pfad: () => Promise<string>;
    wer: Partial<AkteurClaims>;
    body?: unknown;
    status: number;
    schema: { parse(v: unknown): unknown };
    portal?: boolean;
    /** Ungültiger Body (bzw. ein Body, wo keiner erlaubt ist); bei GET eine ungültige Query. */
    ungueltig: unknown;
  }

  const D = (did: string) => `/v1/mandanten/${mandant}/durchfuehrungen/${did}`;
  const P = (did: string) => `/v1/mandanten/${mandant}/portal/aufgaben/${did}`;

  const faelle: Fall[] = [
    {
      name: 'GET Detail',
      methode: 'GET',
      pfad: async () => D(await eingereicht()),
      wer: C.bt,
      status: 200,
      schema: DurchfuehrungDetailSchema,
      ungueltig: '?stand=2026-13-01',
    },
    {
      name: 'POST beginnen',
      methode: 'POST',
      pfad: async () => `${D(await durchfuehrung(k1))}/beginnen`,
      wer: C.bearbeiter,
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: '{}',
    },
    {
      name: 'POST speichern',
      methode: 'POST',
      pfad: async () => `${D(await durchfuehrung(k1))}/speichern`,
      wer: C.bearbeiter,
      body: SPEICHERN,
      status: 200,
      schema: DurchfuehrungSpeichernErgebnisSchema,
      ungueltig: { ...SPEICHERN, mandantId: mandant },
    },
    {
      name: 'POST einreichen',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k1);
        const z = { mandantId: mandant, durchfuehrungId: did };
        await dienst(C.bearbeiter, (ctx) =>
          speichereDurchfuehrung(ctx, { ...z, ...SPEICHERN } as never),
        );
        await dienst(C.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...z, verweis: verweis() }));
        return `${D(did)}/einreichen`;
      },
      wer: C.bearbeiter,
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: '{"stand":"2026-01-01"}',
    },
    {
      name: 'POST Nachweis anhängen',
      methode: 'POST',
      pfad: async () => `${D(await durchfuehrung(k1))}/nachweise`,
      wer: C.bearbeiter,
      body: { verweis: verweis() },
      status: 201,
      schema: NachweisErgebnisSchema,
      ungueltig: { verweis: { ...verweis(), dokumentId: 'ab/abcdef' } },
    },
    {
      name: 'POST Nachweis entfernen',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k1);
        const n = await dienst(C.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, { mandantId: mandant, durchfuehrungId: did, verweis: verweis() }),
        );
        return `${D(did)}/nachweise/${n.nachweis.id}/entfernen`;
      },
      wer: C.bearbeiter,
      status: 200,
      schema: NachweisEntferntSchema,
      ungueltig: '{}',
    },
    {
      name: 'POST zurückweisen',
      methode: 'POST',
      pfad: async () => `${D(await eingereicht())}/zurueckweisen`,
      wer: C.pruefer,
      body: { begruendung: BEGRUENDUNG },
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: { begruendung: 'zu kurz' },
    },
    {
      name: 'POST gegenzeichnen',
      methode: 'POST',
      pfad: async () => `${D(await eingereicht())}/gegenzeichnen`,
      wer: C.pruefer,
      body: {},
      status: 200,
      schema: GegenzeichnenErgebnisSchema,
      ungueltig: { feststellung: { titel: 'x' } },
    },
    {
      name: 'POST Entfallen beantragen',
      methode: 'POST',
      pfad: async () => `${D(await durchfuehrung(k1))}/entfallen/beantragen`,
      wer: C.bearbeiter,
      body: { begruendung: BEGRUENDUNG },
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: { begruendung: BEGRUENDUNG, entfallenVon: p.bt },
    },
    {
      name: 'POST Entfallen freigeben',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k1);
        await dienst(C.bearbeiter, (ctx) =>
          beantrageEntfallen(ctx, {
            mandantId: mandant,
            durchfuehrungId: did,
            begruendung: BEGRUENDUNG,
          }),
        );
        return `${D(did)}/entfallen/freigeben`;
      },
      wer: C.bt,
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: '{}',
    },
    {
      name: 'POST Entfallen ablehnen',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k1);
        await dienst(C.bearbeiter, (ctx) =>
          beantrageEntfallen(ctx, {
            mandantId: mandant,
            durchfuehrungId: did,
            begruendung: BEGRUENDUNG,
          }),
        );
        return `${D(did)}/entfallen/ablehnen`;
      },
      wer: C.bt,
      body: { begruendung: BEGRUENDUNG },
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      ungueltig: { begruendung: 42 },
    },
    {
      name: 'POST Nachtrag',
      methode: 'POST',
      pfad: async () => {
        const did = await eingereicht();
        await dienst(C.pruefer, (ctx) =>
          gegenzeichneDurchfuehrung(ctx, { mandantId: mandant, durchfuehrungId: did }),
        );
        return `${D(did)}/nachtrag`;
      },
      wer: C.bearbeiter,
      body: { begruendung: BEGRUENDUNG },
      status: 201,
      schema: NachtragErgebnisSchema,
      ungueltig: {},
    },
    {
      name: 'GET Nachweis',
      methode: 'GET',
      pfad: async () => {
        const did = await durchfuehrung(k1);
        const n = await dienst(C.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, { mandantId: mandant, durchfuehrungId: did, verweis: verweis() }),
        );
        return `/v1/mandanten/${mandant}/nachweise/${n.nachweis.id}`;
      },
      wer: C.bt,
      status: 200,
      schema: NachweisErgebnisSchema,
      ungueltig: '?x=1',
    },
    // ------------------------------------------------------------- Portal
    {
      name: 'GET Portal-Aufgaben',
      methode: 'GET',
      pfad: async () => {
        await durchfuehrung(k2);
        return `/v1/mandanten/${mandant}/portal/aufgaben`;
      },
      wer: C.gv,
      status: 200,
      schema: KontrollaufgabenSchema,
      portal: true,
      ungueltig: '?stand=2026-10-01',
    },
    {
      name: 'GET Portal-Aufgabe',
      methode: 'GET',
      pfad: async () => P(await durchfuehrung(k2)),
      wer: C.ma,
      status: 200,
      schema: KontrollaufgabeSchema,
      portal: true,
      ungueltig: '?stand=2026-10-01&stand=2026-10-02',
    },
    {
      name: 'POST Portal speichern',
      methode: 'POST',
      pfad: async () => `${P(await durchfuehrung(k2))}/speichern`,
      wer: C.ma,
      body: SPEICHERN,
      status: 200,
      schema: DurchfuehrungSpeichernErgebnisSchema,
      portal: true,
      ungueltig: { ...SPEICHERN, ergebnis: 'WIRKSAM' },
    },
    {
      name: 'POST Portal übermitteln',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k2);
        const z = { mandantId: mandant, durchfuehrungId: did };
        await dienst(C.ma, (ctx) => speichereDurchfuehrung(ctx, { ...z, ...SPEICHERN } as never));
        await dienst(C.ma, (ctx) => haengeNachweisAn(ctx, { ...z, verweis: verweis() }));
        return `${P(did)}/einreichen`;
      },
      wer: C.ma,
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      portal: true,
      ungueltig: '[]',
    },
    {
      name: 'POST Portal Anlage',
      methode: 'POST',
      pfad: async () => `${P(await durchfuehrung(k2))}/anlagen`,
      wer: C.ma,
      body: { verweis: verweis() },
      status: 201,
      schema: NachweisErgebnisSchema,
      portal: true,
      ungueltig: { verweis: { ...verweis(), sha256: 'X'.repeat(64) } },
    },
    {
      name: 'POST Portal Anlage entfernen',
      methode: 'POST',
      pfad: async () => {
        const did = await durchfuehrung(k2);
        const n = await dienst(C.ma, (ctx) =>
          haengeNachweisAn(ctx, { mandantId: mandant, durchfuehrungId: did, verweis: verweis() }),
        );
        return `${P(did)}/anlagen/${n.nachweis.id}/entfernen`;
      },
      wer: C.ma,
      status: 200,
      schema: NachweisEntferntSchema,
      portal: true,
      ungueltig: '{}',
    },
    {
      name: 'POST Portal zurückgeben',
      methode: 'POST',
      pfad: async () => `${P(await eingereicht('k2'))}/zurueckgeben`,
      wer: C.gv,
      body: { begruendung: BEGRUENDUNG },
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      portal: true,
      ungueltig: { begruendung: BEGRUENDUNG, zusatz: true },
    },
    {
      name: 'POST Portal bestätigen',
      methode: 'POST',
      pfad: async () => `${P(await eingereicht('k2'))}/bestaetigen`,
      wer: C.gv,
      status: 200,
      schema: DurchfuehrungUebergangSchema,
      portal: true,
      ungueltig: '{}',
    },
    {
      name: 'GET Portal-Anlage',
      methode: 'GET',
      pfad: async () => {
        const did = await durchfuehrung(k2);
        const n = await dienst(C.ma, (ctx) =>
          haengeNachweisAn(ctx, { mandantId: mandant, durchfuehrungId: did, verweis: verweis() }),
        );
        return `/v1/mandanten/${mandant}/portal/anlagen/${n.nachweis.id}`;
      },
      wer: C.ma,
      status: 200,
      schema: NachweisErgebnisSchema,
      portal: true,
      ungueltig: '?x=1',
    },
  ];

  it.each(faelle)('$name: Erfolg nach Vertrag', async (f) => {
    const r = await senden(f.methode, await f.pfad(), f.wer, f.body);
    const b = await json(r);
    expect(r.status, JSON.stringify(b)).toBe(f.status);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(b['ok']).toBe(true);
    expect(f.schema.parse(b['daten'])).toEqual(b['daten']);
  });

  it.each(faelle)('$name: falscher Mandant → 404', async (f) => {
    const pfad = await f.pfad();
    // Bestätigter Mandantenbezug auf B, Pfad A (dieselbe Person, derselbe Tenant).
    const fremd =
      f.wer.knd === 'MANDANT'
        ? kontakt(f.wer.sub!, mandantB)
        : { ...f.wer, cli: { ...f.wer.cli!, id: mandantB } };
    const r = await senden(f.methode, pfad, fremd, f.body);
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
  });

  it.each(faelle.filter((f) => !f.portal))('$name: Mandantenperson → 404', async (f) => {
    const r = await senden(f.methode, await f.pfad(), C.gv, f.body);
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
  });

  it.each(faelle)('$name: ungültiger Body bzw. ungültige Query → 400', async (f) => {
    const pfad = await f.pfad();
    const r =
      f.methode === 'GET'
        ? await senden('GET', `${pfad}${f.ungueltig as string}`, f.wer)
        : await senden(f.methode, pfad, f.wer, f.ungueltig);
    expect(r.status).toBe(400);
    expect((await json(r))['fehler']).toMatchObject({ code: 'UNGUELTIG' });
  });

  // ---------------------------------------------------------------------------
  // Fehlerabbildung und Querschnitt
  // ---------------------------------------------------------------------------

  it('Vier-Augen → 403 mit Grund; zweiter Übergang → 409', async () => {
    const did = await eingereicht();
    const r1 = await senden('POST', `${D(did)}/gegenzeichnen`, C.bearbeiter, {});
    expect(r1.status).toBe(403);
    expect(await json(r1)).toEqual({
      ok: false,
      fehler: {
        code: 'NICHT_BERECHTIGT',
        meldung: 'Gegenzeichnung muss durch eine andere Person erfolgen (Vier-Augen-Prinzip)',
        grund: 'VIER_AUGEN',
      },
    });
    expect((await senden('POST', `${D(did)}/gegenzeichnen`, C.pruefer, {})).status).toBe(200);
    const r3 = await senden('POST', `${D(did)}/gegenzeichnen`, C.bt, {});
    expect(r3.status).toBe(409);
    expect((await json(r3))['fehler']).toMatchObject({ code: 'KONFLIKT' });
  });

  it('Objekt eines anderen Mandanten: 404 wie unbekannt; Stichtag an schreibenden Routen: 400', async () => {
    const dA = await durchfuehrung(k1);
    // Durchführung von A unter dem Pfad von B (Bezug auf B): unsichtbar.
    const inB = { ...C.bt, cli: { ...C.bt.cli, id: mandantB } };
    const r = await senden('GET', `/v1/mandanten/${mandantB}/durchfuehrungen/${dA}`, inB);
    expect(r.status).toBe(404);
    const u = await senden('GET', `/v1/mandanten/${mandantB}/durchfuehrungen/cunbekannt0000`, inB);
    expect(await json(u)).toEqual(await json(r.clone()));
    const s = await senden('POST', `${D(dA)}/beginnen?stand=2026-01-01`, C.bearbeiter);
    expect(s.status).toBe(400);
    const g = await senden('GET', `${D(dA)}?stand=2026-10-01`, C.bt);
    expect(g.status).toBe(200);
    expect((await json(g))['daten']).toMatchObject({ historisch: true });
  });

  it('Kanzleiperson auf Portal-Lesepfaden: 404 (Service), Mandantenkontakt ohne Zuweisung: 404', async () => {
    const did = await durchfuehrung(k2);
    expect((await senden('GET', `/v1/mandanten/${mandant}/portal/aufgaben`, C.bt)).status).toBe(
      404,
    );
    expect((await senden('GET', P(did), C.bt)).status).toBe(404);
    const fremd = kontakt(randomUUID());
    expect((await senden('GET', P(did), fremd)).status).toBe(404);
  });

  it('Portal-Aufgabe: berechnete Abweichung je Kennzahl in `pruefung` (wie die Einreichprüfung)', async () => {
    const did = await durchfuehrung(k2);
    const z = { mandantId: mandant, durchfuehrungId: did };
    await dienst(C.ma, (ctx) =>
      speichereDurchfuehrung(ctx, {
        ...z,
        ...SPEICHERN,
        werte: [{ key: 'saldo', wert: 3.456, bemerkung: '', erklaert: false }],
      } as never),
    );
    const r = await senden('GET', P(did), C.ma);
    expect(r.status).toBe(200);
    const a = KontrollaufgabeSchema.parse((await json(r))['daten']);
    expect(a.pruefung.kennzahlen).toEqual([
      {
        key: 'saldo',
        label: 'Saldo',
        wert: 3.46, // beim Speichern auf Cent gerundet
        abweichung: 3.46,
        lage: 'AUSSERHALB',
        berechnet: false,
      },
    ]);
    expect(a.pruefung.ausserhalb).toEqual(['Saldo']);
  });
});
