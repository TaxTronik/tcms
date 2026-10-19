// Reine Profilregeln (ohne DB): strikte Struktur, Bereinigung, Pflichtangaben,
// Trigger der Profiländerung.
import { describe, expect, it } from 'vitest';
import {
  ereignisseFuerAenderung,
  gleichesProfil,
  leseProfil,
  neuZuBewerten,
  pruefeProfil,
} from '../profil-regeln';
import { testProfil } from './fixture';

describe('Profilregeln', () => {
  it('liest ein gültiges Profil und bereinigt Listen', () => {
    const p = testProfil();
    p.p1.marktplaetze = ['Amazon', '', 'Amazon'];
    p.p3.laender = ['DE', 'DE', 'AT'];
    const { profil, fehler } = leseProfil(p);
    expect(fehler).toEqual([]);
    expect(profil?.p1.marktplaetze).toEqual(['Amazon']);
    expect(profil?.p3.laender).toEqual(['DE', 'AT']);
    // Die Eingabe bleibt unverändert (keine Seiteneffekte).
    expect(p.p1.marktplaetze).toEqual(['Amazon', '', 'Amazon']);
  });

  it('weist Zusatzfelder und falsche Typen ab', () => {
    const p = testProfil();
    for (const roh of [
      { ...p, p13: {} },
      { ...p, p1: { ...p.p1, extra: true } },
      { ...p, p10: { ...p.p10, vorjahresumsatzEur: -1 } },
      { ...p, p3: { ...p.p3, laender: ['de'] } },
      null,
      [],
    ]) {
      const { profil, fehler } = leseProfil(roh);
      expect(profil).toBeNull();
      expect(fehler.length).toBeGreaterThan(0);
    }
  });

  it('übernimmt keinen eigenen __proto__-Schlüssel (keine Prototyp-Verschmutzung)', () => {
    const roh = JSON.parse(
      `{"__proto__":{"verschmutzt":1},${JSON.stringify(testProfil()).slice(1)}`,
    ) as object;
    const { profil } = leseProfil(roh);
    expect(profil).not.toBeNull();
    expect(Object.getOwnPropertyNames(profil)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>)['verschmutzt']).toBeUndefined();
  });

  it('Pflichtangaben', () => {
    const p = testProfil();
    p.p6.zahlungswege = [];
    expect(pruefeProfil(p)).toEqual(['P6: Mindestens einen Zahlungsweg angeben.']);
  });

  it('Trigger: Ereignistypen und Neubewertung deterministisch mit Grund', () => {
    const alt = testProfil();
    const neu = testProfil();
    neu.p2.lager.push({ land: 'CZ', seit: '2026-09', art: 'PAN-EU' });
    expect(gleichesProfil(alt, neu)).toBe(false);
    expect(ereignisseFuerAenderung(alt, neu).map((e) => e.typ)).toContain('T-02');
    const nb = neuZuBewerten(alt, neu, ['EC-UST-04', 'EC-UST-05', 'EC-UST-06']);
    for (const grund of nb.values()) expect(grund.length).toBeGreaterThan(0);
    expect(ereignisseFuerAenderung(alt, testProfil())).toEqual([]);
  });
});
