import { describe, expect, it } from 'vitest';
import { DienstFehler } from '@tcms/contract';
import { pruefeEingabe as durchfuehrung } from '../bereiche/durchfuehrung/lage';
import { pruefe as feststellungen } from '../bereiche/feststellungen-ereignisse/gemeinsam';
import { pruefeEingabe as lesepfade } from '../bereiche/lesepfade/hilfen';
import { pruefeEingabe as programm } from '../bereiche/programm-beschreibung/gemeinsam';
import { pruefeEingabe as risiken } from '../bereiche/risiken-kontrollen/gemeinsam';
import { pruefeEingabe, type Schema } from '../kern/eingabe';

describe('Eingaben an den Servicegrenzen', () => {
  it('übernimmt die geprüfte Ausgabe des Vertragsschemas', () => {
    expect(pruefeEingabe({ safeParse: () => ({ success: true, data: 'geprüft' }) }, 'roh')).toBe(
      'geprüft',
    );
  });

  it.each([
    ['Durchführung', durchfuehrung, 51],
    ['Feststellungen', feststellungen, 50],
    ['Lesepfade', lesepfade, 50],
    ['Programm', programm, 50],
    ['Risiken', risiken, 50],
  ] as const)(
    '%s gruppiert Feldfehler in Reihenfolge bis zur bisherigen Grenze',
    (_, pruefe, maximal) => {
      const issues = Array.from({ length: 51 }, (_, i) => ({
        path: i < 2 ? [] : ['schritte', i, 'titel'],
        message: String(i),
      }));
      const schema: Schema<unknown> = { safeParse: () => ({ success: false, error: { issues } }) };
      try {
        pruefe(schema, null);
        expect.unreachable('Das Schema hat die Eingabe abgewiesen');
      } catch (e) {
        expect(e).toBeInstanceOf(DienstFehler);
        expect(e).toMatchObject({ code: 'UNGUELTIG', message: 'Eingabe ungültig.' });
        const felder = (e as DienstFehler).felder ?? {};
        expect(felder['eingabe']).toEqual(['0', '1']);
        expect(felder['schritte.2.titel']).toEqual(['2']);
        expect(Object.values(felder).flat()).toHaveLength(maximal);
      }
    },
  );
});
