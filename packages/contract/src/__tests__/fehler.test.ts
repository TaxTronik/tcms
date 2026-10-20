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
  konfliktMitGrund,
  KONFLIKT_GRUENDE,
  nichtBerechtigt,
  VERWEIGERUNG_GRUENDE,
  type FehlerCode,
  type KonfliktGrund,
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

describe('Konfliktgrund (`fehler.konflikt`, tcms-s10): nur bei KONFLIKT, aus der festen Liste', () => {
  it('ist eine feste Liste eindeutiger Bezeichner', () => {
    expect(new Set(KONFLIKT_GRUENDE).size).toBe(KONFLIKT_GRUENDE.length);
    for (const g of KONFLIKT_GRUENDE) expect(g).toMatch(/^[A-Z][A-Z_]{2,30}$/);
  });

  it('konflikt setzt Code, Status, Meldung und Grund', () => {
    for (const g of KONFLIKT_GRUENDE) {
      const f = konfliktMitGrund(g, 'Feste Meldung.');
      expect([f.code, f.status, f.message, f.konflikt, f.grund, f.felder]).toEqual([
        'KONFLIKT',
        409,
        'Feste Meldung.',
        g,
        undefined,
        undefined,
      ]);
    }
    expect(new DienstFehler('KONFLIKT', 'x').konflikt).toBeUndefined();
  });

  it('weist einen Konfliktgrund an anderen Codes und unbekannte Gründe zur Laufzeit ab', () => {
    const roh = DienstFehler as unknown as new (...a: unknown[]) => DienstFehler;
    for (const code of CODES.filter((c) => c !== 'KONFLIKT')) {
      expect(() => new roh(code, 'x', undefined, undefined, 'CODE_FEHLT'), code).toThrow(TypeError);
    }
    expect(() => new roh('KONFLIKT', 'x', undefined, undefined, 'ERFUNDEN')).toThrow(TypeError);
    expect(() => konfliktMitGrund('code_fehlt' as KonfliktGrund, 'x')).toThrow(TypeError);
    // Ein Verweigerungsgrund ist kein Konfliktgrund und umgekehrt.
    expect(() => new roh('KONFLIKT', 'x', undefined, 'VIER_AUGEN', 'CODE_FEHLT')).toThrow(
      TypeError,
    );
    expect(() => new roh('NICHT_BERECHTIGT', 'x', undefined, 'VIER_AUGEN', 'CODE_FEHLT')).toThrow(
      TypeError,
    );
  });

  it('FehlerSchema: konflikt nur bei KONFLIKT und nur aus der Liste', () => {
    for (const k of KONFLIKT_GRUENDE) {
      expect(FehlerSchema.safeParse({ code: 'KONFLIKT', meldung: 'x', konflikt: k }).success).toBe(
        true,
      );
    }
    expect(FehlerSchema.safeParse({ code: 'KONFLIKT' }).success).toBe(true);
    expect(FehlerSchema.safeParse({ code: 'KONFLIKT', konflikt: 'ERFUNDEN' }).success).toBe(false);
    for (const code of CODES.filter((c) => c !== 'KONFLIKT')) {
      const f = code === 'NICHT_BERECHTIGT' ? { code, grund: 'VIER_AUGEN' } : { code };
      expect(FehlerSchema.safeParse({ ...f, konflikt: 'CODE_FEHLT' }).success, code).toBe(false);
    }
    // Insbesondere nie an 404 (kein Existenz-Orakel).
    expect(
      antwortSchema(z.object({}).strict()).safeParse({
        ok: false,
        fehler: { code: 'NICHT_GEFUNDEN', konflikt: 'BEREITS_ERLEDIGT' },
      }).success,
    ).toBe(false);
  });
});
