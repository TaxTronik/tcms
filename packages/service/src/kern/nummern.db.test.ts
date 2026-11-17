// =============================================================================
// Nummernkreise gegen PostgreSQL (DB_TESTS=1, eigener Tenant): max + 1 rechnet
// die Datenbank, je Jahr, Tenant und – bei Feststellungen – Programm; auch
// jenseits von vier Stellen numerisch (nicht nach Text sortiert).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mitTenant, type Tx } from '@tcms/db';
import { naechsteEreignisnummern, naechsteFeststellungsnummer } from './nummern';

const AKTIV = process.env['DB_TESTS'] === '1';

async function programmIn(tx: Tx): Promise<string> {
  const m = randomUUID();
  await tx.mandant.create({ data: { id: m, name: 'Nummern GmbH', rechtsform: 'KapG' } });
  return (
    await tx.tcmsProgramm.create({
      data: { mandantId: m, paketId: 'ecommerce', paketVersion: '1.0' },
    })
  ).id;
}

describe.skipIf(!AKTIV)('Nummernkreise gegen PostgreSQL', () => {
  it('Ereignisnummern: max + 1 je Jahr und Tenant, numerisch', async () => {
    const t = randomUUID();
    await mitTenant(t, async (tx) => {
      const programmId = await programmIn(tx);
      for (const nummer of ['2026-T-0009', '2026-T-10000', '2026-T-x7', '2025-T-0042']) {
        await tx.ereignis.create({
          data: {
            programmId,
            nummer,
            typ: 'Sonstiges',
            titel: 'Ereignis',
            beschreibung: 'Beschreibung',
            quelle: 'MANUELL',
            ereignisDatum: new Date('2026-10-01T00:00:00Z'),
          },
        });
      }
      expect(await naechsteEreignisnummern(tx, 2026, 2)).toEqual(['2026-T-10001', '2026-T-10002']);
      expect(await naechsteEreignisnummern(tx, 2025, 1)).toEqual(['2025-T-0043']);
      expect(await naechsteEreignisnummern(tx, 2027, 1)).toEqual(['2027-T-0001']);
    });
    // Ein anderer Tenant beginnt bei 1 (RLS).
    await mitTenant(randomUUID(), async (tx) => {
      expect(await naechsteEreignisnummern(tx, 2026, 1)).toEqual(['2026-T-0001']);
    });
  });

  it('Feststellungsnummern: max + 1 je Programm und Jahr', async () => {
    await mitTenant(randomUUID(), async (tx) => {
      const a = await programmIn(tx);
      const b = await programmIn(tx);
      for (const nummer of ['F-2026-002', 'F-2026-011', 'F-2025-090']) {
        await tx.feststellung.create({
          data: {
            programmId: a,
            nummer,
            titel: 'Feststellung',
            sachverhalt: 'Sachverhalt',
            quelle: 'HINWEIS',
            quelleText: 'Test',
            klasse: 'HINWEIS',
            schwere: 'GERING',
            auswirkung: 'NEIN',
            erfasstVon: randomUUID(),
          },
        });
      }
      expect(await naechsteFeststellungsnummer(tx, a, 2026)).toBe('F-2026-012');
      expect(await naechsteFeststellungsnummer(tx, a, 2027)).toBe('F-2027-001');
      expect(await naechsteFeststellungsnummer(tx, b, 2026)).toBe('F-2026-001');
    });
  });
});
