// =============================================================================
// Mandantentrennung gegen PostgreSQL (ADR 0001 §4, Aufgabe tcms-data 2).
//
// Läuft nur mit DB_TESTS=1 gegen eine migrierte Datenbank:
//   DATABASE_URL           Laufzeitrolle tcms_app
//   DATABASE_OWNER_URL     Eigentümerrolle tcms_owner
//   DATABASE_SUPERUSER_URL optional, für die Abweisung einer Superuser-Verbindung
// Jeder Lauf legt eigene Fixtures in zwei zufälligen Tenants an und stört
// andere Daten (Seed) nicht.
//
// Die Tests sind so geschnitten, dass sie ohne die jeweilige Schutzmaßnahme
// scheitern (RLS aus, FORCE fehlt, Policy fehlt oder zu weit, einfacher statt
// zusammengesetzter Fremdschlüssel, Grants zu weit, Sperre global oder fehlend).
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { GENESIS_HASH } from '@tcms/domain/audit';
import { pruefeAuditKette, schreibeAudit } from '../audit';
import {
  erzeugeClient,
  mitTenant,
  pruefeLaufzeitverbindung,
  pruefeTenantId,
  sperrSchluessel,
  TenantFehler,
  type Tx,
} from '../tenant';

const AKTIV = process.env['DB_TESTS'] === '1';
const APP_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DATABASE_OWNER_URL'];
const SUPER_URL = process.env['DATABASE_SUPERUSER_URL'];

/** Tabellen ohne tenant_id, ausdrücklich ausgenommen, mit den erlaubten App-Rechten. */
const OHNE_TENANT: Record<string, string[]> = {
  akteur_jti: ['SELECT', 'INSERT', 'DELETE'],
  _prisma_migrations: [],
};
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const NUR_ANHAENGEN = ['SELECT', 'INSERT'];
const ALLE_RECHTE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const POLICY_AUSDRUCK = '(tenant_id = tcms_aktueller_tenant())';

interface Fixture {
  tenant: string;
  mandantId: string;
  kontaktRolleId: string;
  programmId: string;
  teilbereichId: string;
  profilId: string;
  zielId: string;
  risikoId: string;
  risikoStandId: string;
  uebersteuerungId: string;
  kontrolleId: string;
  kontrolleStandId: string;
  durchfuehrungId: string;
  nachweisId: string;
  feststellungId: string;
  erklaerungId: string;
  massnahmeId: string;
  ereignisId: string;
  folgeId: string;
  landId: string;
  beschreibungId: string;
  freigabeId: string;
  nachrichtId: string;
  auditSeq: number;
}

/** Legt in jeder mandantengebundenen Tabelle mindestens eine Zeile an (als tcms_app). */
async function baueFixture(client: PrismaClient, tenant: string): Promise<Fixture> {
  return mitTenant(
    tenant,
    async (tx) => {
      const jetzt = new Date();
      const mandant = await tx.mandant.create({
        data: { id: randomUUID(), name: `Testmandant ${tenant.slice(0, 8)}`, rechtsform: 'KapG' },
      });
      const kontaktRolle = await tx.mandantKontaktRolle.create({
        data: { mandantId: mandant.id, kontaktId: randomUUID(), rolle: 'GESETZLICHER_VERTRETER' },
      });
      const programm = await tx.tcmsProgramm.create({
        data: { mandantId: mandant.id, paketId: 'ecommerce', paketVersion: '1.0' },
      });
      const teilbereich = await tx.teilbereich.create({
        data: {
          programmId: programm.id,
          name: 'E-Commerce',
          abgrenzung: 'Test',
          einschluesse: ['a'],
          ausschluesse: [],
        },
      });
      const profil = await tx.profilStand.create({
        data: { programmId: programm.id, version: 1, antworten: {}, gueltigAb: jetzt },
      });
      const ziel = await tx.complianceZiel.create({
        data: { teilbereichId: teilbereich.id, text: 'Ziel', wesentlichkeitEur: 1000 },
      });
      const risiko = await tx.risiko.create({
        data: { programmId: programm.id, code: 'R-UST-01', aktivAb: jetzt },
      });
      const risikoStand = await tx.risikoStand.create({
        data: {
          risikoId: risiko.id,
          version: 1,
          titel: 'Risiko',
          fehlerquelle: 'f',
          folge: 'g',
          normanker: [],
          s: 'M',
          w: 'MOEGLICH',
          r: 2,
          gt: 'FP',
          modell: 'ec-1.0',
          gueltigAb: jetzt,
        },
      });
      const uebersteuerung = await tx.uebersteuerung.create({
        data: {
          risikoId: risiko.id,
          sicht: 'DESIGN',
          klasse: 'GERING',
          berechnet: 'MITTEL',
          begruendung: 'Begründung mit mindestens dreißig Zeichen.',
          beantragtVon: randomUUID(),
        },
      });
      const kontrolle = await tx.kontrolle.create({
        data: { programmId: programm.id, code: 'K-EC-01', aktivAb: jetzt },
      });
      const kontrolleStand = await tx.kontrolleStand.create({
        data: {
          kontrolleId: kontrolle.id,
          version: 1,
          titel: 'Kontrolle',
          ziel: 'Ziel',
          art: 'D',
          ausfuehrung: 'M',
          vorlageTurnus: 'MONATLICH',
          vorlageAnlass: false,
          partei: 'KANZLEI',
          schluessel: true,
          nachweis: 'Abstimmung',
          mindestNachweise: 1,
          schritte: [],
          kennzahlen: [],
          faelligNachTagen: 10,
          gueltigAb: jetzt,
        },
      });
      await tx.risikoKontrolle.create({ data: { risikoId: risiko.id, kontrolleId: kontrolle.id } });
      const durchfuehrung = await tx.durchfuehrung.create({
        data: {
          kontrolleId: kontrolle.id,
          kontrolleStandId: kontrolleStand.id,
          periodeLabel: 'Okt 2026',
          periodeVon: new Date('2026-10-01'),
          periodeBis: new Date('2026-10-31'),
          faelligAm: new Date('2026-11-10'),
        },
      });
      const nachweis = await tx.nachweis.create({
        data: {
          durchfuehrungId: durchfuehrung.id,
          dokumentId: randomUUID(),
          dateiname: 'n.csv',
          mime: 'text/csv',
          groesse: 1,
          sha256: 'a'.repeat(64),
          hochgeladenVon: randomUUID(),
        },
      });
      const feststellung = await tx.feststellung.create({
        data: {
          programmId: programm.id,
          nummer: 'F-2026-001',
          titel: 'Feststellung',
          sachverhalt: 'Sachverhalt',
          quelle: 'KONTROLLE',
          quelleText: 'K-EC-01',
          durchfuehrungId: durchfuehrung.id,
          klasse: 'HINWEIS',
          schwere: 'GERING',
          auswirkung: 'UNKLAR',
          erfasstVon: randomUUID(),
        },
      });
      await tx.feststellungRisiko.create({
        data: { feststellungId: feststellung.id, risikoId: risiko.id },
      });
      const erklaerung = await tx.betroffeneErklaerung.create({
        data: { feststellungId: feststellung.id, steuerart: 'USt', land: 'DE', zeitraum: '2026' },
      });
      const massnahme = await tx.massnahme.create({
        data: {
          feststellungId: feststellung.id,
          wiedervorlageNr: 1,
          beschreibung: 'Maßnahme',
          verantwortlich: randomUUID(),
          frist: new Date('2026-12-31'),
        },
      });
      const ereignis = await tx.ereignis.create({
        data: {
          programmId: programm.id,
          nummer: '2026-T-0001',
          typ: 'LAGER',
          titel: 'Ereignis',
          beschreibung: 'b',
          quelle: 'MANUELL',
          ereignisDatum: new Date('2026-10-01'),
        },
      });
      const folge = await tx.ereignisFolge.create({
        data: { ereignisId: ereignis.id, art: 'HINWEIS', text: 'Folge' },
      });
      const land = await tx.landStand.create({
        data: {
          programmId: programm.id,
          land: 'AT',
          fernverkaeufeLfdEur: 1,
          fernverkaeufeVorjahrEur: 2,
          oss: true,
          lokaleUstNr: false,
          stand: new Date('2026-10-01'),
        },
      });
      const beschreibung = await tx.beschreibungVersion.create({
        data: { programmId: programm.id, nummer: '1.0', abschnitte: [] },
      });
      const freigabe = await tx.freigabe.create({
        data: {
          programmId: programm.id,
          art: 'KENNTNISNAHME',
          refId: beschreibung.id,
          titel: 'Freigabe',
          angefordertVon: randomUUID(),
          empfaengerId: randomUUID(),
        },
      });
      const nachricht = await tx.nachricht.create({
        data: {
          empfaengerId: randomUUID(),
          zweck: 'FREIGABE_CODE',
          betreff: 'Betreff',
          text: 'Text',
        },
      });
      await schreibeAudit(tx, {
        actorId: randomUUID(),
        actorName: 'Testperson',
        aktion: 'tcms.test.fixture',
        objektTyp: 'TcmsProgramm',
        objektId: programm.id,
        programmId: programm.id,
      });
      const audit = await tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'desc' } });
      return {
        tenant,
        mandantId: mandant.id,
        kontaktRolleId: kontaktRolle.id,
        programmId: programm.id,
        teilbereichId: teilbereich.id,
        profilId: profil.id,
        zielId: ziel.id,
        risikoId: risiko.id,
        risikoStandId: risikoStand.id,
        uebersteuerungId: uebersteuerung.id,
        kontrolleId: kontrolle.id,
        kontrolleStandId: kontrolleStand.id,
        durchfuehrungId: durchfuehrung.id,
        nachweisId: nachweis.id,
        feststellungId: feststellung.id,
        erklaerungId: erklaerung.id,
        massnahmeId: massnahme.id,
        ereignisId: ereignis.id,
        folgeId: folge.id,
        landId: land.id,
        beschreibungId: beschreibung.id,
        freigabeId: freigabe.id,
        nachrichtId: nachricht.id,
        auditSeq: audit.seq,
      };
    },
    { client },
  );
}

function pgClient(url: string | undefined): pg.Client {
  if (!url) throw new Error('Verbindungs-URL für den DB-Test fehlt');
  return new pg.Client({ connectionString: url });
}

/** Erwartet einen Fehler; liefert die Meldung (für Musterprüfungen). */
async function fehlerVon(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('Erwarteter Fehler blieb aus');
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

describe.skipIf(!AKTIV)('Mandantentrennung in PostgreSQL', () => {
  let app: PrismaClient;
  let roh: pg.Client; // tcms_app ohne Kontext, für Rohbefehle
  let A: Fixture;
  let B: Fixture;
  let tenantTabellen: string[];

  beforeAll(async () => {
    app = erzeugeClient(APP_URL);
    roh = pgClient(APP_URL);
    await roh.connect();
    A = await baueFixture(app, randomUUID());
    B = await baueFixture(app, randomUUID());
    const { rows } = await roh.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    tenantTabellen = rows.map((r) => r.relname).filter((t) => !(t in OHNE_TENANT));
  });

  afterAll(async () => {
    await roh?.end();
    await app?.$disconnect();
  });

  // ---------------------------------------------------------------- Katalog --

  describe('Katalog: jede Tabelle', () => {
    it('ist mandantengebunden oder ausdrücklich ausgenommen', () => {
      expect(tenantTabellen.length).toBeGreaterThanOrEqual(25);
      for (const pflicht of [
        'Mandant',
        'MandantKontaktRolle',
        'TcmsProgramm',
        'Risiko',
        'Kontrolle',
        'Durchfuehrung',
        'Feststellung',
        'Ereignis',
        'BeschreibungVersion',
        'Freigabe',
        'AuditEvent',
      ]) {
        expect(tenantTabellen).toContain(pflicht);
      }
    });

    it('hat tenant_id uuid NOT NULL', async () => {
      const { rows } = await roh.query<{
        table_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT table_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
      );
      const je = new Map(rows.map((r) => [r.table_name, r]));
      for (const t of tenantTabellen) {
        expect(je.get(t), t).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
      }
      for (const t of Object.keys(OHNE_TENANT)) expect(je.has(t)).toBe(false);
    });

    it('hat RLS aktiv und erzwungen, Eigentümer tcms_owner', async () => {
      const { rows } = await roh.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
      );
      const je = new Map(rows.map((r) => [r.relname, r]));
      for (const t of tenantTabellen) {
        expect(je.get(t), t).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: 'tcms_owner',
        });
      }
      expect(je.get('akteur_jti')?.owner).toBe('tcms_owner');
    });

    it('hat genau eine Policy: für alle Befehle, USING und WITH CHECK auf den Tenant', async () => {
      const { rows } = await roh.query<{
        tablename: string;
        permissive: string;
        roles: string[] | string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename, permissive, roles, cmd, qual, with_check FROM pg_policies
         WHERE schemaname = 'public'`,
      );
      for (const t of tenantTabellen) {
        const p = rows.filter((r) => r.tablename === t);
        expect(p, t).toHaveLength(1);
        expect(p[0], t).toMatchObject({
          permissive: 'PERMISSIVE',
          cmd: 'ALL',
          qual: POLICY_AUSDRUCK,
          with_check: POLICY_AUSDRUCK,
        });
      }
      expect(rows.filter((r) => r.tablename in OHNE_TENANT)).toHaveLength(0);
    });

    it('gibt der App-Rolle nur DML (Audit nur anhängen, akteur_jti ohne UPDATE)', async () => {
      for (const t of [...tenantTabellen, ...Object.keys(OHNE_TENANT)]) {
        const erwartet =
          t in OHNE_TENANT ? OHNE_TENANT[t]! : t === 'AuditEvent' ? NUR_ANHAENGEN : DML;
        const { rows } = await roh.query<{ recht: string; hat: boolean }>(
          `SELECT r AS recht, has_table_privilege('tcms_app', format('public.%I', $1::text), r) AS hat
           FROM unnest($2::text[]) AS r`,
          [t, ALLE_RECHTE],
        );
        const hat = rows.filter((r) => r.hat).map((r) => r.recht);
        expect(hat.sort(), t).toEqual([...erwartet].sort());
      }
      const spalten = await roh.query<{ hat: boolean }>(
        `SELECT has_any_column_privilege('tcms_app', 'public."AuditEvent"', 'UPDATE') AS hat`,
      );
      expect(spalten.rows[0]?.hat).toBe(false);
    });

    it('Rollen: tcms_app ohne Superuser/BYPASSRLS/Owner-Mitgliedschaft, tcms_owner ohne BYPASSRLS', async () => {
      const { rows } = await roh.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        owner_mitglied: boolean;
      }>(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
                pg_has_role(oid, 'tcms_owner', 'MEMBER') AS owner_mitglied
         FROM pg_roles WHERE rolname IN ('tcms_app', 'tcms_owner') ORDER BY rolname`,
      );
      expect(rows).toEqual([
        {
          rolname: 'tcms_app',
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          owner_mitglied: false,
        },
        {
          rolname: 'tcms_owner',
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          owner_mitglied: true,
        },
      ]);
    });

    it('jedes Prisma-Feld hat eine Spalte (handgeschriebene Migration passt zum Schema)', async () => {
      const { rows } = await roh.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const spalten = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      for (const m of Prisma.dmmf.datamodel.models) {
        const tabelle = m.dbName ?? m.name;
        for (const f of m.fields) {
          if (f.kind === 'object') continue;
          expect(spalten.has(`${tabelle}.${f.dbName ?? f.name}`), `${tabelle}.${f.name}`).toBe(
            true,
          );
        }
      }
    });
  });

  // --------------------------------------------------------- Sichtbarkeit --

  describe('Sichtbarkeit der App-Rolle', () => {
    it('ohne Kontext: keine Zeile in keiner Tabelle', async () => {
      for (const t of tenantTabellen) {
        const { rows } = await roh.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(t)}`);
        expect(Number(rows[0]?.n), t).toBe(0);
      }
    });

    it.each([
      ['leer', ''],
      ['keine UUID', 'nicht-uuid'],
      ['SQL im Wert', "x' OR '1'='1"],
      ['UUID mit Zusatz', `${'0'.repeat(8)}-0000-4000-8000-000000000000 OR true`],
    ])('ungültiger Kontext (%s): keine Zeile, kein Fehler', async (_n, wert) => {
      await roh.query('BEGIN');
      try {
        await roh.query(`SELECT set_config('tcms.tenant_id', $1, true)`, [wert]);
        for (const t of tenantTabellen) {
          const { rows } = await roh.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(t)}`);
          expect(Number(rows[0]?.n), t).toBe(0);
        }
      } finally {
        await roh.query('ROLLBACK');
      }
    });

    it('der Kontext gilt nur in der Transaktion, nicht für die Verbindung danach', async () => {
      await roh.query('BEGIN');
      await roh.query(`SELECT set_config('tcms.tenant_id', $1, true)`, [A.tenant]);
      const drin = await roh.query<{ n: string }>(`SELECT count(*) AS n FROM "Mandant"`);
      await roh.query('COMMIT');
      const danach = await roh.query<{ n: string }>(`SELECT count(*) AS n FROM "Mandant"`);
      expect(Number(drin.rows[0]?.n)).toBeGreaterThan(0);
      expect(Number(danach.rows[0]?.n)).toBe(0);
    });

    it('mit Tenant A: nur Zeilen von A in jeder Tabelle (und umgekehrt)', async () => {
      for (const f of [A, B]) {
        await mitTenant(
          f.tenant,
          async (tx) => {
            for (const t of tenantTabellen) {
              const [z] = await tx.$queryRawUnsafe<{ alle: bigint; fremd: bigint }[]>(
                `SELECT count(*) AS alle, count(*) FILTER (WHERE tenant_id <> $1::uuid) AS fremd FROM ${q(t)}`,
                f.tenant,
              );
              expect(Number(z?.fremd), `${t} fremd`).toBe(0);
              expect(Number(z?.alle), `${t} eigene Fixture`).toBeGreaterThan(0);
            }
          },
          { client: app },
        );
      }
    });

    it('mit Tenant A: Objekte von B sind per ID nicht auffindbar', async () => {
      await mitTenant(
        A.tenant,
        async (tx) => {
          expect(await tx.mandant.findFirst({ where: { id: B.mandantId } })).toBeNull();
          // Auch mit dem vollständigen Schlüssel von B (Tenant aus fremder Quelle): RLS.
          expect(
            await tx.mandant.findUnique({
              where: { tenantId_id: { tenantId: B.tenant, id: B.mandantId } },
            }),
          ).toBeNull();
          expect(await tx.tcmsProgramm.findUnique({ where: { id: B.programmId } })).toBeNull();
          expect(await tx.risiko.findUnique({ where: { id: B.risikoId } })).toBeNull();
          expect(await tx.kontrolle.findUnique({ where: { id: B.kontrolleId } })).toBeNull();
          expect(
            await tx.durchfuehrung.findUnique({ where: { id: B.durchfuehrungId } }),
          ).toBeNull();
          expect(await tx.feststellung.findUnique({ where: { id: B.feststellungId } })).toBeNull();
          expect(await tx.ereignis.findUnique({ where: { id: B.ereignisId } })).toBeNull();
          expect(
            await tx.beschreibungVersion.findUnique({ where: { id: B.beschreibungId } }),
          ).toBeNull();
          expect(await tx.freigabe.findUnique({ where: { id: B.freigabeId } })).toBeNull();
          expect(await tx.auditEvent.findUnique({ where: { seq: B.auditSeq } })).toBeNull();
          expect(await tx.nachweis.findUnique({ where: { id: B.nachweisId } })).toBeNull();
          // Beziehungen führen ebenfalls nicht hinüber.
          const eigenes = await tx.tcmsProgramm.findUniqueOrThrow({
            where: { id: A.programmId },
            include: { risiken: true, kontrollen: true, feststellungen: true },
          });
          expect(eigenes.risiken.map((r) => r.id)).toEqual([A.risikoId]);
        },
        { client: app },
      );
    });

    it('mit Tenant A: UPDATE und DELETE auf Zeilen von B treffen nichts', async () => {
      await mitTenant(
        A.tenant,
        async (tx) => {
          const u = await tx.mandant.updateMany({
            where: { id: B.mandantId },
            data: { name: 'übernommen' },
          });
          expect(u.count).toBe(0);
          const d = await tx.nachricht.deleteMany({ where: { id: B.nachrichtId } });
          expect(d.count).toBe(0);
          const roh2 = await tx.$executeRawUnsafe(
            `UPDATE "Freigabe" SET status = 'FREIGEGEBEN' WHERE id = $1`,
            B.freigabeId,
          );
          expect(roh2).toBe(0);
        },
        { client: app },
      );
      await mitTenant(
        B.tenant,
        async (tx) => {
          expect((await tx.mandant.findFirstOrThrow({ where: { id: B.mandantId } })).name).not.toBe(
            'übernommen',
          );
          expect(await tx.nachricht.findUnique({ where: { id: B.nachrichtId } })).not.toBeNull();
          expect(
            (await tx.freigabe.findUniqueOrThrow({ where: { id: B.freigabeId } })).status,
          ).toBe('OFFEN');
        },
        { client: app },
      );
    });
  });

  // -------------------------------------------------------------- Schreiben --

  describe('Schreiben über Tenantgrenzen', () => {
    it('INSERT mit fremder tenant_id scheitert in jeder Tabelle (RLS WITH CHECK)', async () => {
      for (const t of tenantTabellen) {
        const { rows } = await roh.query<{ spalten: string[] }>(
          `SELECT array_agg(quote_ident(column_name) ORDER BY ordinal_position) AS spalten
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [t],
        );
        const spalten = rows[0]!.spalten;
        const auswahl = spalten.map((s) => (s === 'tenant_id' ? `$1::uuid AS tenant_id` : s));
        const meldung = await fehlerVon(
          mitTenant(
            A.tenant,
            (tx) =>
              tx.$executeRawUnsafe(
                `INSERT INTO ${q(t)} (${spalten.join(', ')})
                 SELECT ${auswahl.join(', ')} FROM ${q(t)} LIMIT 1`,
                B.tenant,
              ),
            { client: app },
          ),
        );
        expect(meldung, t).toMatch(/row-level security/);
      }
    });

    it('INSERT ohne Kontext scheitert (tenant_id bleibt NULL)', async () => {
      const meldung = await fehlerVon(
        roh.query(
          `INSERT INTO "Nachricht" (id, "empfaengerId", zweck, betreff, text)
           VALUES ($1, $2, 'FREIGABE_CODE', 'x', 'x')`,
          [randomUUID(), randomUUID()],
        ),
      );
      expect(meldung).toMatch(/null value in column "tenant_id"|row-level security/);
    });

    it('UPDATE auf fremde tenant_id scheitert in jeder Tabelle', async () => {
      for (const t of tenantTabellen) {
        const meldung = await fehlerVon(
          mitTenant(
            A.tenant,
            (tx) => tx.$executeRawUnsafe(`UPDATE ${q(t)} SET tenant_id = $1::uuid`, B.tenant),
            { client: app },
          ),
        );
        expect(meldung, t).toMatch(t === 'AuditEvent' ? /permission denied/ : /row-level security/);
      }
    });

    it('Prisma-INSERT mit ausdrücklich fremdem Tenant scheitert', async () => {
      const meldung = await fehlerVon(
        mitTenant(
          A.tenant,
          (tx) =>
            tx.mandant.create({
              data: { id: randomUUID(), tenantId: B.tenant, name: 'x', rechtsform: 'x' },
            }),
          { client: app },
        ),
      );
      expect(meldung).toMatch(/row-level security/);
    });

    it('Verweise auf Objekte von B scheitern wie Verweise auf nicht vorhandene (kein Orakel)', async () => {
      const versuche: [string, (tx: Tx, id: string) => Promise<unknown>, string][] = [
        [
          'Risiko → Programm',
          (tx, id) =>
            tx.risiko.create({ data: { programmId: id, code: 'X', aktivAb: new Date() } }),
          B.programmId,
        ],
        [
          'Kontaktrolle → Mandant',
          (tx, id) =>
            tx.mandantKontaktRolle.create({
              data: { mandantId: id, kontaktId: randomUUID(), rolle: 'MITARBEITER' },
            }),
          B.mandantId,
        ],
        [
          'Nachweis → Durchführung',
          (tx, id) =>
            tx.nachweis.create({
              data: {
                durchfuehrungId: id,
                dokumentId: 'd',
                dateiname: 'x',
                mime: 'text/plain',
                groesse: 1,
                sha256: 'b'.repeat(64),
                hochgeladenVon: randomUUID(),
              },
            }),
          B.durchfuehrungId,
        ],
        [
          'Feststellung-Risiko → Risiko',
          (tx, id) =>
            tx.feststellungRisiko.create({
              data: { feststellungId: A.feststellungId, risikoId: id },
            }),
          B.risikoId,
        ],
        [
          'Durchführung → Kontrollstand',
          (tx, id) =>
            tx.durchfuehrung.create({
              data: {
                kontrolleId: A.kontrolleId,
                kontrolleStandId: id,
                periodeLabel: 'x',
                periodeVon: new Date('2026-01-01'),
                periodeBis: new Date('2026-01-31'),
                faelligAm: new Date('2026-02-10'),
              },
            }),
          B.kontrolleStandId,
        ],
      ];
      for (const [name, anlegen, fremdeId] of versuche) {
        const fremd = await fehlerVon(
          mitTenant(A.tenant, (tx) => anlegen(tx, fremdeId), { client: app }),
        );
        const unbekannteId = name.includes('Mandant') ? randomUUID() : `unbekannt-${randomUUID()}`;
        const unbekannt = await fehlerVon(
          mitTenant(A.tenant, (tx) => anlegen(tx, unbekannteId), { client: app }),
        );
        expect(fremd, name).toMatch(/Foreign key constraint/i);
        expect(unbekannt, name).toMatch(/Foreign key constraint/i);
        // Gleicher Fehler, ohne ID oder Inhalt des fremden Objekts.
        expect(fremd.replaceAll(fremdeId, '<id>'), name).toBe(
          unbekannt.replaceAll(unbekannteId, '<id>'),
        );
        expect(fremd).not.toContain(B.tenant);
      }
    });
  });

  // ---------------------------------------------------- RLS nicht abschaltbar --

  describe('App-Rolle kann RLS nicht umgehen', () => {
    it.each([
      [
        'ALTER TABLE … DISABLE RLS',
        `ALTER TABLE "Mandant" DISABLE ROW LEVEL SECURITY`,
        /must be owner/,
      ],
      [
        'ALTER TABLE … NO FORCE RLS',
        `ALTER TABLE "Mandant" NO FORCE ROW LEVEL SECURITY`,
        /must be owner/,
      ],
      ['DROP POLICY', `DROP POLICY tcms_tenant ON "Mandant"`, /must be owner/],
      ['CREATE POLICY', `CREATE POLICY offen ON "Mandant" USING (true)`, /must be owner/],
      ['ALTER POLICY', `ALTER POLICY tcms_tenant ON "Mandant" USING (true)`, /must be owner/],
      [
        'Tenant-Funktion ersetzen',
        `CREATE OR REPLACE FUNCTION tcms_aktueller_tenant() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`,
        /must be owner|permission denied/,
      ],
      ['ALTER TABLE … OWNER', `ALTER TABLE "Mandant" OWNER TO tcms_app`, /must be owner/],
      ['TRUNCATE', `TRUNCATE "Mandant" CASCADE`, /permission denied/],
      ['SET ROLE tcms_owner', `SET ROLE tcms_owner`, /permission denied/],
      ['SET ROLE postgres', `SET ROLE postgres`, /permission denied/],
      ['SET SESSION AUTHORIZATION', `SET SESSION AUTHORIZATION tcms_owner`, /permission denied/],
      ['neue Tabelle', `CREATE TABLE schatten (id int)`, /permission denied/],
      ['temporäre Tabelle', `CREATE TEMP TABLE schatten (id int)`, /permission denied/],
      [
        'Trigger anlegen',
        `CREATE TRIGGER t BEFORE INSERT ON "Mandant" FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
        /permission denied|must be owner/,
      ],
      ['Audit ändern', `UPDATE "AuditEvent" SET "actorName" = 'x'`, /permission denied/],
      ['Audit löschen', `DELETE FROM "AuditEvent"`, /permission denied/],
    ])('%s scheitert', async (_name, sql, muster) => {
      expect(await fehlerVon(roh.query(sql))).toMatch(muster);
    });

    it('SET row_security = off führt zu Fehlern statt zu Daten', async () => {
      await roh.query('BEGIN');
      try {
        await roh.query(`SET LOCAL row_security = off`);
        await roh.query(`SELECT set_config('tcms.tenant_id', $1, true)`, [A.tenant]);
        expect(await fehlerVon(roh.query(`SELECT * FROM "Mandant"`))).toMatch(/row-level security/);
      } finally {
        await roh.query('ROLLBACK');
      }
    });
  });

  // ------------------------------------------------------------- mitTenant --

  describe('mitTenant', () => {
    it.each([
      ['leer', ''],
      ['keine UUID', 'mandant-1'],
      ['SQL', "' OR 1=1 --"],
      ['Nil-UUID', '00000000-0000-0000-0000-000000000000'],
      ['UUID mit Zusatz', `${randomUUID()}x`],
    ])('weist %s vor jedem Datenbankzugriff ab', async (_n, id) => {
      let aufgerufen = false;
      await expect(
        mitTenant(
          id,
          async () => {
            aufgerufen = true;
          },
          { client: app },
        ),
      ).rejects.toBeInstanceOf(TenantFehler);
      expect(aufgerufen).toBe(false);
    });

    it('normalisiert Großschreibung (gleicher Tenant, gleiche Sperre)', async () => {
      const gross = A.tenant.toUpperCase();
      expect(pruefeTenantId(gross)).toBe(A.tenant);
      expect(sperrSchluessel('audit', gross)).toBe(sperrSchluessel('audit', A.tenant));
      const n = await mitTenant(gross, (tx) => tx.mandant.count(), { client: app });
      expect(n).toBeGreaterThan(0);
    });

    it('weist eine Eigentümer-Verbindung ab (könnte RLS abschalten)', async () => {
      const owner = erzeugeClient(OWNER_URL);
      try {
        const meldung = await fehlerVon(
          mitTenant(A.tenant, (tx) => tx.mandant.count(), { client: owner }),
        );
        expect(meldung).toMatch(/Laufzeitverbindung abgewiesen/);
        expect(meldung).not.toMatch(/tcms_owner:|postgresql:\/\//);
      } finally {
        await owner.$disconnect();
      }
    });

    it('Startprüfung: DATABASE_URL als tcms_app wird angenommen', async () => {
      await expect(pruefeLaufzeitverbindung()).resolves.toBeUndefined();
    });

    it.skipIf(!SUPER_URL)('weist eine Superuser-Verbindung ab', async () => {
      const su = erzeugeClient(SUPER_URL);
      try {
        expect(
          await fehlerVon(mitTenant(A.tenant, (tx) => tx.mandant.count(), { client: su })),
        ).toMatch(/Laufzeitverbindung abgewiesen/);
      } finally {
        await su.$disconnect();
      }
    });

    // RT-02: Ein im Callback umgesetzter Tenant-Kontext führt zum Rollback.
    describe('Tenant-Kontext unverändert bis zum Commit (RT-02)', () => {
      const nameVon = (f: Fixture) =>
        mitTenant(
          f.tenant,
          async (tx) => (await tx.mandant.findFirstOrThrow({ where: { id: f.mandantId } })).name,
          { client: app },
        );
      const mitLog = async <T>(fn: () => Promise<T>) => {
        const zeilen: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          zeilen.push(String(chunk));
          return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof process.stdout.write;
        try {
          return { ergebnis: await fn().catch((e: unknown) => e), zeilen };
        } finally {
          process.stdout.write = original;
        }
      };

      it('Umsetzen auf einen fremden Tenant: Rollback, TenantFehler, Log ohne Details', async () => {
        const vorherA = await nameVon(A);
        const vorherB = await nameVon(B);
        const neu = `gekapert-${randomUUID().slice(0, 8)}`;
        const { ergebnis, zeilen } = await mitLog(() =>
          mitTenant(
            A.tenant,
            async (tx) => {
              // Eigene Änderung im richtigen Kontext – muss mit zurückgerollt werden.
              await tx.mandant.update({
                where: { tenantId_id: { tenantId: A.tenant, id: A.mandantId } },
                data: { name: neu },
              });
              await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${B.tenant}, true)`;
              await tx.$executeRaw`UPDATE "Mandant" SET name = ${neu} WHERE id = ${B.mandantId}::uuid`;
              return tx.$queryRaw<{ name: string }[]>`SELECT name FROM "Mandant"`;
            },
            { client: app },
          ),
        );
        expect(ergebnis).toBeInstanceOf(TenantFehler);
        expect(String((ergebnis as Error).message)).not.toContain(B.tenant);
        expect(await nameVon(B)).toBe(vorherB);
        expect(await nameVon(A)).toBe(vorherA);
        const log = zeilen.filter((z) => z.includes('tenant_kontext_veraendert'));
        expect(log).toHaveLength(1);
        expect(JSON.parse(log[0]!)).toEqual({
          zeit: expect.any(String),
          stufe: 'error',
          ereignis: 'tenant_kontext_veraendert',
        });
        for (const z of zeilen) {
          expect(z).not.toContain(A.tenant);
          expect(z).not.toContain(B.tenant);
        }
      });

      it.each([
        ['geleert', ''],
        ['Großschreibung', 'gross'],
        ['zufälliger Tenant', 'zufall'],
      ])('Kontext %s: Rollback', async (_n, art) => {
        const wert =
          art === 'gross' ? A.tenant.toUpperCase() : art === 'zufall' ? randomUUID() : '';
        const ergebnis = await mitTenant(
          A.tenant,
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${wert}, true)`;
            return 'durch';
          },
          { client: app },
        ).catch((e: unknown) => e);
        expect(ergebnis).toBeInstanceOf(TenantFehler);
      });

      it('Kontext auch sitzungsweit (is_local = false) umgesetzt: Rollback, Verbindung danach ohne Kontext', async () => {
        const ergebnis = await mitTenant(
          A.tenant,
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${B.tenant}, false)`;
          },
          { client: app },
        ).catch((e: unknown) => e);
        expect(ergebnis).toBeInstanceOf(TenantFehler);
        // Rollback verwirft auch die Sitzungseinstellung der Transaktion.
        const n = await app.mandant.count();
        expect(n).toBe(0);
      });

      it('unverändert: Ergebnis kommt an, Änderungen bleiben', async () => {
        const r = await mitTenant(A.tenant, (tx) => tx.mandant.count(), { client: app });
        expect(r).toBeGreaterThan(0);
      });
    });
  });

  // ------------------------------------------------------------ Audit-Kette --

  describe('Audit-Kette je Tenant', () => {
    const eintrag = (aktion: string) => ({
      actorId: randomUUID(),
      actorName: 'Parallel',
      aktion,
      objektTyp: 'Test',
      objektId: aktion,
    });

    it('schreibt nur mit Kontext; der Tenant kommt aus dem Kontext', async () => {
      const ohne = await fehlerVon(app.$transaction((tx) => schreibeAudit(tx, eintrag('ohne'))));
      expect(ohne).toMatch(/Kein Tenant-Kontext/);
      const neu = await mitTenant(
        A.tenant,
        async (tx) => {
          await schreibeAudit(tx, eintrag('kontext'));
          return tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'desc' } });
        },
        { client: app },
      );
      expect(neu.tenantId).toBe(A.tenant);
      expect(neu.kettenVersion).toBe(2);
    });

    it('zwei Tenants blockieren sich nicht, derselbe Tenant wartet', async () => {
      let freigeben!: () => void;
      const freigabe = new Promise<void>((r) => (freigeben = r));
      let gesperrt!: () => void;
      const sperreGehalten = new Promise<void>((r) => (gesperrt = r));
      const halter = mitTenant(
        A.tenant,
        async (tx) => {
          await schreibeAudit(tx, eintrag('halter'));
          gesperrt();
          await freigabe;
        },
        { client: app },
      );
      await sperreGehalten;
      let a2: Promise<void> = Promise.resolve();
      try {
        // Tenant B schreibt, während A die Sperre hält.
        const b = mitTenant(B.tenant, (tx) => schreibeAudit(tx, eintrag('b-parallel')), {
          client: app,
        });
        const bFertig = await Promise.race([
          b.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
        ]);
        expect(bFertig).toBe(true);

        // Ein zweiter Schreiber in A wartet auf die Sperre.
        let a2Fertig = false;
        a2 = mitTenant(A.tenant, (tx) => schreibeAudit(tx, eintrag('a-zweiter')), {
          client: app,
        }).then(() => {
          a2Fertig = true;
        });
        await new Promise((r) => setTimeout(r, 750));
        expect(a2Fertig).toBe(false);
        freigeben();
        await Promise.all([halter, a2]);
        expect(a2Fertig).toBe(true);
      } finally {
        // Auch bei einem Fehlschlag die Sperre lösen, damit Folgetests nicht hängen.
        freigeben();
        await Promise.allSettled([halter, a2]);
      }
    });

    it('parallele Schreiber desselben Tenants verzweigen die Kette nicht', async () => {
      const vorher = await mitTenant(A.tenant, (tx) => tx.auditEvent.count(), { client: app });
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          mitTenant(A.tenant, (tx) => schreibeAudit(tx, eintrag(`p${i}`)), { client: app }),
        ),
      );
      const [anzahl, pruefung] = await mitTenant(
        A.tenant,
        async (tx) => [await tx.auditEvent.count(), await pruefeAuditKette(tx)] as const,
        { client: app },
      );
      expect(anzahl).toBe(vorher + 12);
      expect(pruefung).toMatchObject({ gueltig: true, geprueft: anzahl });
      const pruefungB = await mitTenant(B.tenant, (tx) => pruefeAuditKette(tx), { client: app });
      expect(pruefungB.gueltig).toBe(true);
    });

    it('eine Verzweigung scheitert auch ohne Sperre am eindeutigen Vorgänger', async () => {
      const meldung = await fehlerVon(
        mitTenant(
          A.tenant,
          async (tx) => {
            const erster = await tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'asc' } });
            expect(erster.prevHash).toBe(GENESIS_HASH);
            const letzter = await tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'desc' } });
            await tx.auditEvent.create({
              data: {
                pos: letzter.pos + 1,
                kettenVersion: 2,
                at: new Date(),
                actorName: 'Gabel',
                aktion: 'tcms.test.gabel',
                objektTyp: 'Test',
                objektId: 'gabel',
                detail: {},
                prevHash: erster.prevHash,
                hash: 'f'.repeat(64),
              },
            });
          },
          { client: app },
        ),
      );
      expect(meldung).toMatch(/Unique constraint/i);
    });

    // RT-03: Position je Tenant statt globaler Sequenz.
    it('Position zählt je Tenant lückenlos ab 1; fremde Schreiber reißen keine Lücke', async () => {
      const pos = (tenant: string, objektId: string) =>
        mitTenant(
          tenant,
          async (tx) => {
            await schreibeAudit(tx, eintrag(objektId));
            return (
              await tx.auditEvent.findFirstOrThrow({ where: { objektId }, select: { pos: true } })
            ).pos;
          },
          { client: app },
        );
      const lauf = randomUUID().slice(0, 8);
      const a1 = await pos(A.tenant, `rt03-a1-${lauf}`);
      await pos(B.tenant, `rt03-b1-${lauf}`);
      const a2 = await pos(A.tenant, `rt03-a2-${lauf}`);
      expect(a2 - a1).toBe(1);
      for (const t of [A.tenant, B.tenant]) {
        const alle = await mitTenant(
          t,
          (tx) => tx.auditEvent.findMany({ orderBy: { pos: 'asc' }, select: { pos: true } }),
          { client: app },
        );
        expect(alle.map((x) => x.pos)).toEqual(alle.map((_, i) => i + 1));
      }
    });

    it('doppelte Position scheitert am eindeutigen (tenant_id, pos), Position < 1 am CHECK', async () => {
      const anlegen = (pos: (letzter: number) => number) =>
        fehlerVon(
          mitTenant(
            A.tenant,
            async (tx) => {
              const letzter = await tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'desc' } });
              await tx.auditEvent.create({
                data: {
                  pos: pos(letzter.pos),
                  kettenVersion: 2,
                  at: new Date(),
                  actorName: 'Doppelt',
                  aktion: 'tcms.test.doppelt',
                  objektTyp: 'Test',
                  objektId: 'doppelt',
                  detail: {},
                  prevHash: randomBytes(32).toString('hex'),
                  hash: randomBytes(32).toString('hex'),
                },
              });
            },
            { client: app },
          ),
        );
      expect(await anlegen((letzter) => letzter)).toMatch(/Unique constraint/i);
      expect(await anlegen(() => 0)).toMatch(/AuditEvent_pos_check|check constraint/i);
    });
  });

  // ---------------------------------------------------------------- TS-05 --

  describe('Eindeutigkeit (TS-05, je Tenant)', () => {
    async function scheitert(fn: (tx: Tx) => Promise<unknown>): Promise<string> {
      return fehlerVon(mitTenant(A.tenant, fn, { client: app }));
    }

    it('höchstens ein Programm je Mandant', async () => {
      expect(
        await scheitert((tx) =>
          tx.tcmsProgramm.create({
            data: { mandantId: A.mandantId, paketId: 'ecommerce', paketVersion: '1.0' },
          }),
        ),
      ).toMatch(/Unique constraint/i);
    });

    it('Risikostand: keine doppelte Version, höchstens ein offener Stand', async () => {
      const stand = (version: number) => ({
        risikoId: A.risikoId,
        version,
        titel: 't',
        fehlerquelle: 'f',
        folge: 'g',
        normanker: [],
        s: 'M' as const,
        w: 'MOEGLICH' as const,
        r: 2,
        gt: 'FP' as const,
        modell: 'ec-1.0',
        gueltigAb: new Date(),
      });
      expect(await scheitert((tx) => tx.risikoStand.create({ data: stand(1) }))).toMatch(
        /Unique constraint/i,
      );
      expect(await scheitert((tx) => tx.risikoStand.create({ data: stand(2) }))).toMatch(
        /Unique constraint/i,
      );
    });

    it('Kontrollstand und Profilstand: höchstens ein offener Stand, Version eindeutig', async () => {
      const k = await scheitert(async (tx) => {
        const alt = await tx.kontrolleStand.findUniqueOrThrow({
          where: { id: A.kontrolleStandId },
        });
        const { id: _id, tenantId: _t, createdAt: _c, ...rest } = alt;
        await tx.kontrolleStand.create({
          data: {
            ...rest,
            version: 2,
            schritte: [],
            kennzahlen: [],
            toleranzEur: null,
          },
        });
      });
      expect(k).toMatch(/Unique constraint/i);
      expect(
        await scheitert((tx) =>
          tx.profilStand.create({
            data: { programmId: A.programmId, version: 2, antworten: {}, gueltigAb: new Date() },
          }),
        ),
      ).toMatch(/Unique constraint/i);
      expect(
        await scheitert((tx) =>
          tx.profilStand.create({
            data: {
              programmId: A.programmId,
              version: 1,
              antworten: {},
              gueltigAb: new Date(),
              gueltigBis: new Date(),
            },
          }),
        ),
      ).toMatch(/Unique constraint/i);
    });

    it('Ereignisnummer und Wiedervorlage je Tenant: doppelt in A scheitert, gleich in B erlaubt', async () => {
      expect(
        await scheitert((tx) =>
          tx.ereignis.create({
            data: {
              programmId: A.programmId,
              nummer: '2026-T-0001',
              typ: 'X',
              titel: 'x',
              beschreibung: 'x',
              quelle: 'MANUELL',
              ereignisDatum: new Date('2026-10-01'),
            },
          }),
        ),
      ).toMatch(/Unique constraint/i);
      expect(
        await scheitert((tx) =>
          tx.massnahme.create({
            data: {
              feststellungId: A.feststellungId,
              wiedervorlageNr: 1,
              beschreibung: 'x',
              verantwortlich: 'x',
              frist: new Date('2026-12-31'),
            },
          }),
        ),
      ).toMatch(/Unique constraint/i);
      // Die Fixture von B nutzt dieselben Nummern: je Tenant eindeutig, nicht global.
      await mitTenant(
        B.tenant,
        async (tx) => {
          expect(
            (await tx.ereignis.findUniqueOrThrow({ where: { id: B.ereignisId } })).nummer,
          ).toBe('2026-T-0001');
        },
        { client: app },
      );
    });
  });

  describe('Schema-Nachträge Welle 2', () => {
    async function scheitert(fn: (tx: Tx) => Promise<unknown>): Promise<string> {
      return fehlerVon(mitTenant(A.tenant, fn, { client: app }));
    }
    const inA = <T>(fn: (tx: Tx) => Promise<T>) => mitTenant(A.tenant, fn, { client: app });

    it('Mandant: dieselbe ID in zwei Tenants (Schlüssel tenant_id, id), ohne Auskunft über den anderen', async () => {
      // Die ID des Mandanten von B ist in A frei: Anlegen gelingt wie mit einer neuen ID.
      const m = await inA((tx) =>
        tx.mandant.create({
          data: { id: B.mandantId, name: 'Gleiche ID in A', rechtsform: 'KapG' },
        }),
      );
      expect(m).toMatchObject({ id: B.mandantId, tenantId: A.tenant });
      await mitTenant(
        B.tenant,
        async (tx) => {
          const b = await tx.mandant.findMany({ where: { id: B.mandantId } });
          expect(b.map((x) => x.name)).toEqual([`Testmandant ${B.tenant.slice(0, 8)}`]);
        },
        { client: app },
      );
      // Ein zweites Mal im selben Tenant scheitert am Schlüssel.
      expect(
        await scheitert((tx) =>
          tx.mandant.create({ data: { id: B.mandantId, name: 'doppelt', rechtsform: 'KapG' } }),
        ),
      ).toMatch(/Unique constraint/i);
      const { rows } = await roh.query<{ spalten: string }>(
        `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS spalten
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.conrelid = 'public."Mandant"'::regclass AND c.contype = 'p'`,
      );
      expect(rows[0]?.spalten).toBe('tenant_id,id');
    });

    it('Teilindizes: ein offener Nachtrag, eine beantragte Übersteuerung je Sicht, eine offene Risikoakzeptanz', async () => {
      const nachtrag = (status: 'GEPLANT' | 'OHNE_BEFUND') => (tx: Tx) =>
        tx.durchfuehrung.create({
          data: {
            kontrolleId: A.kontrolleId,
            kontrolleStandId: A.kontrolleStandId,
            periodeLabel: 'Okt 2026 · Nachtrag',
            periodeVon: new Date('2026-10-01'),
            periodeBis: new Date('2026-10-31'),
            faelligAm: new Date('2026-11-20'),
            ausserplanmaessig: true,
            nachtragZuId: A.durchfuehrungId,
            status,
          },
        });
      const erster = await inA(nachtrag('GEPLANT'));
      expect(await scheitert(nachtrag('GEPLANT'))).toMatch(/Unique constraint/i);
      // Abgeschlossene Nachträge zählen nicht.
      await inA(nachtrag('OHNE_BEFUND'));
      await inA((tx) =>
        tx.durchfuehrung.update({ where: { id: erster.id }, data: { status: 'OHNE_BEFUND' } }),
      );
      await inA(nachtrag('GEPLANT'));

      const uebersteuerung = (sicht: 'DESIGN' | 'BETRIEB') => (tx: Tx) =>
        tx.uebersteuerung.create({
          data: {
            risikoId: A.risikoId,
            sicht,
            klasse: 'GERING',
            berechnet: 'MITTEL',
            begruendung: 'Begründung mit mindestens dreißig Zeichen.',
            beantragtVon: randomUUID(),
          },
        });
      // Die Fixture hat bereits eine beantragte Übersteuerung (DESIGN).
      expect(await scheitert(uebersteuerung('DESIGN'))).toMatch(/Unique constraint/i);
      await inA(uebersteuerung('BETRIEB'));

      const akzeptanz = (tx: Tx) =>
        tx.freigabe.create({
          data: {
            programmId: A.programmId,
            art: 'RISIKOAKZEPTANZ',
            refId: A.risikoId,
            titel: 'Risikoakzeptanz',
            angefordertVon: randomUUID(),
            empfaengerId: randomUUID(),
          },
        });
      const offen = await inA(akzeptanz);
      expect(await scheitert(akzeptanz)).toMatch(/Unique constraint/i);
      await inA((tx) =>
        tx.freigabe.update({ where: { id: offen.id }, data: { status: 'ABGELEHNT' } }),
      );
      await inA(akzeptanz);
      // Je Tenant: dieselbe refId in B stört A nicht.
      await mitTenant(
        B.tenant,
        (tx) =>
          tx.freigabe.create({
            data: {
              programmId: B.programmId,
              art: 'RISIKOAKZEPTANZ',
              refId: A.risikoId,
              titel: 'Risikoakzeptanz',
              angefordertVon: randomUUID(),
              empfaengerId: randomUUID(),
            },
          }),
        { client: app },
      );
    });

    it('Freigabe: Fehlversuche nur 0–5, Code nur als SHA-256 (hex) gespeichert', async () => {
      for (const data of [
        { codeFehlversuche: 6 },
        { codeFehlversuche: -1 },
        { codeHash: `v1:0:${'a'.repeat(64)}` },
        { codeHash: '123456' },
        { codeHash: 'A'.repeat(64) },
      ]) {
        expect(
          await scheitert((tx) => tx.freigabe.update({ where: { id: A.freigabeId }, data })),
          JSON.stringify(data),
        ).toMatch(/check constraint/i);
      }
      await inA((tx) =>
        tx.freigabe.update({
          where: { id: A.freigabeId },
          data: { codeFehlversuche: 5, codeHash: 'a'.repeat(64) },
        }),
      );
      await inA((tx) =>
        tx.freigabe.update({
          where: { id: A.freigabeId },
          data: { codeFehlversuche: 0, codeHash: null },
        }),
      );
    });

    it('Nachricht: Empfänger nur als UUID, Zweck nur aus dem Enum', async () => {
      for (const sql of [
        `INSERT INTO "Nachricht" (id, "empfaengerId", zweck, betreff, text) VALUES ('${randomUUID()}', 'Jana Weller', 'FREIGABE_CODE', 'x', 'x')`,
        `INSERT INTO "Nachricht" (id, "empfaengerId", zweck, betreff, text) VALUES ('${randomUUID()}', '${randomUUID()}', 'UNBEKANNT', 'x', 'x')`,
        `INSERT INTO "Nachricht" (id, zweck, betreff, text) VALUES ('${randomUUID()}', 'FREIGABE_CODE', 'x', 'x')`,
      ]) {
        expect(await scheitert((tx) => tx.$executeRawUnsafe(sql))).toMatch(
          /invalid input|null value|violates not-null/i,
        );
      }
    });
  });

  describe('Eingefrorene CMS-Beschreibung (Trigger)', () => {
    const inA = <T>(fn: (tx: Tx) => Promise<T>) => mitTenant(A.tenant, fn, { client: app });
    async function version(status: 'BEIM_MANDANTEN' | 'ENTWURF'): Promise<string> {
      const v = await inA((tx) =>
        tx.beschreibungVersion.create({
          data: {
            programmId: A.programmId,
            nummer: `9.${Math.floor(Math.random() * 1e6)}`,
            status,
            abschnitte: [{ key: 'a', text: 'Inhalt' }],
            snapshot: status === 'ENTWURF' ? undefined : { nummer: '9', eingefroren: true },
            snapshotSha256: status === 'ENTWURF' ? null : 'a'.repeat(64),
          },
        }),
      );
      return v.id;
    }
    const aendere = (id: string, data: Record<string, unknown>) =>
      inA((tx) => tx.beschreibungVersion.update({ where: { id }, data }));

    it('Inhalt, Metadaten und Löschen gesperrt; nur die vorgesehenen Statusübergänge', async () => {
      const id = await version('BEIM_MANDANTEN');
      for (const data of [
        { snapshot: { nummer: '9', eingefroren: false } },
        { snapshotSha256: 'b'.repeat(64) },
        { abschnitte: [] },
        { nummer: '9.9' },
        { createdAt: new Date('2020-01-01') },
        { reviewVon: randomUUID() },
        { status: 'ENTWURF' },
        { status: 'KANZLEI_REVIEW' },
        { status: 'FREIGEGEBEN' }, // ohne freigebende Person
        { freigegebenVon: randomUUID() }, // ohne Statuswechsel
      ]) {
        expect(await fehlerVon(aendere(id, data)), JSON.stringify(data)).toMatch(/tcms: /);
      }
      expect(
        await fehlerVon(inA((tx) => tx.beschreibungVersion.delete({ where: { id } }))),
      ).toMatch(/nicht gelöscht/);
      await aendere(id, {
        status: 'FREIGEGEBEN',
        freigegebenVon: randomUUID(),
        freigegebenAm: new Date(),
      });
      for (const data of [
        { freigegebenAm: new Date('2020-01-01') },
        { status: 'BEIM_MANDANTEN' },
        { snapshotSha256: 'c'.repeat(64) },
      ]) {
        expect(await fehlerVon(aendere(id, data)), JSON.stringify(data)).toMatch(/tcms: /);
      }
      await aendere(id, { status: 'ABGELOEST' });
      for (const data of [{ status: 'FREIGEGEBEN' }, { abschnitte: [] }]) {
        expect(await fehlerVon(aendere(id, data)), JSON.stringify(data)).toMatch(/tcms: /);
      }
      // Beim Mandanten → abgelöst (zurückgezogen) ist ebenfalls vorgesehen.
      await aendere(await version('BEIM_MANDANTEN'), { status: 'ABGELOEST' });
    });

    it('Entwürfe bleiben änderbar und löschbar', async () => {
      const id = await version('ENTWURF');
      await aendere(id, { abschnitte: [], status: 'KANZLEI_REVIEW' });
      await inA((tx) => tx.beschreibungVersion.delete({ where: { id } }));
    });

    it('die App-Rolle kann den Trigger nicht abschalten; er gilt auch für den Eigentümer', async () => {
      const id = await version('BEIM_MANDANTEN');
      expect(
        await fehlerVon(
          inA((tx) =>
            tx.$executeRawUnsafe(
              'ALTER TABLE "BeschreibungVersion" DISABLE TRIGGER "BeschreibungVersion_eingefroren"',
            ),
          ),
        ),
      ).toMatch(/must be owner/);
      const eigentuemer = pgClient(OWNER_URL);
      await eigentuemer.connect();
      try {
        await eigentuemer.query('BEGIN');
        await eigentuemer.query(`SELECT set_config('tcms.tenant_id', $1, true)`, [A.tenant]);
        const meldung = await fehlerVon(
          eigentuemer.query(`UPDATE "BeschreibungVersion" SET nummer = 'x' WHERE id = $1`, [id]),
        );
        expect(meldung).toMatch(/unveränderlich/);
      } finally {
        await eigentuemer.query('ROLLBACK');
        await eigentuemer.end();
      }
    });
  });

  // ----------------------------------------------------------- akteur_jti --

  describe('akteur_jti', () => {
    it('ohne Tenant: einfügen, Wiederholung erkennen, lesen, löschen; kein UPDATE', async () => {
      const jti = `test-${randomUUID()}`;
      const exp = new Date(Date.now() + 60_000);
      const sql = `INSERT INTO akteur_jti (jti, exp) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING jti`;
      expect((await roh.query(sql, [jti, exp])).rowCount).toBe(1);
      expect((await roh.query(sql, [jti, exp])).rowCount).toBe(0);
      expect(
        await fehlerVon(roh.query(`UPDATE akteur_jti SET exp = now() WHERE jti = $1`, [jti])),
      ).toMatch(/permission denied/);
      expect((await roh.query(`DELETE FROM akteur_jti WHERE jti = $1`, [jti])).rowCount).toBe(1);
      expect(await fehlerVon(roh.query(`TRUNCATE akteur_jti`))).toMatch(/permission denied/);
    });
  });
});
