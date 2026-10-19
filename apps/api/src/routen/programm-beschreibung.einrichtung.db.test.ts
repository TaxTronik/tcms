// Einrichtungsassistent über die App (DB_TESTS=1): Erfolg je Endpunkt und
// Negativfälle (falscher Mandant, Mandantenperson, ungültige Eingabe).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  akteure,
  legeMandantenAn,
  mandantPfad,
  neueApiWelt,
  ok,
  personen,
  pruefeEndpunkte,
  richteEinUeberHttp,
  SCHRITT1,
  senden,
} from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);
const m = mandantPfad;

describe.skipIf(!AKTIV)('Endpunkte Einrichtungsassistent (App + PostgreSQL)', () => {
  beforeAll(async () => {
    await legeMandantenAn(w);
  });

  it('lesen, Schritte speichern, Version 1 anlegen (Erfolg)', async () => {
    const lesen = await ok(
      await senden(
        w,
        'GET',
        `${m(w.A)}/einrichtung?berufstraegerId=${w.BT}&bearbeitungId=${w.HB}&vertretungId=${w.DRITTE}`,
        a.bt(),
      ),
    );
    expect(lesen).toMatchObject({ eingerichtet: false, programm: null, darfBearbeiten: true });
    await richteEinUeberHttp(w);
    const danach = await ok(await senden(w, 'GET', `${m(w.A)}/einrichtung`, a.bt()));
    expect(danach).toMatchObject({ eingerichtet: true, entwurf: null });
    const nochmal = await senden(w, 'POST', `${m(w.A)}/einrichtung/anlegen`, a.bt(), {
      daten: { kontrollen: {} },
      personen: personen(w),
    });
    expect(nochmal.status).toBe(409);
  });

  pruefeEndpunkte(w, [
    {
      name: 'Einrichtung lesen',
      methode: 'GET',
      pfad: (x) => `${m(x)}/einrichtung`,
      ungueltig: { query: '?berufstraegerId=Anna' },
    },
    {
      name: 'Entwurf speichern',
      methode: 'POST',
      pfad: (x) => `${m(x)}/einrichtung/entwurf`,
      body: { schritt: 1, ziel: 'speichern', daten: SCHRITT1, personen: personen(w) },
      ungueltig: {
        body: {
          schritt: 1,
          ziel: 'speichern',
          daten: SCHRITT1,
          personen: personen(w),
          stand: '2026-01-01',
        },
      },
    },
    {
      name: 'Programm anlegen',
      methode: 'POST',
      pfad: (x) => `${m(x)}/einrichtung/anlegen`,
      body: { daten: { kontrollen: {} }, personen: personen(w) },
      ungueltig: { body: { daten: { kontrollen: {} } } },
    },
  ]);
});
