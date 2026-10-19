// Kommunikation (Freigaben-Historie) über die App (DB_TESTS=1): Erfolg,
// Stichtag, Negativfälle je Endpunkt.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  akteure,
  legeMandantenAn,
  mandantPfad,
  neueApiWelt,
  ok,
  pruefeEndpunkte,
  richteEinUeberHttp,
  senden,
} from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);
const m = mandantPfad;

describe.skipIf(!AKTIV)('Endpunkt Freigaben-Historie (App + PostgreSQL)', () => {
  beforeAll(async () => {
    await legeMandantenAn(w);
    await richteEinUeberHttp(w);
  });

  it('liest die Historie (aktuell und zum Stichtag)', async () => {
    const h = await ok(await senden(w, 'GET', `${m(w.A)}/kommunikation/freigaben`, a.bt()));
    expect(h).toMatchObject({ historisch: false });
    expect((h['freigaben'] as { art: string }[]).map((f) => f.art)).toEqual(['ZIELE']);
    const alt = await ok(
      await senden(w, 'GET', `${m(w.A)}/kommunikation/freigaben?stand=2000-01-01`, a.hb()),
    );
    expect(alt).toMatchObject({ stand: '2000-01-01', historisch: true, freigaben: [] });
  });

  pruefeEndpunkte(w, [
    {
      name: 'Historie',
      methode: 'GET',
      pfad: (x) => `${m(x)}/kommunikation/freigaben`,
      ungueltig: { query: '?stand=2026-02-30' },
    },
  ]);
});
