// =============================================================================
// Zeitlimits der Datenbank im Dienstkern (Befund 33): `mitTenant` setzt
// `lock_timeout` und `statement_timeout`; bricht die Datenbank deshalb ab
// (55P03 Sperre, 57014 Anweisung), übersetzen `imDienst` und `imSystemdienst`
// das in `ZEITLIMIT` mit fester Meldung – ohne SQL, Werte oder Interna.
// Andere Datenbankfehler bleiben unverändert.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import { mitTenant, sperrSchluessel } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  baueWelt,
  btA,
  im,
  imSystem,
  system,
  type Welt,
} from '../bereiche/programm-beschreibung/testwelt';
import { ZEITLIMIT_MELDUNG, type DienstKontext } from '../kontext';

const AKTIV = process.env['DB_TESTS'] === '1';

async function ausgang(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'angenommen';
  } catch (e) {
    if (e instanceof DienstFehler) {
      expect(e.message).toBe(e.code === 'ZEITLIMIT' ? ZEITLIMIT_MELDUNG : e.message);
      return `DienstFehler ${e.code}`;
    }
    return `roh ${(e as { code?: string }).code ?? (e as Error).name}`;
  }
}

/** Anweisung über dem (für den Test verkürzten) statement_timeout. */
const zuLang = async (tx: DienstKontext['tx']) => {
  await tx.$executeRaw`SET LOCAL statement_timeout = '100ms'`;
  return tx.$queryRaw`SELECT pg_catalog.pg_sleep(3)`;
};

describe.skipIf(!AKTIV)('Dienstkern: Zeitlimits der Datenbank', () => {
  let w: Welt;
  beforeAll(async () => {
    w = await baueWelt();
  });

  it('Person: zu lange Anweisung (57014) → ZEITLIMIT', async () => {
    expect(await ausgang(im(btA(w), (ctx) => zuLang(ctx.tx)))).toBe('DienstFehler ZEITLIMIT');
  });

  it('Systemakteur: zu lange Anweisung (57014) → ZEITLIMIT', async () => {
    expect(await ausgang(imSystem(system(w), (ctx) => zuLang(ctx.tx)))).toBe(
      'DienstFehler ZEITLIMIT',
    );
  });

  it('Person: Warten auf eine Sperre über lock_timeout (55P03) → ZEITLIMIT', async () => {
    const schluessel = sperrSchluessel('zeitlimit-dienst', w.tenantId);
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(w.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
      gehalten();
      await schranke;
    });
    try {
      await haelt;
      const r = await ausgang(
        im(btA(w), async (ctx) => {
          await ctx.tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          return ctx.tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${schluessel}::bigint)`;
        }),
      );
      expect(r).toBe('DienstFehler ZEITLIMIT');
    } finally {
      loslassen();
      await halter;
    }
  });

  it('Gegenprobe: ein anderer Abbruch (Division durch null) bleibt unverändert', async () => {
    const r = await ausgang(im(btA(w), (ctx) => ctx.tx.$queryRaw`SELECT 1 / ${0}::int AS x`));
    expect(r).toMatch(/^roh /);
  });
});
