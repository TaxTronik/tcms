// Verweis-Prüfung des Dienstes (`pruefeVerweis`, ADR 0001 §6): Dateinamen nach
// derselben Regel wie der Vertrag – für jeden Code Point der BMP (ohne
// Surrogate) und die Tag-Zeichen entscheidet sie wie `gueltigerNachweisDateiname`.
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
    for (let cp = 0xdffff; cp <= 0xe0080; cp += 1) pruefe(cp);
    expect(abweichend).toEqual([]);
    // Stichproben: Nullbreite, Richtungsmarke, Tag-Zeichen abgewiesen; Umlaut erlaubt.
    for (const cp of [0x200b, 0x200e, 0x061c, 0xfeff, 0xe0041]) {
      expect(
        pruefeVerweis({ ...VERWEIS, dateiname: `a${String.fromCodePoint(cp)}.pdf` })['dateiname'],
        cp.toString(16),
      ).toBeDefined();
    }
    expect(pruefeVerweis({ ...VERWEIS, dateiname: 'Prüfung.pdf' })).toEqual({});
  });
});
