// Länderbezüge (rein): Katalogrisiken mit Grund aus den Merkmalen eines
// Landes und Ereignisse, die das Land nennen – ohne Regex-Einschleusung.
import { describe, expect, it } from 'vitest';
import { ereignisseZumLand, risikoBezuegeZumLand } from './laender';

describe('risikoBezuegeZumLand', () => {
  it('nennt je Merkmal die Risiken mit Grund', () => {
    const alle = risikoBezuegeZumLand({
      land: 'FR',
      lagerSeit: '2026-03',
      oss: true,
      zmRelevant: true,
    });
    expect(alle.map((r) => r.code)).toEqual([
      'EC-UST-01',
      'EC-UST-02',
      'EC-UST-03',
      'EC-UST-04',
      'EC-UST-05',
      'EC-UST-06',
      'EC-ERT-01',
      'EC-ERT-03',
    ]);
    for (const r of alle) expect(r.grund.length).toBeGreaterThan(5);
    const schlank = risikoBezuegeZumLand({
      land: 'FR',
      lagerSeit: null,
      oss: false,
      zmRelevant: false,
    });
    expect(schlank).toEqual([
      { code: 'EC-UST-01', grund: 'EU-Fernverkäufe nach Frankreich' },
      { code: 'EC-UST-02', grund: 'Steuersätze in Frankreich' },
    ]);
    // Inland: keine EU-Fernverkäufe.
    expect(
      risikoBezuegeZumLand({ land: 'DE', lagerSeit: null, oss: false, zmRelevant: false }).map(
        (r) => r.code,
      ),
    ).toEqual(['EC-UST-02']);
  });
});

describe('ereignisseZumLand', () => {
  const e = (id: string, titel: string, beschreibung = '') => ({ id, titel, beschreibung });
  const liste = [
    e('1', 'Lager AT seit März'),
    e('2', 'Hinweis', 'Umsätze in Österreich'),
    e('3', 'ATLAS-Import'),
    e('4', 'Sonstiges', 'nichts'),
  ];

  it('Code als eigenes Wort oder Landesname in Titel bzw. Beschreibung', () => {
    expect(ereignisseZumLand(liste, 'AT')).toEqual(['1', '2']);
  });

  it('nur zweistellige Großbuchstaben-Codes gehen in den Ausdruck ein', () => {
    for (const boese of ['.*', 'A|', '(', '\\b', 'at', 'ATX', '']) {
      expect(ereignisseZumLand(liste, boese), boese).toEqual([]);
    }
  });
});
