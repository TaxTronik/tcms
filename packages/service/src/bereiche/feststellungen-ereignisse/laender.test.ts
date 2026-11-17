// Länderbezüge (rein): Katalogrisiken mit Grund aus den Merkmalen eines
// Landes und Ereignisse, die das Land nennen – ohne Regex-Einschleusung;
// Titel des Schwellenereignisses nach dem Auslöser.
import { describe, expect, it } from 'vitest';
import { fmtEurGanz } from '@tcms/domain';
import { ereignisseZumLand, risikoBezuegeZumLand, schwellenTitel } from './laender';

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
    e('1', 'Lager in Österreich seit März'),
    e('2', 'Hinweis', 'Umsätze in Österreich'),
    e('3', 'ATLAS-Import'),
    e('4', 'Sonstiges', 'nichts'),
    e('5', 'Lager AT seit März'),
    e('6', 'Österreichische Kunden'),
  ];

  it('nur der Landesname als eigenes Wort in Titel bzw. Beschreibung', () => {
    expect(ereignisseZumLand(liste, 'AT')).toEqual(['1', '2']);
  });

  it('gängige Abkürzungen gleich einem Ländercode ordnen nichts zu (IT, HR, NL)', () => {
    const abk = [
      e('it', 'Ausfall der IT-Schnittstelle zum Shop'),
      e('hr', 'HR-Wechsel in der Buchhaltung'),
      e('nl', 'NL-Versand umgestellt'),
      e('it2', 'Neue Preise', 'Die IT meldet Probleme'),
    ];
    for (const code of ['IT', 'HR', 'NL']) expect(ereignisseZumLand(abk, code), code).toEqual([]);
    expect(ereignisseZumLand([e('x', 'Lager in Italien eröffnet')], 'IT')).toEqual(['x']);
  });

  it('nur zweistellige Großbuchstaben-Codes des Katalogs gehen ein', () => {
    for (const boese of ['.*', 'A|', '(', '\\b', 'at', 'ATX', '', 'XX']) {
      expect(ereignisseZumLand(liste, boese), boese).toEqual([]);
    }
  });
});

describe('schwellenTitel (T-04)', () => {
  it('nennt den Auslöser: laufendes Jahr oder Vorjahr', () => {
    expect(schwellenTitel('UEBERSCHRITTEN', { lfd: 20_000, vj: 0 })).toBe(
      `Lieferschwelle überschritten (${fmtEurGanz(20_000)} von 10.000 €)`,
    );
    // Nur das Vorjahr über der Schwelle: nie „überschritten (500 € …)“.
    const vj = schwellenTitel('UEBERSCHRITTEN', { lfd: 500, vj: 50_000 });
    expect(vj).toBe(`Lieferschwelle im Vorjahr überschritten (${fmtEurGanz(50_000)} von 10.000 €)`);
    expect(vj).not.toContain(fmtEurGanz(500));
    expect(schwellenTitel('WARNUNG', { lfd: 8_500, vj: 0 })).toBe(
      `Lieferschwelle 85 % erreicht (${fmtEurGanz(8_500)} von 10.000 €)`,
    );
  });
});
