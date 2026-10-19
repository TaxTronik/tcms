// =============================================================================
// Lader der Kontrolldurchführung gegen PostgreSQL (DB_TESTS=1, DATABASE_URL =
// tcms_app): Kanzlei-Detail, Portal-Aufgabe, Aufgabenliste, Nachweis-Verweis.
// Rechte (TS-03) ohne Existenz-Orakel, Stichtag, Maskierung, JSON-Form.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DurchfuehrungDetailSchema,
  KontrollaufgabeSchema,
  KontrollaufgabenSchema,
  type Akteur,
} from '@tcms/contract';
import type { DienstKontext } from '../../kontext';
import {
  ladeDurchfuehrung,
  ladeKontrollaufgabe,
  ladeNachweis,
  listeKontrollaufgaben,
} from './lesen';
import {
  gegenzeichneDurchfuehrung,
  haengeNachweisAn,
  reicheDurchfuehrungEin,
  speichereDurchfuehrung,
  weiseDurchfuehrungZurueck,
} from './operationen';
import { akteure, baueFall, fehlerVon, PORTS, verweis, type Fall } from './testfall';
import { imDienst } from '../../kontext';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';
const SPEICHERN = {
  schritte: [
    { erledigt: true, kommentar: 'ok' },
    { erledigt: true, kommentar: '' },
  ],
  werte: [
    { key: 'saldoShop', wert: 100, bemerkung: '', erklaert: false },
    { key: 'saldoFibu', wert: 100, bemerkung: '', erklaert: false },
  ],
  ergebnis: 'MIT_BEFUND' as const,
  ergebnisKommentar: 'Differenz im Clearingkonto ungeklärt.',
};

describe.skipIf(!AKTIV)('Durchführung: Lader gegen PostgreSQL', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;
  /** K1, eingereicht mit Befund und gegengezeichnet (Feststellung), zuvor einmal zurückgewiesen. */
  let abgeschlossen = '';
  let nachweisId = '';
  /** K2 (Mandant), in Durchführung durch ma, mit einer Anlage. */
  let aufgabe = '';
  let anlageId = '';
  const ziel = (durchfuehrungId: string) => ({ mandantId: f.mandant, durchfuehrungId });

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
    abgeschlossen = await f.durchfuehrung('k1');
    await f.dienst(a.bearbeiter, (ctx) =>
      speichereDurchfuehrung(ctx, { ...ziel(abgeschlossen), ...SPEICHERN }),
    );
    const n = await f.dienst(a.bearbeiter, (ctx) =>
      haengeNachweisAn(ctx, { ...ziel(abgeschlossen), verweis: verweis() }),
    );
    nachweisId = n.nachweis.id;
    await f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(abgeschlossen)));
    await f.dienst(a.pruefer, (ctx) =>
      weiseDurchfuehrungZurueck(ctx, { ...ziel(abgeschlossen), begruendung: BEGRUENDUNG }),
    );
    await f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(abgeschlossen)));
    await f.dienst(a.pruefer, (ctx) =>
      gegenzeichneDurchfuehrung(ctx, {
        ...ziel(abgeschlossen),
        feststellung: {
          titel: 'Differenz Clearingkonto',
          sachverhalt: 'Das Clearingkonto weist eine ungeklärte Differenz aus.',
          klasse: 'DURCHFUEHRUNGSMANGEL',
          schwere: 'HOCH',
          auswirkung: 'UNKLAR',
          risikoIds: [f.risiko],
        },
      }),
    );
    aufgabe = await f.durchfuehrung('k2');
    const anl = await f.dienst(a.ma, (ctx) =>
      haengeNachweisAn(ctx, {
        ...ziel(aufgabe),
        verweis: verweis({ dateiname: 'Anlage.csv', mime: 'text/csv' }),
      }),
    );
    anlageId = anl.nachweis.id;
  });

  describe('ladeDurchfuehrung (Kanzlei, S8)', () => {
    it('liefert das Detail als JSON nach Vertrag: Nachweise, Verlauf, Feststellung, Risiken, Rechte', async () => {
      const d = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(abgeschlossen)));
      expect(DurchfuehrungDetailSchema.parse(d)).toEqual(d);
      expect(JSON.parse(JSON.stringify(d))).toEqual(d);
      expect(d.status).toBe('MIT_BEFUND');
      expect(d.mandantId).toBe(f.mandant);
      expect(d.kontrolle.code).toBe('K-T-01');
      expect(d.nachweise).toHaveLength(1);
      expect(d.nachweise[0]).not.toHaveProperty('tenantId');
      expect(d.feststellungen).toEqual([
        expect.objectContaining({ nummer: 'F-2026-001', titel: 'Differenz Clearingkonto' }),
      ]);
      expect(d.risiken).toEqual([{ id: f.risiko, code: 'R-UST-01', titel: 'Falscher Steuersatz' }]);
      expect(d.beteiligte).toEqual([f.p.bearbeiter].sort());
      expect(d.verlauf.map((v) => v.aktion)).toEqual(
        expect.arrayContaining([
          'tcms.durchfuehrung.begonnen',
          'tcms.durchfuehrung.zurueckgewiesen',
          'tcms.durchfuehrung.gegengezeichnet',
          'tcms.feststellung.erfasst',
          'system.faellig',
        ]),
      );
      // Personen nur als IDs; der Dienst kennt keine Namen.
      expect(d.namen).toEqual([]);
      expect(JSON.stringify(d)).not.toContain('Kanzleiperson');
      expect(d.zurueckgewiesenVon).toBe(f.p.pruefer);
      expect(d.rechte.nachtrag).toEqual({ erlaubt: true, grund: null });
      expect(d.rechte.gegenzeichnen.erlaubt).toBe(false);
      expect(d.historisch).toBe(false);
      expect(d.stand).toBe('2026-10-16');
    });

    it('Rechte als Flags je Akteur (Vier-Augen sichtbar mit Grund)', async () => {
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) =>
        speichereDurchfuehrung(ctx, { ...ziel(did), ...SPEICHERN }),
      );
      await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
      );
      await f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did)));
      const alsBearbeiter = await f.dienst(a.bearbeiter, (ctx) =>
        ladeDurchfuehrung(ctx, ziel(did)),
      );
      expect(alsBearbeiter.rechte.gegenzeichnen).toEqual({
        erlaubt: false,
        grund: 'Gegenzeichnung muss durch eine andere Person erfolgen (Vier-Augen-Prinzip)',
      });
      const alsPruefer = await f.dienst(a.pruefer, (ctx) => ladeDurchfuehrung(ctx, ziel(did)));
      expect(alsPruefer.rechte.gegenzeichnen).toEqual({ erlaubt: true, grund: null });
      expect(alsPruefer.rechte.zurueckweisen.erlaubt).toBe(true);
      expect(alsPruefer.rechte.bearbeiten.erlaubt).toBe(false);
    });

    it('Namen über das Personenverzeichnis des Kontexts (Demo), im Dienst leer', async () => {
      const namen = await imDienst(
        a.bt,
        {
          ...PORTS,
          personen: { namen: async (ids) => new Map(ids.map((id) => [id, `P-${id.slice(0, 4)}`])) },
        },
        (ctx) => ladeDurchfuehrung(ctx, ziel(abgeschlossen)),
      );
      expect(namen.namen).toContainEqual({ id: f.p.pruefer, name: `P-${f.p.pruefer.slice(0, 4)}` });
    });

    it('historischer Stand: schreibgeschützt, Inhalte zum Stichtag', async () => {
      const d = await f.dienst(a.bt, (ctx) =>
        ladeDurchfuehrung(ctx, { ...ziel(abgeschlossen), stand: '2026-10-15' }),
      );
      expect(d.historisch).toBe(true);
      for (const r of Object.values(d.rechte)) {
        expect(r).toEqual({ erlaubt: false, grund: 'Änderungen nur im aktuellen Stand möglich' });
      }
      // Am 15.10. existierten weder Nachweis noch Abschluss (fachliche Zeit = 16.10.).
      expect(d.nachweise).toHaveLength(0);
      expect(d.nachweiseAusgeblendet).toBe(1);
      expect(d.abgeschlossenAm).toBeNull();
      expect(d.feststellungen).toHaveLength(0);
    });

    it('vertrauliche Feststellung: für Nicht-Beteiligte nur Nummer und Status (RT-01)', async () => {
      await f.tx((tx) =>
        tx.feststellung.updateMany({
          where: { durchfuehrungId: abgeschlossen },
          data: { vertraulich: true },
        }),
      );
      try {
        const kollege = await f.dienst(a.kollege, (ctx) =>
          ladeDurchfuehrung(ctx, ziel(abgeschlossen)),
        );
        // Positivliste wie im dedizierten Lesepfad: kein Titel, keine Schwere.
        const m = kollege.feststellungen[0]!;
        expect(Object.keys(m).sort()).toEqual([
          'id',
          'maskiert',
          'nummer',
          'status',
          'vertraulich',
        ]);
        expect(m).toMatchObject({ maskiert: true, vertraulich: true });
        expect(JSON.stringify(kollege)).not.toContain('Differenz Clearingkonto');
        // Erfassende Person (Prüfer) und zuständige BT sehen Titel und Schwere.
        for (const wer of [a.pruefer, a.bt]) {
          const d = await f.dienst(wer, (ctx) => ladeDurchfuehrung(ctx, ziel(abgeschlossen)));
          expect(d.feststellungen[0]).toMatchObject({
            maskiert: false,
            titel: 'Differenz Clearingkonto',
          });
          expect(d.feststellungen[0]).toHaveProperty('schwere');
        }
      } finally {
        await f.tx((tx) =>
          tx.feststellung.updateMany({
            where: { durchfuehrungId: abgeschlossen },
            data: { vertraulich: false },
          }),
        );
      }
    });

    it('TS-03: kein Lesen ohne Bezug, fremder Mandant/Tenant, Objekt anderer Mandanten, Mandantenkontakt', async () => {
      const dB = await f.durchfuehrung('kB');
      const faelle: [Akteur, string][] = [
        [
          f.kanzlei(f.p.bt, { bt: true, admin: true, zustaendig: true, mandantId: null }),
          abgeschlossen,
        ],
        [f.kanzlei(f.p.bt, { bt: true, admin: true, mandantId: f.mandantB }), abgeschlossen],
        [
          f.kanzlei(f.p.bt, { bt: true, admin: true, zustaendig: true, tenant: randomUUID() }),
          abgeschlossen,
        ],
        [a.bt, dB],
        [a.bt, 'cunbekannt000000000000000'],
        [a.gv, abgeschlossen],
        [a.gv, aufgabe],
      ];
      for (const [akteur, did] of faelle) {
        const e = await fehlerVon(f.dienst(akteur, (ctx) => ladeDurchfuehrung(ctx, ziel(did))));
        expect(e.code).toBe('NICHT_GEFUNDEN');
        expect(e.message).toBe('NICHT_GEFUNDEN');
        expect(e.felder).toBeUndefined();
      }
    });

    it('ungültige Eingaben → UNGUELTIG', async () => {
      for (const eingabe of [
        { mandantId: 'x', durchfuehrungId: abgeschlossen },
        { mandantId: f.mandant, durchfuehrungId: 'A/B' },
        { mandantId: f.mandant, durchfuehrungId: abgeschlossen, stand: '2026-13-01' },
        { mandantId: f.mandant, durchfuehrungId: abgeschlossen, extra: 1 },
      ]) {
        const e = await fehlerVon(
          f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, eingabe as never)),
        );
        expect(e.code).toBe('UNGUELTIG');
      }
    });
  });

  describe('ladeKontrollaufgabe (Portal, P2)', () => {
    it('zugewiesene Person und GV/TCB lesen; ohne Kanzlei-Interna', async () => {
      for (const wer of [a.ma, a.ma2, a.gv, a.tcb]) {
        const d = await f.dienst(wer, (ctx) => ladeKontrollaufgabe(ctx, ziel(aufgabe)));
        expect(KontrollaufgabeSchema.parse(d)).toEqual(d);
        expect(d).not.toHaveProperty('verlauf');
        expect(d).not.toHaveProperty('feststellungen');
        expect(d).not.toHaveProperty('beteiligte');
        expect(d.nachweise.map((n) => n.id)).toEqual([anlageId]);
      }
      const ma = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(aufgabe)));
      expect(ma.rechte.bearbeiten.erlaubt).toBe(true);
      const gv = await f.dienst(a.gv, (ctx) => ladeKontrollaufgabe(ctx, ziel(aufgabe)));
      expect(gv.rechte.bearbeiten.erlaubt).toBe(false);
    });

    it('nicht zugewiesen ohne GV/TCB, ohne Rolle, Kanzlei-Kontrolle, fremder Mandant, Kanzleiperson → NICHT_GEFUNDEN', async () => {
      const faelle: [Akteur, string][] = [
        [a.ma3, aufgabe],
        [a.ohneRolle, aufgabe],
        [a.gv, abgeschlossen],
        [f.kontakt(f.p.gvB, f.mandantB), aufgabe],
        [a.bt, aufgabe],
      ];
      for (const [akteur, did] of faelle) {
        const e = await fehlerVon(f.dienst(akteur, (ctx) => ladeKontrollaufgabe(ctx, ziel(did))));
        expect(e.code).toBe('NICHT_GEFUNDEN');
        expect(e.message).toBe('NICHT_GEFUNDEN');
      }
    });
  });

  describe('listeKontrollaufgaben (Portal)', () => {
    it('GV sieht die offenen Mandanten-Aufgaben, Mitarbeiter nur zugewiesene', async () => {
      const gv = await f.dienst(a.gv, (ctx) =>
        listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
      );
      expect(KontrollaufgabenSchema.parse(gv)).toEqual(gv);
      expect(gv.aufgaben.map((x) => x.id)).toContain(aufgabe);
      expect(gv.aufgaben.every((x) => x.kontrolleCode === 'K-T-02')).toBe(true);
      expect(gv.aufgaben.find((x) => x.id === aufgabe)).toMatchObject({
        art: 'DURCHFUEHREN',
        eigene: false,
      });
      const ma = await f.dienst(a.ma, (ctx) =>
        listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
      );
      expect(ma.aufgaben.find((x) => x.id === aufgabe)).toMatchObject({
        eigene: true,
        nachweise: 1,
      });
      const ma3 = await f.dienst(a.ma3, (ctx) =>
        listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
      );
      expect(ma3.aufgaben).toEqual([]);
    });

    it('Kanzleiperson, fremder Mandant, ohne Rolle → NICHT_GEFUNDEN', async () => {
      for (const [akteur, mandantId] of [
        [a.bt, f.mandant],
        [a.gv, f.mandantB],
        [a.ohneRolle, f.mandant],
      ] as [Akteur, string][]) {
        const e = await fehlerVon(
          f.dienst(akteur, (ctx) => listeKontrollaufgaben(ctx, { mandantId })),
        );
        expect(e.code).toBe('NICHT_GEFUNDEN');
      }
    });
  });

  describe('ladeNachweis (Download-Rechte, TS-03)', () => {
    const lade = (akteur: Akteur, id: string, mandantId?: string) =>
      f.dienst(akteur, (ctx: DienstKontext) =>
        ladeNachweis(ctx, { mandantId: mandantId ?? f.mandant, nachweisId: id }),
      );

    it('Kanzlei mit Bezug; Portal nur für sichtbare Aufgaben', async () => {
      expect((await lade(a.kollege, nachweisId)).nachweis.id).toBe(nachweisId);
      expect((await lade(a.ma, anlageId)).durchfuehrungId).toBe(aufgabe);
      expect((await lade(a.gv, anlageId)).nachweis.dokumentId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('ohne Bezug, fremder Mandant/Tenant, nicht sichtbare Aufgabe → NICHT_GEFUNDEN', async () => {
      const dB = await f.durchfuehrung('kB');
      const inB = f.kanzlei(f.p.bearbeiter, { hb: true, mandantId: f.mandantB });
      const { nachweis } = await f.dienst(inB, (ctx) =>
        haengeNachweisAn(ctx, { mandantId: f.mandantB, durchfuehrungId: dB, verweis: verweis() }),
      );
      const faelle: [Akteur, string, string?][] = [
        [f.kanzlei(f.p.bt, { admin: true, mandantId: null }), nachweisId],
        [f.kanzlei(f.p.bt, { admin: true, mandantId: f.mandantB }), nachweisId],
        [f.kanzlei(f.p.bt, { admin: true, tenant: randomUUID() }), nachweisId],
        // Nachweis von Mandant B unter Mandant A (gleicher Tenant).
        [a.bt, nachweis.id],
        // Mandant B mit passendem Bezug sieht ihn, aber nicht unter A:
        [inB, nachweis.id, f.mandant],
        [a.ma3, anlageId],
        [a.gv, nachweisId],
        [f.kontakt(f.p.gvB, f.mandantB), anlageId, f.mandantB],
      ];
      for (const [akteur, id, m] of faelle) {
        const e = await fehlerVon(lade(akteur, id, m));
        expect(e.code).toBe('NICHT_GEFUNDEN');
      }
      expect((await lade(inB, nachweis.id, f.mandantB)).nachweis.id).toBe(nachweis.id);
    });
  });
});
