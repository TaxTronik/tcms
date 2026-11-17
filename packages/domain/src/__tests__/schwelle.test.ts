import { describe, expect, it } from 'vitest';
import { bewerteSchwelle, inCent, summeEur } from '../index';

const status = (lfd: number, vj = 0) => bewerteSchwelle(lfd, vj).status;

describe('EU-Lieferschwelle (Vergleich in Cent)', () => {
  it('Grenzwerte 9.999,99 / 10.000,00 / 10.000,01 EUR', () => {
    expect(status(9_999.99)).toBe('WARNUNG');
    expect(status(10_000)).toBe('WARNUNG');
    expect(status(10_000.01)).toBe('UEBERSCHRITTEN');
    expect(status(0, 10_000)).toBe('UNTERSCHRITTEN');
    expect(status(0, 10_000.01)).toBe('UEBERSCHRITTEN');
  });

  it('Grenzwerte der Warnstufe 7.999,99 / 8.000,00 EUR', () => {
    expect(status(7_999.99)).toBe('UNTERSCHRITTEN');
    expect(status(8_000)).toBe('WARNUNG');
  });

  it('Gleitkommasummen genau an der Grenze kippen den Status nicht', () => {
    // Als Gleitkommasumme 10000.000000000002 bzw. 7999.999999999999.
    const ueber = [4_885.13, 3_513.34, 1_601.53];
    const warn = [4_985.33, 2_286.56, 728.11];
    expect(ueber.reduce((s, x) => s + x, 0)).not.toBe(10_000);
    expect(warn.reduce((s, x) => s + x, 0)).not.toBe(8_000);
    expect(status(ueber.reduce((s, x) => s + x, 0))).toBe('WARNUNG');
    expect(status(warn.reduce((s, x) => s + x, 0))).toBe('WARNUNG');
    // Jede Reihenfolge ergibt dieselbe Summe.
    for (const xs of [ueber, [...ueber].reverse(), [ueber[1]!, ueber[0]!, ueber[2]!]]) {
      expect(summeEur(xs)).toBe(10_000);
      expect(status(summeEur(xs))).toBe('WARNUNG');
    }
    expect(summeEur(warn)).toBe(8_000);
    expect(summeEur([])).toBe(0);
  });

  it('Anteil und Label rechnen auf dem Cent-Betrag', () => {
    const e = bewerteSchwelle(8_000.004, 0);
    expect(e.anteilLfd).toBe(0.8);
    expect(e.label).toBe('Warnung · 80 %');
    expect(inCent(4_885.13)).toBe(488_513);
  });
});
