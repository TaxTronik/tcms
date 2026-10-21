// =============================================================================
// Endpunkte des Bereichs „lesepfade" über `erzeugeApp` mit echter Datenbank
// (DB_TESTS=1, DATABASE_URL = tcms_app, Demo-Seed) und signierten
// Akteursbestätigungen: Erfolg, Mandantenbindung (404), Mandantenperson auf
// Staff-Endpunkten (404), ungültige Eingaben (400).
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  ArbeitskorbAntwortSchema,
  bodySha256,
  KontakteAntwortSchema,
  KontaktRollenAntwortSchema,
  KontextAntwortSchema,
  AuditListeAntwortSchema,
  AuditPruefenAntwortSchema,
  MandantAnkerAntwortSchema,
  MAX_MANDANTEN_JE_ANFRAGE,
  PortalUebersichtAntwortSchema,
  PortfolioAntwortSchema,
  type AkteurClaims,
} from '@tcms/contract';
import { mitTenant, schreibeAudit, type Tx } from '@tcms/db';
import { DEMO_IDS, DEMO_MANDANTEN, DEMO_TENANT_ID } from '@tcms/db/demo';
import { beteiligteVon } from '@tcms/service';
import { describe, expect, it } from 'vitest';
import { aufbau, bestaetigtSenden, claims, json, mandantClaims } from '../__tests__/hilfen';
import { registriereLesepfade } from './lesepfade';

const AKTIV = process.env['DB_TESTS'] === '1';

const app = () =>
  aufbau({
    routen: (r) => registriereLesepfade(r as Parameters<typeof registriereLesepfade>[0]),
    daten: {
      mitTenant: (tenantId, fn) => mitTenant(tenantId, fn as (tx: Tx) => Promise<never>),
      ping: async () => undefined,
    },
  }).app;

/** Anna (Admin, BT) mit Bezug auf Talwind, im Demo-Tenant. */
const anna = (over: Partial<AkteurClaims> = {}): Partial<AkteurClaims> => ({
  tnt: DEMO_TENANT_ID,
  sub: DEMO_IDS.anna,
  rol: { adm: true, bt: true },
  cli: { id: DEMO_IDS.talwind, bt: true, hb: false },
  ...over,
});

/** Bestätigung für Jana (Mandantenkontakt Talwind, GV) für genau diese Anfrage. */
const jana = (ziel: string, methode: AkteurClaims['req']['m'] = 'GET', body = ''): AkteurClaims =>
  mandantClaims(DEMO_IDS.talwind, {
    tnt: DEMO_TENANT_ID,
    sub: DEMO_IDS.jana,
    nam: 'Jana',
    req: { m: methode, p: ziel, b: bodySha256(new TextEncoder().encode(body)) },
  });

describe.skipIf(!AKTIV)('Endpunkte lesepfade gegen PostgreSQL', () => {
  describe('GET /v1/mandanten/:mandantId/kontext', () => {
    const pfad = `/v1/mandanten/${DEMO_IDS.talwind}/kontext`;

    it('liefert den Kontext (200, vertragsgemäß)', async () => {
      const r = await bestaetigtSenden(app(), { ziel: `${pfad}?stand=2026-03-31`, claims: anna() });
      expect(r.status).toBe(200);
      const b = await json(r);
      const daten = KontextAntwortSchema.parse(b['daten']);
      expect(daten.mandant.id).toBe(DEMO_IDS.talwind);
      expect(daten.historisch).toBe(true);
      expect(daten.rechte).toEqual({ bearbeiten: false, wuerdigen: false });
      expect(daten.mandant.rechte).toEqual({ bearbeiten: false });
      // Aktueller Stand: Admin/Partnerin mit Bezug darf den Anker pflegen.
      const heute = await bestaetigtSenden(app(), { ziel: pfad, claims: anna() });
      expect(KontextAntwortSchema.parse((await json(heute))['daten']).mandant.rechte).toEqual({
        bearbeiten: true,
      });
    });

    it('Zeitraumzahlen der Prüfungsvorbereitung (ohneDurchfuehrung, nachweise, entfallen)', async () => {
      const r = await bestaetigtSenden(app(), { ziel: pfad, claims: anna() });
      const k = KontextAntwortSchema.parse((await json(r))['daten']);
      const ab = Date.parse(k.programm!.wirksamAb!);
      const bis = Date.parse(k.programm!.wirksamBis!) + 60 * 86_400_000;
      const imFenster = (d: (typeof k.durchfuehrungen)[number]) =>
        Date.parse(d.faelligAm) >= ab && Date.parse(d.faelligAm) <= bis;
      // Gegenrechnung aus derselben Antwort mit den Regeln der Prüfungsseite.
      const faellig = k.durchfuehrungen.filter((d) => imFenster(d) && d.anzeige !== 'GEPLANT');
      const mit = new Set(
        k.durchfuehrungen
          .filter((d) => imFenster(d) && d.anzeige !== 'ENTFALLEN')
          .map((d) => d.kontrolleId),
      );
      const begonnen = ab <= Date.parse(`${k.stand}T23:59:59.999Z`);
      expect(k.zeitraum).not.toBeNull();
      expect(k.zeitraum!.nachweise).toBe(
        faellig
          .filter((d) => d.anzeige === 'OHNE_BEFUND' || d.anzeige === 'MIT_BEFUND')
          .reduce((s, d) => s + d.nachweise, 0),
      );
      expect(k.zeitraum!.entfallen).toBe(faellig.filter((d) => d.anzeige === 'ENTFALLEN').length);
      expect(k.zeitraum!.ohneDurchfuehrung).toEqual(
        begonnen
          ? k.kontrollen
              .filter((x) => x.frequenz.turnus !== 'KEIN' && !mit.has(x.id))
              .map((x) => x.code)
          : [],
      );
      expect(k.zeitraum!.nachweise).toBeGreaterThan(0);
      // Pflichtattribute: Lückenliste neben dem Kennzeichen (eine Regel).
      for (const x of k.kontrollen)
        expect(x.pflichtattributeOk, x.code).toBe(x.pflichtattributeLuecken.length === 0);
    });

    it('falscher Mandant im Pfad: 404 (Bindung an cli.id)', async () => {
      const r = await bestaetigtSenden(app(), {
        ziel: `/v1/mandanten/${DEMO_IDS.seestern}/kontext`,
        claims: anna(),
      });
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    });

    it('fremder Tenant mit passendem cli: 404 wie unbekannt', async () => {
      const r = await bestaetigtSenden(app(), {
        ziel: pfad,
        claims: anna({ tnt: claims().tnt }),
      });
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    });

    it('Mandantenperson auf dem Staff-Endpunkt: 404', async () => {
      const r = await bestaetigtSenden(app(), { ziel: pfad, roheClaims: jana(pfad) });
      expect(r.status).toBe(404);
    });

    it('ungültige Query: 400', async () => {
      for (const q of ['?stand=2026-13-01', '?stand=heute', '?x=1', '?stand=2026-01-01&stand=x']) {
        const r = await bestaetigtSenden(app(), { ziel: `${pfad}${q}`, claims: anna() });
        expect(r.status, q).toBe(400);
      }
    });

    it('RT-01: vertrauliche Feststellung für Nicht-Beteiligte nur mit Nummer und Status', async () => {
      // Eine Talwind-Feststellung, an der Thomas nicht beteiligt ist, vorübergehend vertraulich.
      const f = await mitTenant(DEMO_TENANT_ID, async (tx) => {
        const kandidaten = await tx.feststellung.findMany({
          where: { programm: { mandantId: DEMO_IDS.talwind }, vertraulich: false },
          include: { massnahmen: { select: { verantwortlich: true } } },
          orderBy: { nummer: 'asc' },
        });
        const x = kandidaten.find((k) => !beteiligteVon(k).includes(DEMO_IDS.thomas))!;
        await tx.feststellung.update({ where: { id: x.id }, data: { vertraulich: true } });
        return x;
      });
      try {
        // Thomas: Berufsträger mit Bezug auf Talwind, weder Admin noch zuständig.
        const r = await bestaetigtSenden(app(), {
          ziel: pfad,
          claims: anna({
            sub: DEMO_IDS.thomas,
            rol: { adm: false, bt: true },
            cli: { id: DEMO_IDS.talwind, bt: false, hb: false },
          }),
        });
        expect(r.status).toBe(200);
        const roh = await r.text();
        const daten = KontextAntwortSchema.parse((JSON.parse(roh) as { daten: unknown }).daten);
        expect(daten.feststellungen.find((x) => x.id === f.id)).toEqual({
          maskiert: true,
          id: f.id,
          nummer: f.nummer,
          vertraulich: true,
          status: f.status,
          erfasstAm: f.erfasstAm.toISOString(),
        });
        expect(roh).not.toContain(f.titel);
      } finally {
        await mitTenant(DEMO_TENANT_ID, (tx) =>
          tx.feststellung.update({ where: { id: f.id }, data: { vertraulich: false } }),
        );
      }
    });
  });

  describe('GET /v1/mandanten/:mandantId/portal/uebersicht', () => {
    const pfad = `/v1/mandanten/${DEMO_IDS.talwind}/portal/uebersicht`;

    it('Mandantenkontakt mit Rolle: 200, vertragsgemäß', async () => {
      const r = await bestaetigtSenden(app(), { ziel: pfad, roheClaims: jana(pfad) });
      expect(r.status).toBe(200);
      const u = PortalUebersichtAntwortSchema.parse((await json(r))['daten']);
      expect(u.mandant.id).toBe(DEMO_IDS.talwind);
      expect(u.rechte.portalLesen).toBe(true);
    });

    it('fremder Mandant im Pfad: 404', async () => {
      const fremd = `/v1/mandanten/${DEMO_IDS.seestern}/portal/uebersicht`;
      const r = await bestaetigtSenden(app(), { ziel: fremd, roheClaims: jana(fremd) });
      expect(r.status).toBe(404);
    });

    it('Kanzleiperson: 404 wie ein unbekannter Pfad (Portal nur für Mandantenkontakte)', async () => {
      const r = await bestaetigtSenden(app(), { ziel: pfad, claims: anna() });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    });

    it('Query: 400', async () => {
      const mitQuery = `${pfad}?stand=2026-01-01`;
      const q = await bestaetigtSenden(app(), { ziel: mitQuery, roheClaims: jana(mitQuery) });
      expect(q.status).toBe(400);
    });
  });

  describe('Mandantenanker und Kontaktrollen', () => {
    const tenant = randomUUID();
    const mandant = randomUUID();
    const ankerPfad = `/v1/mandanten/${mandant}`;
    const kontaktPfad = `${ankerPfad}/kontakte`;
    const admin = (over: Partial<AkteurClaims> = {}): Partial<AkteurClaims> => ({
      tnt: tenant,
      sub: randomUUID(),
      rol: { adm: true, bt: true },
      cli: { id: mandant, bt: false, hb: false },
      ...over,
    });
    const ankerBody = JSON.stringify({ name: 'Neu GmbH', rechtsform: 'KapG', datevNr: '1234' });

    it('PUT Anker: 200 (anlegen, dann unverändert)', async () => {
      const put = () =>
        bestaetigtSenden(app(), {
          methode: 'PUT',
          ziel: ankerPfad,
          body: ankerBody,
          claims: admin(),
        });
      const r1 = await put();
      expect(r1.status).toBe(200);
      expect(MandantAnkerAntwortSchema.parse((await json(r1))['daten']).angelegt).toBe(true);
      const r2 = await put();
      expect(MandantAnkerAntwortSchema.parse((await json(r2))['daten'])).toMatchObject({
        angelegt: false,
        geaendert: false,
      });
    });

    it('PUT Anker: falscher Mandant 404, Mandantenperson 404, ohne Zuständigkeit 403, Body 400', async () => {
      const fremd = await bestaetigtSenden(app(), {
        methode: 'PUT',
        ziel: `/v1/mandanten/${randomUUID()}`,
        body: ankerBody,
        claims: admin(),
      });
      expect(fremd.status).toBe(404);
      const kontaktClaims = mandantClaims(mandant, {
        tnt: tenant,
        req: { m: 'PUT', p: ankerPfad, b: bodySha256(new TextEncoder().encode(ankerBody)) },
      });
      const k = await bestaetigtSenden(app(), {
        methode: 'PUT',
        ziel: ankerPfad,
        body: ankerBody,
        roheClaims: kontaktClaims,
      });
      expect(k.status).toBe(404);
      const ohne = await bestaetigtSenden(app(), {
        methode: 'PUT',
        ziel: ankerPfad,
        body: ankerBody,
        claims: admin({ rol: { adm: false, bt: true } }),
      });
      expect(ohne.status).toBe(403);
      expect(await ohne.json()).toMatchObject({ fehler: { grund: 'BEARBEITEN' } });
      for (const body of [
        '{}',
        JSON.stringify({ name: 'A', rechtsform: 'KapG', tenantId: randomUUID() }),
        JSON.stringify({ name: 'A\u0000', rechtsform: 'KapG' }),
        // Unzulässige Zeichen (eine Regel, richtungszeichen.test.ts): ZWSP, LRM,
        // weiches Trennzeichen, Tag-Zeichen.
        JSON.stringify({ name: 'A\u200bB', rechtsform: 'KapG' }),
        JSON.stringify({ name: 'A\u200eB', rechtsform: 'KapG' }),
        JSON.stringify({ name: 'Neu GmbH', rechtsform: 'Kap\u00adG' }),
        JSON.stringify({ name: 'A\u{e0041}', rechtsform: 'KapG' }),
      ]) {
        const r = await bestaetigtSenden(app(), {
          methode: 'PUT',
          ziel: ankerPfad,
          body,
          claims: admin(),
        });
        expect(r.status, body).toBe(400);
      }
    });

    it('PUT/GET Kontakte: 200, Mandantenperson 404, falscher Mandant 404, Body 400', async () => {
      const kontaktId = randomUUID();
      const body = JSON.stringify({
        kontaktId,
        rollen: ['GESETZLICHER_VERTRETER'],
        funktion: 'GF',
      });
      const r = await bestaetigtSenden(app(), {
        methode: 'PUT',
        ziel: kontaktPfad,
        body,
        claims: admin(),
      });
      expect(r.status).toBe(200);
      expect(KontaktRollenAntwortSchema.parse((await json(r))['daten']).geaendert).toBe(true);
      const g = await bestaetigtSenden(app(), { ziel: kontaktPfad, claims: admin() });
      expect(g.status).toBe(200);
      const liste = KontakteAntwortSchema.parse((await json(g))['daten']);
      expect(liste.kontakte.map((x) => x.kontaktId)).toContain(kontaktId);
      expect(liste.rechte).toEqual({ bearbeiten: true });
      // Ohne Zuständigkeit: Lesen ja, Kennzeichen false (wie das 403 beim Setzen).
      const ohne = await bestaetigtSenden(app(), {
        ziel: kontaktPfad,
        claims: admin({ rol: { adm: false, bt: true } }),
      });
      expect(KontakteAntwortSchema.parse((await json(ohne))['daten']).rechte).toEqual({
        bearbeiten: false,
      });
      // Der neue Kontakt ist jetzt GV, darf aber Staff-Endpunkte nie nutzen.
      const kontaktGet = mandantClaims(mandant, {
        tnt: tenant,
        sub: kontaktId,
        req: { m: 'GET', p: kontaktPfad, b: bodySha256(new Uint8Array()) },
      });
      expect(
        (await bestaetigtSenden(app(), { ziel: kontaktPfad, roheClaims: kontaktGet })).status,
      ).toBe(404);
      const fremd = `/v1/mandanten/${randomUUID()}/kontakte`;
      expect((await bestaetigtSenden(app(), { ziel: fremd, claims: admin() })).status).toBe(404);
      for (const b of [
        JSON.stringify({ kontaktId, rollen: ['GESETZLICHER_VERTRETER', 'GESETZLICHER_VERTRETER'] }),
        JSON.stringify({ kontaktId: 'x', rollen: [] }),
        JSON.stringify({ kontaktId, rollen: [], mandantId: randomUUID() }),
        JSON.stringify({ kontaktId, rollen: [], funktion: 'G\u2060F' }),
        JSON.stringify({ kontaktId, rollen: [], funktion: 'G\u061cF' }),
      ]) {
        const x = await bestaetigtSenden(app(), {
          methode: 'PUT',
          ziel: kontaktPfad,
          body: b,
          claims: admin(),
        });
        expect(x.status, b).toBe(400);
      }
    });
  });

  describe('Audit', () => {
    it('GET /v1/audit: Admin 200, Nicht-Admin 403, Mandantenperson 404, Query 400', async () => {
      const ok = await bestaetigtSenden(app(), {
        ziel: '/v1/audit?limit=5&nach=0&aktion=tcms',
        claims: anna({ cli: undefined }),
      });
      expect(ok.status).toBe(200);
      const daten = AuditListeAntwortSchema.parse((await json(ok))['daten']);
      expect(daten.eintraege.length).toBeLessThanOrEqual(5);
      const nichtAdmin = await bestaetigtSenden(app(), {
        ziel: '/v1/audit',
        claims: anna({ rol: { adm: false, bt: true } }),
      });
      expect(nichtAdmin.status).toBe(403);
      expect(
        (await bestaetigtSenden(app(), { ziel: '/v1/audit', roheClaims: jana('/v1/audit') }))
          .status,
      ).toBe(404);
      for (const q of [
        '?limit=501',
        '?limit=abc',
        '?nach=-1',
        '?nach=1&vor=2',
        '?x=1',
        '?nach=99999999999',
      ]) {
        const r = await bestaetigtSenden(app(), { ziel: `/v1/audit${q}`, claims: anna() });
        expect(r.status, q).toBe(400);
      }
    });

    it('GET /v1/audit (tcms-s11): vertrauliche Feststellung für Admin ohne Bezug maskiert, mit Bezug lesbar; Prüfung intakt', async () => {
      // Eigener Tenant: die Demodaten bleiben unberührt.
      const t = randomUUID();
      const m = randomUUID();
      const geheim = 'Quelle Geheimakte API';
      const f = await mitTenant(t, async (tx) => {
        await tx.mandant.create({ data: { id: m, name: 'Vertraulich GmbH', rechtsform: 'KapG' } });
        const p = await tx.tcmsProgramm.create({
          data: { mandantId: m, paketId: 'ecommerce', paketVersion: '1.0' },
        });
        const f = await tx.feststellung.create({
          data: {
            programmId: p.id,
            nummer: 'F-API-1',
            titel: 'Vertraulich',
            sachverhalt: 'Vertraulicher Sachverhalt.',
            quelle: 'HINWEIS',
            quelleText: geheim,
            klasse: 'STEUERLICHER_FEHLER',
            schwere: 'HOCH',
            auswirkung: 'JA',
            vertraulich: true,
            erfasstVon: DEMO_IDS.anna,
          },
        });
        for (const aktion of ['tcms.feststellung.erfasst', 'tcms.feststellung.vertraulich']) {
          await schreibeAudit(tx, {
            actorId: DEMO_IDS.anna,
            actorName: 'Anna Geheim',
            aktion,
            objektTyp: 'Feststellung',
            objektId: f.id,
            programmId: p.id,
            detail: { quelle: geheim },
          });
        }
        return f;
      });
      const ohneBezug = await bestaetigtSenden(app(), {
        ziel: '/v1/audit',
        claims: anna({ tnt: t, cli: undefined }),
      });
      expect(ohneBezug.status).toBe(200);
      const roh = await json(ohneBezug);
      const daten = AuditListeAntwortSchema.parse(roh['daten']);
      expect(daten.eintraege).toHaveLength(2);
      for (const e of daten.eintraege) {
        expect(e).toMatchObject({ maskiert: true, objektId: f.id, vertraulich: true });
      }
      expect(daten.kopf?.hash).toBeNull();
      expect(JSON.stringify(roh)).not.toContain('Geheim');
      const mitBezug = await bestaetigtSenden(app(), {
        ziel: '/v1/audit',
        claims: anna({ tnt: t, cli: { id: m, bt: true, hb: false } }),
      });
      const offen = AuditListeAntwortSchema.parse((await json(mitBezug))['daten']);
      expect(offen.eintraege.map((e) => e.maskiert)).toEqual([false, false]);
      expect(offen.kopf?.hash).toMatch(/^[0-9a-f]{64}$/);
      const pruefung = await bestaetigtSenden(app(), {
        methode: 'POST',
        ziel: '/v1/audit/pruefen',
        body: '{}',
        claims: anna({ tnt: t, cli: undefined }),
      });
      expect(AuditPruefenAntwortSchema.parse((await json(pruefung))['daten'])).toEqual({
        status: 'INTAKT',
        geprueft: 2,
        bruchBei: null,
        grund: null,
        weiterAb: null,
      });
    });

    it('POST /v1/audit/pruefen: Admin 200, Nicht-Admin 403, Body 400', async () => {
      const ok = await bestaetigtSenden(app(), {
        methode: 'POST',
        ziel: '/v1/audit/pruefen',
        body: '{}',
        claims: anna(),
      });
      expect(ok.status).toBe(200);
      expect(AuditPruefenAntwortSchema.parse((await json(ok))['daten']).status).toBe('INTAKT');
      const nein = await bestaetigtSenden(app(), {
        methode: 'POST',
        ziel: '/v1/audit/pruefen',
        body: '{}',
        claims: anna({ rol: { adm: false, bt: true } }),
      });
      expect(nein.status).toBe(403);
      for (const body of ['{"ab":"x"}', '{"ab":-1}', '{"von":1}', '']) {
        const r = await bestaetigtSenden(app(), {
          methode: 'POST',
          ziel: '/v1/audit/pruefen',
          body,
          claims: anna(),
        });
        expect(r.status, body).toBe(400);
      }
    });
  });

  for (const [pfad, schema] of [
    ['/v1/portfolio', PortfolioAntwortSchema],
    ['/v1/arbeitskorb', ArbeitskorbAntwortSchema],
  ] as const) {
    describe(`POST ${pfad}`, () => {
      const liste = JSON.stringify({
        mandantIds: DEMO_MANDANTEN.map((m) => m.id),
        bt: [DEMO_IDS.talwind],
        hb: [],
      });
      const post = (body: string, over: Partial<AkteurClaims> = anna({ cli: undefined })) =>
        bestaetigtSenden(app(), { methode: 'POST', ziel: pfad, body, claims: over });

      it('liefert nur Mandanten der bestätigten Liste (200, vertragsgemäß)', async () => {
        const r = await post(liste);
        expect(r.status).toBe(200);
        const daten = schema.parse((await json(r))['daten']);
        expect(daten.heute).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const nur = await post(JSON.stringify({ mandantIds: [DEMO_IDS.seestern] }));
        const b = await json(nur);
        if (pfad === '/v1/portfolio') {
          const p = PortfolioAntwortSchema.parse(b['daten']);
          expect(p.zeilen.map((z) => z.mandant.id)).toEqual([DEMO_IDS.seestern]);
        } else {
          const k = ArbeitskorbAntwortSchema.parse(b['daten']);
          const ids = [...k.durchfuehrungen, ...k.gegenzeichnungen, ...k.p153].map(
            (x) => x.mandant.id,
          );
          expect(ids.every((id) => id === DEMO_IDS.seestern)).toBe(true);
        }
      });

      it('fremder Tenant: Demo-IDs bleiben unsichtbar', async () => {
        const r = await post(liste, anna({ tnt: claims().tnt, cli: undefined }));
        expect(r.status).toBe(200);
        const b = await json(r);
        const leer =
          pfad === '/v1/portfolio'
            ? PortfolioAntwortSchema.parse(b['daten']).zeilen
            : ArbeitskorbAntwortSchema.parse(b['daten']).durchfuehrungen;
        expect(leer).toEqual([]);
      });

      it('Mandantenperson: 404 (kein Portal-Endpunkt)', async () => {
        const r = await bestaetigtSenden(app(), {
          methode: 'POST',
          ziel: pfad,
          body: liste,
          roheClaims: jana(pfad, 'POST', liste),
        });
        expect(r.status).toBe(404);
      });

      it('ungültiger Body: 400', async () => {
        for (const body of [
          JSON.stringify({ mandantIds: [DEMO_IDS.talwind, DEMO_IDS.talwind] }),
          JSON.stringify({ mandantIds: [DEMO_IDS.talwind], bt: [DEMO_IDS.seestern] }),
          JSON.stringify({ mandantIds: 'alle' }),
          JSON.stringify({
            mandantIds: Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE + 1 }, () => randomUUID()),
          }),
          '',
        ]) {
          const r = await post(body);
          expect(r.status, body.slice(0, 60)).toBe(400);
        }
      });

      it(`${MAX_MANDANTEN_JE_ANFRAGE} IDs passen in die Body-Grenze`, async () => {
        const body = JSON.stringify({
          mandantIds: Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE }, () => randomUUID()),
        });
        const r = await post(body);
        expect(r.status).toBe(200);
      });
    });
  }
});
