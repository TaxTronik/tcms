// =============================================================================
// API-Tests Länder-Monitor (S12) über `erzeugeApp` mit echter Datenbank und
// signierten Akteursbestätigungen.
// =============================================================================

import { LaenderSchema } from '@tcms/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AKTIV,
  B,
  BEGRUENDUNG,
  baueApiWelt,
  db,
  ereignis,
  F,
  feststellung,
  FRIST,
  GV,
  HB,
  landEingabe,
  naechsteNr,
  naechstesLand,
  P,
  portalMeldung,
  pruefeFall,
  rufe,
  w,
  ZBT,
  type Fall,
} from './feststellungen-ereignisse.testhilfe';

const faelle: Fall[] = [
  {
    name: 'Länder lesen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({ pfad: `${B}/laender` }),
  },
  {
    name: 'Land hinzufügen',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/laender`,
      body: { datenstand: '2026-10-01', land: landEingabe(naechstesLand()) },
    }),
  },
  {
    name: 'Länderstände',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => {
      const code = naechstesLand();
      const r = await rufe(HB, 'POST', `${B}/laender`, {
        datenstand: '2026-10-01',
        land: landEingabe(code),
      });
      expect(r.status).toBe(201);
      return {
        pfad: `${B}/laender/staende`,
        body: { datenstand: '2026-10-05', laender: [landEingabe(code)] },
      };
    },
  },
];

describe.skipIf(!AKTIV)('API Länder-Monitor gegen PostgreSQL', () => {
  beforeAll(baueApiWelt);

  for (const f of faelle) {
    it(`${f.methode} ${f.name}: 400 ungültig, 404 falscher Mandant, 404 Mandantenperson, dann Erfolg ${f.erfolg}`, () =>
      pruefeFall(f));
  }

  it('Antwort ist vertragskonform; Stichtag in der Query', async () => {
    const l = await rufe(HB, 'GET', `${B}/laender?stand=2026-10-01`);
    expect(LaenderSchema.parse(l.json['daten']).historisch).toBe(true);
  });

  it('Länderbezüge je Land: Ereignisse, die das Land nennen; vertrauliche Feststellungen nie', async () => {
    const neu = await rufe(HB, 'POST', `${B}/laender`, {
      datenstand: '2026-10-01',
      land: landEingabe('LV'),
    });
    expect(neu.status).toBe(201);
    const e = await ereignis(w.programm, [{ art: 'HINWEIS' }], {
      titel: 'Neue Meldepflicht in Lettland',
    });
    const geheim = await feststellung({ titel: 'LV Selbstanzeige vorbereiten', vertraulich: true });
    const l = LaenderSchema.parse((await rufe(HB, 'GET', `${B}/laender`)).json['daten']);
    const lv = l.bezuege.find((b) => b.land === 'LV')!;
    expect(lv.ereignisse).toContain(e.id);
    expect(lv.risiken.every((r) => r.grund.length > 0)).toBe(true);
    expect(l.bezuege.map((b) => b.land).sort()).toEqual(l.historie.map((h) => h.land).sort());
    expect(JSON.stringify(l)).not.toContain(geheim.id);
    expect(JSON.stringify(l)).not.toContain('Selbstanzeige');
  });
});
