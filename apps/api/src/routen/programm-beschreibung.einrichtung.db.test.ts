// Einrichtungsassistent über die App (DB_TESTS=1): Erfolg je Endpunkt und
// Negativfälle (falscher Mandant, Mandantenperson, ungültige Eingabe).
import { kalendertag } from '@tcms/service';
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
    const vorher = kalendertag(new Date());
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
    // „Heute" der echten Uhr des Dienstes (Kalendertag Europe/Berlin) in beiden Zuständen;
    // über Mitternacht darf es der folgende Tag sein.
    const nachher = kalendertag(new Date());
    for (const v of [lesen, danach]) expect([vorher, nachher]).toContain(v['heute']);
    const nochmal = await senden(w, 'POST', `${m(w.A)}/einrichtung/anlegen`, a.bt(), {
      daten: { kontrollen: {} },
      personen: personen(w),
    });
    expect(nochmal.status).toBe(409);
  });

  // kanzleikonsole s7nach (Bergkamm der Demo): Ohne Entwurf und ohne Zuständigkeit in der
  // Query belegte der Plan Personen mit '' vor – Antwort verletzte EntwurfKontrolleSchema.
  it('ohne Entwurf und ohne Zuständigkeit: unbekannte Personen sind null, nie leer', async () => {
    for (const query of ['', `?berufstraegerId=${w.BT}`, `?bearbeitungId=${w.HB}`]) {
      // Vertragsprüfung der Test-App (antwortSchema) läuft bei jeder Antwort mit.
      const lesen = await ok(await senden(w, 'GET', `${m(w.B)}/einrichtung${query}`, a.bt(w.B)));
      expect(lesen, query).toMatchObject({ eingerichtet: false, programm: null });
      const plan = lesen['plan'] as {
        kontrollen: { code: string; zust: { partei: string } & Record<string, unknown> }[];
      };
      expect(plan.kontrollen.length, query).toBeGreaterThan(0);
      const ids = plan.kontrollen.flatMap((k) =>
        Object.entries(k.zust)
          .filter(([f]) => f.endsWith('Id'))
          .map(([f, id]) => [k.code, f, id] as const),
      );
      for (const [code, feld, id] of ids) {
        expect(id === null || /^[0-9a-f-]{36}$/.test(String(id)), `${query} ${code} ${feld}`).toBe(
          true,
        );
      }
      // Kanzleikontrollen (außer K-EC-20/24, die die Berufsträger:in durchführt):
      // Durchführung = Hauptbearbeitung, ohne Angabe offen (null).
      const kanzlei = plan.kontrollen.find(
        (k) => k.zust.partei === 'KANZLEI' && !['K-EC-20', 'K-EC-24'].includes(k.code),
      );
      expect(kanzlei, query).toBeDefined();
      expect(kanzlei!.zust['durchfuehrendId'], query).toBe(
        query.includes('bearbeitungId') ? w.HB : null,
      );
    }
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
