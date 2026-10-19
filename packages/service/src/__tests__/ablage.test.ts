// Verweis-Prüfung des Dienstes (`pruefeVerweis`, ADR 0001 §6): Dateinamen nach
// derselben Regel wie der Vertrag – für jeden Code Point der BMP (ohne
// Surrogate), die Tag-Zeichen, Variantenselektoren und die übrigen
// unsichtbaren Bereiche entscheidet sie wie `gueltigerNachweisDateiname`.
import { gueltigerNachweisDateiname } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { pruefeVerweis } from '../ablage';

const VERWEIS = {
  dokumentId: '0f0f0f0f-1111-4111-8111-111111111111',
  mime: 'application/pdf',
  groesse: 1,
  sha256: 'a'.repeat(64),
};

describe('pruefeVerweis: Dateiname wie der Vertrag', () => {
  it('entscheidet für jeden Code Point wie gueltigerNachweisDateiname', () => {
    const abweichend: string[] = [];
    const pruefe = (cp: number) => {
      const dateiname = `a${String.fromCodePoint(cp)}b.pdf`;
      const dienst = !pruefeVerweis({ ...VERWEIS, dateiname })['dateiname'];
      if (dienst !== gueltigerNachweisDateiname(dateiname)) abweichend.push(cp.toString(16));
    };
    for (let cp = 0; cp <= 0xffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) pruefe(cp);
    // Unsichtbare und Formatzeichen außerhalb der BMP (RT4-T-01): Kaithi,
    // Hieroglyphen-Format, Kurzschrift, Notenschrift, Tags, Variantenselektoren.
    for (const [a, b] of [
      [0x110b0, 0x110d0],
      [0x13420, 0x13460],
      [0x1bc90, 0x1bcb0],
      [0x1d160, 0x1d190],
      [0xdffff, 0xe1000],
    ] as const) {
      for (let cp = a; cp <= b; cp += 1) pruefe(cp);
    }
    expect(abweichend).toEqual([]);
    // Stichproben: Nullbreite, Richtungsmarke, Tag-Zeichen, Variantenselektoren
    // und unsichtbare kombinierende Zeichen abgewiesen; Umlaut erlaubt.
    for (const cp of [0x200b, 0x200e, 0x061c, 0xfeff, 0xe0041, 0xfe0f, 0xe0100, 0x034f, 0x180b]) {
      expect(
        pruefeVerweis({ ...VERWEIS, dateiname: `a${String.fromCodePoint(cp)}.pdf` })['dateiname'],
        cp.toString(16),
      ).toBeDefined();
    }
    expect(pruefeVerweis({ ...VERWEIS, dateiname: 'Prüfung.pdf' })).toEqual({});
  });
});
