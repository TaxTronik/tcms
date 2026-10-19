// Routentabelle „risiken-kontrollen" ohne Datenbank: jede Route ist an den
// Mandanten gebunden, keine ist ein Portal-Endpunkt (Mandantenkontakte → 404),
// schreibende Routen nehmen keinen Stichtag (TS-07), lesende nur `stand`.
import type { Endpunkt } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import type { Tx } from '@tcms/db';
import { RoutenTabelle } from '../routen';
import { registriereRisikenKontrollen } from '../routen/risiken-kontrollen';

/** Die Routen des Bereichs, wie sie aus dem Endpunktregister entstehen. */
function definitionen() {
  const liste: Endpunkt[] = [];
  registriereRisikenKontrollen({
    endpunkt: (e) => liste.push(e),
    route: () => {
      throw new Error('Fachrouten nur aus dem Endpunktregister');
    },
  });
  return liste.map((e) => ({
    methode: e.methode,
    pfad: e.pfad,
    akteure: e.akteure,
    body: e.bodySchema ?? undefined,
    query: e.querySchema ?? undefined,
  }));
}

describe('Routen risiken-kontrollen', () => {
  it('lassen sich eindeutig eintragen (keine mehrdeutigen Muster)', () => {
    const t = new RoutenTabelle<Tx>();
    expect(() => registriereRisikenKontrollen(t.registrar())).not.toThrow();
    expect(definitionen()).toHaveLength(20);
  });

  it('nur Kanzleipersonen, nur unter /v1/mandanten/:mandantId/', () => {
    for (const d of definitionen()) {
      expect(d.pfad.startsWith('/v1/mandanten/:mandantId/')).toBe(true);
      expect(d.akteure).toEqual(['KANZLEI']);
    }
  });

  it('schreibend: Body-Schema, keine Query; lesend: nur ?stand, kein Body', () => {
    for (const d of definitionen()) {
      if (d.methode === 'GET') {
        expect(d.body).toBeUndefined();
        const q = d.query as unknown as { safeParse(x: unknown): { success: boolean } };
        expect(q.safeParse({ stand: '2026-10-16' }).success).toBe(true);
        expect(q.safeParse({ stand: '2026-02-30' }).success).toBe(false);
        expect(q.safeParse({ stand: '2026-10-16', x: '1' }).success).toBe(false);
      } else {
        expect(d.methode).toBe('POST');
        expect(d.query).toBeUndefined();
        const b = d.body as unknown as { safeParse(x: unknown): { success: boolean } };
        expect(b).toBeDefined();
        // Mandant und Objekt-IDs kommen nur aus dem Pfad.
        expect(b.safeParse({ mandantId: '3c3c3c3c-3333-4333-8333-33333333abcd' }).success).toBe(
          false,
        );
      }
    }
  });
});
