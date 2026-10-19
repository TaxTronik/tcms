import { describe, expect, it } from 'vitest';
import {
  brutto,
  bewerte,
  nettoBetrieb,
  nettoDesign,
  SCHAEDEN,
  WAHRSCHEINLICHKEITEN,
  type KontrolleFuerNetto,
  type Klasse,
} from '../index';

describe('Bruttoklasse (Wahrheitstabelle S × W)', () => {
  const erwartet: Record<string, Klasse[]> = {
    N: ['GERING', 'GERING', 'MITTEL', 'MITTEL'],
    M: ['GERING', 'MITTEL', 'HOCH', 'HOCH'],
    H: ['MITTEL', 'HOCH', 'KRITISCH', 'KRITISCH'],
  };
  for (const s of SCHAEDEN) {
    WAHRSCHEINLICHKEITEN.forEach((w, i) => {
      it(`${s} × ${w} ohne Reichweitenerhöhung → ${erwartet[s]![i]}`, () => {
        expect(brutto(s, w, 1).klasse).toBe(erwartet[s]![i]);
        expect(brutto(s, w, 2).klasse).toBe(erwartet[s]![i]);
      });
    });
  }

  it('Reichweite 3 hebt um eine Klasse, höchstens bis kritisch', () => {
    expect(brutto('N', 'SELTEN', 3).klasse).toBe('MITTEL');
    expect(brutto('M', 'MOEGLICH', 3).klasse).toBe('HOCH');
    expect(brutto('H', 'MOEGLICH', 3).klasse).toBe('KRITISCH');
    const k = brutto('H', 'WAHRSCHEINLICH', 3);
    expect(k.klasse).toBe('KRITISCH');
    expect(k.angehoben).toBe(false);
    expect(k.erklaerung).toContain('bereits kritisch');
  });
});

const ktr = (p: Partial<KontrolleFuerNetto>): KontrolleFuerNetto => ({
  code: 'K',
  art: 'D',
  design: 'ANGEMESSEN',
  schluessel: false,
  betrieb: 'OK',
  ...p,
});

describe('Netto (Design)', () => {
  it('ohne angemessene Kontrolle kein Abschlag', () => {
    expect(nettoDesign('HOCH', []).klasse).toBe('HOCH');
    expect(nettoDesign('HOCH', [ktr({ design: 'NICHT_BEURTEILT' })]).klasse).toBe('HOCH');
    expect(nettoDesign('HOCH', [ktr({ design: 'MANGEL' })]).klasse).toBe('HOCH');
  });
  it('eine angemessene Kontrolle senkt um eine Klasse', () => {
    expect(nettoDesign('KRITISCH', [ktr({})]).klasse).toBe('HOCH');
  });
  it('präventiv + detektiv senkt um zwei Klassen', () => {
    expect(nettoDesign('KRITISCH', [ktr({ art: 'P' }), ktr({ art: 'D' })]).klasse).toBe('MITTEL');
  });
  it('präventive Schlüsselkontrolle senkt um zwei Klassen', () => {
    expect(nettoDesign('HOCH', [ktr({ art: 'P', schluessel: true })]).klasse).toBe('GERING');
  });
  it('Untergrenze gering', () => {
    expect(nettoDesign('GERING', [ktr({ art: 'P' }), ktr({ art: 'D' })]).klasse).toBe('GERING');
  });
});

describe('Netto (Betrieb)', () => {
  it('Abschlag entfällt bei überfälliger oder beanstandeter Durchführung', () => {
    const e = nettoBetrieb('KRITISCH', [
      ktr({ art: 'P', betrieb: 'UEBERFAELLIG' }),
      ktr({ art: 'D' }),
    ]);
    expect(e.klasse).toBe('HOCH');
    expect(e.erklaerung).toContain('überfällig');
    expect(nettoBetrieb('HOCH', [ktr({ betrieb: 'MIT_BEFUND' })]).klasse).toBe('HOCH');
    expect(nettoBetrieb('HOCH', [ktr({ betrieb: 'KEINE' })]).klasse).toBe('HOCH');
  });
  it('liegt nie unter Netto (Design)', () => {
    for (const betrieb of ['OK', 'MIT_BEFUND', 'UEBERFAELLIG', 'KEINE'] as const) {
      const k = [ktr({ art: 'P', betrieb }), ktr({ art: 'D' })];
      const d = nettoDesign('KRITISCH', k).klasse;
      const b = nettoBetrieb('KRITISCH', k).klasse;
      expect(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'].indexOf(b)).toBeGreaterThanOrEqual(
        ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'].indexOf(d),
      );
    }
  });
});

describe('Übersteuerung', () => {
  it('lässt den berechneten Wert sichtbar und setzt den wirksamen Wert', () => {
    const b = bewerte('H', 'MOEGLICH', 3, [ktr({})], { design: 'MITTEL' });
    expect(b.nettoDesign.klasse).toBe('HOCH');
    expect(b.wirksamDesign).toBe('MITTEL');
    expect(b.uebersteuertDesign).toBe(true);
    expect(b.uebersteuertBetrieb).toBe(false);
  });
});
