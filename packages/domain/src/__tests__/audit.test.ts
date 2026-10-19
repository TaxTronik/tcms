import { describe, expect, it } from 'vitest';
import { auditHash, GENESIS_HASH, kanonisch, pruefeKette, type AuditEintrag } from '../audit';

function kette(n: number): AuditEintrag[] {
  const out: AuditEintrag[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const inhalt = {
      at: new Date(Date.UTC(2026, 9, i)),
      actorId: 'p1',
      aktion: 'test',
      objektTyp: 'X',
      objektId: String(i),
      detail: { i },
    };
    const hash = auditHash(prev, inhalt);
    out.push({ ...inhalt, seq: i, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

describe('Audit-Hashkette', () => {
  it('serialisiert stabil unabhängig von der Schlüsselreihenfolge', () => {
    expect(kanonisch({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      kanonisch({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });
  it('erkennt eine intakte Kette', () => {
    expect(pruefeKette(kette(5))).toMatchObject({ gueltig: true, geprueft: 5 });
  });
  it('erkennt eine nachträgliche Änderung', () => {
    const k = kette(5);
    k[2] = { ...k[2]!, detail: { i: 99 } };
    expect(pruefeKette(k)).toMatchObject({ gueltig: false, bruchBei: 3 });
  });
});
