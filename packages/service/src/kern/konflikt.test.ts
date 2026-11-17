// =============================================================================
// Datenbankkonflikt → KONFLIKT (Befund 92) ohne Datenbank: die Fehlerformen von
// Prisma 7 mit adapter-pg (wie in packages/db/src/__tests__/fehler.test.ts) und
// die statische Regel „genau eine Abbildung“.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DienstFehler } from '@tcms/contract';
import { alsKonflikt, istDbKonflikt, konfliktSicher, STAND_GEAENDERT } from './konflikt';

const prisma = (code: string, originalCode: string) => ({
  name: 'PrismaClientKnownRequestError',
  clientVersion: '7.9.1',
  code,
  message: 'Database error. Code: …',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: { originalCode, kind: 'postgres', code: originalCode, message: '…' },
    },
  },
});

describe('Datenbankkonflikt → KONFLIKT', () => {
  it('Verklemmung (P2039/P2010 mit 40P01), Eindeutigkeit und Serialisierung werden KONFLIKT', async () => {
    for (const e of [
      prisma('P2039', '40P01'),
      prisma('P2010', '40P01'),
      prisma('P2010', '23505'),
      prisma('P2002', '23505'),
      prisma('P2034', '40001'),
    ]) {
      expect(istDbKonflikt(e)).toBe(true);
      const k = alsKonflikt(e);
      expect(k).toBeInstanceOf(DienstFehler);
      expect([(k as DienstFehler).code, (k as DienstFehler).message]).toEqual([
        'KONFLIKT',
        STAND_GEAENDERT,
      ]);
      const f = await konfliktSicher(() => Promise.reject(e), 'Eigene Meldung.').catch(
        (x: unknown) => x,
      );
      expect([(f as DienstFehler).code, (f as DienstFehler).message]).toEqual([
        'KONFLIKT',
        'Eigene Meldung.',
      ]);
    }
  });

  it('andere Fehler und eigene Fehler bleiben unverändert', async () => {
    const fk = prisma('P2003', '23503');
    expect(alsKonflikt(fk)).toBe(fk);
    const text = prisma('P2039', '22021');
    expect(alsKonflikt(text)).toBe(text);
    const d = new DienstFehler('NICHT_GEFUNDEN');
    expect(alsKonflikt(d)).toBe(d);
    // Ein eigener Fehler mit Datenbankursache bleibt der eigene Fehler.
    const mitUrsache = Object.assign(new DienstFehler('UNGUELTIG'), {
      cause: prisma('P2002', '23505'),
    });
    expect(alsKonflikt(mitUrsache)).toBe(mitUrsache);
    expect(alsKonflikt(null)).toBe(null);
    expect(await konfliktSicher(() => Promise.resolve(7))).toBe(7);
  });

  it('genau eine Abbildung: kein Bereich prüft Prisma-Konfliktcodes selbst', () => {
    const wurzel = fileURLToPath(new URL('../', import.meta.url));
    const dateien = (ordner: string): string[] =>
      readdirSync(ordner, { withFileTypes: true }).flatMap((e) => {
        const pfad = join(ordner, e.name);
        if (e.isDirectory()) return dateien(pfad);
        return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [pfad] : [];
      });
    const treffer = dateien(wurzel).flatMap((d) =>
      /['"](P2002|P2034|40P01|40001|23505)['"]/.test(readFileSync(d, 'utf8'))
        ? [relative(wurzel, d).replaceAll('\\', '/')]
        : [],
    );
    expect(treffer).toEqual([]);
  });
});
