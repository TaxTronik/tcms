// Geschäftsprofil lesen (ohne DB): strikte Struktur aus dem Vertrag, Bereinigung
// über die Profilregeln der Domain, keine Prototyp-Verschmutzung.
import { describe, expect, it } from 'vitest';
import { leeresProfil, type Geschaeftsprofil } from '@tcms/domain';
import { leseProfil } from './profil';

function profil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] };
  p.p3 = { laender: ['DE', 'AT'], b2bAnteilProzent: 5, b2bEU: true, b2bInland: false };
  return p;
}

describe('leseProfil', () => {
  it('liest ein gültiges Profil und bereinigt Listen ohne Seiteneffekt', () => {
    const p = profil();
    p.p1.marktplaetze = ['Amazon', '', 'Amazon'];
    p.p3.laender = ['DE', 'DE', 'AT'];
    const { profil: gelesen, fehler } = leseProfil(p);
    expect(fehler).toEqual([]);
    expect(gelesen?.p1.marktplaetze).toEqual(['Amazon']);
    expect(gelesen?.p3.laender).toEqual(['DE', 'AT']);
    expect(p.p1.marktplaetze).toEqual(['Amazon', '', 'Amazon']);
  });

  it('weist Zusatzfelder und falsche Typen ab, ohne Eingabewerte zu nennen', () => {
    const p = profil();
    for (const roh of [
      { ...p, p13: {} },
      { ...p, p1: { ...p.p1, extra: 'geheimer-wert' } },
      { ...p, p10: { ...p.p10, vorjahresumsatzEur: -1 } },
      { ...p, p3: { ...p.p3, laender: ['de'] } },
      null,
      [],
    ]) {
      const { profil: gelesen, fehler } = leseProfil(roh);
      expect(gelesen).toBeNull();
      expect(fehler.length).toBeGreaterThan(0);
      expect(fehler.join(' ')).not.toContain('geheimer-wert');
    }
  });

  it('übernimmt keinen eigenen __proto__-Schlüssel (keine Prototyp-Verschmutzung)', () => {
    const roh = JSON.parse(
      `{"__proto__":{"verschmutzt":1},${JSON.stringify(profil()).slice(1)}`,
    ) as object;
    const { profil: gelesen } = leseProfil(roh);
    expect(gelesen).not.toBeNull();
    expect(Object.getOwnPropertyNames(gelesen)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>)['verschmutzt']).toBeUndefined();
  });
});
