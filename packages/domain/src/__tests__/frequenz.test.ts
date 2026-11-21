import { describe, expect, it } from 'vitest';
import {
  anlassQuellen,
  frequenzLabel,
  leiteFrequenzAb,
  matrixFrequenz,
  matrixZelle,
  mindestfrequenzText,
  strengere,
} from '../index';

describe('Anzeige der Häufigkeitsmatrix', () => {
  it('nennt für „jede Periode“ den Turnus des Mandanten', () => {
    expect(matrixZelle('FP', 'HOCH')).toBe('jede Periode');
    expect(mindestfrequenzText('FP', 'HOCH', 'QUARTALSWEISE')).toBe(
      'FP · hoch → jede Periode (quartalsweise)',
    );
  });

  it('zeigt anlassbezogene und jährliche Startwerte unabhängig vom Erklärungsturnus', () => {
    expect(mindestfrequenzText('FF', 'KRITISCH', 'JAEHRLICH')).toBe(
      'FF · kritisch → monatlich + jede Auslösung',
    );
    expect(matrixZelle('IN', 'GERING')).toBe('bei Ereignis');
    expect(matrixZelle('IN', 'MITTEL')).toBe('jährliche Bestätigung + bei Ereignis');
    expect(mindestfrequenzText('FP', 'GERING', 'MONATLICH')).toBe('FP · gering → jährlich');
  });
});

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
  it('nennt die Quelle der Prüfung bei Auslösung, wenn sie aus einem anderen Risiko stammt', () => {
    const a = leiteFrequenzAb(
      { turnus: 'JAEHRLICH', anlass: false },
      [
        { code: 'EC-UST-03', gt: 'FP', brutto: 'KRITISCH' },
        { code: 'EC-UST-05', gt: 'FF', brutto: 'MITTEL' },
      ],
      'MONATLICH',
    );
    expect(a.effektiv).toEqual({ turnus: 'MONATLICH', anlass: true });
    expect(a.quelle?.code).toBe('EC-UST-03');
    expect(a.begruendung).toBe(
      'abgeleitet aus FP · kritisch (EC-UST-03); Prüfung bei Auslösung aus FF · mittel (EC-UST-05); Vorlage: jährlich',
    );
  });
  it('nennt die Auslösungs-Quellen nach GT-Vorrang (FF vor IN), höchstens drei', () => {
    const b = leiteFrequenzAb({ turnus: 'JAEHRLICH', anlass: false }, [
      { code: 'A', gt: 'FP', brutto: 'GERING' },
      { code: 'B', gt: 'IN', brutto: 'HOCH' },
    ]);
    expect(b.effektiv).toEqual({ turnus: 'JAEHRLICH', anlass: true });
    expect(b.begruendung).toBe(
      'abgeleitet aus FP · gering (A); Prüfung bei Auslösung aus IN · hoch (B); Vorlage: jährlich',
    );
    const c = leiteFrequenzAb({ turnus: 'JAEHRLICH', anlass: false }, [
      { code: 'A', gt: 'FP', brutto: 'KRITISCH' },
      { code: 'I1', gt: 'IN', brutto: 'GERING' },
      { code: 'F1', gt: 'FF', brutto: 'GERING' },
      { code: 'I2', gt: 'IN', brutto: 'HOCH' },
      { code: 'F2', gt: 'FF', brutto: 'MITTEL' },
    ]);
    expect(c.begruendung).toContain(
      'Prüfung bei Auslösung aus FF · gering (F1), FF · mittel (F2), IN · gering (I1) und 1 weiteren;',
    );
  });
  it('nennt keine zusätzliche Quelle, wenn das Turnus-Risiko die Auslösung selbst verlangt', () => {
    const a = leiteFrequenzAb({ turnus: 'JAEHRLICH', anlass: false }, [
      { code: 'F', gt: 'FF', brutto: 'KRITISCH' },
      { code: 'I', gt: 'IN', brutto: 'HOCH' },
    ]);
    expect(a.begruendung).toBe('abgeleitet aus FF · kritisch (F); Vorlage: jährlich');
    expect(anlassQuellen(a.quelle, [{ code: 'I', gt: 'IN', brutto: 'HOCH' }], 'MONATLICH')).toEqual(
      [],
    );
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
