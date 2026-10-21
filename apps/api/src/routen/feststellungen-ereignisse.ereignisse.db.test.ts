// =============================================================================
// API-Tests Ereigniseingang (S11), Portal-Meldung (P3) und Anlagen (TS-09)
// über `erzeugeApp` mit echter Datenbank und signierten Akteursbestätigungen.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import {
  EreignisAnlagenJeDokumentSchema,
  EreignisDetailSchema,
  PortalMeldungenSchema,
} from '@tcms/contract';
import { schreibeAudit } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AKTIV,
  B,
  BEGRUENDUNG,
  baueApiWelt,
  db,
  ereignis,
  F,
  FALSCH,
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
    name: 'Ereignis-Anlagen je Dokument',
    methode: 'GET',
    erfolg: 200,
    vorbereiten: async () => ({
      pfad: `${B}/ereignis-anlagen`,
      query: `dokumentId=${randomUUID()}`,
    }),
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

  it('Anlagen: neue Dateinamen mit unzulässigen Zeichen → 400; gespeicherte (frühere Regel) lesbar', async () => {
    const anlage = (dateiname: string) => {
      const sha256 = randomBytes(32).toString('hex');
      return {
        dokumentId: `kk:${sha256.slice(0, 12)}`,
        dateiname,
        mime: 'application/pdf',
        groesse: 10,
        sha256,
      };
    };
    // Neu (Portal-Meldung): ZWSP, LRM, weiches Trennzeichen → 400, nichts gemeldet.
    for (const name of ['Vertrag\u200b.pdf', 'Vertrag\u200e.pdf', 'Ver\u00adtrag.pdf']) {
      const r = await rufe(GV(), 'POST', `${B}/portal/ereignisse`, portalMeldung([anlage(name)]));
      expect(r.status, name).toBe(400);
      expect(r.json).toMatchObject({ ok: false, fehler: { code: 'UNGUELTIG' } });
    }
    // Vor der Angleichung gespeichert (Meldungs-Audit, unveränderlich): LRM und ZWSP
    // im Namen waren zulässig – Detail und Anlage bleiben lesbar (Vertragsprüfung).
    const e = await ereignis();
    const alt = [anlage('Vertrag\u200e.pdf'), anlage('Ver\u200btrag.pdf')];
    await db((tx) =>
      schreibeAudit(tx, {
        actorId: P.gv,
        actorName: 'Testkontakt',
        aktion: 'tcms.ereignis.gemeldet',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: w.programm,
        detail: { anlagen: alt },
      }),
    );
    const d = await rufe(ZBT, 'GET', `${B}/ereignisse/${e.id}`);
    expect(d.status).toBe(200);
    expect(EreignisDetailSchema.parse(d.json['daten']).anlagen.map((a) => a.dateiname)).toEqual(
      alt.map((a) => a.dateiname),
    );
    const a = await rufe(ZBT, 'GET', `${B}/ereignisse/${e.id}/anlagen/${alt[0]!.sha256}`);
    expect(a.status).toBe(200);
    expect(a.json['daten']).toEqual(alt[0]);
  });

  it('GET ereignis-anlagen?dokumentId= (Abgleich, tcms-s11): Treffer je Ereignis; nur Kanzlei mit Bezug; fremd und unbekannt leer', async () => {
    const dok = randomUUID();
    const sha256 = randomBytes(32).toString('hex');
    const verweis = (dokumentId: string, sha = sha256) => ({
      dokumentId,
      dateiname: 'Lagervertrag.pdf',
      mime: 'application/pdf',
      groesse: 10,
      sha256: sha,
    });
    const m = await rufe(GV(), 'POST', `${B}/portal/ereignisse`, portalMeldung([verweis(dok)]));
    expect(m.status).toBe(201);
    const gemeldet = m.json['daten'] as { id: string; nummer: string };
    // Meldung beim anderen Mandanten (F) mit eigener Dokument-ID: zählt unter M nicht.
    const dokF = randomUUID();
    const ef = await ereignis(w.programmF);
    await db((tx) =>
      schreibeAudit(tx, {
        actorId: P.gv,
        actorName: 'Testkontakt',
        aktion: 'tcms.ereignis.gemeldet',
        objektTyp: 'Ereignis',
        objektId: ef.id,
        programmId: w.programmF,
        detail: { anlagen: [verweis(dokF, randomBytes(32).toString('hex'))] },
      }),
    );

    const A = `${B}/ereignis-anlagen`;
    const ok = await rufe(HB, 'GET', `${A}?dokumentId=${dok.toUpperCase()}`);
    expect(ok.status).toBe(200);
    expect(EreignisAnlagenJeDokumentSchema.parse(ok.json['daten'])).toEqual({
      dokumentId: dok,
      anlagen: [
        {
          ereignisId: gemeldet.id,
          nummer: gemeldet.nummer,
          status: 'NEU',
          sha256,
          entfernt: false,
        },
      ],
    });
    // Gegenprobe: beim Mandanten F (Bestätigung mit Bezug F) ist der Verweis da.
    const beiF = await rufe(
      FALSCH,
      'GET',
      `/v1/mandanten/${F}/ereignis-anlagen?dokumentId=${dokF}`,
    );
    expect(beiF.status).toBe(200);
    expect((beiF.json['daten'] as { anlagen: unknown[] }).anlagen).toHaveLength(1);
    for (const unbekannt of [randomUUID(), dokF]) {
      const leer = await rufe(ZBT, 'GET', `${A}?dokumentId=${unbekannt}`);
      expect(leer.status).toBe(200);
      expect(leer.json['daten']).toEqual({ dokumentId: unbekannt, anlagen: [] });
    }
    // Mandantenkontakt (Register: nur KANZLEI) und falscher Mandant: 404 ohne Detail.
    for (const [ziel, wer] of [
      [`${A}?dokumentId=${dok}`, GV()],
      [`/v1/mandanten/${F}/ereignis-anlagen?dokumentId=${dok}`, ZBT],
    ] as const) {
      const r = await rufe(wer, 'GET', ziel);
      expect(r.status, ziel).toBe(404);
      expect(r.json).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }
    // Ohne, ungültige (keine UUID), doppelte Dokument-ID oder fremde Parameter: 400.
    for (const q of [
      '',
      '?dokumentId=ab',
      `?dokumentId=kk:${dok}`,
      `?dokumentId=${dok}&dokumentId=${dok}`,
      `?dokumentId=${dok}&stand=2026-10-01`,
    ]) {
      const r = await rufe(HB, 'GET', `${A}${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json).toMatchObject({ ok: false, fehler: { code: 'UNGUELTIG' } });
    }
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

  // tcms-s10: Die kanzleikonsole wiederholt eine Meldung mit unklarem Ausgang gefahrlos.
  it('Portal-Meldung mit Idempotenzschlüssel: Wiederholung 201 mit derselben Antwort, anderer Inhalt 409 mit Grund', async () => {
    const schluessel = randomUUID();
    const titel = `Lager idempotent ${randomBytes(3).toString('hex')}`;
    const body = { ...portalMeldung([]), titel, idempotenzSchluessel: schluessel };
    // Zwei gleichzeitige Anfragen (Antwort verloren, Client wiederholt sofort).
    const [a, b] = await Promise.all([
      rufe(GV(), 'POST', `${B}/portal/ereignisse`, body),
      rufe(GV(), 'POST', `${B}/portal/ereignisse`, body),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json).toEqual(a.json);
    const c = await rufe(GV(), 'POST', `${B}/portal/ereignisse`, body);
    expect(c).toEqual(a);
    const anders = await rufe(GV(), 'POST', `${B}/portal/ereignisse`, {
      ...body,
      beschreibung: 'Ab Dezember lagern wir Ware in Posen.',
    });
    expect(anders).toEqual({
      status: 409,
      json: {
        ok: false,
        fehler: {
          code: 'KONFLIKT',
          meldung: expect.any(String),
          konflikt: 'IDEMPOTENZ_ABWEICHUNG',
        },
      },
    });
    expect(await db((tx) => tx.ereignis.count({ where: { titel } }))).toBe(1);
    // Nur UUID als Schlüssel.
    const kaputt = await rufe(GV(), 'POST', `${B}/portal/ereignisse`, {
      ...body,
      idempotenzSchluessel: 'meldung-1',
    });
    expect(kaputt.status).toBe(400);
  });
});
