// Schlüssel der Bestätigungscodes in der Demo (H5): erst beim Gebrauch gelesen,
// fail closed ohne gültigen Wert, Meldungen ohne Werte.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { demoCodeSchluessel, pruefeCodeSchluesselListe } from './code-schluessel';

describe('Code-Schlüssel der Demo', () => {
  const gut = randomBytes(32).toString('base64url');

  it('nimmt eine gültige Liste an; der erste Eintrag signiert', () => {
    const zweiter = randomBytes(32).toString('base64url');
    expect(pruefeCodeSchluesselListe(`${gut}, ${zweiter}`)).toEqual([gut, zweiter]);
    const a = demoCodeSchluessel(() => `${gut},${zweiter}`);
    const b = demoCodeSchluessel(() => gut);
    expect(a.aktuelleId).toBe(b.aktuelleId);
    expect(a.kennt(b.aktuelleId)).toBe(true);
  });

  it('weist fehlende, kurze, Platzhalter- und doppelte Werte ab, ohne Werte zu nennen', () => {
    for (const wert of [
      undefined,
      '',
      'kurz',
      'bitte-durch-einen-zufaelligen-code-schluessel-ersetzen',
      `${gut},${gut}`,
    ]) {
      let meldung = '';
      try {
        pruefeCodeSchluesselListe(wert);
      } catch (e) {
        meldung = (e as Error).message;
      }
      expect(meldung, String(wert).slice(0, 6)).toMatch(/TCMS_CODE_SCHLUESSEL/);
      expect(meldung).not.toContain(gut);
    }
  });

  it('liest die Umgebung erst beim ersten Gebrauch (Build und übrige Demo ohne Variable)', () => {
    let gelesen = 0;
    const s = demoCodeSchluessel(() => {
      gelesen += 1;
      return undefined;
    });
    expect(gelesen).toBe(0);
    expect(() => s.aktuelleId).toThrow(/TCMS_CODE_SCHLUESSEL/);
    expect(gelesen).toBe(1);
  });
});
