import { describe, expect, it } from 'vitest';
import {
  auditHash,
  GENESIS_HASH,
  kanonisch,
  KETTEN_VERSION,
  pruefeKette,
  type AuditEintrag,
  type AuditInhalt,
} from '../audit';

const TENANT_A = '0b6f2a52-6c1e-4d5f-9a39-3f1f0c4a2b11';
const TENANT_B = '7d0c1e9a-2f44-4b8e-8c5d-91a0e3f4b622';

function kette(n: number, tenantId = TENANT_A, seqStart = 1): AuditEintrag[] {
  const out: AuditEintrag[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const inhalt: AuditInhalt = {
      tenantId,
      at: new Date(Date.UTC(2026, 9, i + 1)),
      actorId: 'c3a3b8f0-0000-4000-8000-000000000001',
      actorName: 'StB Dr. Anna Roth',
      aktion: 'tcms.test',
      objektTyp: 'X',
      objektId: String(i),
      programmId: 'prog-1',
      detail: { i },
    };
    const hash = auditHash(prev, inhalt);
    out.push({ ...inhalt, seq: seqStart + i, kettenVersion: KETTEN_VERSION, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

/** Ersetzt ein Feld des dritten Eintrags, ohne den Hash neu zu berechnen. */
function manipuliert<K extends keyof AuditEintrag>(feld: K, wert: AuditEintrag[K]): AuditEintrag[] {
  const k = kette(5);
  k[2] = { ...k[2]!, [feld]: wert };
  return k;
}

describe('Audit-Hashkette (Kettenversion 2)', () => {
  it('serialisiert stabil unabhängig von der Schlüsselreihenfolge', () => {
    expect(kanonisch({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      kanonisch({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it('erkennt eine intakte Kette', () => {
    expect(pruefeKette(TENANT_A, kette(5))).toMatchObject({ gueltig: true, geprueft: 5 });
    expect(pruefeKette(TENANT_A, [])).toMatchObject({ gueltig: true, geprueft: 0 });
  });

  // Jedes gebundene Feld: Änderung ohne neuen Hash bricht die Kette an genau
  // diesem Eintrag. actorName, programmId und tenantId deckte Version 1 nicht
  // ab (TS-10); mit dem alten Hash schlügen diese drei Fälle fehl.
  const faelle: [keyof AuditEintrag, unknown][] = [
    ['tenantId', TENANT_B],
    ['at', new Date(Date.UTC(2026, 9, 30))],
    ['actorId', 'c3a3b8f0-0000-4000-8000-000000000002'],
    ['actorId', null],
    ['actorName', 'Leon Brandt'],
    ['aktion', 'tcms.anders'],
    ['objektTyp', 'Y'],
    ['objektId', '99'],
    ['programmId', 'prog-2'],
    ['programmId', null],
    ['detail', { i: 99 }],
    ['detail', { i: 2, zusatz: true }],
    ['prevHash', 'f'.repeat(64)],
    ['hash', 'e'.repeat(64)],
    ['kettenVersion', 1],
  ];
  it.each(faelle)('erkennt die Manipulation von %s', (feld, wert) => {
    const r = pruefeKette(TENANT_A, manipuliert(feld, wert as never));
    expect(r.gueltig).toBe(false);
    expect(r.bruchBei).toBe(3);
  });

  it('jedes gebundene Feld verändert den Hash', () => {
    const basis = kette(1)[0]!;
    const h = auditHash(GENESIS_HASH, basis);
    for (const [feld, wert] of faelle) {
      if (feld === 'prevHash' || feld === 'hash' || feld === 'kettenVersion') continue;
      expect(auditHash(GENESIS_HASH, { ...basis, [feld]: wert })).not.toBe(h);
    }
  });

  it('erkennt einen neu berechneten Hash am Folgeeintrag', () => {
    const k = kette(5);
    const neu = { ...k[2]!, detail: { i: 99 } };
    neu.hash = auditHash(neu.prevHash, neu);
    k[2] = neu;
    expect(pruefeKette(TENANT_A, k)).toMatchObject({ gueltig: false, bruchBei: 4 });
  });

  it('erkennt gelöschte und vertauschte Einträge', () => {
    const k = kette(5);
    expect(pruefeKette(TENANT_A, [k[0]!, k[1]!, k[3]!, k[4]!])).toMatchObject({
      gueltig: false,
      bruchBei: 4,
    });
    expect(pruefeKette(TENANT_A, [k[0]!, k[2]!, k[1]!])).toMatchObject({ gueltig: false });
  });

  it('weist einen gültigen Eintrag eines anderen Tenants zurück', () => {
    const fremd = kette(1, TENANT_B, 100);
    // Kette von B ist für sich gültig, aber nicht als Kette von A.
    expect(pruefeKette(TENANT_B, fremd).gueltig).toBe(true);
    expect(pruefeKette(TENANT_A, fremd)).toMatchObject({
      gueltig: false,
      grund: 'Eintrag gehört zu einem anderen Tenant',
    });
  });

  it('gleicher Inhalt in zwei Tenants ergibt verschiedene Hashes', () => {
    expect(kette(1, TENANT_A)[0]!.hash).not.toBe(kette(1, TENANT_B)[0]!.hash);
  });
});
