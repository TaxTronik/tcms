import { describe, expect, it } from 'vitest';
import { frequenzLabel, leiteFrequenzAb, matrixFrequenz, strengere } from '../index';

describe('Häufigkeitsmatrix GT × Bruttoklasse', () => {
  it('FP: jede Periode / quartalsweise / jährlich', () => {
    expect(matrixFrequenz('FP', 'KRITISCH')).toEqual({ turnus: 'MONATLICH', anlass: false });
    expect(matrixFrequenz('FP', 'HOCH', 'QUARTALSWEISE')).toEqual({
      turnus: 'QUARTALSWEISE',
      anlass: false,
    });
    expect(matrixFrequenz('FP', 'MITTEL')).toEqual({ turnus: 'QUARTALSWEISE', anlass: false });
    expect(matrixFrequenz('FP', 'GERING')).toEqual({ turnus: 'JAEHRLICH', anlass: false });
  });
  it('FF: Monitoring mit jeder Auslösung', () => {
    expect(frequenzLabel(matrixFrequenz('FF', 'KRITISCH'))).toBe('monatlich + bei Auslösung');
    expect(frequenzLabel(matrixFrequenz('FF', 'MITTEL'))).toBe('quartalsweise + bei Auslösung');
    expect(frequenzLabel(matrixFrequenz('FF', 'GERING'))).toBe('nur bei Auslösung');
  });
  it('IN: jährliche Bestätigung oder nur bei Ereignis', () => {
    expect(matrixFrequenz('IN', 'KRITISCH')).toEqual({ turnus: 'JAEHRLICH', anlass: true });
    expect(matrixFrequenz('IN', 'GERING')).toEqual({ turnus: 'KEIN', anlass: true });
  });
});

describe('Ableitung je Kontrolle', () => {
  it('nimmt die strengste Frequenz über alle Risiken und die strengere aus Vorlage und Matrix', () => {
    const a = leiteFrequenzAb({ turnus: 'QUARTALSWEISE', anlass: false }, [
      { code: 'EC-UST-03', gt: 'FP', brutto: 'HOCH' },
      { code: 'EC-UST-05', gt: 'FF', brutto: 'KRITISCH' },
    ]);
    expect(a.effektiv).toEqual({ turnus: 'MONATLICH', anlass: true });
    expect(a.abweichendVonVorlage).toBe(true);
    expect(a.gt).toBe('FF');
    expect(a.quelle?.code).toBe('EC-UST-05');
  });
  it('bleibt bei der Vorlage, wenn sie strenger ist', () => {
    const a = leiteFrequenzAb({ turnus: 'MONATLICH', anlass: false }, [
      { code: 'X', gt: 'FP', brutto: 'GERING' },
    ]);
    expect(a.effektiv).toEqual({ turnus: 'MONATLICH', anlass: false });
    expect(a.abweichendVonVorlage).toBe(false);
  });
  it('übernimmt den Anlass aus FF-Risiken', () => {
    const a = leiteFrequenzAb({ turnus: 'MONATLICH', anlass: false }, [
      { code: 'EC-UST-05', gt: 'FF', brutto: 'KRITISCH' },
    ]);
    expect(a.effektiv).toEqual({ turnus: 'MONATLICH', anlass: true });
    expect(a.gt).toBe('FF');
  });
  it('strengere ist kommutativ', () => {
    const x = { turnus: 'JAEHRLICH' as const, anlass: true };
    const y = { turnus: 'QUARTALSWEISE' as const, anlass: false };
    expect(strengere(x, y)).toEqual(strengere(y, x));
  });
});

describe('jede Periode', () => {
  it('folgt dem eigenen Rhythmus der Kontrolle (OSS quartalsweise)', () => {
    const a = leiteFrequenzAb(
      { turnus: 'QUARTALSWEISE', anlass: false },
      [{ code: 'EC-UST-03', gt: 'FP', brutto: 'KRITISCH' }],
      'MONATLICH',
    );
    expect(a.effektiv).toEqual({ turnus: 'QUARTALSWEISE', anlass: false });
    expect(a.abweichendVonVorlage).toBe(false);
  });
  it('nimmt bei jährlicher Vorlage den Erklärungsturnus des Mandanten', () => {
    const a = leiteFrequenzAb(
      { turnus: 'JAEHRLICH', anlass: false },
      [{ code: 'X', gt: 'FP', brutto: 'HOCH' }],
      'MONATLICH',
    );
    expect(a.effektiv.turnus).toBe('MONATLICH');
  });
});
