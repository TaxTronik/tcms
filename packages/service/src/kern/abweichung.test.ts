import { describe, expect, it } from 'vitest';
import { antragAnzeige, antragDerAbweichung, type AbweichungsStand } from './abweichung';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

function stand(
  version: number,
  gueltigAb: string,
  erstelltVon: string,
  abweichung: Partial<AbweichungsStand> = {},
): AbweichungsStand {
  return {
    id: `s${version}`,
    version,
    gueltigAb: new Date(gueltigAb),
    erstelltVon,
    abweichungTurnus: null,
    abweichungAnlass: null,
    abweichungBegruendung: null,
    abweichungFreigegebenVon: null,
    ...abweichung,
  };
}

const antrag = { abweichungTurnus: 'QUARTAL', abweichungBegruendung: 'Begründung des Antrags' };

describe('Antrag einer Frequenzabweichung (eine Regel für Operation und Arbeitskorb)', () => {
  it('der früheste Stand der Folge mit derselben offenen Abweichung', () => {
    const s = [
      stand(1, '2026-10-01T09:00:00Z', C),
      stand(2, '2026-10-02T09:00:00Z', A, antrag),
      stand(3, '2026-10-03T09:00:00Z', B, antrag),
    ];
    expect(antragDerAbweichung(s).von).toBe(A);
  });

  it('Reihenfolge nach Version, nicht nach `gueltigAb` (Demo-Uhr springt um Mitternacht UTC)', () => {
    // v2 mittags ohne Abweichung, v3 Antrag von A um 23:50 UTC, v4 von B (Personenänderung)
    // um 00:10 UTC des Demo-Tags – `gueltigAb` von v4 liegt vor v2 und v3.
    const s = [
      stand(1, '2026-10-16T08:00:00Z', C),
      stand(2, '2026-10-16T12:00:00Z', C),
      stand(3, '2026-10-16T23:50:00Z', A, antrag),
      stand(4, '2026-10-16T00:10:00Z', B, antrag),
    ];
    const erwartet = { von: A, am: new Date('2026-10-16T23:50:00Z') };
    expect(antragDerAbweichung(s)).toEqual(erwartet);
    // Unabhängig von der Reihenfolge der Eingabe (z. B. nach `gueltigAb` geladen).
    const nachGueltigAb = [...s].sort((x, y) => x.gueltigAb.getTime() - y.gueltigAb.getTime());
    expect(antragDerAbweichung(nachGueltigAb)).toEqual(erwartet);
  });

  it('`bis`: spätere Versionen zählen nicht', () => {
    const s = [
      stand(1, '2026-10-01T09:00:00Z', C),
      stand(2, '2026-10-02T09:00:00Z', A, antrag),
      stand(3, '2026-10-03T09:00:00Z', B),
    ];
    expect(antragDerAbweichung(s).von).toBeNull();
    expect(antragDerAbweichung(s, { version: 2 }).von).toBe(A);
    expect(antragDerAbweichung(s, { version: 1 }).von).toBeNull();
  });

  it('freigegebene Abweichung: kein offener Antrag, die Anzeige nennt den Antrag', () => {
    const s = [
      stand(1, '2026-10-01T09:00:00Z', C),
      stand(2, '2026-10-02T09:00:00Z', A, antrag),
      stand(3, '2026-10-03T09:00:00Z', B, { ...antrag, abweichungFreigegebenVon: B }),
    ];
    expect(antragDerAbweichung(s).von).toBeNull();
    expect(antragAnzeige(s).von).toBe(A);
  });
});
