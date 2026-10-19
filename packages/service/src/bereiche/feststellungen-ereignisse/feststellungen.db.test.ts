// =============================================================================
// Feststellungen und Maßnahmen gegen PostgreSQL (DB_TESTS=1, DATABASE_URL =
// tcms_app): Rechte je Operation (TS-03), Mandanten- und Tenant-Trennung ohne
// Existenz-Orakel, TS-04 (Auswirkung „NEIN"), §-153 nur zuständige
// Berufsträger:innen, Vier-Augen beim Verwerfen, Vertraulichkeit im Service,
// TS-05 (gleichzeitige Entscheidungen → genau eine, die andere KONFLIKT) und
// Audit je Änderung.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DienstFehler,
  FeststellungDetailSchema,
  FeststellungListeSchema,
  P153BodySchema,
  type Akteur,
} from '@tcms/contract';
import type { DienstKontext } from '../../kontext';
import {
  aktualisiereWuerdigung,
  beantrageFeststellungVerwerfen,
  bestaetigeFeststellungVerwerfen,
  entscheideP153,
  erfasseFeststellung,
  erledigeMassnahme,
  fuegeErklaerungHinzu,
  legeMassnahmeAn,
  legeNachkontrolleAn,
  lehneFeststellungVerwerfenAb,
  schalteFeststellungWeiter,
  setzeVertraulich,
} from './feststellungen';
import { ladeFeststellung, ladeFeststellungen } from './feststellungen-lesen';
import { legeFeststellungAn } from './gemeinsam';
import {
  akteure,
  aufwaermen,
  auditZahl,
  baueWelt,
  fehlerVon,
  genauEinerKonflikt,
  gleichzeitig,
  im,
  inTenant,
  neueFeststellung,
  neueMassnahme,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Die Berichtigung der USt-Voranmeldung für August ist veranlasst.';

describe.skipIf(!AKTIV)('Feststellungen gegen PostgreSQL', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    await aufwaermen(w);
  });

  const feststellung = (a: Akteur, id: string) => ({ mandantId: w.mandant, feststellungId: id, a });

  // ---------------------------------------------------------------------------
  // Zugriff für alle Operationen (TS-03): kein Bezug, fremder Mandant, fremder
  // Tenant, Mandantenkontakte, Objekt-ID eines anderen Mandanten, unbekannte ID
  // ---------------------------------------------------------------------------

  type Op = {
    name: string;
    lauf: (ctx: DienstKontext, feststellungId: string, massnahmeId: string) => Promise<unknown>;
    /** Akteur ohne das nötige Recht, aber mit Lesezugriff → NICHT_BERECHTIGT */
    ohneRecht: keyof ReturnType<typeof akteure>;
  };
  const ops: Op[] = [
    {
      name: 'weiter',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          von: 'ERFASST',
        }),
    },
    {
      name: 'p153',
      ohneRecht: 'hb',
      lauf: (ctx, id) =>
        entscheideP153(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          entscheidung: 'KEINE_PFLICHT',
          begruendung: BEGRUENDUNG,
          bisher: null,
        }),
    },
    {
      name: 'wuerdigung',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        aktualisiereWuerdigung(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          schwere: 'HOCH',
          auswirkung: 'JA',
        }),
    },
    {
      name: 'erklaerung',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        fuegeErklaerungHinzu(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          steuerart: 'USt',
          land: 'de',
          zeitraum: 'Q3 2026',
          auswirkungEur: 12.345,
        }),
    },
    {
      name: 'massnahme',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        legeMassnahmeAn(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          beschreibung: 'Konto abstimmen',
          verantwortlich: { id: w.p.hb, art: 'KANZLEI' },
          frist: '2026-12-01',
        }),
    },
    {
      name: 'massnahme erledigen',
      ohneRecht: 'leser',
      lauf: (ctx, _id, mid) =>
        erledigeMassnahme(ctx, {
          mandantId: w.mandant,
          massnahmeId: mid,
          nachweis: 'Abstimmung liegt in DMS.',
        }),
    },
    {
      name: 'nachkontrolle',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        legeNachkontrolleAn(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          kontrolleId: w.kontrolle,
          faelligAm: '2026-12-01',
        }),
    },
    {
      name: 'verwerfen beantragen',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        beantrageFeststellungVerwerfen(ctx, {
          mandantId: w.mandant,
          feststellungId: id,
          begruendung: BEGRUENDUNG,
        }),
    },
    {
      name: 'verwerfen bestätigen',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: id }),
    },
    {
      name: 'verwerfen ablehnen',
      ohneRecht: 'leser',
      lauf: (ctx, id) =>
        lehneFeststellungVerwerfenAb(ctx, { mandantId: w.mandant, feststellungId: id }),
    },
    {
      name: 'vertraulich',
      ohneRecht: 'hb',
      lauf: (ctx, id) =>
        setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: id, vertraulich: true }),
    },
    {
      name: 'detail',
      ohneRecht: 'leser',
      lauf: (ctx, id) => ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: id }),
    },
  ];

  for (const op of ops) {
    it(`${op.name}: ohne Bezug, fremder Mandant, fremder Tenant, Mandantenkontakte → NICHT_GEFUNDEN`, async () => {
      const f = await neueFeststellung(w, {
        status: 'MASSNAHMEN_OFFEN',
        verwerfenBeantragtVon: w.p.adminOhneBt,
      });
      const m = await neueMassnahme(w, f.id, w.p.zbt);
      for (const a of [
        A.ohneBezug,
        A.fremdBezug,
        A.fremdTenant,
        A.leerTenant,
        A.gv,
        A.tcb,
        A.ma,
        A.ohneRolle,
      ]) {
        const e = await fehlerVon(im(a, (ctx) => op.lauf(ctx, f.id, m.id)));
        expect(e.code, `${op.name} als ${a.id}/${a.art}`).toBe('NICHT_GEFUNDEN');
        expect(e.message).toBe('NICHT_GEFUNDEN');
      }
      expect(await auditZahl(w, f.id)).toBe(0);
    });

    it(`${op.name}: Objekt eines anderen Mandanten und unbekannte ID → NICHT_GEFUNDEN`, async () => {
      const fremd = await neueFeststellung(w, {
        programmId: w.programmFremd,
        status: 'MASSNAHMEN_OFFEN',
        verwerfenBeantragtVon: w.p.adminOhneBt,
      });
      const fm = await neueMassnahme(w, fremd.id, w.p.zbt);
      for (const [fid, mid] of [
        [fremd.id, fm.id],
        ['cunbekannt000000000000000', 'cunbekannt000000000000001'],
      ] as const) {
        const e = await fehlerVon(im(A.admin, (ctx) => op.lauf(ctx, fid, mid)));
        expect(e.code, op.name).toBe('NICHT_GEFUNDEN');
      }
      // Feststellung im fremden Tenant mit derselben Mandanten-ID.
      const b = await neueFeststellung(
        w,
        { programmId: w.programmB, status: 'MASSNAHMEN_OFFEN' },
        w.tenantB,
      );
      expect((await fehlerVon(im(A.admin, (ctx) => op.lauf(ctx, b.id, b.id)))).code).toBe(
        'NICHT_GEFUNDEN',
      );
      expect(await auditZahl(w, fremd.id)).toBe(0);
    });

    it(`${op.name}: Lesezugriff ohne das Recht → NICHT_BERECHTIGT mit Grund, keine Änderung`, async () => {
      const f = await neueFeststellung(w, {
        status: 'MASSNAHMEN_OFFEN',
        verwerfenBeantragtVon: w.p.adminOhneBt,
      });
      const m = await neueMassnahme(w, f.id, w.p.zbt);
      const p = im(A[op.ohneRecht], (ctx) => op.lauf(ctx, f.id, m.id));
      if (op.name === 'detail') {
        await expect(p).resolves.toMatchObject({ maskiert: false, id: f.id });
        return;
      }
      const e = await fehlerVon(p);
      expect(e.code).toBe('NICHT_BERECHTIGT');
      // §-153 und Vertraulichkeit: kannWuerdigen; alles andere: kannBearbeiten.
      expect(e.grund).toBe(
        op.name === 'p153' || op.name === 'vertraulich' ? 'WUERDIGEN' : 'BEARBEITEN',
      );
      expect(e.message.length).toBeGreaterThan(10);
      expect(await auditZahl(w, f.id)).toBe(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Status weiterschalten
  // ---------------------------------------------------------------------------

  it('weiter: ERFASST → IN_WUERDIGUNG mit Audit', async () => {
    const f = await neueFeststellung(w);
    const r = await im(A.hb, (ctx) =>
      schalteFeststellungWeiter(ctx, {
        mandantId: w.mandant,
        feststellungId: f.id,
        von: 'ERFASST',
      }),
    );
    expect(r).toEqual({ id: f.id, nummer: f.nummer, status: 'IN_WUERDIGUNG' });
    expect(await auditZahl(w, f.id, 'tcms.feststellung.status')).toBe(1);
  });

  it('weiter: veralteter Status (von) → KONFLIKT; fachlich gesperrt → UNGUELTIG mit Feld von', async () => {
    const f = await neueFeststellung(w, { status: 'IN_WUERDIGUNG' });
    expect(
      (
        await fehlerVon(
          im(A.hb, (ctx) =>
            schalteFeststellungWeiter(ctx, {
              mandantId: w.mandant,
              feststellungId: f.id,
              von: 'ERFASST',
            }),
          ),
        )
      ).code,
    ).toBe('KONFLIKT');
    // §-153 offen: Schritt blockiert.
    const e = await fehlerVon(
      im(A.hb, (ctx) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          von: 'IN_WUERDIGUNG',
        }),
      ),
    );
    expect(e.code).toBe('UNGUELTIG');
    expect(e.message).toMatch(/§-153/);
    expect(e.felder).toEqual({ von: [e.message] });
    // Ohne Maßnahme (§ 153 erledigt): ebenfalls gesperrt, nicht geschaltet.
    const ohne = await neueFeststellung(w, { status: 'IN_WUERDIGUNG', auswirkung: 'NEIN' });
    const m = await fehlerVon(
      im(A.hb, (ctx) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: ohne.id,
          von: 'IN_WUERDIGUNG',
        }),
      ),
    );
    expect(m).toMatchObject({
      code: 'UNGUELTIG',
      felder: { von: [expect.stringMatching(/Maßnahme/)] },
    });
    // Offene Maßnahme bzw. fehlende Nachkontrolle: gesperrt.
    for (const [status, muster] of [
      ['MASSNAHMEN_OFFEN', /offene Maßnahmen/],
      ['NACHKONTROLLE', /Nachkontrolle/],
    ] as const) {
      const g = await neueFeststellung(w, { status, auswirkung: 'NEIN' });
      await neueMassnahme(w, g.id, w.p.hb);
      const x = await fehlerVon(
        im(A.hb, (ctx) =>
          schalteFeststellungWeiter(ctx, {
            mandantId: w.mandant,
            feststellungId: g.id,
            von: status,
          }),
        ),
      );
      expect(x, status).toMatchObject({
        code: 'UNGUELTIG',
        felder: { von: [expect.stringMatching(muster)] },
      });
    }
    // Geschlossen bzw. verworfen auf dem gesehenen Stand: kein weiterer Schritt (400);
    // ein veralteter Stand dagegen bleibt die gleichzeitige Änderung (409).
    for (const status of ['GESCHLOSSEN', 'VERWORFEN'] as const) {
      const g = await neueFeststellung(w, { status });
      const gesehen = await fehlerVon(
        im(A.hb, (ctx) =>
          schalteFeststellungWeiter(ctx, {
            mandantId: w.mandant,
            feststellungId: g.id,
            von: status,
          }),
        ),
      );
      expect(gesehen, status).toMatchObject({
        code: 'UNGUELTIG',
        felder: { von: [expect.any(String)] },
      });
      const veraltet = await fehlerVon(
        im(A.hb, (ctx) =>
          schalteFeststellungWeiter(ctx, {
            mandantId: w.mandant,
            feststellungId: g.id,
            von: 'NACHKONTROLLE',
          }),
        ),
      );
      expect(veraltet.code, status).toBe('KONFLIKT');
    }
    // Recht vor Zustand: ohne Bearbeitungsrecht 403, auch bei gesperrtem Schritt.
    const r = await fehlerVon(
      im(A.leser, (ctx) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          von: 'IN_WUERDIGUNG',
        }),
      ),
    );
    expect(r).toMatchObject({ code: 'NICHT_BERECHTIGT', grund: 'BEARBEITEN' });
    expect(await auditZahl(w, f.id, 'tcms.feststellung.status')).toBe(0);
  });

  it('weiter: Schritt wäre möglich, aber gesehener Status veraltet → KONFLIKT, nichts geschaltet', async () => {
    const f = await neueFeststellung(w, { status: 'IN_WUERDIGUNG', auswirkung: 'NEIN' });
    await neueMassnahme(w, f.id, w.p.hb);
    const e = await fehlerVon(
      im(A.hb, (ctx) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          von: 'ERFASST',
        }),
      ),
    );
    expect(e.code).toBe('KONFLIKT');
    expect(
      (await inTenant(w, (tx) => tx.feststellung.findUniqueOrThrow({ where: { id: f.id } })))
        .status,
    ).toBe('IN_WUERDIGUNG');
    await expect(
      im(A.hb, (ctx) =>
        schalteFeststellungWeiter(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          von: 'IN_WUERDIGUNG',
        }),
      ),
    ).resolves.toMatchObject({ status: 'MASSNAHMEN_OFFEN' });
  });

  it('TS-05 weiter: zwei gleichzeitige Klicks schalten genau einen Schritt', async () => {
    for (let runde = 0; runde < 3; runde++) {
      const f = await neueFeststellung(w, { auswirkung: 'NEIN' });
      const klick = () =>
        im(A.hb, (ctx) =>
          schalteFeststellungWeiter(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            von: 'ERFASST',
          }),
        );
      expect(genauEinerKonflikt(await gleichzeitig(klick, klick))).toBe(true);
      const jetzt = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: f.id } }),
      );
      expect(jetzt.status).toBe('IN_WUERDIGUNG');
      expect(await auditZahl(w, f.id, 'tcms.feststellung.status')).toBe(1);
    }
  });

  it('geschlossene oder verworfene Feststellung: KONFLIKT', async () => {
    for (const status of ['GESCHLOSSEN', 'VERWORFEN'] as const) {
      const f = await neueFeststellung(w, { status });
      const e = await fehlerVon(
        im(A.zbt, (ctx) =>
          fuegeErklaerungHinzu(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            steuerart: 'USt',
            land: 'DE',
            zeitraum: 'Q3',
          }),
        ),
      );
      expect(e.code).toBe('KONFLIKT');
    }
  });

  // ---------------------------------------------------------------------------
  // §-153-Würdigung
  // ---------------------------------------------------------------------------

  it('§ 153: zuständige Berufsträgerin entscheidet; Wiedervorlage mit Frist, Status, Audit', async () => {
    const f = await neueFeststellung(w);
    const r = await im(A.zbt, (ctx) =>
      entscheideP153(ctx, {
        mandantId: w.mandant,
        feststellungId: f.id,
        entscheidung: 'BERICHTIGUNG',
        begruendung: BEGRUENDUNG,
        frist: '2026-11-15',
        bisher: null,
      }),
    );
    expect(r.entscheidung).toBe('BERICHTIGUNG');
    expect(r.wiedervorlageNr).toBeGreaterThan(0);
    const jetzt = await inTenant(w, (tx) =>
      tx.feststellung.findUniqueOrThrow({ where: { id: f.id }, include: { massnahmen: true } }),
    );
    expect(jetzt).toMatchObject({
      status: 'IN_WUERDIGUNG',
      p153Entscheidung: 'BERICHTIGUNG',
      p153EntschiedenVon: w.p.zbt,
    });
    expect(jetzt.massnahmen).toHaveLength(1);
    expect(jetzt.massnahmen[0]!.verantwortlich).toBe(w.p.zbt);
    expect(await auditZahl(w, f.id, 'tcms.feststellung.p153_entschieden')).toBe(1);
  });

  it('§ 153: nur Berufsträger:in mit Zuständigkeit oder Admin-BT; Admin ohne BT, Hauptbearbeitung und BT ohne Zuständigkeit abgewiesen', async () => {
    const f = await neueFeststellung(w);
    for (const a of [A.hb, A.leser, A.adminOhneBt]) {
      const e = await fehlerVon(
        im(a, (ctx) =>
          entscheideP153(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            entscheidung: 'KEINE_PFLICHT',
            begruendung: BEGRUENDUNG,
            bisher: null,
          }),
        ),
      );
      expect(e).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'WUERDIGEN',
        message: 'Dieser Schritt ist Berufsträger:innen vorbehalten.',
      });
    }
    await expect(
      im(A.admin, (ctx) =>
        entscheideP153(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          entscheidung: 'UEBERGABE',
          begruendung: BEGRUENDUNG,
          bisher: null,
        }),
      ),
    ).resolves.toMatchObject({ entscheidung: 'UEBERGABE' });
  });

  it('§ 153: vier gleichrangige Optionen ohne Standardwert – fehlende Entscheidung ist ungültig', async () => {
    const ohne = { begruendung: BEGRUENDUNG, bisher: null };
    expect(P153BodySchema.safeParse(ohne).success).toBe(false);
    expect(P153BodySchema.shape.entscheidung.options).toEqual([
      'BERICHTIGUNG',
      'KEINE_PFLICHT',
      'WEITERE_KLAERUNG',
      'UEBERGABE',
    ]);
    const f = await neueFeststellung(w);
    const e = await fehlerVon(
      im(A.zbt, (ctx) =>
        entscheideP153(ctx, { mandantId: w.mandant, feststellungId: f.id, ...ohne } as never),
      ),
    );
    expect(e.code).toBe('UNGUELTIG');
    expect(e.felder?.['entscheidung']).toBeDefined();
    // Frist Pflicht bei Berichtigung, nicht in der Vergangenheit.
    for (const frist of [undefined, '2026-10-15']) {
      const x = await fehlerVon(
        im(A.zbt, (ctx) =>
          entscheideP153(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            entscheidung: 'BERICHTIGUNG',
            begruendung: BEGRUENDUNG,
            bisher: null,
            frist,
          }),
        ),
      );
      expect(x.code).toBe('UNGUELTIG');
    }
  });

  it('TS-05 § 153: zwei gleichzeitige Entscheidungen → genau eine, die andere KONFLIKT', async () => {
    for (let runde = 0; runde < 3; runde++) {
      const f = await neueFeststellung(w);
      const entscheide = (a: Akteur, entscheidung: 'KEINE_PFLICHT' | 'UEBERGABE') => () =>
        im(a, (ctx) =>
          entscheideP153(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            entscheidung,
            begruendung: BEGRUENDUNG,
            bisher: null,
          }),
        );
      expect(
        genauEinerKonflikt(
          await gleichzeitig(entscheide(A.zbt, 'KEINE_PFLICHT'), entscheide(A.admin, 'UEBERGABE')),
        ),
      ).toBe(true);
      expect(await auditZahl(w, f.id, 'tcms.feststellung.p153_entschieden')).toBe(1);
    }
  });

  it('§ 153: abschließende Entscheidung ist endgültig; nach „weitere Klärung" nur auf gesehenem Stand', async () => {
    const f = await neueFeststellung(w);
    const p153 = (
      bisher: 'WEITERE_KLAERUNG' | null,
      entscheidung: 'WEITERE_KLAERUNG' | 'KEINE_PFLICHT',
    ) =>
      im(A.zbt, (ctx) =>
        entscheideP153(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          entscheidung,
          begruendung: BEGRUENDUNG,
          frist: '2026-12-01',
          bisher,
        }),
      );
    await p153(null, 'WEITERE_KLAERUNG');
    // Wer den Stand vor der Klärung gesehen hat, überschreibt nicht.
    expect((await fehlerVon(p153(null, 'KEINE_PFLICHT'))).code).toBe('KONFLIKT');
    await p153('WEITERE_KLAERUNG', 'KEINE_PFLICHT');
    const e = await fehlerVon(p153('WEITERE_KLAERUNG', 'KEINE_PFLICHT'));
    expect(e).toMatchObject({
      code: 'KONFLIKT',
      message: 'Die §-153-Würdigung ist bereits dokumentiert.',
    });
  });

  it('§ 153: ohne steuerliche Auswirkung gibt es keinen §-153-Pfad', async () => {
    const f = await neueFeststellung(w, { auswirkung: 'NEIN' });
    const e = await fehlerVon(
      im(A.zbt, (ctx) =>
        entscheideP153(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          entscheidung: 'KEINE_PFLICHT',
          begruendung: BEGRUENDUNG,
          bisher: null,
        }),
      ),
    );
    expect(e.code).toBe('KONFLIKT');
  });

  // ---------------------------------------------------------------------------
  // Würdigungsangaben (TS-04 beim Herabstufen)
  // ---------------------------------------------------------------------------

  it('TS-04: Herabstufen auf „NEIN" nur mit Würdigungsrecht', async () => {
    for (const von of ['JA', 'UNKLAR'] as const) {
      const f = await neueFeststellung(w, { auswirkung: von });
      const herab = (a: Akteur) =>
        im(a, (ctx) =>
          aktualisiereWuerdigung(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            schwere: 'GERING',
            auswirkung: 'NEIN',
          }),
        );
      for (const a of [A.hb, A.adminOhneBt]) {
        const e = await fehlerVon(herab(a));
        expect([e.code, e.grund]).toEqual(['NICHT_BERECHTIGT', 'WUERDIGEN']);
        expect(e.message).toMatch(/Berufsträger/);
      }
      const nachher = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: f.id } }),
      );
      expect(nachher.auswirkung).toBe(von);
      await herab(A.zbt);
      expect(
        (await inTenant(w, (tx) => tx.feststellung.findUniqueOrThrow({ where: { id: f.id } })))
          .auswirkung,
      ).toBe('NEIN');
      expect(await auditZahl(w, f.id, 'tcms.feststellung.wuerdigung')).toBe(1);
    }
  });

  it('Würdigung: Bearbeitung ändert Schwere und Ursache; nach § 153 keine Änderung der Auswirkung', async () => {
    const f = await neueFeststellung(w);
    await im(A.hb, (ctx) =>
      aktualisiereWuerdigung(ctx, {
        mandantId: w.mandant,
        feststellungId: f.id,
        schwere: 'HOCH',
        auswirkung: 'UNKLAR',
        ursache: 'Schnittstelle',
      }),
    );
    const g = await neueFeststellung(w, {
      p153Entscheidung: 'WEITERE_KLAERUNG',
      status: 'IN_WUERDIGUNG',
    });
    const e = await fehlerVon(
      im(A.zbt, (ctx) =>
        aktualisiereWuerdigung(ctx, {
          mandantId: w.mandant,
          feststellungId: g.id,
          schwere: 'HOCH',
          auswirkung: 'NEIN',
        }),
      ),
    );
    expect(e.code).toBe('KONFLIKT');
  });

  // ---------------------------------------------------------------------------
  // Erklärungen, Maßnahmen, Nachkontrolle
  // ---------------------------------------------------------------------------

  it('Erklärung: angelegt mit gerundetem Betrag; übergroße Beträge und Steuerzeichen → UNGUELTIG', async () => {
    const f = await neueFeststellung(w);
    const ok = await im(A.hb, (ctx) =>
      fuegeErklaerungHinzu(ctx, {
        mandantId: w.mandant,
        feststellungId: f.id,
        steuerart: 'USt (OSS)',
        land: 'cz',
        zeitraum: 'Q3 2026',
        auswirkungEur: 1234.567,
      }),
    );
    const e = await inTenant(w, (tx) =>
      tx.betroffeneErklaerung.findUniqueOrThrow({ where: { id: ok.id } }),
    );
    expect(e.land).toBe('CZ');
    expect(Number(e.auswirkungEur)).toBe(1234.57);
    for (const boese of [
      { auswirkungEur: 1e13 },
      { auswirkungEur: Number.NaN },
      { steuerart: 'USt\u0000' },
      { zeitraum: 'Q3\ud800' },
      { land: 'x'.repeat(41) },
    ]) {
      const x = await fehlerVon(
        im(A.hb, (ctx) =>
          fuegeErklaerungHinzu(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            steuerart: 'USt',
            land: 'DE',
            zeitraum: 'Q3',
            ...boese,
          }),
        ),
      );
      expect(x.code, JSON.stringify(boese)).toBe('UNGUELTIG');
    }
  });

  it('Maßnahme: kanzleiweite Wiedervorlage, Mandantenkontakt nur mit aktiver Rolle, Frist nicht in der Vergangenheit', async () => {
    const f = await neueFeststellung(w, {
      status: 'NACHKONTROLLE',
      p153Entscheidung: 'BERICHTIGUNG',
    });
    const lege = (
      verantwortlich: { id: string; art: 'KANZLEI' | 'MANDANT' },
      frist = '2026-12-01',
    ) =>
      im(A.hb, (ctx) =>
        legeMassnahmeAn(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          beschreibung: 'Konto abstimmen',
          verantwortlich,
          frist,
        }),
      );
    const a = await lege({ id: w.p.ma, art: 'MANDANT' });
    expect(a.wiedervorlageNr).toBeGreaterThan(0);
    // Neue Maßnahme während der Nachkontrolle → zurück auf „Maßnahmen offen".
    expect(
      (await inTenant(w, (tx) => tx.feststellung.findUniqueOrThrow({ where: { id: f.id } })))
        .status,
    ).toBe('MASSNAHMEN_OFFEN');
    for (const p of [
      { id: w.p.ohneRolle, art: 'MANDANT' as const },
      { id: w.p.gvFremd, art: 'MANDANT' as const },
    ]) {
      expect((await fehlerVon(lege(p))).code).toBe('UNGUELTIG');
    }
    expect((await fehlerVon(lege({ id: w.p.hb, art: 'KANZLEI' }, '2026-10-15'))).code).toBe(
      'UNGUELTIG',
    );
    expect(await auditZahl(w, a.id, 'tcms.massnahme.angelegt')).toBe(1);
  });

  it('TS-05 Maßnahmen: gleichzeitige Anlage vergibt verschiedene Wiedervorlage-Nummern', async () => {
    const f = await neueFeststellung(w, { status: 'MASSNAHMEN_OFFEN' });
    const lege = () =>
      im(A.hb, (ctx) =>
        legeMassnahmeAn(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          beschreibung: 'Konto abstimmen',
          verantwortlich: { id: w.p.hb, art: 'KANZLEI' },
          frist: '2026-12-01',
        }),
      );
    const [a, b] = await Promise.all([lege(), lege()]);
    expect(a.wiedervorlageNr).not.toBe(b.wiedervorlageNr);
  });

  it('Maßnahme erledigen: verantwortliche Person ohne Bearbeitungsrecht darf, andere nicht; doppelt → KONFLIKT', async () => {
    const f = await neueFeststellung(w, { status: 'MASSNAHMEN_OFFEN' });
    const m = await neueMassnahme(w, f.id, w.p.leser);
    const n = await neueMassnahme(w, f.id, w.p.zbt);
    const erledige = (a: Akteur, id: string) => () =>
      im(a, (ctx) =>
        erledigeMassnahme(ctx, {
          mandantId: w.mandant,
          massnahmeId: id,
          nachweis: 'Abstimmung liegt im DMS.',
        }),
      );
    await expect(erledige(A.leser, m.id)()).resolves.toMatchObject({ id: m.id });
    expect(await fehlerVon(erledige(A.leser, n.id)())).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      grund: 'BEARBEITEN',
    });
    for (let runde = 0; runde < 3; runde++) {
      const x = await neueMassnahme(w, f.id, w.p.zbt);
      expect(
        genauEinerKonflikt(await gleichzeitig(erledige(A.zbt, x.id), erledige(A.hb, x.id))),
        `Runde ${runde}`,
      ).toBe(true);
      expect(await auditZahl(w, x.id, 'tcms.massnahme.erledigt')).toBe(1);
    }
  });

  it('Nachkontrolle: Kontrolle des Programms; fremde Kontrolle → NICHT_GEFUNDEN; gleichzeitig → genau eine', async () => {
    for (let runde = 0; runde < 3; runde++) {
      const f = await neueFeststellung(w, { status: 'MASSNAHMEN_OFFEN' });
      const nk = (kontrolleId: string) => () =>
        im(A.hb, (ctx) =>
          legeNachkontrolleAn(ctx, {
            mandantId: w.mandant,
            feststellungId: f.id,
            kontrolleId,
            faelligAm: '2026-12-01',
          }),
        );
      expect((await fehlerVon(nk(w.kontrolleFremd)())).code).toBe('NICHT_GEFUNDEN');
      expect(
        genauEinerKonflikt(await gleichzeitig(nk(w.kontrolle), nk(w.kontrolle))),
        `Runde ${runde}`,
      ).toBe(true);
      const d = await inTenant(w, (tx) =>
        tx.durchfuehrung.count({ where: { anlass: `Nachkontrolle ${f.nummer}` } }),
      );
      expect(d).toBe(1);
      expect(await auditZahl(w, f.id, 'tcms.feststellung.nachkontrolle')).toBe(1);
    }
  });

  // ---------------------------------------------------------------------------
  // Verwerfen (Vier-Augen)
  // ---------------------------------------------------------------------------

  it('Verwerfen: dieselbe Person bestätigt nicht; zweite Person bestätigt; Audit', async () => {
    const f = await neueFeststellung(w);
    await im(A.hb, (ctx) =>
      beantrageFeststellungVerwerfen(ctx, {
        mandantId: w.mandant,
        feststellungId: f.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    // Auch in anderer Schreibweise der ID ist es dieselbe Person.
    const gross = { ...A.hb, id: A.hb.id.toUpperCase() } as Akteur;
    for (const a of [A.hb, gross]) {
      const e = await fehlerVon(
        im(a, (ctx) =>
          bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
        ),
      );
      expect(e).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'VIER_AUGEN',
        message: 'Die Bestätigung muss durch eine zweite Person erfolgen.',
      });
    }
    await expect(
      im(A.zbt, (ctx) =>
        bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
      ),
    ).resolves.toMatchObject({ status: 'VERWORFEN' });
    const x = await inTenant(w, (tx) => tx.feststellung.findUniqueOrThrow({ where: { id: f.id } }));
    expect(x).toMatchObject({
      status: 'VERWORFEN',
      verwerfenBeantragtVon: w.p.hb,
      verwerfenBestaetigtVon: w.p.zbt,
    });
    expect(await auditZahl(w, f.id, 'tcms.feststellung.verwerfen_bestaetigt')).toBe(1);
  });

  it('Verwerfen mit möglicher Steuerwirkung („JA"/„UNKLAR"): Bestätigung nur mit Würdigungsrecht (Regel 5)', async () => {
    for (const auswirkung of ['JA', 'UNKLAR'] as const) {
      const f = await neueFeststellung(w, { auswirkung, verwerfenBeantragtVon: w.p.zbt });
      // Zweite Person mit Bearbeitungsrecht, aber ohne Würdigungsrecht: abgewiesen, unverändert.
      for (const a of [A.hb, A.adminOhneBt]) {
        const e = await fehlerVon(
          im(a, (ctx) =>
            bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
          ),
        );
        expect(e.code, `${auswirkung} als ${a.id}`).toBe('NICHT_BERECHTIGT');
        expect(e.grund).toBe('WUERDIGEN');
        expect(e.message).toMatch(/Berufsträger.*§ 153/);
      }
      const x = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: f.id } }),
      );
      expect(x).toMatchObject({ status: 'ERFASST', verwerfenBestaetigtVon: null });
      expect(await auditZahl(w, f.id)).toBe(0);
      // Zuständige Berufsträgerin als zweite Person darf.
      await expect(
        im(A.admin, (ctx) =>
          bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
        ),
      ).resolves.toMatchObject({ status: 'VERWORFEN' });
    }
    // Steuerwirkung ausgeschlossen („NEIN"): die zweite Person genügt.
    const nein = await neueFeststellung(w, { auswirkung: 'NEIN', verwerfenBeantragtVon: w.p.zbt });
    await expect(
      im(A.hb, (ctx) =>
        bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: nein.id }),
      ),
    ).resolves.toMatchObject({ status: 'VERWORFEN' });
  });

  it('TS-05 Verwerfen: zwei zweite Personen gleichzeitig → genau eine Bestätigung', async () => {
    const f = await neueFeststellung(w, { verwerfenBeantragtVon: w.p.hb });
    const best = (a: Akteur) => () =>
      im(a, (ctx) =>
        bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
      );
    expect(genauEinerKonflikt(await gleichzeitig(best(A.zbt), best(A.admin)))).toBe(true);
    expect(await auditZahl(w, f.id, 'tcms.feststellung.verwerfen_bestaetigt')).toBe(1);
  });

  it('Verwerfen: Antragsteller:in zieht zurück, andere lehnen ab; doppelter Antrag → KONFLIKT', async () => {
    const f = await neueFeststellung(w);
    const beantrage = () =>
      im(A.hb, (ctx) =>
        beantrageFeststellungVerwerfen(ctx, {
          mandantId: w.mandant,
          feststellungId: f.id,
          begruendung: BEGRUENDUNG,
        }),
      );
    await beantrage();
    expect((await fehlerVon(beantrage())).code).toBe('KONFLIKT');
    await expect(
      im(A.hb, (ctx) =>
        lehneFeststellungVerwerfenAb(ctx, { mandantId: w.mandant, feststellungId: f.id }),
      ),
    ).resolves.toEqual({ id: f.id, zurueckgezogen: true });
    await beantrage();
    await expect(
      im(A.zbt, (ctx) =>
        lehneFeststellungVerwerfenAb(ctx, { mandantId: w.mandant, feststellungId: f.id }),
      ),
    ).resolves.toEqual({ id: f.id, zurueckgezogen: false });
    expect(
      (
        await fehlerVon(
          im(A.zbt, (ctx) =>
            bestaetigeFeststellungVerwerfen(ctx, { mandantId: w.mandant, feststellungId: f.id }),
          ),
        )
      ).code,
    ).toBe('KONFLIKT');
  });

  // ---------------------------------------------------------------------------
  // Vertraulichkeit (Setzen nur mit Würdigungsrecht, Maskierung im Service)
  // ---------------------------------------------------------------------------

  it('vertraulich setzen: nur mit Würdigungsrecht; unverändert ohne Audit', async () => {
    const f = await neueFeststellung(w);
    for (const a of [A.hb, A.adminOhneBt, A.leser]) {
      expect(
        await fehlerVon(
          im(a, (ctx) =>
            setzeVertraulich(ctx, {
              mandantId: w.mandant,
              feststellungId: f.id,
              vertraulich: true,
            }),
          ),
        ),
      ).toMatchObject({ code: 'NICHT_BERECHTIGT', grund: 'WUERDIGEN' });
    }
    await expect(
      im(A.zbt, (ctx) =>
        setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: f.id, vertraulich: true }),
      ),
    ).resolves.toEqual({ id: f.id, vertraulich: true, geaendert: true });
    await expect(
      im(A.zbt, (ctx) =>
        setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: f.id, vertraulich: true }),
      ),
    ).resolves.toEqual({ id: f.id, vertraulich: true, geaendert: false });
    expect(await auditZahl(w, f.id, 'tcms.feststellung.vertraulich')).toBe(1);
  });

  it('vertraulich: Liste und Detail für Nicht-Beteiligte maskiert, für Beteiligte vollständig', async () => {
    const f = await neueFeststellung(w, {
      vertraulich: true,
      titel: 'Geheimer Titel zur Selbstanzeige',
    });
    await neueMassnahme(w, f.id, w.p.zbt);
    const liste = (a: Akteur) => im(a, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
    const fremd = (await liste(A.leser)).feststellungen.find((x) => x.id === f.id)!;
    expect(fremd).toMatchObject({ maskiert: true, vertraulich: true, nummer: f.nummer });
    expect(JSON.stringify(fremd)).not.toMatch(/Geheimer|Klarna|abstimmen/);
    const voll = (await liste(A.zbt)).feststellungen.find((x) => x.id === f.id)!;
    expect(voll).toMatchObject({ maskiert: false, titel: 'Geheimer Titel zur Selbstanzeige' });
    // Beteiligte über die Maßnahme / Erfassung: BT ohne Zuständigkeit, aber verantwortlich.
    await neueMassnahme(w, f.id, w.p.leser);
    expect((await liste(A.leser)).feststellungen.find((x) => x.id === f.id)).toMatchObject({
      maskiert: false,
    });

    const g = await neueFeststellung(w, {
      vertraulich: true,
      titel: 'Zweiter geheimer Titel',
      erfasstVon: w.p.zbt,
    });
    const detail = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: g.id }),
    );
    expect(detail).toEqual({
      maskiert: true,
      stand: '2026-10-16',
      historisch: false,
      id: g.id,
      nummer: g.nummer,
      vertraulich: true,
    });
    expect(FeststellungDetailSchema.parse(detail)).toEqual(detail);
    // Ein früher Stichtag legt den heutigen Inhalt nicht frei.
    const alt = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: g.id, stand: '2026-10-05' }),
    );
    expect(alt.maskiert).toBe(true);
    const offen = await im(A.zbt, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: g.id }),
    );
    expect(offen).toMatchObject({ maskiert: false, titel: 'Zweiter geheimer Titel' });
  });

  it('vertraulich heute, zum frühen Stichtag noch offen → historisches Detail trotzdem maskiert', async () => {
    const f = await neueFeststellung(w, {
      titel: 'Heute vertraulich gesetzt',
      erfasstVon: w.p.zbt,
    });
    await im(A.zbt, (ctx) =>
      setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: f.id, vertraulich: true }),
    );
    const damals = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id, stand: '2026-10-10' }),
    );
    expect(damals).toMatchObject({ maskiert: true });
    expect(JSON.stringify(damals)).not.toMatch(/Heute vertraulich/);
  });

  it('vertraulich zum Stichtag: damals vertraulich, heute offen → im historischen Detail maskiert', async () => {
    // Anlage als vertraulich, danach (Audit mit echter Zeit, nach dem Stichtag) aufgehoben.
    const f = await neueFeststellung(w, {
      vertraulich: true,
      titel: 'Früher vertraulich',
      erfasstVon: w.p.zbt,
    });
    await im(A.zbt, (ctx) =>
      setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: f.id, vertraulich: false }),
    );
    const heute = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id }),
    );
    expect(heute).toMatchObject({
      maskiert: false,
      vertraulich: false,
      titel: 'Früher vertraulich',
    });
    const damals = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id, stand: '2026-10-10' }),
    );
    expect(damals).toMatchObject({ maskiert: true, historisch: true });
    expect(JSON.stringify(damals)).not.toMatch(/Früher vertraulich/);
    // Beteiligte sehen auch den historischen Stand.
    const bt = await im(A.zbt, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id, stand: '2026-10-10' }),
    );
    expect(bt).toMatchObject({ maskiert: false, vertraulich: true });
  });

  // ---------------------------------------------------------------------------
  // Lesen
  // ---------------------------------------------------------------------------

  it('Liste und Detail: vertragskonform (JSON, ISO-Daten), fremder Tenant → NICHT_GEFUNDEN', async () => {
    const f = await neueFeststellung(w, { status: 'MASSNAHMEN_OFFEN' });
    await neueMassnahme(w, f.id, w.p.hb, 'ERLEDIGT');
    const liste = await im(A.leser, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
    expect(FeststellungListeSchema.parse(liste)).toEqual(liste);
    expect(liste.feststellungen.some((x) => x.id === f.id)).toBe(true);
    const detail = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id }),
    );
    expect(FeststellungDetailSchema.parse(detail)).toEqual(detail);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
    for (const a of [A.fremdTenant, A.leerTenant, A.ohneBezug, A.fremdBezug, A.gv, A.ohneRolle]) {
      expect(
        (await fehlerVon(im(a, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant })))).code,
      ).toBe('NICHT_GEFUNDEN');
    }
    // Stichtag vor der Erfassung: Feststellung existiert dort noch nicht.
    expect(
      (
        await fehlerVon(
          im(A.leser, (ctx) =>
            ladeFeststellung(ctx, {
              mandantId: w.mandant,
              feststellungId: f.id,
              stand: '2026-09-01',
            }),
          ),
        )
      ).code,
    ).toBe('NICHT_GEFUNDEN');
    // Strikte Eingabe: kein tenantId, kein historisch.
    for (const boese of [{ tenantId: w.tenantB }, { historisch: true }, { stand: '16.10.2026' }]) {
      expect(
        (
          await fehlerVon(
            im(A.leser, (ctx) =>
              ladeFeststellungen(ctx, { mandantId: w.mandant, ...boese } as never),
            ),
          )
        ).code,
      ).toBe('UNGUELTIG');
    }
  });

  // ---------------------------------------------------------------------------
  // Erfassen (TS-04) und gemeinsamer Anlage-Helfer
  // ---------------------------------------------------------------------------

  it('TS-04 erfassen: „NEIN" ohne Würdigungsrecht wird „UNKLAR" (Audit nennt die Angabe), mit Recht „NEIN"', async () => {
    const erfasse = (a: Akteur) =>
      im(a, (ctx) =>
        erfasseFeststellung(ctx, {
          mandantId: w.mandant,
          titel: 'Rundungsdifferenz OSS',
          sachverhalt: 'Rundungsdifferenz in der OSS-Meldung, Betrag unter Toleranz.',
          quelle: 'STICHPROBE',
          quelleText: 'Stichprobe Oktober',
          klasse: 'HINWEIS',
          schwere: 'GERING',
          auswirkung: 'NEIN',
          risikoIds: [w.risiko],
        }),
      );
    for (const a of [A.hb, A.adminOhneBt]) {
      const r = await erfasse(a);
      expect(r).toMatchObject({ auswirkung: 'UNKLAR', auswirkungHerabgestuft: true });
      const audit = await inTenant(w, (tx) =>
        tx.auditEvent.findFirstOrThrow({
          where: { objektId: r.id, aktion: 'tcms.feststellung.erfasst' },
        }),
      );
      expect(audit.detail).toMatchObject({
        auswirkung: 'UNKLAR',
        auswirkungAngegeben: 'NEIN',
        manuell: true,
      });
    }
    await expect(erfasse(A.zbt)).resolves.toMatchObject({
      auswirkung: 'NEIN',
      auswirkungHerabgestuft: false,
    });
    expect(await fehlerVon(erfasse(A.leser))).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      grund: 'BEARBEITEN',
    });
  });

  it('erfassen: Risiken und Durchführung anderer Mandanten → NICHT_GEFUNDEN; Durchführung nur bei Quelle Kontrolle', async () => {
    const basis = {
      mandantId: w.mandant,
      titel: 'Belegfehler Marktplatz',
      sachverhalt: 'Marktplatzbelege ohne Leistungsdatum im Zeitraum August.',
      quelle: 'KONTROLLE' as const,
      quelleText: 'K-EC-02 Q3',
      klasse: 'DURCHFUEHRUNGSMANGEL' as const,
      schwere: 'MITTEL' as const,
      auswirkung: 'JA' as const,
    };
    const erfasse = (
      x: Partial<typeof basis> & { risikoIds?: string[]; durchfuehrungId?: string },
    ) => im(A.hb, (ctx) => erfasseFeststellung(ctx, { ...basis, ...x }));
    expect((await fehlerVon(erfasse({ risikoIds: [w.risiko, w.risikoFremd] }))).code).toBe(
      'NICHT_GEFUNDEN',
    );
    expect((await fehlerVon(erfasse({ durchfuehrungId: w.durchfuehrungFremd }))).code).toBe(
      'NICHT_GEFUNDEN',
    );
    expect(
      (await fehlerVon(erfasse({ quelle: 'HINWEIS' as never, durchfuehrungId: w.durchfuehrung })))
        .code,
    ).toBe('UNGUELTIG');
    expect((await fehlerVon(erfasse({ risikoIds: [w.risiko, w.risiko] }))).code).toBe('UNGUELTIG');
    const ok = await erfasse({ durchfuehrungId: w.durchfuehrung, risikoIds: [w.risiko] });
    const f = await inTenant(w, (tx) =>
      tx.feststellung.findUniqueOrThrow({ where: { id: ok.id }, include: { risiken: true } }),
    );
    expect(f).toMatchObject({
      durchfuehrungId: w.durchfuehrung,
      erfasstVon: w.p.hb,
      status: 'ERFASST',
    });
    expect(f.risiken.map((r) => r.risikoId)).toEqual([w.risiko]);
  });

  it('TS-05 erfassen: gleichzeitige Erfassungen erhalten verschiedene Nummern', async () => {
    const erfasse = () =>
      im(A.hb, (ctx) =>
        erfasseFeststellung(ctx, {
          mandantId: w.mandant,
          titel: 'Parallel erfasst',
          sachverhalt: 'Zwei Personen erfassen gleichzeitig eine Feststellung.',
          quelle: 'HINWEIS',
          quelleText: 'Hinweis',
          klasse: 'HINWEIS',
          schwere: 'GERING',
          auswirkung: 'UNKLAR',
        }),
      );
    const [a, b] = await Promise.all([erfasse(), erfasse()]);
    expect(a.nummer).not.toBe(b.nummer);
  });

  it('legeFeststellungAn (gemeinsamer Weg, auch für die Gegenzeichnung): TS-04 im Helfer', async () => {
    const lege = (a: Akteur) =>
      im(a, async (ctx) => {
        const r = await legeFeststellungAn(ctx, new Date('2026-10-16T10:00:00Z'), {
          mandantId: w.mandant,
          programmId: w.programm,
          titel: 'Befund aus Gegenzeichnung',
          sachverhalt: 'Kennzahl außerhalb der Toleranz.',
          quelle: 'KONTROLLE',
          quelleText: 'K-EC-02 Q3 2026',
          durchfuehrungId: w.durchfuehrung,
          klasse: 'DURCHFUEHRUNGSMANGEL',
          schwere: 'MITTEL',
          auswirkung: 'NEIN',
          risikoIds: [w.risiko],
        });
        return r;
      });
    expect(await lege(A.hb)).toMatchObject({ auswirkung: 'UNKLAR', auswirkungHerabgestuft: true });
    expect(await lege(A.zbt)).toMatchObject({ auswirkung: 'NEIN', auswirkungHerabgestuft: false });
    // Fremde Durchführung/Risiken auch im Helfer abgewiesen.
    const e = await fehlerVon(
      im(A.zbt, (ctx) =>
        legeFeststellungAn(ctx, new Date(), {
          mandantId: w.mandant,
          programmId: w.programm,
          titel: 'x'.repeat(10),
          sachverhalt: 'y'.repeat(25),
          quelle: 'KONTROLLE',
          quelleText: 'K',
          durchfuehrungId: w.durchfuehrungFremd,
          klasse: 'HINWEIS',
          schwere: 'GERING',
          auswirkung: 'JA',
        }),
      ),
    );
    expect(e).toBeInstanceOf(DienstFehler);
    expect(e.code).toBe('NICHT_GEFUNDEN');
  });
});
