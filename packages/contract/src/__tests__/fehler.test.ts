// Maschinenlesbarer Verweigerungsgrund (`fehler.grund`): genau bei
// NICHT_BERECHTIGT, aus der festen Liste, nie an NICHT_GEFUNDEN (kein
// Existenz-Orakel) – im Fehlerobjekt des Dienstes wie im Antwortschema.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  antwortSchema,
  DienstFehler,
  FEHLER_STATUS,
  FehlerSchema,
  nichtBerechtigt,
  VERWEIGERUNG_GRUENDE,
  type FehlerCode,
  type VerweigerungGrund,
} from '../index';

const CODES = Object.keys(FEHLER_STATUS) as FehlerCode[];

describe('VERWEIGERUNG_GRUENDE', () => {
  it('ist eine feste Liste eindeutiger Bezeichner', () => {
    expect(new Set(VERWEIGERUNG_GRUENDE).size).toBe(VERWEIGERUNG_GRUENDE.length);
    for (const g of VERWEIGERUNG_GRUENDE) expect(g).toMatch(/^[A-Z][A-Z_]{2,30}$/);
  });
});

describe('DienstFehler mit Verweigerungsgrund', () => {
  it('nichtBerechtigt setzt Code, Status, Meldung und Grund', () => {
    for (const g of VERWEIGERUNG_GRUENDE) {
      const f = nichtBerechtigt(g, 'Nur zuständige Personen.');
      expect(f).toBeInstanceOf(DienstFehler);
      expect([f.code, f.status, f.message, f.grund, f.felder]).toEqual([
        'NICHT_BERECHTIGT',
        403,
        'Nur zuständige Personen.',
        g,
        undefined,
      ]);
    }
  });

  it('andere Codes haben keinen Grund', () => {
    for (const code of CODES.filter((c) => c !== 'NICHT_BERECHTIGT')) {
      expect(new DienstFehler(code as Exclude<FehlerCode, 'NICHT_BERECHTIGT'>).grund).toBe(
        undefined,
      );
    }
  });

  it('weist NICHT_BERECHTIGT ohne Grund und einen Grund an anderen Codes zur Laufzeit ab', () => {
    // Der Typ verbietet beides; JavaScript-Aufrufer und Umwandlungen prüft der Konstruktor.
    const roh = DienstFehler as unknown as new (...a: unknown[]) => DienstFehler;
    expect(() => new roh('NICHT_BERECHTIGT', 'x')).toThrow(TypeError);
    expect(() => new roh('NICHT_BERECHTIGT')).toThrow(TypeError);
    expect(() => new roh('NICHT_GEFUNDEN', undefined, undefined, 'BEARBEITEN')).toThrow(TypeError);
    expect(() => new roh('KONFLIKT', 'x', undefined, 'VIER_AUGEN')).toThrow(TypeError);
    expect(() => new roh('NICHT_BERECHTIGT', 'x', undefined, 'ERFUNDEN')).toThrow(TypeError);
    expect(() => nichtBerechtigt('bearbeiten' as VerweigerungGrund, 'x')).toThrow(TypeError);
    // @ts-expect-error NICHT_BERECHTIGT nur über nichtBerechtigt(grund, meldung)
    expect(() => new DienstFehler('NICHT_BERECHTIGT', 'x')).toThrow(TypeError);
  });
});

describe('FehlerSchema: grund genau bei NICHT_BERECHTIGT', () => {
  it('nimmt 403 mit jedem Grund der Liste an', () => {
    for (const grund of VERWEIGERUNG_GRUENDE) {
      expect(
        FehlerSchema.safeParse({ code: 'NICHT_BERECHTIGT', meldung: 'x', grund }).success,
      ).toBe(true);
    }
  });

  it('weist 403 ohne Grund, unbekannte Gründe und Gründe an anderen Codes ab', () => {
    expect(FehlerSchema.safeParse({ code: 'NICHT_BERECHTIGT', meldung: 'x' }).success).toBe(false);
    expect(FehlerSchema.safeParse({ code: 'NICHT_BERECHTIGT', grund: 'ERFUNDEN' }).success).toBe(
      false,
    );
    expect(FehlerSchema.safeParse({ code: 'NICHT_BERECHTIGT', grund: 'bearbeiten' }).success).toBe(
      false,
    );
    for (const code of CODES.filter((c) => c !== 'NICHT_BERECHTIGT')) {
      expect(FehlerSchema.safeParse({ code }).success, code).toBe(true);
      expect(FehlerSchema.safeParse({ code, grund: 'BEARBEITEN' }).success, code).toBe(false);
    }
  });

  it('gilt auch im Antwortumschlag', () => {
    const s = antwortSchema(z.object({}).strict());
    expect(
      s.safeParse({ ok: false, fehler: { code: 'NICHT_GEFUNDEN', grund: 'VERTRAULICH' } }).success,
    ).toBe(false);
    expect(
      s.safeParse({ ok: false, fehler: { code: 'NICHT_BERECHTIGT', grund: 'VERTRAULICH' } })
        .success,
    ).toBe(true);
  });
});
