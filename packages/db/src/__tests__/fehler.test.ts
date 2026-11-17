// =============================================================================
// `eingabeFehlercode` (RT4-T-08): erkennt die Datenbankfehler ungültiger
// Texteingaben in den Formen von Prisma 7 mit adapter-pg (gemessen gegen
// PostgreSQL) und von `pg`; alles andere ist kein Eingabefehler.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { eingabeFehlercode, konfliktFehlercode } from '../fehler';

/** Form eines Prisma-Fehlers mit Treiberadapter (wie gemessen, Meldungen gekürzt). */
const prisma = (code: string, originalCode: string, kind = 'postgres') => ({
  name: 'PrismaClientKnownRequestError',
  code,
  message: 'Database error. Code: …',
  meta: {
    modelName: 'Nachricht',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: { originalCode, kind, code: originalCode, message: '…' },
    },
  },
});

describe('eingabeFehlercode', () => {
  it('erkennt NUL in TEXT, NUL in JSONB und ungültiges JSON bzw. ungültige Darstellung', () => {
    expect(eingabeFehlercode(prisma('P2039', '22021'))).toBe('22021');
    expect(eingabeFehlercode(prisma('P2039', '22P05'))).toBe('22P05');
    expect(eingabeFehlercode(prisma('P2007', '22P02', 'InvalidInputValue'))).toBe('22P02');
    expect(eingabeFehlercode(prisma('P2010', '22021'))).toBe('22021');
    // pg direkt bzw. als Ursache verpackt.
    expect(eingabeFehlercode({ code: '22P05' })).toBe('22P05');
    expect(eingabeFehlercode(new Error('x', { cause: { code: '22021' } }))).toBe('22021');
  });

  it('andere Fehler sind keine Eingabefehler', () => {
    for (const e of [
      prisma('P2002', '23505'),
      prisma('P2034', '40001'),
      prisma('P2010', '22012'),
      { code: 'P2002' },
      new Error('22021'),
      '22021',
      null,
      undefined,
      42,
    ]) {
      expect(eingabeFehlercode(e), JSON.stringify(e) ?? String(e)).toBeNull();
    }
  });

  it('endet bei Zyklen und tiefer Verschachtelung', () => {
    const a: Record<string, unknown> = {};
    a['cause'] = a;
    expect(eingabeFehlercode(a)).toBeNull();
    let tief: Record<string, unknown> = { code: '22021' };
    for (let i = 0; i < 10; i += 1) tief = { cause: tief };
    expect(eingabeFehlercode(tief)).toBeNull();
  });
});

// =============================================================================
// `konfliktFehlercode` (Befund 92): gleichzeitige Änderungen in den Formen von
// Prisma 7 mit adapter-pg – auch die Verklemmung, die nur als P2039 bzw. P2010
// mit dem SQLSTATE in `meta.driverAdapterError.cause` ankommt.
// =============================================================================

describe('konfliktFehlercode', () => {
  it('erkennt Eindeutigkeit, Serialisierung und Verklemmung in allen Formen', () => {
    expect(konfliktFehlercode(prisma('P2002', '23505', 'UniqueConstraintViolation'))).toBe('23505');
    expect(konfliktFehlercode(prisma('P2034', '40001', 'TransactionWriteConflict'))).toBe('40001');
    // Verklemmung: Modellabfrage (P2039) und Raw-SQL (P2010), Code nur in der Ursache.
    expect(konfliktFehlercode(prisma('P2039', '40P01'))).toBe('40P01');
    expect(konfliktFehlercode(prisma('P2010', '40P01'))).toBe('40P01');
    expect(konfliktFehlercode(prisma('P2010', '23505'))).toBe('23505');
    expect(konfliktFehlercode(prisma('P2010', '40001'))).toBe('40001');
    // Prisma-Code allein (ohne Ursache) und pg direkt bzw. verpackt.
    expect(konfliktFehlercode({ code: 'P2002' })).toBe('23505');
    expect(konfliktFehlercode({ code: 'P2034' })).toBe('40001');
    expect(konfliktFehlercode({ code: '40P01' })).toBe('40P01');
    expect(konfliktFehlercode(new Error('x', { cause: { code: '40001' } }))).toBe('40001');
  });

  it('andere Fehler sind keine Konflikte', () => {
    for (const e of [
      prisma('P2039', '22021'),
      prisma('P2010', '23503'),
      prisma('P2003', '23503', 'ForeignKeyConstraintViolation'),
      prisma('P2010', '55P03'),
      { code: 'KONFLIKT' },
      { code: 'P2025' },
      { code: 'hasOwnProperty' },
      new Error('40P01'),
      '40P01',
      null,
      undefined,
      42,
    ]) {
      expect(konfliktFehlercode(e), JSON.stringify(e) ?? String(e)).toBeNull();
    }
  });

  it('endet bei Zyklen und tiefer Verschachtelung', () => {
    const a: Record<string, unknown> = {};
    a['cause'] = a;
    expect(konfliktFehlercode(a)).toBeNull();
    let tief: Record<string, unknown> = { code: '40P01' };
    for (let i = 0; i < 10; i += 1) tief = { cause: tief };
    expect(konfliktFehlercode(tief)).toBeNull();
  });
});
