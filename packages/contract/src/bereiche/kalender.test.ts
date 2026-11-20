import { describe, expect, it } from 'vitest';
import { KontextAntwortSchema } from './lesepfade';
import { FreigabenHistorieSchema, TeilbereichSchrittSchema } from './programm-beschreibung';

describe('Kalender in den Leseverträgen und im Assistenten', () => {
  it('liefert die Freigabehistorie nur für einen existierenden Stichtag', () => {
    const daten = { stand: '2024-02-29', historisch: true, freigaben: [] };
    expect(FreigabenHistorieSchema.safeParse(daten).success).toBe(true);
    expect(FreigabenHistorieSchema.safeParse({ ...daten, stand: '2026-02-29' }).success).toBe(
      false,
    );
  });

  it('begrenzt die Prüflast auf existierende Monate', () => {
    const schema = KontextAntwortSchema.shape.prueflast;
    const last = { monat: '2026-12', FP: 1, FF: 0, IN: 0, ausloesungen: 0, gesamt: 1 };
    expect(schema.safeParse([last]).success).toBe(true);
    for (const monat of ['2026-00', '2026-13']) {
      expect(schema.safeParse([{ ...last, monat }]).success).toBe(false);
    }
  });

  it('lässt einen unvollständigen Zeitraum im Entwurf zum Überarbeiten zu', () => {
    expect(
      TeilbereichSchrittSchema.shape.zeitraum.safeParse({
        angemessenheitStichtag: '',
        wirksamAb: '2026-02-29',
        wirksamBis: '',
        erklaerungsTurnus: 'MONATLICH',
      }).success,
    ).toBe(true);
  });
});
