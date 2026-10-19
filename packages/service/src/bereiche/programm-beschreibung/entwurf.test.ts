// Gespeicherter Entwurf des Einrichtungsassistenten (rein): Texte aus der Zeit
// vor einer strengeren Eingaberegel (RT4-T-03 einzeilig, tcms-s9
// Richtungssteuerzeichen) bleiben lesbar und fallen nicht still auf Startwerte
// zurück; Struktur und Längen prüft das Lesen weiter.
import { describe, expect, it } from 'vitest';
import { SetupEntwurfSchema, TeilbereichSchrittSchema, ZieleSchrittSchema } from '@tcms/contract';
import { leseEntwurf, neuerEntwurf } from './entwurf';

const HEUTE = new Date('2026-10-19T00:00:00Z');

describe('leseEntwurf: Altbestand', () => {
  const basis = neuerEntwurf(HEUTE, null);
  const alt = {
    ...basis,
    abgeschlossen: 3,
    teilbereich: {
      ...basis.teilbereich,
      name: 'Teilbereich\tmit TAB',
      abgrenzung: 'Abgrenzung \u202ealt\u202c',
      einschluesse: ['Kanal \u2066isoliert\u2069'],
    },
    ziele: basis.ziele.map((z, i) => (i === 0 ? { ...z, text: 'Ziel \u202bRLE\u202c' } : z)),
    risiken: { 'EC-UST-01': { uebernehmen: false, begruendung: 'Begründung \u2068FSI\u2069' } },
  };

  it('behält Texte, die die heutige Eingaberegel abweist', () => {
    // Voraussetzung: Die Eingabe-Schemas weisen genau diese Texte ab.
    expect(
      TeilbereichSchrittSchema.safeParse({ teilbereich: alt.teilbereich, zeitraum: alt.zeitraum })
        .success,
    ).toBe(false);
    expect(ZieleSchrittSchema.safeParse({ ziele: alt.ziele, freigabe: alt.freigabe }).success).toBe(
      false,
    );
    const e = leseEntwurf(JSON.parse(JSON.stringify(alt)), HEUTE, null);
    expect(e.teilbereich).toEqual(alt.teilbereich);
    expect(e.ziele).toEqual(alt.ziele);
    expect(e.risiken).toEqual(alt.risiken);
    expect(e.abgeschlossen).toBe(3);
    // Die Antwort (`EinrichtungView.entwurf`) nimmt den gelesenen Entwurf an.
    expect(SetupEntwurfSchema.parse(e)).toEqual(e);
  });

  it('Struktur und Längen gelten weiter: Ungültiges fällt je Schritt auf Startwerte zurück', () => {
    const lang = {
      ...alt,
      teilbereich: { ...alt.teilbereich, abgrenzung: 'x'.repeat(4001) },
      ziele: [{ ...alt.ziele[0]!, unbekannt: 1 }],
    };
    const e = leseEntwurf(lang, HEUTE, null);
    expect(e.teilbereich).toEqual(basis.teilbereich);
    expect(e.ziele).toEqual(basis.ziele);
    expect(e.risiken).toEqual(alt.risiken);
  });
});
