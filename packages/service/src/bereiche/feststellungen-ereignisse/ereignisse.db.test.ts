// =============================================================================
// Ereigniseingang, Triage und Portal-Meldung gegen PostgreSQL (DB_TESTS=1):
// Rechte je Operation, Mandanten- und Tenant-Trennung, TS-04 auf dem Weg
// „Folge → Feststellung", Vier-Augen beim Verwerfen (Antragsteller aus der
// gesperrten Zeile), TS-05 bei gleichzeitigen Übergängen, Anlagen nur als
// Verweise (TS-09) und Audit je Änderung.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EreignisDetailSchema,
  EreignisListeSchema,
  PortalMeldungenSchema,
  type Akteur,
  type AnlageVerweis,
} from '@tcms/contract';
import { schreibeAudit } from '@tcms/db';
import type { DienstKontext } from '../../kontext';
import {
  beantrageEreignisVerwerfen,
  bestaetigeEreignisVerwerfen,
  erfasseEreignis,
  erledigeFolge,
  fuegeFolgeHinzu,
  legeEreignisAn,
  legeFolgenAn,
  lehneEreignisVerwerfenAb,
  nehmeEreignisInPruefung,
  schliesseEreignisAb,
  verwerfeFolge,
} from './ereignisse';
import { ladeEreignis, ladeEreignisAnlage, ladeEreignisse } from './ereignisse-lesen';
import { ladePortalMeldungen, meldeEreignis } from './portal';
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
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Meldung betrifft einen anderen Mandanten, irrtümlich gemeldet.';

describe.skipIf(!AKTIV)('Ereignisse gegen PostgreSQL', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    await aufwaermen(w);
  });

  /** Ereignis mit Katalogfolgen (T-02: Profil, Risiko EC-UST-05, Kontrolle K-EC-02 …). */
  async function neuesEreignis(typ = 'T-02', programmId = w.programm, tenant = w.tenant) {
    return inTenant(
      w,
      async (tx) => {
        const e = await legeEreignisAn(tx, {
          programmId,
          typ,
          titel: 'Neues Lager in Tschechien',
          beschreibung: 'Seit September Lager bei einem Fulfillment-Dienstleister in Prag.',
          quelle: 'MANUELL',
          gemeldetVon: w.p.hb,
          ereignisDatum: new Date('2026-09-01T00:00:00Z'),
          zeitpunkt: new Date('2026-10-02T09:00:00Z'),
        });
        const folgen = await tx.ereignisFolge.findMany({
          where: { ereignisId: e.id },
          orderBy: { id: 'asc' },
        });
        return { ...e, folgenListe: folgen };
      },
      tenant,
    );
  }

  /** Folge einer bestimmten Art an ein Ereignis hängen (als Vorschlag). */
  async function folgeAn(
    ereignisId: string,
    art: 'HINWEIS' | 'FESTSTELLUNG_ANLEGEN' | 'RISIKO_NEU_BEWERTEN' | 'KONTROLLE_AUSSERPLANMAESSIG',
    ziel: string | null = null,
    tenant = w.tenant,
  ) {
    return inTenant(
      w,
      (tx) => tx.ereignisFolge.create({ data: { ereignisId, art, ziel, text: 'Vorschlag' } }),
      tenant,
    );
  }

  // ---------------------------------------------------------------------------
  // Zugriff für alle Operationen
  // ---------------------------------------------------------------------------

  type Op = {
    name: string;
    lauf: (ctx: DienstKontext, ereignisId: string, folgeId: string) => Promise<unknown>;
  };
  const ops: Op[] = [
    {
      name: 'in Prüfung',
      lauf: (ctx, id) => nehmeEreignisInPruefung(ctx, { mandantId: w.mandant, ereignisId: id }),
    },
    {
      name: 'Folgen anlegen',
      lauf: (ctx, id, fid) =>
        legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: id, folgen: [{ folgeId: fid }] }),
    },
    {
      name: 'Folge hinzufügen',
      lauf: (ctx, id) =>
        fuegeFolgeHinzu(ctx, {
          mandantId: w.mandant,
          ereignisId: id,
          art: 'HINWEIS',
          text: 'Prüfen lassen',
        }),
    },
    {
      name: 'Folge erledigen',
      lauf: (ctx, id, fid) =>
        erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: id, folgeId: fid }),
    },
    {
      name: 'Folge verwerfen',
      lauf: (ctx, id, fid) =>
        verwerfeFolge(ctx, {
          mandantId: w.mandant,
          ereignisId: id,
          folgeId: fid,
          begruendung: BEGRUENDUNG,
        }),
    },
    {
      name: 'abschließen',
      lauf: (ctx, id) => schliesseEreignisAb(ctx, { mandantId: w.mandant, ereignisId: id }),
    },
    {
      name: 'Verwerfen beantragen',
      lauf: (ctx, id) =>
        beantrageEreignisVerwerfen(ctx, {
          mandantId: w.mandant,
          ereignisId: id,
          begruendung: BEGRUENDUNG,
        }),
    },
    {
      name: 'Verwerfen bestätigen',
      lauf: (ctx, id) => bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: id }),
    },
    {
      name: 'Verwerfen ablehnen',
      lauf: (ctx, id) => lehneEreignisVerwerfenAb(ctx, { mandantId: w.mandant, ereignisId: id }),
    },
    {
      name: 'Detail',
      lauf: (ctx, id) => ladeEreignis(ctx, { mandantId: w.mandant, ereignisId: id }),
    },
    {
      name: 'Anlage',
      lauf: (ctx, id) =>
        ladeEreignisAnlage(ctx, { mandantId: w.mandant, ereignisId: id, sha256: 'a'.repeat(64) }),
    },
  ];

  for (const op of ops) {
    it(`${op.name}: ohne Bezug, fremder Mandant/Tenant, Mandantenkontakte, fremde Objekt-IDs → NICHT_GEFUNDEN`, async () => {
      const e = await neuesEreignis();
      const f = await folgeAn(e.id, 'HINWEIS');
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
        const x = await fehlerVon(im(a, (ctx) => op.lauf(ctx, e.id, f.id)));
        expect(x.code, `${op.name} als ${a.art} ${a.id}`).toBe('NICHT_GEFUNDEN');
        expect(x.message).toBe('NICHT_GEFUNDEN');
      }
      // Ereignis eines anderen Mandanten (selber Tenant) bzw. fremden Tenants, unbekannte ID.
      const fremd = await neuesEreignis('T-02', w.programmFremd);
      const ff = await folgeAn(fremd.id, 'HINWEIS');
      const b = await neuesEreignis('T-02', w.programmB, w.tenantB);
      for (const [eid, fid] of [
        [fremd.id, ff.id],
        [b.id, b.folgenListe[0]!.id],
        ['cunbekannt000000000000000', 'cunbekannt000000000000001'],
        // Folge eines anderen Ereignisses (anderer Mandant) unter dem eigenen Ereignis.
        ...(['Folgen anlegen', 'Folge erledigen', 'Folge verwerfen'].includes(op.name)
          ? [[e.id, ff.id]]
          : []),
      ] as const) {
        const x = await fehlerVon(im(A.admin, (ctx) => op.lauf(ctx, eid, fid)));
        expect(x.code, `${op.name} mit ${eid}/${fid}`).toBe('NICHT_GEFUNDEN');
      }
      expect(await auditZahl(w, fremd.id)).toBe(0);
      expect(await auditZahl(w, e.id)).toBe(0);
    });
  }

  it('Lesezugriff ohne Bearbeitungsrecht → NICHT_BERECHTIGT mit Grund, keine Änderung', async () => {
    const e = await neuesEreignis();
    const f = await folgeAn(e.id, 'HINWEIS');
    for (const op of ops.filter((o) => o.name !== 'Detail' && o.name !== 'Anlage')) {
      const x = await fehlerVon(im(A.leser, (ctx) => op.lauf(ctx, e.id, f.id)));
      expect(x.code, op.name).toBe('NICHT_BERECHTIGT');
      expect(x.grund, op.name).toBe('BEARBEITEN');
      expect(x.message).toBe('Dieser Schritt ist zuständigen Personen vorbehalten.');
    }
    expect(await auditZahl(w, e.id)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // In Prüfung nehmen
  // ---------------------------------------------------------------------------

  it('in Prüfung: NEU → IN_TRIAGE mit Audit; gleichzeitig → genau einmal', async () => {
    const e = await neuesEreignis();
    const nimm = () =>
      im(A.hb, (ctx) => nehmeEreignisInPruefung(ctx, { mandantId: w.mandant, ereignisId: e.id }));
    expect(genauEinerKonflikt(await gleichzeitig(nimm, nimm))).toBe(true);
    const x = await inTenant(w, (tx) => tx.ereignis.findUniqueOrThrow({ where: { id: e.id } }));
    expect(x).toMatchObject({ status: 'IN_TRIAGE', triagiertVon: w.p.hb });
    expect(await auditZahl(w, e.id, 'tcms.ereignis.in_triage')).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Folgen anlegen
  // ---------------------------------------------------------------------------

  it('TS-04 Folge „Feststellung anlegen": „NEIN" ohne Würdigungsrecht wird „UNKLAR", mit Recht „NEIN"', async () => {
    for (const [a, erwartet] of [
      [A.hb, 'UNKLAR'],
      [A.adminOhneBt, 'UNKLAR'],
      [A.zbt, 'NEIN'],
    ] as const) {
      const e = await neuesEreignis();
      const f = await folgeAn(e.id, 'FESTSTELLUNG_ANLEGEN');
      const r = await im(a, (ctx) =>
        legeFolgenAn(ctx, {
          mandantId: w.mandant,
          ereignisId: e.id,
          folgen: [
            {
              folgeId: f.id,
              feststellung: {
                titel: 'Lager ohne Registrierung',
                klasse: 'STEUERLICHER_FEHLER',
                schwere: 'HOCH',
                auswirkung: 'NEIN',
              },
            },
          ],
        }),
      );
      const angelegt = r.folgen[0]!;
      expect(angelegt).toMatchObject({
        status: 'ERLEDIGT',
        auswirkungHerabgestuft: erwartet === 'UNKLAR',
      });
      const fs = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: angelegt.objektId! } }),
      );
      expect(fs).toMatchObject({
        auswirkung: erwartet,
        quelle: 'EREIGNIS',
        ereignisId: e.id,
        programmId: w.programm,
        erfasstVon: a.id,
      });
      expect(await auditZahl(w, fs.id, 'tcms.feststellung.erfasst')).toBe(1);
    }
  });

  it('Folgen anlegen: Risiko markieren, Kontrolle einplanen, Triage-Start und Audit je Folge', async () => {
    const e = await neuesEreignis('T-02');
    const r = await folgeAn(e.id, 'RISIKO_NEU_BEWERTEN', 'EC-UST-02');
    const k = await folgeAn(e.id, 'KONTROLLE_AUSSERPLANMAESSIG', 'K-EC-02');
    const ergebnis = await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        folgen: [
          { folgeId: r.id, zustaendig: { id: w.p.ma, art: 'MANDANT' } },
          { folgeId: k.id, frist: '2026-11-30', zustaendig: { id: w.p.leser, art: 'KANZLEI' } },
        ],
      }),
    );
    expect(ergebnis.folgen.map((f) => f.status)).toEqual(['ANGELEGT', 'ANGELEGT']);
    const [risiko, folgeK, ereignis] = await inTenant(
      w,
      async (tx) =>
        [
          await tx.risiko.findUniqueOrThrow({ where: { id: w.risiko } }),
          await tx.ereignisFolge.findUniqueOrThrow({ where: { id: k.id } }),
          await tx.ereignis.findUniqueOrThrow({ where: { id: e.id } }),
        ] as const,
    );
    expect(risiko.neuBewerten).toBe(true);
    expect(folgeK).toMatchObject({ status: 'ANGELEGT', zustaendig: w.p.leser });
    expect(ereignis.status).toBe('IN_TRIAGE');
    expect(await auditZahl(w, r.id, 'tcms.ereignis.folge_angelegt')).toBe(1);
    expect(await auditZahl(w, folgeK.objektId!, 'tcms.durchfuehrung.ausserplanmaessig')).toBe(1);
  });

  it('Folgen anlegen: ungültige Angaben → UNGUELTIG ohne Änderung', async () => {
    const e = await neuesEreignis();
    const k = await folgeAn(e.id, 'KONTROLLE_AUSSERPLANMAESSIG', 'K-EC-02');
    const fs = await folgeAn(e.id, 'FESTSTELLUNG_ANLEGEN');
    const h = await folgeAn(e.id, 'HINWEIS');
    const inaktiv = await folgeAn(e.id, 'RISIKO_NEU_BEWERTEN', 'EC-UST-13');
    for (const folgen of [
      [{ folgeId: k.id }], // ohne Frist
      [{ folgeId: k.id, frist: '2026-10-01' }], // Frist in der Vergangenheit
      [{ folgeId: fs.id }], // ohne Feststellungsangaben
      [{ folgeId: h.id, zustaendig: { id: w.p.ohneRolle, art: 'MANDANT' as const } }],
      [{ folgeId: h.id, zustaendig: { id: w.p.gvFremd, art: 'MANDANT' as const } }],
      [{ folgeId: inaktiv.id }],
      [{ folgeId: h.id }, { folgeId: h.id }], // doppelt
    ]) {
      const x = await fehlerVon(
        im(A.hb, (ctx) => legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: e.id, folgen })),
      );
      expect(x.code, JSON.stringify(folgen)).toBe('UNGUELTIG');
    }
    expect(await auditZahl(w, e.id)).toBe(0);
  });

  it('TS-05 Folgen anlegen: dieselbe Folge gleichzeitig → genau einmal (eine Feststellung)', async () => {
    for (let runde = 0; runde < 3; runde++) {
      const e = await neuesEreignis();
      const f = await folgeAn(e.id, 'FESTSTELLUNG_ANLEGEN');
      // Bereits in Triage: Nur die Übernahme der Folge selbst schützt (nicht der Triage-Start).
      await im(A.hb, (ctx) =>
        nehmeEreignisInPruefung(ctx, { mandantId: w.mandant, ereignisId: e.id }),
      );
      const lege = () =>
        im(A.hb, (ctx) =>
          legeFolgenAn(ctx, {
            mandantId: w.mandant,
            ereignisId: e.id,
            folgen: [
              {
                folgeId: f.id,
                feststellung: {
                  titel: 'Lager ohne Registrierung',
                  klasse: 'HINWEIS',
                  schwere: 'GERING',
                  auswirkung: 'UNKLAR',
                },
              },
            ],
          }),
        );
      expect(genauEinerKonflikt(await gleichzeitig(lege, lege)), `Runde ${runde}`).toBe(true);
      expect(
        await inTenant(w, (tx) => tx.feststellung.count({ where: { ereignisId: e.id } })),
      ).toBe(1);
      expect(await auditZahl(w, f.id, 'tcms.ereignis.folge_angelegt')).toBe(1);
    }
  });

  // ---------------------------------------------------------------------------
  // Folge hinzufügen, erledigen, verwerfen
  // ---------------------------------------------------------------------------

  it('Folge hinzufügen: Code je Art Pflicht; angelegt als Vorschlag mit Audit', async () => {
    const e = await neuesEreignis();
    const fuege = (
      art: 'RISIKO_NEU_BEWERTEN' | 'KONTROLLE_AUSSERPLANMAESSIG' | 'HINWEIS',
      ziel?: string,
    ) =>
      im(A.hb, (ctx) =>
        fuegeFolgeHinzu(ctx, {
          mandantId: w.mandant,
          ereignisId: e.id,
          art,
          ziel,
          text: 'Länder-Monitor ergänzen',
        }),
      );
    expect((await fehlerVon(fuege('RISIKO_NEU_BEWERTEN'))).code).toBe('UNGUELTIG');
    expect((await fehlerVon(fuege('KONTROLLE_AUSSERPLANMAESSIG', 'EC-UST-02'))).code).toBe(
      'UNGUELTIG',
    );
    const r = await fuege('RISIKO_NEU_BEWERTEN', 'ec-ust-02');
    const f = await inTenant(w, (tx) =>
      tx.ereignisFolge.findUniqueOrThrow({ where: { id: r.id } }),
    );
    expect(f).toMatchObject({ status: 'VORGESCHLAGEN', ziel: 'EC-UST-02', ereignisId: e.id });
    expect(await auditZahl(w, r.id, 'tcms.ereignis.folge_hinzugefuegt')).toBe(1);
  });

  it('Folge erledigen: zuständige Person ohne Bearbeitungsrecht darf; Markierung frei; doppelt → KONFLIKT', async () => {
    const e = await neuesEreignis();
    const r = await folgeAn(e.id, 'RISIKO_NEU_BEWERTEN', 'EC-UST-02');
    const h = await folgeAn(e.id, 'HINWEIS');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        folgen: [
          { folgeId: r.id, zustaendig: { id: w.p.leser, art: 'KANZLEI' } },
          { folgeId: h.id },
        ],
      }),
    );
    // Andere angelegte Folgen desselben Risikos dürfen nicht stören: Testwelt-Risiko frisch markiert.
    const erledige = (a: Akteur, fid: string) => () =>
      im(a, (ctx) => erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: e.id, folgeId: fid }));
    expect(await fehlerVon(erledige(A.leser, h.id)())).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      grund: 'BEARBEITEN',
    });
    expect(
      genauEinerKonflikt(await gleichzeitig(erledige(A.leser, r.id), erledige(A.hb, r.id))),
    ).toBe(true);
    expect(await auditZahl(w, r.id, 'tcms.ereignis.folge_erledigt')).toBe(1);
    const offen = await inTenant(w, (tx) =>
      tx.ereignisFolge.count({
        where: {
          objektId: w.risiko,
          status: 'ANGELEGT',
          art: { in: ['RISIKO_NEU_BEWERTEN', 'RISIKO_AKTIVIEREN'] },
        },
      }),
    );
    const risiko = await inTenant(w, (tx) =>
      tx.risiko.findUniqueOrThrow({ where: { id: w.risiko } }),
    );
    expect(risiko.neuBewerten).toBe(offen > 0);
  });

  it('Folge erledigen: außerplanmäßige Kontrolle erst nach Abschluss', async () => {
    const e = await neuesEreignis();
    const k = await folgeAn(e.id, 'KONTROLLE_AUSSERPLANMAESSIG', 'K-EC-02');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        folgen: [{ folgeId: k.id, frist: '2026-11-30' }],
      }),
    );
    const erledige = () =>
      im(A.hb, (ctx) =>
        erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: e.id, folgeId: k.id }),
      );
    expect((await fehlerVon(erledige())).code).toBe('KONFLIKT');
    const d = await inTenant(w, (tx) =>
      tx.ereignisFolge.findUniqueOrThrow({ where: { id: k.id } }),
    );
    await inTenant(w, (tx) =>
      tx.durchfuehrung.update({ where: { id: d.objektId! }, data: { status: 'OHNE_BEFUND' } }),
    );
    await expect(erledige()).resolves.toEqual({ id: k.id, status: 'ERLEDIGT' });
  });

  it('Folge verwerfen: begründet, mit Audit; angelegte Feststellung nicht; gleichzeitig → genau einmal', async () => {
    const e = await neuesEreignis();
    const verwerfe = (fid: string) => () =>
      im(A.hb, (ctx) =>
        verwerfeFolge(ctx, {
          mandantId: w.mandant,
          ereignisId: e.id,
          folgeId: fid,
          begruendung: BEGRUENDUNG,
        }),
      );
    for (let runde = 0; runde < 3; runde++) {
      const h = await folgeAn(e.id, 'HINWEIS');
      expect(
        genauEinerKonflikt(await gleichzeitig(verwerfe(h.id), verwerfe(h.id))),
        `Runde ${runde}`,
      ).toBe(true);
      expect(await auditZahl(w, h.id, 'tcms.ereignis.folge_verworfen')).toBe(1);
    }
    const fs = await folgeAn(e.id, 'FESTSTELLUNG_ANLEGEN');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        folgen: [
          {
            folgeId: fs.id,
            feststellung: {
              titel: 'Feststellung aus Ereignis',
              klasse: 'HINWEIS',
              schwere: 'GERING',
              auswirkung: 'JA',
            },
          },
        ],
      }),
    );
    expect((await fehlerVon(verwerfe(fs.id)())).code).toBe('KONFLIKT');
  });

  // ---------------------------------------------------------------------------
  // Abschließen und Verwerfen des Ereignisses
  // ---------------------------------------------------------------------------

  it('abschließen: erst wenn jede Folge erledigt oder verworfen und mindestens eine erledigt ist', async () => {
    const e = await neuesEreignis('SONST');
    const [hinweis] = e.folgenListe;
    const schliesse = () =>
      im(A.hb, (ctx) => schliesseEreignisAb(ctx, { mandantId: w.mandant, ereignisId: e.id }));
    expect((await fehlerVon(schliesse())).code).toBe('KONFLIKT');
    await im(A.hb, (ctx) =>
      verwerfeFolge(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        folgeId: hinweis!.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    expect((await fehlerVon(schliesse())).message).toMatch(/zweite Person/);
    const h = await folgeAn(e.id, 'HINWEIS');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: e.id, folgen: [{ folgeId: h.id }] }),
    );
    await im(A.hb, (ctx) =>
      erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: e.id, folgeId: h.id }),
    );
    await expect(schliesse()).resolves.toMatchObject({ status: 'ERLEDIGT' });
    expect((await fehlerVon(schliesse())).code).toBe('KONFLIKT');
    expect(await auditZahl(w, e.id, 'tcms.ereignis.abgeschlossen')).toBe(1);
  });

  it('Rechte im Detail (abschließen, Verwerfen beantragen/bestätigen) = Ergebnis der Operation', async () => {
    type Schritt = 'abschliessen' | 'beantragen' | 'bestaetigen';
    const op = (schritt: Schritt, a: Akteur, ereignisId: string) =>
      im(a, (ctx) => {
        const z = { mandantId: w.mandant, ereignisId };
        if (schritt === 'abschliessen') return schliesseEreignisAb(ctx, z);
        if (schritt === 'beantragen')
          return beantrageEreignisVerwerfen(ctx, { ...z, begruendung: BEGRUENDUNG });
        return bestaetigeEreignisVerwerfen(ctx, z);
      });
    /** Liest das Kennzeichen, führt den Schritt aus und vergleicht: erlaubt ⇔ Erfolg, sonst 403 mit Grund bzw. 409. */
    const vergleiche = async (schritt: Schritt, a: Akteur, ereignisId: string) => {
      const d = await im(a, (ctx) => ladeEreignis(ctx, { mandantId: w.mandant, ereignisId }));
      expect(EreignisDetailSchema.parse(d)).toEqual(d);
      const recht =
        schritt === 'abschliessen'
          ? d.rechte.abschliessen
          : schritt === 'beantragen'
            ? d.rechte.verwerfen.beantragen
            : d.rechte.verwerfen.bestaetigen;
      if (recht.erlaubt) {
        await expect(op(schritt, a, ereignisId)).resolves.toBeTruthy();
      } else {
        const f = await fehlerVon(op(schritt, a, ereignisId));
        if (recht.verweigerung) {
          expect(f, schritt).toMatchObject({ code: 'NICHT_BERECHTIGT', grund: recht.verweigerung });
        } else expect(f.code, schritt).toBe('KONFLIKT');
      }
      return recht;
    };

    // Neues Ereignis (offene Vorschläge): abschließen nur Zustand, Leser ohne Recht.
    const e = await neuesEreignis();
    expect(await vergleiche('abschliessen', A.leser, e.id)).toEqual({
      erlaubt: false,
      verweigerung: 'BEARBEITEN',
    });
    expect(await vergleiche('abschliessen', A.hb, e.id)).toEqual({
      erlaubt: false,
      verweigerung: null,
    });
    expect(await vergleiche('bestaetigen', A.hb, e.id)).toEqual({
      erlaubt: false,
      verweigerung: null,
    });
    expect(await vergleiche('beantragen', A.leser, e.id)).toEqual({
      erlaubt: false,
      verweigerung: 'BEARBEITEN',
    });
    expect(await vergleiche('beantragen', A.hb, e.id)).toEqual({
      erlaubt: true,
      verweigerung: null,
    });
    // Antrag liegt vor: Antragsteller → VIER_AUGEN, zweite Person darf, erneut beantragen → Zustand.
    expect(await vergleiche('beantragen', A.zbt, e.id)).toEqual({
      erlaubt: false,
      verweigerung: null,
    });
    expect(await vergleiche('bestaetigen', A.hb, e.id)).toEqual({
      erlaubt: false,
      verweigerung: 'VIER_AUGEN',
    });
    expect(await vergleiche('bestaetigen', A.leser, e.id)).toEqual({
      erlaubt: false,
      verweigerung: 'BEARBEITEN',
    });
    expect(await vergleiche('bestaetigen', A.zbt, e.id)).toEqual({
      erlaubt: true,
      verweigerung: null,
    });
    // Verworfen: nichts mehr möglich, Recht vor Zustand.
    for (const s of ['abschliessen', 'beantragen', 'bestaetigen'] as const) {
      expect(await vergleiche(s, A.zbt, e.id), s).toEqual({ erlaubt: false, verweigerung: null });
      expect(await vergleiche(s, A.leser, e.id), s).toEqual({
        erlaubt: false,
        verweigerung: 'BEARBEITEN',
      });
    }

    // Abschließen erlaubt, sobald eine Folge erledigt und der Rest verworfen ist.
    const z = await neuesEreignis('SONST');
    const h = await folgeAn(z.id, 'HINWEIS');
    for (const f of z.folgenListe) {
      await im(A.hb, (ctx) =>
        verwerfeFolge(ctx, {
          mandantId: w.mandant,
          ereignisId: z.id,
          folgeId: f.id,
          begruendung: BEGRUENDUNG,
        }),
      );
    }
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: z.id, folgen: [{ folgeId: h.id }] }),
    );
    await im(A.hb, (ctx) =>
      erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: z.id, folgeId: h.id }),
    );
    expect(await vergleiche('abschliessen', A.hb, z.id)).toEqual({
      erlaubt: true,
      verweigerung: null,
    });

    // Historischer Stand: schreibgeschützt (weder erlaubt noch ein 403-Grund).
    const alt = await im(A.hb, (ctx) =>
      ladeEreignis(ctx, { mandantId: w.mandant, ereignisId: z.id, stand: '2026-10-10' }),
    );
    expect(alt.historisch).toBe(true);
    const nie = { erlaubt: false, verweigerung: null };
    expect(alt.rechte).toEqual({
      abschliessen: nie,
      verwerfen: { beantragen: nie, bestaetigen: nie },
    });
  });

  it('Verwerfen: Antragsteller (aus der Zeile) bestätigt nicht; zweite Person bestätigt, offene Vorschläge mit verworfen', async () => {
    const e = await neuesEreignis();
    await im(A.hb, (ctx) =>
      beantrageEreignisVerwerfen(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    expect(
      (
        await fehlerVon(
          im(A.hb, (ctx) =>
            beantrageEreignisVerwerfen(ctx, {
              mandantId: w.mandant,
              ereignisId: e.id,
              begruendung: BEGRUENDUNG,
            }),
          ),
        )
      ).code,
    ).toBe('KONFLIKT');
    const gross = { ...A.hb, id: A.hb.id.toUpperCase() } as Akteur;
    for (const a of [A.hb, gross]) {
      const x = await fehlerVon(
        im(a, (ctx) =>
          bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }),
        ),
      );
      expect(x).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'VIER_AUGEN',
        message: 'Die Bestätigung muss durch eine zweite Person erfolgen.',
      });
    }
    await expect(
      im(A.zbt, (ctx) =>
        bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }),
      ),
    ).resolves.toMatchObject({
      status: 'VERWORFEN',
    });
    const folgen = await inTenant(w, (tx) =>
      tx.ereignisFolge.findMany({ where: { ereignisId: e.id } }),
    );
    expect(folgen.every((f) => f.status === 'VERWORFEN')).toBe(true);
    const audit = await inTenant(w, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { objektId: e.id, aktion: 'tcms.ereignis.verwerfen_bestaetigt' },
      }),
    );
    expect(audit).toMatchObject({
      actorId: w.p.zbt,
      detail: expect.objectContaining({ beantragtVon: w.p.hb }),
    });
  });

  it('Verwerfen: Antragsteller steht in der Zeile; ein späterer Audit-Eintrag eines Dritten ändert nichts', async () => {
    const e = await neuesEreignis();
    await im(A.hb, (ctx) =>
      beantrageEreignisVerwerfen(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    expect(
      await inTenant(w, (tx) => tx.ereignis.findUniqueOrThrow({ where: { id: e.id } })),
    ).toMatchObject({ verwerfenBeantragtVon: w.p.hb });
    // Ein Audit-Eintrag „verwerfen_beantragt" einer anderen Person (z. B. Altbestand
    // oder Fehler) macht die antragstellende Person nicht zur zweiten Person.
    await inTenant(w, (tx) =>
      schreibeAudit(tx, {
        actorId: w.p.zbt,
        actorName: 'Dritte Person',
        aktion: 'tcms.ereignis.verwerfen_beantragt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: w.programm,
        detail: {},
      }),
    );
    const x = await fehlerVon(
      im(A.hb, (ctx) =>
        bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }),
      ),
    );
    expect([x.code, x.grund]).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);
    // Zurückziehen leert den Antrag samt Antragsteller.
    await im(A.hb, (ctx) =>
      lehneEreignisVerwerfenAb(ctx, { mandantId: w.mandant, ereignisId: e.id }),
    );
    expect(
      await inTenant(w, (tx) => tx.ereignis.findUniqueOrThrow({ where: { id: e.id } })),
    ).toMatchObject({ verwerfenBegruendung: null, verwerfenBeantragtVon: null });
  });

  it('TS-05 Verwerfen: zwei zweite Personen gleichzeitig → genau eine Bestätigung', async () => {
    const e = await neuesEreignis();
    await im(A.hb, (ctx) =>
      beantrageEreignisVerwerfen(ctx, {
        mandantId: w.mandant,
        ereignisId: e.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    const best = (a: Akteur) => () =>
      im(a, (ctx) => bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }));
    expect(genauEinerKonflikt(await gleichzeitig(best(A.zbt), best(A.admin)))).toBe(true);
    expect(await auditZahl(w, e.id, 'tcms.ereignis.verwerfen_bestaetigt')).toBe(1);
  });

  it('Verwerfen: nach Zurückziehen und neuem Antrag einer anderen Person zählt der neue Antragsteller', async () => {
    const e = await neuesEreignis();
    const beantrage = (a: Akteur) =>
      im(a, (ctx) =>
        beantrageEreignisVerwerfen(ctx, {
          mandantId: w.mandant,
          ereignisId: e.id,
          begruendung: BEGRUENDUNG,
        }),
      );
    await beantrage(A.hb);
    await expect(
      im(A.hb, (ctx) => lehneEreignisVerwerfenAb(ctx, { mandantId: w.mandant, ereignisId: e.id })),
    ).resolves.toEqual({
      id: e.id,
      zurueckgezogen: true,
    });
    await beantrage(A.zbt);
    // Jetzt ist hb die zweite Person, zbt nicht mehr.
    expect(
      (
        await fehlerVon(
          im(A.zbt, (ctx) =>
            bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }),
          ),
        )
      ).code,
    ).toBe('NICHT_BERECHTIGT');
    await expect(
      im(A.hb, (ctx) =>
        bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e.id }),
      ),
    ).resolves.toMatchObject({
      status: 'VERWORFEN',
    });
  });

  it('Verwerfen beantragen: nicht mit angelegten Folgen', async () => {
    const e = await neuesEreignis();
    const h = await folgeAn(e.id, 'HINWEIS');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: e.id, folgen: [{ folgeId: h.id }] }),
    );
    expect(
      (
        await fehlerVon(
          im(A.hb, (ctx) =>
            beantrageEreignisVerwerfen(ctx, {
              mandantId: w.mandant,
              ereignisId: e.id,
              begruendung: BEGRUENDUNG,
            }),
          ),
        )
      ).code,
    ).toBe('KONFLIKT');
  });

  // ---------------------------------------------------------------------------
  // Ereignis erfassen
  // ---------------------------------------------------------------------------

  it('Ereignis erfassen: Katalogtyp mit Vorschlägen, Nummer je Tenant, Audit; Rechte', async () => {
    const erfasse = (a: Akteur, typ = 'T-05') =>
      im(a, (ctx) =>
        erfasseEreignis(ctx, {
          mandantId: w.mandant,
          typ,
          quelle: 'MANUELL',
          titel: 'USt-Sonderprüfung angekündigt',
          beschreibung: 'Prüfungsanordnung für Q2 2026 liegt vor.',
          datum: '2026-10-10',
        }),
      );
    const [a, b] = await Promise.all([erfasse(A.hb), erfasse(A.zbt)]);
    expect(a.nummer).not.toBe(b.nummer);
    expect(a.folgen).toBeGreaterThan(0);
    expect(await auditZahl(w, a.id, 'tcms.ereignis.erfasst')).toBe(1);
    expect((await fehlerVon(erfasse(A.hb, 'T-99'))).code).toBe('UNGUELTIG');
    expect((await fehlerVon(erfasse(A.hb, 'SONST'))).code).toBe('UNGUELTIG');
    for (const a of [A.leser]) {
      expect(await fehlerVon(erfasse(a))).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'BEARBEITEN',
      });
    }
    for (const a of [A.gv, A.ohneBezug, A.fremdBezug, A.leerTenant])
      expect((await fehlerVon(erfasse(a))).code).toBe('NICHT_GEFUNDEN');
  });

  // ---------------------------------------------------------------------------
  // Portal-Meldung (P3)
  // ---------------------------------------------------------------------------

  const anlage = (): AnlageVerweis => {
    const sha256 = randomBytes(32).toString('hex');
    return {
      dokumentId: `${sha256.slice(0, 2)}/${sha256}`,
      dateiname: 'Mietvertrag Lager.pdf',
      mime: 'application/pdf',
      groesse: 2048,
      sha256,
    };
  };
  const meldung = (x: Record<string, unknown> = {}) => ({
    mandantId: w.mandant,
    typ: 'T-02',
    titel: 'Neues Lager in Polen',
    beschreibung: 'Ab November lagern wir Ware in Posen.',
    datum: '2026-10-12',
    anlagen: [anlage()],
    zusageAenderungen: true,
    benachrichtigen: { id: w.p.hb, name: 'Leon Brandt' },
    ...x,
  });

  it('Portal: GV und TCB melden; Anlagen als Verweis im Audit, Nachricht an die genannte Kanzleiperson', async () => {
    for (const a of [A.gv, A.tcb]) {
      const eingabe = meldung();
      const r = await im(a, (ctx) => meldeEreignis(ctx, eingabe as never));
      const e = await inTenant(w, (tx) =>
        tx.ereignis.findUniqueOrThrow({ where: { id: r.id }, include: { folgen: true } }),
      );
      expect(e).toMatchObject({
        quelle: 'PORTAL',
        gemeldetVon: a.id,
        status: 'NEU',
        programmId: w.programm,
      });
      expect(e.folgen.length).toBeGreaterThan(0);
      const audit = await inTenant(w, (tx) =>
        tx.auditEvent.findFirstOrThrow({
          where: { objektId: r.id, aktion: 'tcms.ereignis.gemeldet' },
        }),
      );
      expect(audit.detail).toMatchObject({
        quelle: 'PORTAL',
        anlagen: eingabe.anlagen,
        benachrichtigt: w.p.hb,
      });
      const n = await inTenant(w, (tx) =>
        tx.nachricht.findFirstOrThrow({ where: { betreff: { contains: r.nummer } } }),
      );
      // TS-06: adressiert über die ID, nie über den mitgelieferten Namen.
      expect(n).toMatchObject({
        empfaengerId: w.p.hb,
        zweck: 'EREIGNIS_GEMELDET',
        mandantId: w.mandant,
        empfaengerArt: 'KANZLEI',
        code: null,
        daten: {
          ereignisId: r.id,
          nummer: r.nummer,
          titel: eingabe.titel,
          typ: expect.any(String),
          gemeldetVonId: a.id,
        },
      });
      expect(JSON.stringify(n)).not.toContain('Leon Brandt');
    }
    // Ohne genannte Person entsteht keine Nachricht (das Ereignis steht im Eingang).
    const ohne = await im(A.gv, (ctx) =>
      meldeEreignis(ctx, meldung({ benachrichtigen: null }) as never),
    );
    expect(
      await inTenant(w, (tx) =>
        tx.nachricht.count({ where: { betreff: { contains: ohne.nummer } } }),
      ),
    ).toBe(0);
  });

  it('Portal: Mitarbeitende und Kanzlei → NICHT_BERECHTIGT; ohne Rolle, fremder Mandant, fremder Tenant → NICHT_GEFUNDEN', async () => {
    for (const [a, grund] of [
      [A.ma, 'PORTAL_ROLLE'],
      [A.zbt, 'PARTEI'],
    ] as const) {
      const x = await fehlerVon(im(a, (ctx) => meldeEreignis(ctx, meldung() as never)));
      expect([x.code, x.grund]).toEqual(['NICHT_BERECHTIGT', grund]);
    }
    for (const a of [A.ohneRolle, A.gvFremd, A.ohneBezug, A.leerTenant]) {
      const x = await fehlerVon(im(a, (ctx) => meldeEreignis(ctx, meldung() as never)));
      expect(x.code, a.id).toBe('NICHT_GEFUNDEN');
    }
    // GV eines anderen Mandanten meldet für seinen eigenen Mandanten, nicht für diesen.
    const x = await fehlerVon(
      im(A.gv, (ctx) => meldeEreignis(ctx, meldung({ mandantId: w.fremd }) as never)),
    );
    expect(x.code).toBe('NICHT_GEFUNDEN');
  });

  it('Portal: ungültige Eingaben (Typ, Datum, Anlagen) → UNGUELTIG', async () => {
    const a = anlage();
    for (const x of [
      { typ: 'T-04' }, // nicht im Portal meldbar
      { datum: '2020-01-01' },
      { anlagen: [{ ...a, mime: 'text/html' }] },
      { anlagen: [{ ...a, groesse: 11 * 1024 * 1024 }] },
      { anlagen: [{ ...a, dokumentId: '../../etc/passwd' }] },
      { anlagen: [{ ...a, dateiname: 'rechnung\u202epdf.exe' }] },
      { anlagen: [a, a] },
      { anlagen: Array.from({ length: 6 }, anlage) },
      { anlagen: [{ ...a, inhalt: 'AAAA' }] },
      { titel: 'kurz' },
    ]) {
      const f = await fehlerVon(im(A.gv, (ctx) => meldeEreignis(ctx, meldung(x) as never)));
      expect(f.code, JSON.stringify(x).slice(0, 80)).toBe('UNGUELTIG');
    }
  });

  it('Portal-Meldungen lesen: alle aktiven Rollen des eigenen Mandanten, sonst NICHT_GEFUNDEN', async () => {
    const r = await im(A.gv, (ctx) => meldeEreignis(ctx, meldung() as never));
    for (const a of [A.ma, A.tcb, A.gv, A.leser]) {
      const l = await im(a, (ctx) => ladePortalMeldungen(ctx, { mandantId: w.mandant }));
      expect(PortalMeldungenSchema.parse(l)).toEqual(l);
      expect(l.meldungen.some((m) => m.id === r.id)).toBe(true);
    }
    for (const a of [A.ohneRolle, A.gvFremd, A.ohneBezug, A.leerTenant]) {
      expect(
        (await fehlerVon(im(a, (ctx) => ladePortalMeldungen(ctx, { mandantId: w.mandant })))).code,
      ).toBe('NICHT_GEFUNDEN');
    }
  });

  it('Portal-Meldungen lesen: Melderecht = Ergebnis von „Ereignis melden"; Programm vorhanden', async () => {
    const gesehen = new Set<boolean>();
    for (const [wer, a] of Object.entries({ gv: A.gv, tcb: A.tcb, ma: A.ma, leser: A.leser })) {
      const l = await im(a, (ctx) => ladePortalMeldungen(ctx, { mandantId: w.mandant }));
      expect(l.programmVorhanden, wer).toBe(true);
      let tatsaechlich = true;
      try {
        await im(a, (ctx) => meldeEreignis(ctx, meldung() as never));
      } catch (e) {
        expect((await fehlerVon(Promise.reject(e))).code, wer).toBe('NICHT_BERECHTIGT');
        tatsaechlich = false;
      }
      expect(l.melden, wer).toBe(tatsaechlich);
      gesehen.add(tatsaechlich);
    }
    expect(gesehen).toEqual(new Set([true, false]));
  });

  // ---------------------------------------------------------------------------
  // Lesen und Anlagen (TS-09)
  // ---------------------------------------------------------------------------

  it('Liste und Detail: vertragskonform, ohne Dokument-ID; Anlage nur über ladeEreignisAnlage', async () => {
    const eingabe = meldung();
    const r = await im(A.gv, (ctx) => meldeEreignis(ctx, eingabe as never));
    const liste = await im(A.leser, (ctx) => ladeEreignisse(ctx, { mandantId: w.mandant }));
    expect(EreignisListeSchema.parse(liste)).toEqual(liste);
    expect(liste.ereignisse.some((e) => e.id === r.id)).toBe(true);
    const detail = await im(A.leser, (ctx) =>
      ladeEreignis(ctx, { mandantId: w.mandant, ereignisId: r.id }),
    );
    expect(EreignisDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.anlagen).toEqual([
      {
        dateiname: 'Mietvertrag Lager.pdf',
        mime: 'application/pdf',
        groesse: 2048,
        sha256: eingabe.anlagen[0]!.sha256,
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain(eingabe.anlagen[0]!.dokumentId);
    const v = await im(A.leser, (ctx) =>
      ladeEreignisAnlage(ctx, {
        mandantId: w.mandant,
        ereignisId: r.id,
        sha256: eingabe.anlagen[0]!.sha256,
      }),
    );
    expect(v).toEqual(eingabe.anlagen[0]);
    // Anlage zur Meldung eines anderen Mandanten (gleicher Tenant) unter dem eigenen Mandanten.
    const fremdeMeldung = meldung({ mandantId: w.fremd });
    const rf = await im(A.gvFremd, (ctx) => meldeEreignis(ctx, fremdeMeldung as never));
    const fremdSha = fremdeMeldung.anlagen[0]!.sha256;
    expect(
      (
        await fehlerVon(
          im(A.leser, (ctx) =>
            ladeEreignisAnlage(ctx, { mandantId: w.mandant, ereignisId: rf.id, sha256: fremdSha }),
          ),
        )
      ).code,
    ).toBe('NICHT_GEFUNDEN');
    // Unbekannter Hash, Ereignis eines anderen Mandanten, Mandantenkontakt → NICHT_GEFUNDEN.
    const fremd = await neuesEreignis('T-02', w.programmFremd);
    for (const [a, eid, sha] of [
      [A.leser, r.id, 'b'.repeat(64)],
      [A.leser, fremd.id, eingabe.anlagen[0]!.sha256],
      [A.gv, r.id, eingabe.anlagen[0]!.sha256],
    ] as const) {
      expect(
        (
          await fehlerVon(
            im(a, (ctx) =>
              ladeEreignisAnlage(ctx, { mandantId: w.mandant, ereignisId: eid, sha256: sha }),
            ),
          )
        ).code,
      ).toBe('NICHT_GEFUNDEN');
    }
    expect(
      (
        await fehlerVon(
          im(A.leser, (ctx) =>
            ladeEreignisAnlage(ctx, { mandantId: w.mandant, ereignisId: r.id, sha256: 'ZZ' }),
          ),
        )
      ).code,
    ).toBe('UNGUELTIG');
  });

  it('Liste: fremde Tenants, ohne Bezug, Mandantenkontakte → NICHT_GEFUNDEN; Stichtag', async () => {
    for (const a of [A.fremdTenant, A.leerTenant, A.ohneBezug, A.fremdBezug, A.gv]) {
      expect(
        (await fehlerVon(im(a, (ctx) => ladeEreignisse(ctx, { mandantId: w.mandant })))).code,
      ).toBe('NICHT_GEFUNDEN');
    }
    const e = await neuesEreignis();
    const alt = await im(A.leser, (ctx) =>
      ladeEreignisse(ctx, { mandantId: w.mandant, stand: '2026-09-15' }),
    );
    expect(alt.historisch).toBe(true);
    expect(alt.ereignisse.some((x) => x.id === e.id)).toBe(false);
  });
});
