import { describe, expect, it } from 'vitest';
import { fehlendeWerte, toleranzLagen, type Kennzahl, type WertEintrag } from '../index';

const defs: Kennzahl[] = [
  { key: 'a', label: 'Kasse', sollEur: 20 },
  { key: 'b', label: 'Bank', sollEur: null },
  { key: 'd', label: 'Differenz', sollEur: null, differenzAus: ['a', 'b'] },
];

function eintrag(wert: number | null, erklaert = false, bemerkung = ''): WertEintrag {
  return { wert, erklaert, bemerkung };
}

describe('Kennzahlen einer Durchführung', () => {
  it('rundet Sollabweichung und Differenz auf Cent und rechnet die Differenz aus den Eingabewerten', () => {
    const werte = { a: eintrag(20.012), b: eintrag(21), d: eintrag(100, true, 'Beleg') };
    expect(toleranzLagen(defs, werte, 0.01)).toEqual([
      { def: defs[0], wert: 20.012, abweichung: 0.01, berechnet: false, lage: 'OK' },
      { def: defs[1], wert: 21, abweichung: null, berechnet: false, lage: null },
      { def: defs[2], wert: -0.99, abweichung: -0.99, berechnet: true, lage: 'ERKLAERT' },
    ]);
  });

  it('prüft fehlende Eingaben, auch wenn ein Wert für die berechnete Differenz vorliegt', () => {
    const werte = { b: eintrag(0), d: eintrag(100) };
    expect(fehlendeWerte(defs, werte)).toEqual(['Kasse']);
    expect(toleranzLagen(defs, werte, null)[2]).toMatchObject({
      wert: null,
      abweichung: null,
      berechnet: true,
      lage: null,
    });
  });

  it.each([
    [0.006, false, '', 'OK'],
    [0.005, true, ' ', 'AUSSERHALB'],
    [null, false, 'Beleg', 'AUSSERHALB'],
    [null, true, 'Beleg', 'ERKLAERT'],
  ] as const)(
    'wahrt die Toleranz mit Rundungspuffer und prüft Kennzeichen und Begründung (%s, %s, %s)',
    (toleranz, erklaert, text, lage) => {
      const werte = { a: eintrag(19.99, erklaert, text) };
      expect(toleranzLagen(defs, werte, toleranz)[0]?.lage).toBe(lage);
    },
  );
});
