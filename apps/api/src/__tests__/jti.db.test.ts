// DB-Tests gegen PostgreSQL. Laufen nur mit TCMS_API_TEST_DATABASE_URL
// (Superuser einer Test-Datenbank, z. B. tcms_auth). Die Tabelle wird mit genau
// dem DDL aus packages/db angelegt. Gearbeitet wird als NOLOGIN-Rolle
// `tcms_auth_test_app` mit genau den Rechten der Laufzeitrolle (INSERT, SELECT,
// DELETE – kein UPDATE). Die Tests löschen nur Zeilen, die sie selbst anlegen.

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDatenzugriff, pruefeLaufzeitrolle } from '../daten-pg';
import { PgJti } from '../jti';
import { MANDANT, aufbau, bestaetigung, senden } from './hilfen';

const URL_TEST = process.env.TCMS_API_TEST_DATABASE_URL;
const ROLLE = 'tcms_auth_test_app';
const LAUF = randomBytes(6).toString('base64url');
const jti = (n: string | number) => `test-${LAUF}-${n}-${randomBytes(8).toString('base64url')}`;

describe.skipIf(!URL_TEST)('PostgreSQL', () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let app2: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_TEST, max: 2 });
    await admin.query(
      'CREATE TABLE IF NOT EXISTS akteur_jti (jti text PRIMARY KEY, exp timestamptz NOT NULL)',
    );
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLLE}') THEN
        CREATE ROLE ${ROLLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF; END $$`);
    await admin.query(`REVOKE ALL ON akteur_jti FROM ${ROLLE}`);
    await admin.query(`GRANT INSERT, SELECT, DELETE ON akteur_jti TO ${ROLLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLLE}`);
    await admin.query(
      'CREATE TABLE IF NOT EXISTS api_test_rueckrollen (id text PRIMARY KEY, tenant text)',
    );
    await admin.query(`GRANT INSERT, SELECT ON api_test_rueckrollen TO ${ROLLE}`);
    // Zwei Pools = zwei Dienstinstanzen; jede Verbindung läuft als Laufzeitrolle.
    const opts = { connectionString: URL_TEST, max: 10, options: `-c role=${ROLLE}` };
    app = new pg.Pool(opts);
    app2 = new pg.Pool(opts);
  });

  afterAll(async () => {
    await admin?.query("DELETE FROM akteur_jti WHERE jti LIKE 'test-' || $1 || '-%'", [LAUF]);
    await admin?.query("DELETE FROM api_test_rueckrollen WHERE id LIKE $1 || '%'", [LAUF]);
    await Promise.all([admin?.end(), app?.end(), app2?.end()]);
  });

  it('läuft als Rolle ohne Superuser und ohne BYPASSRLS (Startprüfung besteht)', async () => {
    const r = await app.query('SELECT current_user');
    expect(r.rows[0].current_user).toBe(ROLLE);
    await expect(pruefeLaufzeitrolle(app)).resolves.toBeUndefined();
  });

  it('Startprüfung verweigert den Superuser', async () => {
    await expect(pruefeLaufzeitrolle(admin)).rejects.toThrow(/Superuser/);
  });

  it('trägt eine jti genau einmal ein', async () => {
    const j = new PgJti(app);
    const id = jti('einmal');
    const exp = new Date(Date.now() + 60_000);
    expect(await j.einmalig(id, exp)).toBe(true);
    expect(await j.einmalig(id, exp)).toBe(false);
  });

  it('lässt bei gleichzeitiger Wiederholung über zwei Instanzen genau eine durch', async () => {
    const a = new PgJti(app);
    const b = new PgJti(app2);
    for (let runde = 0; runde < 10; runde++) {
      const id = jti(`parallel-${runde}`);
      const exp = new Date(Date.now() + 60_000);
      const ergebnisse = await Promise.all(
        Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).einmalig(id, exp)),
      );
      expect(ergebnisse.filter(Boolean), `Runde ${runde}`).toHaveLength(1);
    }
  });

  it('lässt über die App von zwei gleichzeitigen Anfragen genau eine durch', async () => {
    const t = aufbau({ jti: new PgJti(app) });
    const ziel = '/v1/ich';
    const { headers } = bestaetigung({ ziel, claims: { jti: jti('app') } });
    const [r1, r2] = await Promise.all([
      senden(t.app, { ziel, headers }),
      senden(t.app, { ziel, headers }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    expect(t.log.find((z) => z.status === 401)?.grund).toBe('JTI_WIEDERHOLT');
  });

  it('weist eine abgelaufene, noch nicht gelöschte jti weiter ab (fail closed)', async () => {
    const id = jti('abgelaufen');
    await admin.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '1 minute')", [id]);
    expect(await new PgJti(app).einmalig(id, new Date(Date.now() + 60_000))).toBe(false);
  });

  it('räumt nur abgelaufene Einträge auf, in Stapeln, mit den Rechten der Laufzeitrolle', async () => {
    const alt = Array.from({ length: 5 }, (_, i) => jti(`alt-${i}`));
    const frisch = jti('frisch');
    for (const id of alt) {
      await admin.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '1 second')", [id]);
    }
    await admin.query("INSERT INTO akteur_jti VALUES ($1, now() + interval '1 minute')", [frisch]);
    const geloescht = await new PgJti(app, 2, 100).aufraeumen();
    expect(geloescht).toBeGreaterThanOrEqual(5);
    const rest = await admin.query('SELECT jti FROM akteur_jti WHERE jti = ANY($1)', [
      [...alt, frisch],
    ]);
    expect(rest.rows.map((r) => r.jti)).toEqual([frisch]);
  });

  it('die Laufzeitrolle kann akteur_jti nicht ändern (kein UPDATE nötig, keines erlaubt)', async () => {
    await expect(app.query("UPDATE akteur_jti SET exp = now() WHERE jti = 'x'")).rejects.toThrow(
      /permission denied/,
    );
  });

  describe('pgDatenzugriff', () => {
    const TENANT_A = '11111111-1111-4111-8111-111111111111';

    it('setzt tcms.tenant_id nur innerhalb der Transaktion', async () => {
      const einzel = new pg.Pool({
        connectionString: URL_TEST,
        max: 1,
        options: `-c role=${ROLLE}`,
      });
      try {
        const d = pgDatenzugriff(einzel);
        const innen = await d.mitTenant(TENANT_A, async (tx) => {
          const r = await tx.query("SELECT current_setting('tcms.tenant_id', true) AS t");
          return r.rows[0].t as string;
        });
        expect(innen).toBe(TENANT_A);
        const danach = await einzel.query("SELECT current_setting('tcms.tenant_id', true) AS t");
        expect(danach.rows[0].t ?? '').toBe('');
      } finally {
        await einzel.end();
      }
    });

    it('hinterlässt nach einem Fehler weder Tenant-Kontext noch offene Transaktion', async () => {
      // Eine Verbindung: Die nächste Anfrage bekommt genau diese Verbindung zurück.
      const einzel = new pg.Pool({
        connectionString: URL_TEST,
        max: 1,
        options: `-c role=${ROLLE}`,
      });
      try {
        await expect(
          pgDatenzugriff(einzel).mitTenant(TENANT_A, async () => {
            throw new Error('Route scheitert');
          }),
        ).rejects.toThrow();
        const r = await einzel.query(
          "SELECT current_setting('tcms.tenant_id', true) AS t, now() = statement_timestamp() AS ohne_tx",
        );
        expect(r.rows[0].t ?? '').toBe('');
        expect(r.rows[0].ohne_tx).toBe(true);
      } finally {
        await einzel.end();
      }
    });

    it('rollt bei einem Fehler der Route vollständig zurück', async () => {
      const id = `${LAUF}-rueck`;
      await expect(
        pgDatenzugriff(app).mitTenant(TENANT_A, async (tx) => {
          await tx.query('INSERT INTO api_test_rueckrollen VALUES ($1, $2)', [id, MANDANT]);
          throw new Error('Route scheitert');
        }),
      ).rejects.toThrow('Route scheitert');
      const r = await admin.query('SELECT 1 FROM api_test_rueckrollen WHERE id = $1', [id]);
      expect(r.rowCount).toBe(0);
    });
  });
});
