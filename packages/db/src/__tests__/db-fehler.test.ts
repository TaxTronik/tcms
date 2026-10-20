// =============================================================================
// Helfer für Abweisungen der Datenbank (db-fehler.ts), ohne Datenbank: Nur
// strukturierte Felder zählen; die Meldung eines Prisma-Fehlers (mit
// Codeausschnitt) bleibt ungelesen, und kein anderer Fehler besteht.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { abgewiesenOhneDb, dbAbgewiesen, dbFehlerAus, erwarteDbFehler, regel } from './db-fehler';

/** Wie ein PrismaClientKnownRequestError mit adapter-pg (Prisma 7). */
function prismaFehler(code: string, ursache: Record<string, unknown> | undefined, message: string) {
  return Object.assign(new Error(message), {
    name: 'PrismaClientKnownRequestError',
    code,
    clientVersion: '7.9.1',
    meta: ursache ? { modelName: 'X', driverAdapterError: { cause: ursache } } : { modelName: 'X' },
  });
}

/** Wie ein DatabaseError von pg. */
function pgFehler(code: string, message: string) {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

const CHECK = 'new row for relation "Freigabe" violates check constraint "Freigabe_codeHash_check"';
const AUSSCHNITT =
  '\nInvalid `tx.freigabe.update()` invocation in\n/x.ts:3:1\n\n  1 // violates check constraint ' +
  '"Freigabe_codeFehlversuche_check"\n→ 3 tx.freigabe.update(\nDatabase error.';

describe('dbFehlerAus', () => {
  it('liest SQLSTATE und Meldung des Servers aus der Ursache eines Prisma-Fehlers', () => {
    const e = prismaFehler(
      'P2039',
      { originalCode: '23514', originalMessage: CHECK, code: '23514', message: CHECK },
      AUSSCHNITT,
    );
    expect(dbFehlerAus(e)).toEqual({ sqlstate: '23514', meldung: CHECK, prisma: 'P2039' });
  });

  it('nimmt originalCode/originalMessage auch ohne code/message (z. B. P2002)', () => {
    const m = 'duplicate key value violates unique constraint "Mandant_pkey"';
    const e = prismaFehler('P2002', { originalCode: '23505', originalMessage: m }, 'Unique');
    expect(dbFehlerAus(e)).toEqual({ sqlstate: '23505', meldung: m, prisma: 'P2002' });
  });

  it('liest pg-Fehler (Meldung des Servers ohne Ausschnitt)', () => {
    expect(dbFehlerAus(pgFehler('42501', 'permission denied for table akteur_jti'))).toEqual({
      sqlstate: '42501',
      meldung: 'permission denied for table akteur_jti',
      prisma: null,
    });
  });

  it('kein Datenbankfehler: Prisma ohne Ursache, eigene Fehler, DienstFehler, Fremdes', () => {
    for (const e of [
      prismaFehler('P2025', undefined, 'Record not found'),
      prismaFehler('P2039', { originalCode: 'P', originalMessage: 'x' }, 'x'),
      prismaFehler('P2039', { originalCode: '23514' }, CHECK),
      Object.assign(new Error('KONFLIKT'), { name: 'DienstFehler', code: 'KONFLIKT' }),
      Object.assign(new Error('x'), { code: '23514' }), // ohne Schweregrad: nicht pg
      { code: '23514', severity: 'ERROR', message: CHECK }, // kein Error
      new TypeError('x'),
      'violates check constraint',
      null,
      undefined,
    ]) {
      expect(dbFehlerAus(e)).toBeNull();
    }
  });
});

describe('erwarteDbFehler / dbAbgewiesen', () => {
  const e = prismaFehler('P2039', { originalCode: '23514', originalMessage: CHECK }, AUSSCHNITT);

  it('besteht nur mit genau dieser Regel, nie über den Codeausschnitt', () => {
    expect(erwarteDbFehler(e, regel.check('Freigabe', 'Freigabe_codeHash_check'))).toMatchObject({
      sqlstate: '23514',
    });
    // Der Ausschnitt nennt die andere Regel – die Meldung des Prisma-Fehlers enthält
    // sie also, der Helfer liest sie aber nicht.
    expect(e.message.includes('Freigabe_codeFehlversuche_check')).toBe(true);
    expect(() =>
      erwarteDbFehler(e, regel.check('Freigabe', 'Freigabe_codeFehlversuche_check')),
    ).toThrow(Error);
    // Anderer SQLSTATE mit passender Meldung besteht ebenso wenig.
    expect(() => erwarteDbFehler(e, { sqlstate: '23505', meldung: CHECK })).toThrow(Error);
    // Muster nur gegen die Meldung des Servers.
    expect(erwarteDbFehler(e, { sqlstate: '23514', meldung: /codeHash_check"$/ }).meldung).toBe(
      CHECK,
    );
    expect(() => erwarteDbFehler(e, { sqlstate: '23514', meldung: /Invalid/ })).toThrow(Error);
  });

  it('ein angenommener Aufruf oder ein anderer Fehler besteht nicht', async () => {
    const ergebnis = async (p: Promise<unknown>) =>
      dbAbgewiesen(p, regel.check('Freigabe', 'Freigabe_codeHash_check')).then(
        () => 'bestanden',
        () => 'abgewiesen',
      );
    expect(await ergebnis(Promise.resolve(1))).toBe('abgewiesen');
    expect(await ergebnis(Promise.reject(new TypeError('x')))).toBe('abgewiesen');
    expect(await ergebnis(Promise.reject(prismaFehler('P2025', undefined, CHECK)))).toBe(
      'abgewiesen',
    );
    expect(await ergebnis(Promise.reject(e))).toBe('bestanden');
  });
});

describe('abgewiesenOhneDb', () => {
  const ergebnis = async (p: Promise<unknown>, m: string | RegExp) =>
    abgewiesenOhneDb(p, m).then(
      () => 'bestanden',
      () => 'abgewiesen',
    );

  it('besteht nur mit einem eigenen Fehler und genau dieser Meldung', async () => {
    expect(
      await ergebnis(
        Promise.reject(new Error('[service] Kein Schlüssel')),
        '[service] Kein Schlüssel',
      ),
    ).toBe('bestanden');
    expect(
      await ergebnis(
        Promise.reject(new Error('[service] Kein Schlüssel!')),
        '[service] Kein Schlüssel',
      ),
    ).toBe('abgewiesen');
    expect(await ergebnis(Promise.reject(new Error('x Kein y')), /Kein/)).toBe('bestanden');
    expect(await ergebnis(Promise.resolve(1), /x/)).toBe('abgewiesen');
  });

  it('ein Prisma- oder Datenbankfehler besteht nie, auch wenn der Text passt', async () => {
    const prisma = prismaFehler('P2025', undefined, 'Kein Code-Schlüssel');
    expect(await ergebnis(Promise.reject(prisma), /Kein Code-Schlüssel/)).toBe('abgewiesen');
    const pg = pgFehler('P0001', 'Kein Code-Schlüssel');
    expect(await ergebnis(Promise.reject(pg), 'Kein Code-Schlüssel')).toBe('abgewiesen');
    expect(await ergebnis(Promise.reject('Kein Code-Schlüssel'), /Kein/)).toBe('abgewiesen');
  });
});
