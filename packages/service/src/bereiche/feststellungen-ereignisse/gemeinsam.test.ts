// Reine Tests der gemeinsamen Bausteine (ohne Datenbank).

import { describe, expect, it } from 'vitest';
import { DienstFehler, FeststellungWeiterSchema } from '@tcms/contract';
import { alsKonflikt, EINGABE_UNGUELTIG, pruefe } from './gemeinsam';

describe('gemeinsame Bausteine', () => {
  it('Unique-Verletzung und Schreibkonflikt werden KONFLIKT, andere Fehler bleiben', () => {
    for (const code of ['P2002', 'P2034']) {
      const e = alsKonflikt(Object.assign(new Error('x'), { code }));
      expect(e).toBeInstanceOf(DienstFehler);
      expect((e as DienstFehler).code).toBe('KONFLIKT');
    }
    const anders = Object.assign(new Error('x'), { code: 'P2025' });
    expect(alsKonflikt(anders)).toBe(anders);
    const d = new DienstFehler('NICHT_GEFUNDEN');
    expect(alsKonflikt(d)).toBe(d);
    expect(alsKonflikt(null)).toBe(null);
  });

  it('pruefe: strikte Eingabe, Feldfehler ohne Eingabewerte', () => {
    const geheim = 'geheimer-wert-1234567890';
    try {
      pruefe(FeststellungWeiterSchema, {
        mandantId: geheim,
        feststellungId: 'x',
        von: 'ERFASST',
        unbekannt: geheim,
      });
      throw new Error('keine Ausnahme');
    } catch (e) {
      expect(e).toBeInstanceOf(DienstFehler);
      const f = e as DienstFehler;
      expect(f.code).toBe('UNGUELTIG');
      expect(f.message).toBe(EINGABE_UNGUELTIG);
      expect(Object.keys(f.felder ?? {})).toEqual(
        expect.arrayContaining(['mandantId', 'feststellungId']),
      );
      expect(JSON.stringify(f.felder)).not.toContain(geheim);
    }
  });
});
