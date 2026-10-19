// =============================================================================
// Richtungszeichen in Dateinamen und Stammdaten (Anzeige-Spoofing): Die Regexe
// in `feststellungen-ereignisse.ts` (DATEINAME_VERBOTEN) und `lesepfade.ts`
// (`einzeilig`) enthielten die Bereiche U+202A–U+202E und U+2066–U+2069 als
// rohe Zeichen („Trojan Source", siehe __tests__/repo-zeichen.test.ts); sie
// stehen jetzt als Escapes da. Dieser Test belegt, dass sich das Verhalten
// dabei nicht geändert hat: Für jeden Code Point der BMP (ohne Surrogate)
// entscheiden die Schemas wie die bisherigen Regexe. Die bisherigen Regexe
// werden hier aus Code Points gebaut, damit auch dieser Test keine rohen
// Zeichen enthält.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { AnlageVerweisSchema } from './feststellungen-ereignisse';
import { MandantAnkerBodySchema } from './lesepfade';

const z = (cp: number) => String.fromCharCode(cp);
/** Bisherige Zeichenklasse, Bereiche als rohe Zeichen (wie vor der Änderung). */
const RICHTUNG_ROH = `${z(0x202a)}-${z(0x202e)}${z(0x2066)}-${z(0x2069)}`;
const DATEINAME_BISHER = new RegExp(`[\\u0000-\\u001f\\u007f/\\\\${RICHTUNG_ROH}]`);
const EINZEILIG_BISHER = new RegExp(`^[^\\u0000-\\u001f\\u007f${RICHTUNG_ROH}]*$`);

const VERWEIS = {
  dokumentId: 'ab/0123',
  mime: 'application/pdf',
  groesse: 1,
  sha256: 'a'.repeat(64),
};

/** Alle BMP-Code-Points außer Surrogaten (kein gültiges einzelnes Zeichen). */
function* bmp(): Generator<number> {
  for (let cp = 0; cp <= 0xffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) yield cp;
}

describe('Richtungszeichen als Escapes: Verhalten unverändert', () => {
  it('Dateiname einer Anlage (DATEINAME_VERBOTEN) entscheidet wie bisher', () => {
    const abweichend: string[] = [];
    for (const cp of bmp()) {
      const dateiname = `a${z(cp)}b.pdf`;
      const bisher = !DATEINAME_BISHER.test(dateiname);
      const jetzt = AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success;
      if (bisher !== jetzt) abweichend.push(cp.toString(16));
    }
    expect(abweichend).toEqual([]);
  });

  it('Stammdaten des Mandantenankers (einzeilig) entscheiden wie bisher', () => {
    const abweichend: string[] = [];
    for (const cp of bmp()) {
      const name = `A${z(cp)}B`;
      const bisher = EINZEILIG_BISHER.test(name);
      const jetzt = MandantAnkerBodySchema.safeParse({ name, rechtsform: 'GmbH' }).success;
      if (bisher !== jetzt) abweichend.push(cp.toString(16));
    }
    expect(abweichend).toEqual([]);
  });

  it('weist jedes Richtungszeichen ab und lässt Umlaute zu', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(
        AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname: `a${z(cp)}.pdf` }).success,
      ).toBe(false);
      expect(
        MandantAnkerBodySchema.safeParse({ name: `A${z(cp)}B`, rechtsform: 'KG' }).success,
      ).toBe(false);
    }
    expect(AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname: 'Prüfung.pdf' }).success).toBe(
      true,
    );
    expect(
      MandantAnkerBodySchema.safeParse({ name: 'Müller & Söhne', rechtsform: 'KG' }).success,
    ).toBe(true);
  });
});
