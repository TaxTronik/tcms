// Vertrag des Audits mit vertraulichen Feststellungen (tcms-s11, ADR 0001
// §5.1): Jeder Eintrag ist eine von zwei strikten Varianten. Die maskierte
// trägt nur Position, Zeitpunkt, Ereignisart, Objekt, Mandant, Akteursart und
// „vertraulich“ – jedes Inhalts-, Personen- oder Hashfeld wird abgewiesen.
// Hashes sind in lesbaren Einträgen und im Kettenkopf nullbar (ab der ersten
// maskierten Position gibt der Dienst keine aus).
import { describe, expect, it } from 'vitest';
import { AuditListeAntwortSchema } from './lesepfade';

const ok = (v: unknown) => AuditListeAntwortSchema.safeParse(v).success;
const HASH = 'a'.repeat(64);

const rahmen = {
  pos: 3,
  at: '2026-10-16T09:00:00.000Z',
  aktion: 'tcms.feststellung.p153_entschieden',
  objektTyp: 'Feststellung',
  objektId: 'ckz0a1b2c3d4e5f6g7h8i9j0',
  programmId: 'ckz0a1b2c3d4e5f6g7h8i9j1',
  mandantId: '3c3c3c3c-3333-4333-8333-33333333abcd',
};
const maskiert = { maskiert: true, ...rahmen, akteurArt: 'KANZLEI', vertraulich: true };
const offen = {
  maskiert: false,
  ...rahmen,
  actorId: '22222222-2222-4222-8222-222222222222',
  actorName: 'StB Anna Roth',
  detail: { entscheidung: 'BERICHTIGUNG' },
  prevHash: HASH,
  hash: HASH,
};
const seite = (e: unknown, kopfHash: string | null = HASH) => ({
  eintraege: [e],
  weiter: null,
  kopf: { pos: 3, hash: kopfHash, at: rahmen.at },
});

describe('Vertrag: Audit mit vertraulichen Feststellungen', () => {
  it('maskierte Variante: Positivliste, jedes weitere Feld abgewiesen', () => {
    expect(ok(seite(maskiert))).toBe(true);
    for (const akteurArt of ['KANZLEI', 'MANDANT', 'SYSTEM', null]) {
      expect(ok(seite({ ...maskiert, akteurArt })), String(akteurArt)).toBe(true);
    }
    for (const [feld, wert] of Object.entries({
      actorId: offen.actorId,
      actorName: offen.actorName,
      detail: offen.detail,
      prevHash: HASH,
      hash: HASH,
      titel: 'Treuhandkonto',
      nummer: 'F-2026-001',
    })) {
      expect(ok(seite({ ...maskiert, [feld]: wert })), feld).toBe(false);
    }
    // Maskiert heißt immer vertraulich; nur bekannte Akteursarten.
    expect(ok(seite({ ...maskiert, vertraulich: false }))).toBe(false);
    expect(ok(seite({ ...maskiert, akteurArt: 'ADMIN' }))).toBe(false);
  });

  it('lesbare Variante: maskiert false Pflicht (kein Eintrag ohne Diskriminator), Hashes nullbar', () => {
    expect(ok(seite(offen))).toBe(true);
    expect(ok(seite({ ...offen, prevHash: null, hash: null }, null))).toBe(true);
    const { maskiert: _m, ...ohne } = offen;
    expect(ok(seite(ohne))).toBe(false);
    expect(ok(seite({ ...offen, vertraulich: true }))).toBe(false);
    expect(ok(seite({ ...offen, hash: 'kein-hash' }))).toBe(false);
  });
});
