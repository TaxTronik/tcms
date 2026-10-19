import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(await new PgJti(voll as never, { stapel: 2, maxStapelJeLauf: 5 }).aufraeumen()).toBe(10);
    expect(aufrufe).toBe(5);
    const teil = { query: async () => ({ rowCount: 1, rows: [] }) };
    expect(await new PgJti(teil as never, { stapel: 2, maxStapelJeLauf: 5 }).aufraeumen()).toBe(1);
  });

  it('löscht erst nach der Karenz (Standard 300 s) und weist ungültige Karenz ab', async () => {
    const werte: unknown[][] = [];
    const pool = {
      query: async (_: string, w: unknown[]) => (werte.push(w), { rowCount: 0, rows: [] }),
    };
    await new PgJti(pool as never).aufraeumen();
    expect(werte[0]).toEqual([1000, 300]);
    expect(() => new PgJti(pool as never, { karenzS: -1 })).toThrow();
    expect(() => new PgJti(pool as never, { karenzS: 1.5 })).toThrow();
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
