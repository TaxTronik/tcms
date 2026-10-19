// Kommunikation (Freigaben-Historie) über die App (DB_TESTS=1): Erfolg,
// Stichtag, Zustellstatus der Anforderung (offen → unzustellbar über den
// Systemakteur), Negativfälle je Endpunkt.
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

  it('zeigt den Zustellstatus der Anforderung (offen, nach Meldung unzustellbar mit Grund)', async () => {
    const pfad = `${m(w.A)}/kommunikation/freigaben`;
    const zustellung = async () =>
      (
        (await ok(await senden(w, 'GET', pfad, a.bt())))['freigaben'] as {
          zustellung: Record<string, unknown> | null;
        }[]
      )[0]!.zustellung;
    expect(await zustellung()).toEqual({
      status: 'OFFEN',
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: expect.any(String),
    });
    const offen = await ok(await senden(w, 'GET', '/v1/nachrichten/offen', a.system()));
    const [n] = offen['nachrichten'] as { id: string; empfaengerId: string }[];
    expect(n!.empfaengerId).toBe(w.GV);
    await ok(
      await senden(w, 'POST', `/v1/nachrichten/${n!.id}/unzustellbar`, a.system(), {
        grund: 'EMPFAENGER_UNGUELTIG',
      }),
    );
    expect(await zustellung()).toEqual({
      status: 'UNZUSTELLBAR',
      grund: 'EMPFAENGER_UNGUELTIG',
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: expect.any(String),
      am: expect.any(String),
    });
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
