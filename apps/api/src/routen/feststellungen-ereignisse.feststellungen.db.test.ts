// =============================================================================
// API-Tests Feststellungen und Maßnahmen (S10) über `erzeugeApp` mit echter
// Datenbank und signierten Akteursbestätigungen (Hilfen: *.testhilfe.ts).
// =============================================================================

import { FeststellungDetailSchema, FeststellungListeSchema } from '@tcms/contract';
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
    name: 'Feststellungen lesen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({ pfad: `${B}/feststellungen` }),
  },
  {
    name: 'Feststellung lesen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({ pfad: `${B}/feststellungen/${(await feststellung()).id}` }),
  },
  {
    name: 'Feststellung erfassen',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen`,
      body: {
        titel: 'Rundung OSS',
        sachverhalt: 'Rundungsdifferenz in der OSS-Meldung, Betrag unter Toleranz.',
        quelle: 'STICHPROBE',
        quelleText: 'Stichprobe Oktober',
        klasse: 'HINWEIS',
        schwere: 'GERING',
        auswirkung: 'NEIN',
        risikoIds: [w.risiko],
      },
    }),
  },
  {
    name: 'weiter',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/weiter`,
      body: { von: 'ERFASST' },
    }),
  },
  {
    name: '§ 153',
    methode: 'POST',
    erfolg: 200,
    akteur: () => ZBT,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/p153`,
      body: {
        entscheidung: 'BERICHTIGUNG',
        begruendung: 'Berichtigung der USt-Voranmeldung August ist veranlasst.',
        frist: FRIST,
        bisher: null,
      },
    }),
  },
  {
    name: 'Würdigung',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/wuerdigung`,
      body: { schwere: 'HOCH', auswirkung: 'UNKLAR', ursache: 'Schnittstelle' },
    }),
  },
  {
    name: 'Erklärung',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/erklaerungen`,
      body: { steuerart: 'USt', land: 'DE', zeitraum: 'Q3 2026', auswirkungEur: 120.5 },
    }),
  },
  {
    name: 'Maßnahme',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/massnahmen`,
      body: {
        beschreibung: 'Konto abstimmen',
        verantwortlich: { id: P.hb, art: 'KANZLEI' },
        frist: FRIST,
      },
    }),
  },
  {
    name: 'Nachkontrolle',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung({ status: 'MASSNAHMEN_OFFEN' })).id}/nachkontrolle`,
      body: { kontrolleId: w.kontrolle, faelligAm: FRIST },
    }),
  },
  {
    name: 'Verwerfen beantragen',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/verwerfen/beantragen`,
      body: { begruendung: BEGRUENDUNG },
    }),
  },
  {
    name: 'Verwerfen bestätigen',
    methode: 'POST',
    erfolg: 200,
    akteur: () => ZBT,
    ungueltig: {},
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung({ verwerfenBeantragtVon: P.hb, verwerfenBegruendung: BEGRUENDUNG })).id}/verwerfen/bestaetigen`,
    }),
  },
  {
    name: 'Verwerfen ablehnen',
    methode: 'POST',
    erfolg: 200,
    ungueltig: { grund: 'x' },
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung({ verwerfenBeantragtVon: P.zbt, verwerfenBegruendung: BEGRUENDUNG })).id}/verwerfen/ablehnen`,
    }),
  },
  {
    name: 'vertraulich',
    methode: 'POST',
    erfolg: 200,
    akteur: () => ZBT,
    vorbereiten: async () => ({
      pfad: `${B}/feststellungen/${(await feststellung()).id}/vertraulich`,
      body: { vertraulich: true },
    }),
  },
  {
    name: 'Maßnahme erledigen',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => {
      const f = await feststellung({ status: 'MASSNAHMEN_OFFEN' });
      const m = await db((tx) =>
        tx.massnahme.create({
          data: {
            feststellungId: f.id,
            wiedervorlageNr: 700_000 + naechsteNr(),
            beschreibung: 'abstimmen',
            verantwortlich: P.hb,
            frist: new Date(`${FRIST}T00:00:00Z`),
          },
        }),
      );
      return {
        pfad: `${B}/massnahmen/${m.id}/erledigen`,
        body: { nachweis: 'Abstimmung im DMS abgelegt.' },
      };
    },
  },
];

describe.skipIf(!AKTIV)('API Feststellungen gegen PostgreSQL', () => {
  beforeAll(baueApiWelt);

  for (const f of faelle) {
    it(`${f.methode} ${f.name}: 400 ungültig, 404 falscher Mandant, 404 Mandantenperson, dann Erfolg ${f.erfolg}`, () =>
      pruefeFall(f));
  }

  it('Objekt-ID eines anderen Mandanten unter dem eigenen Mandanten → 404 ohne Detail', async () => {
    const fremd = await feststellung({}, w.programmF);
    for (const [methode, ziel, body] of [
      ['GET', `${B}/feststellungen/${fremd.id}`, undefined],
      ['POST', `${B}/feststellungen/${fremd.id}/weiter`, { von: 'ERFASST' }],
    ] as const) {
      const r = await rufe(ZBT, methode, ziel, body);
      expect(r.status, ziel).toBe(404);
      expect(r.json).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }
  });

  it('Pfad schlägt Body: mandantId oder Objekt-IDs im Body → 400', async () => {
    const f = await feststellung();
    for (const body of [
      { von: 'ERFASST', mandantId: F },
      { von: 'ERFASST', feststellungId: f.id },
    ]) {
      const r = await rufe(HB, 'POST', `${B}/feststellungen/${f.id}/weiter`, body);
      expect(r.status).toBe(400);
    }
    const r = await rufe(HB, 'POST', `${B}/feststellungen`, { mandantId: F });
    expect(r.status).toBe(400);
  });

  it('Antworten sind vertragskonform (Liste, Detail) und ohne Namen im Dienst', async () => {
    const f = await feststellung();
    const liste = await rufe(HB, 'GET', `${B}/feststellungen`);
    expect(FeststellungListeSchema.parse(liste.json['daten'])).toBeTruthy();
    const d = await rufe(HB, 'GET', `${B}/feststellungen/${f.id}`);
    const detail = FeststellungDetailSchema.parse(d.json['daten']);
    if (detail.maskiert) throw new Error('unerwartet maskiert');
    expect(detail.namen).toEqual([]);
  });

  it('§ 153 über die API: Bearbeitung → 403 mit Grund; Doppelentscheidung → 409', async () => {
    const f = await feststellung();
    const body = {
      entscheidung: 'KEINE_PFLICHT',
      begruendung: 'Keine Berichtigungspflicht, Betrag unter der Toleranz.',
      bisher: null,
    };
    const hb = await rufe(HB, 'POST', `${B}/feststellungen/${f.id}/p153`, body);
    expect(hb.status).toBe(403);
    expect(hb.json).toEqual({
      ok: false,
      fehler: {
        code: 'NICHT_BERECHTIGT',
        meldung: 'Dieser Schritt ist Berufsträger:innen vorbehalten.',
      },
    });
    expect((await rufe(ZBT, 'POST', `${B}/feststellungen/${f.id}/p153`, body)).status).toBe(200);
    expect((await rufe(ZBT, 'POST', `${B}/feststellungen/${f.id}/p153`, body)).status).toBe(409);
    const ohne = await rufe(ZBT, 'POST', `${B}/feststellungen/${f.id}/p153`, {
      begruendung: body.begruendung,
      bisher: null,
    });
    expect(ohne.status).toBe(400);
  });
});
