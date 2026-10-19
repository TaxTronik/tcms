import { afterEach, describe, expect, it, vi } from 'vitest';
import { pgDatenzugriff, pruefeLaufzeitrolle } from '../daten-pg';
import { PgJti, SpeicherJti, starteJtiAufraeumen } from '../jti';
import type { LogWert } from '../log';

const EXP = new Date('2026-10-19T10:01:00.000Z');

describe('SpeicherJti', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lässt jede jti genau einmal zu, auch gleichzeitig', async () => {
    const s = new SpeicherJti();
    const ergebnisse = await Promise.all(
      Array.from({ length: 50 }, () => s.einmalig('jti-1', EXP)),
    );
    expect(ergebnisse.filter(Boolean)).toHaveLength(1);
    expect(await s.einmalig('jti-2', EXP)).toBe(true);
  });

  it('räumt nur abgelaufene Einträge auf', async () => {
    const s = new SpeicherJti();
    await s.einmalig('alt', new Date('2026-10-19T09:00:00Z'));
    await s.einmalig('neu', EXP);
    expect(await s.aufraeumen(new Date('2026-10-19T10:00:00Z'))).toBe(1);
    expect(await s.einmalig('neu', EXP)).toBe(false);
  });

  it('weist leere jti und ungültiges exp ab', async () => {
    const s = new SpeicherJti();
    await expect(s.einmalig('', EXP)).rejects.toThrow();
    await expect(s.einmalig('x', new Date(Number.NaN))).rejects.toThrow();
  });

  it('verweigert sich in Produktion', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new SpeicherJti()).toThrow(/nur für Tests/);
  });
});

describe('PgJti ohne Datenbank', () => {
  it('nutzt genau ein parametrisiertes INSERT … ON CONFLICT DO NOTHING RETURNING', async () => {
    const aufrufe: [string, unknown[]][] = [];
    const pool = {
      query: async (sql: string, werte: unknown[]) => {
        aufrufe.push([sql, werte]);
        return { rowCount: aufrufe.length === 1 ? 1 : 0, rows: [] };
      },
    };
    const j = new PgJti(pool as never);
    expect(await j.einmalig("x'); DROP TABLE akteur_jti; --", EXP)).toBe(true);
    expect(await j.einmalig("x'); DROP TABLE akteur_jti; --", EXP)).toBe(false);
    expect(aufrufe[0]![0]).toBe(
      'INSERT INTO akteur_jti (jti, exp) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING jti',
    );
    expect(aufrufe[0]![1]).toEqual(["x'); DROP TABLE akteur_jti; --", EXP]);
  });

  it('löscht in Stapeln und begrenzt die Arbeit je Lauf', async () => {
    let aufrufe = 0;
    const voll = { query: async () => (aufrufe++, { rowCount: 2, rows: [] }) };
    expect(await new PgJti(voll as never, 2, 5).aufraeumen()).toBe(10);
    expect(aufrufe).toBe(5);
    const teil = { query: async () => ({ rowCount: 1, rows: [] }) };
    expect(await new PgJti(teil as never, 2, 5).aufraeumen()).toBe(1);
  });
});

describe('starteJtiAufraeumen', () => {
  afterEach(() => vi.useRealTimers());

  it('läuft gestreut zwischen Basis und 1,5 × Basis und protokolliert nur Zahlen', async () => {
    vi.useFakeTimers();
    const log: [string, Record<string, LogWert> | undefined][] = [];
    let laeufe = 0;
    const stopp = starteJtiAufraeumen(
      { aufraeumen: async () => (++laeufe === 2 ? Promise.reject(new TypeError('geheim')) : 3) },
      { log: { schreibe: (_s, e, f) => log.push([e, f]) }, intervallMs: 1000, zufall: () => 0.999 },
    );
    await vi.advanceTimersByTimeAsync(1498);
    expect(laeufe).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(laeufe).toBe(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(laeufe).toBe(2);
    stopp();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(laeufe).toBe(2);
    expect(log).toEqual([
      ['jti_aufgeraeumt', { anzahl: 3 }],
      ['jti_aufraeumen_fehlgeschlagen', { fehler: 'TypeError' }],
    ]);
  });
});

describe('pruefeLaufzeitrolle', () => {
  const pool = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never;

  it('verweigert Superuser, BYPASSRLS und unbekannte Rollen', async () => {
    await expect(
      pruefeLaufzeitrolle(pool([{ rolsuper: true, rolbypassrls: false }])),
    ).rejects.toThrow();
    await expect(
      pruefeLaufzeitrolle(pool([{ rolsuper: false, rolbypassrls: true }])),
    ).rejects.toThrow();
    await expect(pruefeLaufzeitrolle(pool([]))).rejects.toThrow();
    await expect(
      pruefeLaufzeitrolle(pool([{ rolsuper: false, rolbypassrls: false }])),
    ).resolves.toBeUndefined();
  });
});

describe('pgDatenzugriff ohne Datenbank', () => {
  function fakePool(scheitertBei?: string) {
    const sql: string[] = [];
    const freigaben: unknown[] = [];
    let verbunden = 0;
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (scheitertBei && text.startsWith(scheitertBei))
          throw new Error(`${scheitertBei} kaputt`);
        return { rows: [] };
      },
      release: (fehler?: unknown) => freigaben.push(fehler),
    };
    const p = { connect: async () => (verbunden++, client) };
    return { p: p as never, sql, freigaben, verbunden: () => verbunden };
  }

  it('prüft die Tenant-ID, bevor eine Verbindung geöffnet wird', async () => {
    const f = fakePool();
    for (const t of ['', 'x', "'; RESET ROLE; --", '11111111-1111-4111-8111-11111111111']) {
      await expect(pgDatenzugriff(f.p).mitTenant(t, async () => 1)).rejects.toThrow(/UUID/);
    }
    expect(f.verbunden()).toBe(0);
  });

  it('setzt den Kontext transaktionslokal und committet', async () => {
    const f = fakePool();
    const t = '11111111-1111-4111-8111-111111111111';
    expect(await pgDatenzugriff(f.p).mitTenant(t, async () => 42)).toBe(42);
    expect(f.sql).toEqual(['BEGIN', "SELECT set_config('tcms.tenant_id', $1, true)", 'COMMIT']);
    expect(f.freigaben).toEqual([undefined]);
  });

  it('rollt bei Fehlern zurück und verwirft die Verbindung, wenn auch das scheitert', async () => {
    const t = '11111111-1111-4111-8111-111111111111';
    const ok = fakePool();
    await expect(
      pgDatenzugriff(ok.p).mitTenant(t, async () => {
        throw new Error('Route');
      }),
    ).rejects.toThrow('Route');
    expect(ok.sql.at(-1)).toBe('ROLLBACK');
    expect(ok.freigaben).toEqual([undefined]);
    const kaputt = fakePool('ROLLBACK');
    await expect(
      pgDatenzugriff(kaputt.p).mitTenant(t, async () => {
        throw new Error('Route');
      }),
    ).rejects.toThrow('Route');
    expect(kaputt.freigaben[0]).toBeInstanceOf(Error);
  });
});
