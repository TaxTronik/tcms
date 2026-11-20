import { describe, expect, it } from 'vitest';
import { dauerText } from './anzeige';

describe('Dauer des Wirksamkeitszeitraums', () => {
  it('zeigt aus dem Schaltjahr einen ganzen Februar an', () => {
    expect(dauerText('2024-02-01', '2024-02-29')).toBe('1 Monat');
  });

  it('zeigt für unmögliche Tage eines unvollständigen Entwurfs keine Dauer', () => {
    expect(dauerText('2026-02-29', '2026-03-31')).toBeNull();
    expect(dauerText('2026-02-01', '2026-02-31')).toBeNull();
  });
});
