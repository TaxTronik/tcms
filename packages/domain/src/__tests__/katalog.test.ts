import { describe, expect, it } from 'vitest';
import {
  EREIGNISTYPEN,
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KERN_RISIKEN,
  kontrollenFuerRisiko,
} from '../index';

describe('Katalog E-Commerce v1.0', () => {
  it('enthält 23 Risiken, davon 8 Kernrisiken', () => {
    expect(KATALOG_RISIKEN).toHaveLength(23);
    expect(KERN_RISIKEN).toHaveLength(8);
  });

  it('verteilt die Governance-Typen wie im Fachkonzept (14 FP, 8 FF, 1 IN)', () => {
    const zahl = (gt: string) => KATALOG_RISIKEN.filter((r) => r.gt === gt).length;
    expect([zahl('FP'), zahl('FF'), zahl('IN')]).toEqual([14, 8, 1]);
  });

  it('enthält 24 Kontrollen, davon 6 Schlüsselkontrollen', () => {
    expect(KATALOG_KONTROLLEN).toHaveLength(24);
    expect(KATALOG_KONTROLLEN.filter((k) => k.schluessel).map((k) => k.code)).toEqual([
      'K-EC-01',
      'K-EC-04',
      'K-EC-05',
      'K-EC-11',
      'K-EC-12',
      'K-EC-20',
    ]);
  });

  it('deckt jedes Katalogrisiko mit mindestens einer Kontrolle ab', () => {
    for (const r of KATALOG_RISIKEN) {
      expect(kontrollenFuerRisiko(r.code).length, r.code).toBeGreaterThan(0);
    }
  });

  it('verweist nur auf existierende Risiken', () => {
    const codes = new Set(KATALOG_RISIKEN.map((r) => r.code));
    for (const k of KATALOG_KONTROLLEN) {
      for (const r of k.risiken) expect(codes.has(r), `${k.code} → ${r}`).toBe(true);
    }
    for (const r of KATALOG_RISIKEN) {
      for (const z of r.wirktAuf) expect(codes.has(z), `${r.code} → ${z}`).toBe(true);
    }
  });

  it('hat eindeutige Codes und 15 Ereignistypen', () => {
    expect(new Set(KATALOG_RISIKEN.map((r) => r.code)).size).toBe(23);
    expect(new Set(KATALOG_KONTROLLEN.map((k) => k.code)).size).toBe(24);
    expect(EREIGNISTYPEN.map((t) => t.code)).toEqual(
      Array.from({ length: 15 }, (_, i) => `T-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('verweist in Ereignisfolgen nur auf existierende Objekte', () => {
    const codes = new Set([
      ...KATALOG_RISIKEN.map((r) => r.code),
      ...KATALOG_KONTROLLEN.map((k) => k.code),
    ]);
    for (const t of EREIGNISTYPEN) {
      for (const f of t.folgen)
        if (f.ziel) expect(codes.has(f.ziel), `${t.code} → ${f.ziel}`).toBe(true);
    }
  });
});
