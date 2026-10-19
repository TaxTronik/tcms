// Bestätigungscodes (rein): Format, HMAC mit geheimem Schlüssel (H5), Bindung an
// die Freigabe, Schlüsselliste für die Rotation, Vergleich in konstanter Zeit,
// gespeicherter Codezustand (fail closed).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  brauchtCodeSchluessel,
  CODE_GUELTIG_TAGE,
  codeAblaufAb,
  codeHash,
  codePasst,
  codeStatus,
  codeVerfahrenGueltig,
  erzeugeCode,
  erzeugeCodeSchluessel,
  leseCodeZustand,
  MAX_FEHLVERSUCHE,
} from './code';

vi.mock('node:crypto', async (original) => {
  const o = await original<typeof import('node:crypto')>();
  return { ...o, timingSafeEqual: vi.fn(o.timingSafeEqual), randomInt: vi.fn(o.randomInt) };
});

const HEX = 'a'.repeat(64);
const ID = '0123456789abcdef';
/** Zufällige Testschlüssel (keine festen Werte im Repository). */
const neuerSchluessel = () => randomBytes(32).toString('base64url');
const A = neuerSchluessel();
const B = neuerSchluessel();
const nurA = erzeugeCodeSchluessel([A]);

describe('Bestätigungscode', () => {
  it('erzeugt 6 Ziffern aus randomInt (node:crypto), auch mit führenden Nullen', async () => {
    const { randomInt } = await import('node:crypto');
    for (let i = 0; i < 200; i++) expect(erzeugeCode()).toMatch(/^\d{6}$/);
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    vi.mocked(randomInt).mockReturnValueOnce(42 as never);
    expect(erzeugeCode()).toBe('000042');
  });

  it('Hash: HMAC mit dem Schlüssel, an die Freigabe gebunden, ohne Schlüssel nicht nachrechenbar', () => {
    const h = codeHash(nurA, 'freigabe-a', '123456');
    expect(h.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.codeSchluesselId).toMatch(/^[0-9a-f]{16}$/);
    expect(h.codeSchluesselId).toBe(nurA.aktuelleId);
    expect(h.codeHash).not.toBe(codeHash(nurA, 'freigabe-b', '123456').codeHash);
    // Weder das frühere Verfahren (SHA-256) noch ein anderer Schlüssel ergibt denselben Hash.
    const frueher = createHash('sha256')
      .update('tcms|freigabe-code|v1|freigabe-a|123456')
      .digest('hex');
    expect(h.codeHash).not.toBe(frueher);
    expect(h.codeHash).not.toBe(
      createHmac('sha256', B).update('tcms|freigabe-code|v2|freigabe-a|123456').digest('hex'),
    );
    expect(h.codeHash).toBe(
      createHmac('sha256', A).update('tcms|freigabe-code|v2|freigabe-a|123456').digest('hex'),
    );
    // Die Kennung verrät den Schlüssel nicht (abgeleitet, nicht enthalten).
    expect(A).not.toContain(h.codeSchluesselId);
    const z = { hash: h.codeHash, schluesselId: h.codeSchluesselId };
    expect(codePasst(nurA, 'freigabe-a', '123456', z)).toBe(true);
    expect(codePasst(nurA, 'freigabe-b', '123456', z)).toBe(false);
    expect(codePasst(nurA, 'freigabe-a', '123457', z)).toBe(false);
  });

  it('Rotation: der erste Schlüssel signiert, alle prüfen; ein entfernter Schlüssel prüft nicht mehr', () => {
    const alt = codeHash(nurA, 'f', '111111');
    const rotiert = erzeugeCodeSchluessel([B, A]);
    const neu = codeHash(rotiert, 'f', '222222');
    expect(neu.codeSchluesselId).not.toBe(alt.codeSchluesselId);
    const zAlt = { hash: alt.codeHash, schluesselId: alt.codeSchluesselId };
    const zNeu = { hash: neu.codeHash, schluesselId: neu.codeSchluesselId };
    expect(codePasst(rotiert, 'f', '111111', zAlt)).toBe(true);
    expect(codePasst(rotiert, 'f', '222222', zNeu)).toBe(true);
    const nurB = erzeugeCodeSchluessel([B]);
    expect(codePasst(nurB, 'f', '111111', zAlt)).toBe(false);
    const zustand = (h: { codeHash: string; codeSchluesselId: string }) =>
      leseCodeZustand({ ...h, codeFehlversuche: 0 });
    expect(codeVerfahrenGueltig(nurB, zustand(alt))).toBe(false);
    expect(codeVerfahrenGueltig(rotiert, zustand(alt))).toBe(true);
    // Früheres Verfahren (Hash ohne Kennung): nie gültig.
    expect(
      codeVerfahrenGueltig(
        rotiert,
        leseCodeZustand({ codeHash: HEX, codeSchluesselId: null, codeFehlversuche: 0 }),
      ),
    ).toBe(false);
  });

  it('Schlüsselliste fail closed: leer, zu kurz, doppelt; ohne Schlüsselbund kein Code', () => {
    expect(() => erzeugeCodeSchluessel([])).toThrow(/leer/);
    expect(() => erzeugeCodeSchluessel(['x'.repeat(31)])).toThrow(/kürzer/);
    expect(() => erzeugeCodeSchluessel([A, A])).toThrow(/doppelt/);
    const meldungen: string[] = [];
    for (const liste of [[], ['kurz'], [A, A]]) {
      try {
        erzeugeCodeSchluessel(liste);
      } catch (e) {
        meldungen.push((e as Error).message);
      }
    }
    expect(meldungen.join('|')).not.toContain(A);
    expect(() => brauchtCodeSchluessel(undefined)).toThrow(/Kein Code-Schlüssel/);
    expect(brauchtCodeSchluessel(nurA)).toBe(nurA);
  });

  it('vergleicht in konstanter Zeit (timingSafeEqual über gleich lange Werte)', () => {
    vi.mocked(timingSafeEqual).mockClear();
    const h = codeHash(nurA, 'f', '000001');
    const z = { hash: h.codeHash, schluesselId: h.codeSchluesselId };
    codePasst(nurA, 'f', '000002', z);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = vi.mocked(timingSafeEqual).mock.calls[0]!;
    expect((a as Buffer).length).toBe(32);
    expect((b as Buffer).length).toBe(32);
    vi.mocked(timingSafeEqual).mockClear();
    expect(codePasst(nurA, 'f', '000001', { hash: null, schluesselId: null })).toBe(false);
    expect(codePasst(nurA, 'f', '000001', { hash: 'abc', schluesselId: ID })).toBe(false);
    expect(codePasst(nurA, 'f', '000001', { hash: h.codeHash, schluesselId: ID })).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  });

  it('liest den gespeicherten Zustand streng (Hash, Kennung, Zähler); Unbekanntes gilt als gesperrt', () => {
    const z = (
      codeHash: string | null,
      codeFehlversuche: number,
      codeSchluesselId: string | null = ID,
    ) => leseCodeZustand({ codeHash, codeSchluesselId, codeFehlversuche });
    expect(z(null, 0)).toEqual({ fehlversuche: 0, hash: null, schluesselId: null });
    expect(z(HEX, 3)).toEqual({ fehlversuche: 3, hash: HEX, schluesselId: ID });
    expect(z(HEX, 3, null)).toEqual({ fehlversuche: 3, hash: HEX, schluesselId: null });
    expect(z(null, 2)).toEqual({ fehlversuche: 2, hash: null, schluesselId: null });
    const gesperrt = { fehlversuche: MAX_FEHLVERSUCHE, hash: null, schluesselId: null };
    for (const [hash, n, id] of [
      [HEX, MAX_FEHLVERSUCHE, ID],
      [null, MAX_FEHLVERSUCHE, ID],
      [HEX, 6, ID],
      [HEX, -1, ID],
      [HEX, 1.5, ID],
      [HEX, Number.NaN, ID],
      [`v1:0:${HEX}`, 0, ID],
      [HEX.toUpperCase(), 0, ID],
      ['', 0, ID],
      [`${HEX}0`, 0, ID],
      [HEX, 0, 'ABCDEF0123456789'],
      [HEX, 0, '0123'],
    ] as const) {
      expect(z(hash, n, id), `${hash}/${n}/${id}`).toEqual(gesperrt);
    }
  });

  it('Frist und Status auf übergebener (echter) Zeit; früheres Verfahren und unbekannter Schlüssel: abgelaufen', () => {
    const jetzt = new Date('2030-01-01T00:00:00Z');
    expect(codeAblaufAb(jetzt).getTime() - jetzt.getTime()).toBe(CODE_GUELTIG_TAGE * 86_400_000);
    const ablauf = codeAblaufAb(jetzt);
    const f = (
      codeHash: string | null,
      codeFehlversuche: number,
      codeAblauf: Date | null,
      codeSchluesselId: string | null = nurA.aktuelleId,
    ) => ({ codeHash, codeSchluesselId, codeFehlversuche, codeAblauf });
    expect(codeStatus(f(HEX, 0, ablauf), jetzt, nurA)).toBe('AKTIV');
    expect(codeStatus(f(HEX, 0, ablauf), new Date(ablauf.getTime() + 1), nurA)).toBe('ABGELAUFEN');
    expect(codeStatus(f(HEX, 0, ablauf, null), jetzt, nurA)).toBe('ABGELAUFEN');
    expect(codeStatus(f(HEX, 0, ablauf, ID), jetzt, nurA)).toBe('ABGELAUFEN');
    // Ohne Schlüsselbund (nur Anzeige): allein die gespeicherte Kennung zählt.
    expect(codeStatus(f(HEX, 0, ablauf, ID), jetzt)).toBe('AKTIV');
    expect(codeStatus(f(HEX, 0, ablauf, null), jetzt)).toBe('ABGELAUFEN');
    expect(codeStatus(f(null, MAX_FEHLVERSUCHE, null), jetzt, nurA)).toBe('GESPERRT');
    expect(codeStatus(f(HEX, MAX_FEHLVERSUCHE, ablauf), jetzt, nurA)).toBe('GESPERRT');
    expect(codeStatus(f(null, 0, null, null), jetzt, nurA)).toBe('KEIN');
  });
});
