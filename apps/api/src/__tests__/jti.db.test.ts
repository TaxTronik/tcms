// DB-Tests gegen eine Datenbank, die wie in Produktion aufgebaut ist:
// packages/db/prisma/init/01_bootstrap.sql (Rollen) und die Init-Migration als
// tcms_owner. Laufen nur mit DB_TESTS=1; DATABASE_URL ist die Laufzeitrolle
// tcms_app wie im Dienst. Alles läuft mit genau deren Rechten (auf akteur_jti:
// SELECT, INSERT, DELETE). Die Tests löschen nur Zeilen, die sie selbst anlegen.

import { randomBytes } from 'node:crypto';
import {
  aktuellerTenant,
  erzeugeClient,
  mitTenant,
  pruefeLaufzeitverbindung,
  type PrismaClient,
  type Tx,
} from '@tcms/db';
import { dbAbgewiesen, regel } from '@tcms/db/testhilfe';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Datenzugriff } from '../app';
import { PgJti } from '../jti';
import type { Routen } from '../routen';
import { TENANT, aufbau, bestaetigtSenden, bestaetigung, json, senden } from './hilfen';

const AKTIV = process.env.DB_TESTS === '1';
const APP_URL = process.env.DATABASE_URL;
const LAUF = randomBytes(6).toString('base64url');
const jti = (n: string | number) => `test-${LAUF}-${n}-${randomBytes(8).toString('base64url')}`;

describe.skipIf(!AKTIV)('PostgreSQL als Laufzeitrolle tcms_app', () => {
  let app: pg.Pool;
  let app2: pg.Pool;
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!APP_URL) throw new Error('DB_TESTS=1 verlangt DATABASE_URL (tcms_app)');
    // Zwei Pools = zwei Dienstinstanzen.
    app = new pg.Pool({ connectionString: APP_URL, max: 10 });
    app2 = new pg.Pool({ connectionString: APP_URL, max: 10 });
    prisma = erzeugeClient(APP_URL);
  });

  afterAll(async () => {
    await app?.query("DELETE FROM akteur_jti WHERE jti LIKE 'test-' || $1 || '-%'", [LAUF]);
    await Promise.all([app?.end(), app2?.end(), prisma?.$disconnect()]);
  });

  it('besteht die Startprüfung als tcms_app', async () => {
    const r = await app.query('SELECT current_user');
    expect(r.rows[0].current_user).toBe('tcms_app');
    await expect(pruefeLaufzeitverbindung()).resolves.toBeUndefined();
  });

  it('tcms_app darf akteur_jti weder ändern noch leeren', async () => {
    await dbAbgewiesen(
      app.query("UPDATE akteur_jti SET exp = now() WHERE jti = 'x'"),
      regel.keinRecht('akteur_jti'),
    );
    await dbAbgewiesen(app.query('TRUNCATE akteur_jti'), regel.keinRecht('akteur_jti'));
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
    await app.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '1 minute')", [id]);
    expect(await new PgJti(app).einmalig(id, new Date(Date.now() + 60_000))).toBe(false);
  });

  it('räumt nur abgelaufene Einträge auf, in Stapeln', async () => {
    const alt = Array.from({ length: 5 }, (_, i) => jti(`alt-${i}`));
    const frisch = jti('frisch');
    for (const id of alt) {
      await app.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '1 second')", [id]);
    }
    await app.query("INSERT INTO akteur_jti VALUES ($1, now() + interval '1 minute')", [frisch]);
    const geloescht = await new PgJti(app, { stapel: 2, karenzS: 0 }).aufraeumen();
    expect(geloescht).toBeGreaterThanOrEqual(5);
    const rest = await app.query('SELECT jti FROM akteur_jti WHERE jti = ANY($1)', [
      [...alt, frisch],
    ]);
    expect(rest.rows.map((r) => r.jti)).toEqual([frisch]);
  });

  it('löscht abgelaufene Einträge erst nach der Karenz (Uhrabweichung Dienst/Datenbank)', async () => {
    const innerhalb = jti('karenz-innen');
    const ausserhalb = jti('karenz-aussen');
    await app.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '4 minutes')", [
      innerhalb,
    ]);
    await app.query("INSERT INTO akteur_jti VALUES ($1, now() - interval '6 minutes')", [
      ausserhalb,
    ]);
    await new PgJti(app).aufraeumen();
    const rest = await app.query('SELECT jti FROM akteur_jti WHERE jti = ANY($1)', [
      [innerhalb, ausserhalb],
    ]);
    expect(rest.rows.map((r) => r.jti)).toEqual([innerhalb]);
  });

  describe('Mandantenkontext über die App mit mitTenant aus @tcms/db', () => {
    const gesehen: { pid?: number } = {};
    const routen = (r: Routen<unknown>) => {
      r.route({
        methode: 'GET',
        pfad: '/v1/kontext',
        handler: async ({ tx }) => ({ tenant: await aktuellerTenant(tx as Tx) }),
      });
      r.route({
        methode: 'GET',
        pfad: '/v1/scheitern',
        handler: async ({ tx }) => {
          const [zeile] = await (tx as Tx).$queryRaw<{ pid: number }[]>`
            SELECT pg_backend_pid() AS pid`;
          gesehen.pid = zeile!.pid;
          throw new Error('Route scheitert nach Arbeit in der Transaktion');
        },
      });
    };
    const daten = (): Datenzugriff => ({
      mitTenant: (tenantId, fn) =>
        mitTenant(tenantId, fn as (tx: Tx) => Promise<never>, { client: prisma }),
      ping: async () => {
        await app.query('SELECT 1');
      },
    });

    it('setzt den Tenant aus der Bestätigung', async () => {
      const t = aufbau({ routen, daten: daten() });
      const r = await bestaetigtSenden(t.app, { ziel: '/v1/kontext' });
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ ok: true, daten: { tenant: TENANT } });
    });

    it('hinterlässt nach einem Fehler der Route weder Tenant-Kontext noch offene Transaktion', async () => {
      const t = aufbau({ routen, daten: daten() });
      const r = await bestaetigtSenden(t.app, { ziel: '/v1/scheitern' });
      expect(r.status).toBe(500);
      // Nacheinander genutzt gibt der Pool dieselbe Verbindung zurück; die PID belegt es.
      const [danach] = await prisma.$queryRaw<
        { pid: number; t: string | null; ohne_tx: boolean }[]
      >`
        SELECT pg_backend_pid() AS pid,
               current_setting('tcms.tenant_id', true) AS t,
               now() = statement_timestamp() AS ohne_tx`;
      expect(gesehen.pid).toBeDefined();
      expect(danach!.pid).toBe(gesehen.pid);
      expect(danach!.t ?? '').toBe('');
      expect(danach!.ohne_tx).toBe(true);
    });

    it('meldet die Datenbank im Health-Check ohne Tenant', async () => {
      const t = aufbau({ routen, daten: daten() });
      const { headers } = bestaetigung({ ziel: '/v1/health' });
      const r = await senden(t.app, { ziel: '/v1/health', headers });
      expect(await json(r)).toEqual({ ok: true, daten: { version: '0.1.0', datenbank: 'ok' } });
    });
  });
});
