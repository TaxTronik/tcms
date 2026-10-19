// Reine Profilregeln (Bereinigung, Pflichtangaben, Strukturfehler, Trigger der
// Profiländerung) – gemeinsame Quelle für Service und Demo-Komponenten.
import { describe, expect, it } from 'vitest';
import {
  bereinigeProfil,
  ereignisseFuerAenderung,
  gleichesProfil,
  inhaltGleich,
  leeresProfil,
  neuZuBewerten,
  profilDiff,
  profilStrukturFehler,
  pruefeProfil,
  type Geschaeftsprofil,
} from '../index';

function profil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] };
  p.p2 = {
    eigenversandDE: true,
    lager: [
      { land: 'DE', seit: '2021-04', art: 'FBA' },
      { land: 'PL', seit: '2025-03', art: 'PAN-EU' },
    ],
  };
  p.p3 = { laender: ['DE', 'AT', 'FR', 'PL'], b2bAnteilProzent: 5, b2bEU: true, b2bInland: false };
  p.p4 = {
    warengruppen: [{ name: 'Outdoor-Bekleidung', abweichenderSatz: false }],
    gebrauchtware: false,
  };
  p.p5 = { drittlandImport: true, laender: ['CN'], zollabwicklung: 'Spediteur' };
  p.p6 = { zahlungswege: ['PayPal', 'Klarna'] };
  p.p9 = { ossSeit: '2021-07', ioss: false, lokaleUstNr: ['PL'], dauerfrist: true };
  p.p10 = {
    vorjahresumsatzEur: 4_000_000,
    euFernverkaeufeVorjahrEur: 900_000,
    euFernverkaeufeLfdEur: 700_000,
  };
  p.p11 = { vorhanden: true, anbieter: ['Amazon EU S.à r.l.'] };
  return p;
}

describe('Profilregeln', () => {
  it('bereinigt Listen auf einer Kopie (Eingabe unverändert)', () => {
    const p = profil();
    p.p1.marktplaetze = ['Amazon', '', 'Amazon'];
    p.p3.laender = ['DE', 'DE', 'AT'];
    p.p5 = { drittlandImport: false, laender: ['CN'], zollabwicklung: '' };
    p.p11 = { vorhanden: false, anbieter: ['X'] };
    const b = bereinigeProfil(p);
    expect(b.p1.marktplaetze).toEqual(['Amazon']);
    expect(b.p3.laender).toEqual(['DE', 'AT']);
    expect(b.p5.laender).toEqual([]);
    expect(b.p11.anbieter).toEqual([]);
    expect(p.p1.marktplaetze).toEqual(['Amazon', '', 'Amazon']);
  });

  it('Strukturfehler nennen nur die Profilfrage, nie den Eingabewert', () => {
    const f = profilStrukturFehler([
      { path: ['p3', 'laender', 0] },
      { path: ['p3'] },
      { path: [] },
    ]);
    expect(f).toEqual([
      'P3: Angaben unvollständig oder im falschen Format.',
      ': Angaben unvollständig oder im falschen Format.',
    ]);
  });

  it('Pflichtangaben', () => {
    const p = profil();
    p.p6.zahlungswege = [];
    expect(pruefeProfil(p)).toEqual(['P6: Mindestens einen Zahlungsweg angeben.']);
    expect(pruefeProfil(profil())).toEqual([]);
  });

  it('Trigger: Ereignistypen und Neubewertung deterministisch mit Grund', () => {
    const alt = profil();
    const neu = profil();
    neu.p2.lager.push({ land: 'CZ', seit: '2026-09', art: 'PAN-EU' });
    expect(gleichesProfil(alt, neu)).toBe(false);
    expect(profilDiff(alt, neu).map((d) => d.nr)).toEqual(['P2']);
    expect(ereignisseFuerAenderung(alt, neu).map((e) => e.typ)).toContain('T-02');
    const nb = neuZuBewerten(alt, neu, ['EC-UST-04', 'EC-UST-05', 'EC-UST-06']);
    for (const grund of nb.values()) expect(grund.length).toBeGreaterThan(0);
    expect(ereignisseFuerAenderung(alt, profil())).toEqual([]);
  });

  it('Inhaltsgleichheit unabhängig von der Schlüsselreihenfolge', () => {
    expect(inhaltGleich({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(inhaltGleich({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(inhaltGleich([1, 2], [2, 1])).toBe(false);
  });
});
