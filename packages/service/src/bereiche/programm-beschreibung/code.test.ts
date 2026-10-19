// Bestätigungscodes (rein): Format, Bindung an die Freigabe, Vergleich in
// konstanter Zeit, gespeicherter Codezustand (fail closed).
import { createHash, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CODE_GUELTIG_TAGE,
  codeAblaufAb,
  codeHash,
  codePasst,
  codeStatus,
  erzeugeCode,
  leseCodeZustand,
  MAX_FEHLVERSUCHE,
} from './code';

vi.mock('node:crypto', async (original) => {
  const o = await original<typeof import('node:crypto')>();
  return { ...o, timingSafeEqual: vi.fn(o.timingSafeEqual), randomInt: vi.fn(o.randomInt) };
});

const HEX = 'a'.repeat(64);

describe('Bestätigungscode', () => {
  it('erzeugt 6 Ziffern aus randomInt (node:crypto), auch mit führenden Nullen', async () => {
    const { randomInt } = await import('node:crypto');
    for (let i = 0; i < 200; i++) expect(erzeugeCode()).toMatch(/^\d{6}$/);
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    vi.mocked(randomInt).mockReturnValueOnce(42 as never);
    expect(erzeugeCode()).toBe('000042');
  });

  it('Hash ist an die Freigabe gebunden und enthält den Code nicht', () => {
    const h = codeHash('freigabe-a', '123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(codeHash('freigabe-b', '123456'));
    expect(h).not.toBe(createHash('sha256').update('123456').digest('hex'));
    expect(codePasst('freigabe-a', '123456', h)).toBe(true);
    expect(codePasst('freigabe-b', '123456', h)).toBe(false);
    expect(codePasst('freigabe-a', '123457', h)).toBe(false);
  });

  it('vergleicht in konstanter Zeit (timingSafeEqual über gleich lange Werte)', () => {
    vi.mocked(timingSafeEqual).mockClear();
    const h = codeHash('f', '000001');
    codePasst('f', '000002', h);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = vi.mocked(timingSafeEqual).mock.calls[0]!;
    expect((a as Buffer).length).toBe(32);
    expect((b as Buffer).length).toBe(32);
    vi.mocked(timingSafeEqual).mockClear();
    expect(codePasst('f', '000001', null)).toBe(false);
    expect(codePasst('f', '000001', 'abc')).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('liest den gespeicherten Zustand streng (Hash + Zähler); Unbekanntes gilt als gesperrt', () => {
    const z = (codeHash: string | null, codeFehlversuche: number) =>
      leseCodeZustand({ codeHash, codeFehlversuche });
    expect(z(null, 0)).toEqual({ fehlversuche: 0, hash: null });
    expect(z(HEX, 3)).toEqual({ fehlversuche: 3, hash: HEX });
    expect(z(null, 2)).toEqual({ fehlversuche: 2, hash: null });
    const gesperrt = { fehlversuche: MAX_FEHLVERSUCHE, hash: null };
    for (const [hash, n] of [
      [HEX, MAX_FEHLVERSUCHE],
      [null, MAX_FEHLVERSUCHE],
      [HEX, 6],
      [HEX, -1],
      [HEX, 1.5],
      [HEX, Number.NaN],
      [`v1:0:${HEX}`, 0],
      [HEX.toUpperCase(), 0],
      ['', 0],
      [`${HEX}0`, 0],
    ] as const) {
      expect(z(hash, n), `${hash}/${n}`).toEqual(gesperrt);
    }
  });

  it('Frist und Status auf übergebener (echter) Zeit', () => {
    const jetzt = new Date('2030-01-01T00:00:00Z');
    expect(codeAblaufAb(jetzt).getTime() - jetzt.getTime()).toBe(CODE_GUELTIG_TAGE * 86_400_000);
    const ablauf = codeAblaufAb(jetzt);
    const f = (codeHash: string | null, codeFehlversuche: number, codeAblauf: Date | null) => ({
      codeHash,
      codeFehlversuche,
      codeAblauf,
    });
    expect(codeStatus(f(HEX, 0, ablauf), jetzt)).toBe('AKTIV');
    expect(codeStatus(f(HEX, 0, ablauf), new Date(ablauf.getTime() + 1))).toBe('ABGELAUFEN');
    expect(codeStatus(f(null, MAX_FEHLVERSUCHE, null), jetzt)).toBe('GESPERRT');
    expect(codeStatus(f(HEX, MAX_FEHLVERSUCHE, ablauf), jetzt)).toBe('GESPERRT');
    expect(codeStatus(f(null, 0, null), jetzt)).toBe('KEIN');
  });
});
