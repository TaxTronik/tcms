// Mandantenliste von Portfolio und Arbeitskorb (Befund 42): Jeder schemagültige
// Body passt in die Body-Grenze. Früher galt die Grenze von 5 000 IDs je Liste
// (`mandantIds`, `bt`, `hb`), zusammen also bis zu 15 000 UUIDs – die Kante wies
// schon ab 5 000 + 1 721 Einträgen mit `413` ab, obwohl das Schema sie annahm.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENDPUNKTE } from '../endpunkte';
import {
  MAX_BODY_BYTES,
  MAX_LISTENEINTRAEGE_JE_ANFRAGE,
  MAX_MANDANTEN_JE_ANFRAGE,
} from '../fehler';
import { MandantenListeSchema } from './lesepfade';

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const bytes = (wert: unknown) => Buffer.byteLength(JSON.stringify(wert), 'utf8');

describe('MandantenListeSchema: Summengrenze passend zur Body-Grenze', () => {
  it('der größte schemagültige Body passt in MAX_BODY_BYTES', () => {
    const mandantIds = ids(MAX_MANDANTEN_JE_ANFRAGE);
    const rest = MAX_LISTENEINTRAEGE_JE_ANFRAGE - MAX_MANDANTEN_JE_ANFRAGE;
    const groesst = { mandantIds, bt: mandantIds.slice(0, rest), hb: [] as string[] };
    expect(MandantenListeSchema.safeParse(groesst).success).toBe(true);
    expect(bytes(groesst)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // Gleich verteilt (BT und HB je für einen Teil) ebenso.
    const drittel = Math.floor(MAX_LISTENEINTRAEGE_JE_ANFRAGE / 3);
    const m = ids(drittel);
    const verteilt = { mandantIds: m, bt: m, hb: m };
    expect(MandantenListeSchema.safeParse(verteilt).success).toBe(true);
    expect(bytes(verteilt)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it('weist mehr Einträge als die Summengrenze ab (400 statt 413 an der Kante)', () => {
    const mandantIds = ids(MAX_MANDANTEN_JE_ANFRAGE);
    const rest = MAX_LISTENEINTRAEGE_JE_ANFRAGE - MAX_MANDANTEN_JE_ANFRAGE + 1;
    const zuViel = { mandantIds, bt: mandantIds.slice(0, rest), hb: [] };
    expect(MandantenListeSchema.safeParse(zuViel).success).toBe(false);
    // Vorher schemagültig: 5 000 + 5 000 + 5 000.
    expect(
      MandantenListeSchema.safeParse({ mandantIds, bt: mandantIds, hb: mandantIds }).success,
    ).toBe(false);
  });

  it('Portfolio und Arbeitskorb nutzen dieses Schema', () => {
    expect(ENDPUNKTE.portfolioLesen.bodySchema).toBe(MandantenListeSchema);
    expect(ENDPUNKTE.arbeitskorbLesen.bodySchema).toBe(MandantenListeSchema);
  });
});
