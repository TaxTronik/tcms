import { describe, expect, it } from 'vitest';
import { parseDezimal } from '../components/durchfuehrung/werte';
import { ausHistorischemStand, betrag, betragAbNull, FormularFehler } from './formular';

// Eigene Logik der Demo-Hülle: ein Parser für Beträge (Befund 22) und die
// Stichtagsprüfung der Formulare über den Tageswechsel (Befund 71).

describe('parseDezimal: Beträge in deutscher Schreibweise', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1234,56', 1234.56],
    ['412.380,15', 412380.15],
    ['-12,5', -12.5],
    ['\u221212,5', -12.5],
    ['0', 0],
    ['1.234', 1234],
    ['12.500.000', 12500000],
    ['1.234,56 €', 1234.56],
    ['1 234,56', 1234.56],
    ['1\u00a0234,56\u00a0€', 1234.56],
    ['1234.56', 1234.56],
    ['1.5', 1.5],
    ['12.50', 12.5],
  ])('liest „%s“ als %d', (eingabe, erwartet) => {
    expect(parseDezimal(eingabe)).toBe(erwartet);
  });

  it.each([
    // Mehrdeutig: englische Tausender mit Dezimalpunkt bzw. mehrere Kommas.
    '12,345.67',
    '1,234,56',
    '1.23,4',
    ',5',
    '1,',
    // Hex, Exponent, Text, Vorzeichen doppelt, zu groß.
    '0x10',
    '1e5',
    'Infinity',
    'viel',
    '--5',
    '+5',
    '1.000.000.000.000',
  ])('weist „%s“ ab', (eingabe) => {
    expect(parseDezimal(eingabe)).toBe('fehler');
  });

  it('leere Eingabe ist kein Betrag', () => {
    expect(parseDezimal('')).toBeNull();
    expect(parseDezimal('  € ')).toBeNull();
  });
});

/** Der `FormularFehler` eines Aufrufs (sonst scheitert der Test). */
function abbruchVon(f: () => unknown): FormularFehler {
  try {
    f();
  } catch (e) {
    if (e instanceof FormularFehler) return e;
    throw e;
  }
  throw new Error('kein FormularFehler');
}

describe('betrag und betragAbNull (Formularwerte)', () => {
  it('liest Formularwerte über denselben Parser', () => {
    expect(betrag('1234.56')).toBe(1234.56);
    expect(betrag('12,345.67')).toBe('fehler');
    expect(betrag('')).toBeNull();
    expect(betrag(null)).toBeNull();
    expect(betrag(new File(['1'], 'x.txt'))).toBe('fehler');
  });

  it('Beträge ab 0 € bis zur Obergrenze, leer → 0', () => {
    expect(betragAbNull('1.200,50', 'Fernverkäufe', 1e11)).toBe(1200.5);
    expect(betragAbNull('10.000', 'Fernverkäufe', 1e11)).toBe(10000);
    expect(betragAbNull('', 'Fernverkäufe', 1e11)).toBe(0);
    for (const roh of ['-1', 'viel', '1e5', '200.000.000.000'])
      expect(() => betragAbNull(roh, 'Fernverkäufe', 1e11)).toThrow(FormularFehler);
    const fehler = abbruchVon(() => betragAbNull('viel', 'Malta, Fernverkäufe', 1e11));
    expect(fehler.message).toBe('Malta, Fernverkäufe: bitte einen Betrag ab 0 € angeben.');
  });
});

describe('ausHistorischemStand (Regel 6, Bedienhilfe)', () => {
  const formular = (stand?: string) => {
    const fd = new FormData();
    fd.set('id', 'x');
    if (stand !== undefined) fd.set('stand', stand);
    return fd;
  };
  const tag = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('Formular der aktuellen Ansicht (ohne `stand`) gilt auch nach Mitternacht als aktuell', () => {
    // Vor Mitternacht geladen, nach Mitternacht abgesendet: kein Stichtag im Formular.
    expect(ausHistorischemStand(formular(), tag('2026-11-17'))).toBe(false);
    expect(ausHistorischemStand(formular(''), tag('2026-11-18'))).toBe(false);
  });

  it('Formular eines historischen Stichtags ist schreibgeschützt', () => {
    expect(ausHistorischemStand(formular('2026-10-01'), tag('2026-11-17'))).toBe(true);
    expect(ausHistorischemStand(formular('2026-11-16'), tag('2026-11-17'))).toBe(true);
  });

  it('Stichtag heute oder später sowie ungültige Werte gelten als aktueller Stand', () => {
    expect(ausHistorischemStand(formular('2026-11-17'), tag('2026-11-17'))).toBe(false);
    expect(ausHistorischemStand(formular('2027-01-01'), tag('2026-11-17'))).toBe(false);
    expect(ausHistorischemStand(formular('gestern'), tag('2026-11-17'))).toBe(false);
  });
});
