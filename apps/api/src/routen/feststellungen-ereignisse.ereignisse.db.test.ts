// =============================================================================
// API-Tests Ereigniseingang (S11), Portal-Meldung (P3) und Anlagen (TS-09)
// über `erzeugeApp` mit echter Datenbank und signierten Akteursbestätigungen.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { EreignisDetailSchema, PortalMeldungenSchema } from '@tcms/contract';
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
  kontaktClaims,
  landEingabe,
  M,
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
    name: 'Ereignisse lesen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({ pfad: `${B}/ereignisse` }),
  },
  {
    name: 'Ereignis lesen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/ereignisse/${(await ereignis()).id}`,
      query: 'stand=2026-10-10',
    }),
  },
  {
    name: 'Anlage auflösen',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => {
      const sha = randomBytes(32).toString('hex');
      const r = await rufe(
        GV(),
        'POST',
        `${B}/portal/ereignisse`,
        portalMeldung([
          {
            dokumentId: `kk:${sha.slice(0, 12)}`,
            dateiname: 'Vertrag.pdf',
            mime: 'application/pdf',
            groesse: 10,
            sha256: sha,
          },
        ]),
      );
      expect(r.status).toBe(201);
      return { pfad: `${B}/ereignisse/${(r.json.daten as { id: string }).id}/anlagen/${sha}` };
    },
  },
  {
    name: 'Ereignis erfassen',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/ereignisse`,
      body: {
        typ: 'T-05',
        quelle: 'MANUELL',
        titel: 'Sonderprüfung angekündigt',
        beschreibung: 'Prüfungsanordnung liegt vor.',
        datum: '2026-10-10',
      },
    }),
  },
  {
    name: 'in Prüfung',
    methode: 'POST',
    erfolg: 200,
    ungueltig: [],
    vorbereiten: async () => ({ pfad: `${B}/ereignisse/${(await ereignis()).id}/in-pruefung` }),
  },
  {
    name: 'Folge hinzufügen',
    methode: 'POST',
    erfolg: 201,
    vorbereiten: async () => ({
      pfad: `${B}/ereignisse/${(await ereignis()).id}/folgen`,
      body: { art: 'HINWEIS', text: 'Länder-Monitor ergänzen' },
    }),
  },
  {
    name: 'Folgen anlegen',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => {
      const e = await ereignis(w.programm, [{ art: 'FESTSTELLUNG_ANLEGEN' }]);
      return {
        pfad: `${B}/ereignisse/${e.id}/folgen/anlegen`,
        body: {
          folgen: [
            {
              folgeId: e.folgen[0]!.id,
              feststellung: {
                titel: 'Feststellung aus Ereignis',
                klasse: 'HINWEIS',
                schwere: 'GERING',
                auswirkung: 'NEIN',
              },
            },
          ],
        },
      };
    },
  },
  {
    name: 'Folge erledigen',
    methode: 'POST',
    erfolg: 200,
    ungueltig: { x: 1 },
    vorbereiten: async () => {
      const e = await ereignis(w.programm, [{ art: 'HINWEIS', status: 'ANGELEGT' }], {
        status: 'IN_TRIAGE',
      });
      return { pfad: `${B}/ereignisse/${e.id}/folgen/${e.folgen[0]!.id}/erledigen` };
    },
  },
  {
    name: 'Folge verwerfen',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => {
      const e = await ereignis();
      return {
        pfad: `${B}/ereignisse/${e.id}/folgen/${e.folgen[0]!.id}/verwerfen`,
        body: { begruendung: BEGRUENDUNG },
      };
    },
  },
  {
    name: 'abschließen',
    methode: 'POST',
    erfolg: 200,
    ungueltig: { jetzt: true },
    vorbereiten: async () => {
      const e = await ereignis(w.programm, [{ art: 'HINWEIS', status: 'ERLEDIGT' }], {
        status: 'IN_TRIAGE',
      });
      return { pfad: `${B}/ereignisse/${e.id}/abschliessen` };
    },
  },
  {
    name: 'Ereignis verwerfen beantragen',
    methode: 'POST',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/ereignisse/${(await ereignis()).id}/verwerfen/beantragen`,
      body: { begruendung: BEGRUENDUNG },
    }),
  },
  {
    name: 'Ereignis verwerfen bestätigen',
    methode: 'POST',
    erfolg: 200,
    akteur: () => ZBT,
    ungueltig: {},
    vorbereiten: async () => {
      const e = await ereignis();
      const r = await rufe(HB, 'POST', `${B}/ereignisse/${e.id}/verwerfen/beantragen`, {
        begruendung: BEGRUENDUNG,
      });
      expect(r.status).toBe(200);
      return { pfad: `${B}/ereignisse/${e.id}/verwerfen/bestaetigen` };
    },
  },
  {
    name: 'Ereignis verwerfen ablehnen',
    methode: 'POST',
    erfolg: 200,
    ungueltig: {},
    vorbereiten: async () => {
      const e = await ereignis();
      const r = await rufe(ZBT, 'POST', `${B}/ereignisse/${e.id}/verwerfen/beantragen`, {
        begruendung: BEGRUENDUNG,
      });
      expect(r.status).toBe(200);
      return { pfad: `${B}/ereignisse/${e.id}/verwerfen/ablehnen` };
    },
  },
  {
    name: 'Portal: Meldungen lesen',
    methode: 'GET',
    erfolg: 200,
    portal: true,
    akteur: GV,
    ungueltig: 'query',
    vorbereiten: async () => ({ pfad: `${B}/portal/ereignisse` }),
  },
  {
    name: 'Portal: Ereignis melden',
    methode: 'POST',
    erfolg: 201,
    portal: true,
    akteur: GV,
    vorbereiten: async () => ({ pfad: `${B}/portal/ereignisse`, body: portalMeldung([]) }),
  },
];

describe.skipIf(!AKTIV)('API Ereignisse und Portal gegen PostgreSQL', () => {
  beforeAll(baueApiWelt);

  for (const f of faelle) {
    it(`${f.methode} ${f.name}: 400 ungültig, 404 falscher Mandant, 404 Mandantenperson, dann Erfolg ${f.erfolg}`, () =>
      pruefeFall(f));
  }

  it('Objekt-ID eines anderen Mandanten unter dem eigenen Mandanten → 404 ohne Detail', async () => {
    const e = await ereignis(w.programmF);
    for (const [methode, ziel] of [
      ['POST', `${B}/ereignisse/${e.id}/in-pruefung`],
      ['GET', `${B}/ereignisse/${e.id}`],
    ] as const) {
      const r = await rufe(ZBT, methode, ziel);
      expect(r.status, ziel).toBe(404);
      expect(r.json).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }
  });

  it('Antwort des Details ist vertragskonform', async () => {
    const e = await ereignis();
    const ed = await rufe(HB, 'GET', `${B}/ereignisse/${e.id}`);
    expect(EreignisDetailSchema.parse(ed.json['daten']).id).toBe(e.id);
  });

  it('Detail: Rechte je Schritt mit Grund; Verwerfen bestätigt nur eine zweite Person', async () => {
    const e = await ereignis();
    const lies = async (wer: typeof HB) =>
      EreignisDetailSchema.parse((await rufe(wer, 'GET', `${B}/ereignisse/${e.id}`)).json['daten'])
        .rechte;
    expect(await lies(HB)).toEqual({
      abschliessen: { erlaubt: false, verweigerung: null },
      verwerfen: {
        beantragen: { erlaubt: true, verweigerung: null },
        bestaetigen: { erlaubt: false, verweigerung: null },
      },
    });
    const antrag = await rufe(HB, 'POST', `${B}/ereignisse/${e.id}/verwerfen/beantragen`, {
      begruendung: BEGRUENDUNG,
    });
    expect(antrag.status).toBe(200);
    expect((await lies(HB)).verwerfen.bestaetigen).toEqual({
      erlaubt: false,
      verweigerung: 'VIER_AUGEN',
    });
    const selbst = await rufe(HB, 'POST', `${B}/ereignisse/${e.id}/verwerfen/bestaetigen`);
    expect(selbst.status).toBe(403);
    expect(selbst.json['fehler']).toMatchObject({ grund: 'VIER_AUGEN' });
    expect((await lies(ZBT)).verwerfen.bestaetigen).toEqual({ erlaubt: true, verweigerung: null });
  });

  it('Portal-Meldungen: Melderecht (GV ja, Mitarbeitende nein) und Programm vorhanden', async () => {
    const gv = PortalMeldungenSchema.parse(
      (await rufe(GV(), 'GET', `${B}/portal/ereignisse`)).json['daten'],
    );
    expect(gv).toMatchObject({ melden: true, programmVorhanden: true });
    const ma = PortalMeldungenSchema.parse(
      (await rufe(kontaktClaims(M, P.ma), 'GET', `${B}/portal/ereignisse`)).json['daten'],
    );
    expect(ma).toMatchObject({ melden: false, programmVorhanden: true });
    const melden = await rufe(
      kontaktClaims(M, P.ma),
      'POST',
      `${B}/portal/ereignisse`,
      portalMeldung([]),
    );
    expect(melden.status).toBe(403);
  });
});
