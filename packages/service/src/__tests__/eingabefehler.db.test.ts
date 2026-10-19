// =============================================================================
// Datenbankfehler ungültiger Texteingaben im Dienstkern (RT4-T-08): `imDienst`
// und `imSystemdienst` übersetzen 22021 (NUL in TEXT), 22P05 (NUL in JSONB)
// und 22P02 (ungültige Darstellung) in `UNGUELTIG` ohne Werte in der Meldung;
// andere Datenbankfehler bleiben unverändert (fail closed, kein Verschleiern).
// Die Eingaben selbst weist schon der Vertrag ab; dies ist die zweite Linie.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  baueWelt,
  btA,
  im,
  imSystem,
  system,
  type Welt,
} from '../bereiche/programm-beschreibung/testwelt';
import type { DienstKontext, SystemKontext } from '../kontext';

const AKTIV = process.env['DB_TESTS'] === '1';
const WERT = 'Geheimer Wert \u0000';

async function ausgang(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'angenommen';
  } catch (e) {
    if (e instanceof DienstFehler) {
      expect(e.message).not.toContain('Geheimer');
      return `DienstFehler ${e.code}`;
    }
    return `roh ${(e as { code?: string }).code ?? (e as Error).name}`;
  }
}

describe.skipIf(!AKTIV)('Dienstkern: Datenbankfehler ungültiger Texteingaben', () => {
  let w: Welt;
  beforeAll(async () => {
    w = await baueWelt();
  });

  const laeufe: [string, (tx: DienstKontext['tx']) => Promise<unknown>][] = [
    ['22021 NUL in TEXT', (tx) => tx.$queryRaw`SELECT ${WERT}::text AS x`],
    ['22P05 NUL in JSONB', (tx) => tx.$queryRaw`SELECT ${JSON.stringify({ a: WERT })}::jsonb AS x`],
    ['22P02 ungültige Darstellung', (tx) => tx.$queryRaw`SELECT ${'Geheimer Wert'}::uuid AS x`],
  ];

  it.each(laeufe)('Person: %s → UNGUELTIG', async (_n, lauf) => {
    expect(await ausgang(im(btA(w), (ctx) => lauf(ctx.tx)))).toBe('DienstFehler UNGUELTIG');
  });

  it.each(laeufe)('Systemakteur: %s → UNGUELTIG', async (_n, lauf) => {
    expect(await ausgang(imSystem(system(w), (ctx: SystemKontext) => lauf(ctx.tx)))).toBe(
      'DienstFehler UNGUELTIG',
    );
  });

  it('andere Datenbankfehler bleiben unverändert (Division durch null)', async () => {
    const r = await ausgang(im(btA(w), (ctx) => ctx.tx.$queryRaw`SELECT 1 / ${0}::int AS x`));
    expect(r).toMatch(/^roh /);
  });
});
