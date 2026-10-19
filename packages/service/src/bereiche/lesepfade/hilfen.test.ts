import { describe, expect, it } from 'vitest';
import { DienstFehler, KontextEingabeSchema, StandSchema } from '@tcms/contract';
import {
  alsJson,
  antwortNach,
  mitListenBezug,
  nurKanzlei,
  pruefeEingabe,
  VertragsFehler,
} from './hilfen';
import { kanzlei, kontakt } from './testhilfen';

const M = 'a1000000-0000-4000-8000-000000004711';

describe('Hilfen lesepfade', () => {
  it('alsJson: Date → ISO, undefined entfällt, alles Nicht-JSON wird abgewiesen', () => {
    expect(alsJson({ a: new Date('2026-10-16T00:00:00Z'), b: undefined, c: [1, null] })).toEqual({
      a: '2026-10-16T00:00:00.000Z',
      c: [1, null],
    });
    for (const x of [new Map(), new Set(), () => 1, 1n, Number.NaN, new (class K {})()]) {
      expect(() => alsJson({ x })).toThrow(VertragsFehler);
    }
  });

  it('antwortNach: unbekannte Felder → interner Fehler, nie UNGUELTIG', () => {
    expect(antwortNach(StandSchema, 't', '2026-10-16')).toBe('2026-10-16');
    const e = (() => {
      try {
        antwortNach(KontextEingabeSchema, 't', { mandantId: M, geheim: 'x' });
      } catch (f) {
        return f;
      }
    })();
    expect(e).toBeInstanceOf(VertragsFehler);
    expect(e).not.toBeInstanceOf(DienstFehler);
    expect(String((e as Error).message)).not.toContain('geheim');
  });

  it('pruefeEingabe: UNGUELTIG mit Feldern', () => {
    try {
      pruefeEingabe(KontextEingabeSchema, { mandantId: 'x' });
      expect.unreachable();
    } catch (f) {
      expect(f).toBeInstanceOf(DienstFehler);
      expect((f as DienstFehler).code).toBe('UNGUELTIG');
      expect(Object.keys((f as DienstFehler).felder ?? {})).toEqual(['mandantId']);
    }
  });

  it('nurKanzlei und Listenbezug ersetzen den Bezug, statt ihn zu ergänzen', () => {
    expect(() => nurKanzlei(kontakt(M, M))).toThrow(DienstFehler);
    const a = kanzlei(M, 'b1000000-0000-4000-8000-000000000001', { zustaendig: true });
    const b = mitListenBezug(nurKanzlei(a), {
      id: M.toUpperCase(),
      zustaendigBerufstraeger: false,
      hauptbearbeitung: true,
    });
    expect(b.mandant).toEqual({ id: M, zustaendigBerufstraeger: false, hauptbearbeitung: true });
    expect(Object.isFrozen(b) && Object.isFrozen(b.mandant)).toBe(true);
  });
});
