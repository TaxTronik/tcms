// =============================================================================
// Operationen der Kontrolldurchführung gegen PostgreSQL (DB_TESTS=1,
// DATABASE_URL = tcms_app): positive Fälle, jedes Recht negativ, fremder
// Tenant/Mandant ohne Existenz-Orakel, TS-05 mit zwei gleichzeitigen
// Transaktionen (zwei Verbindungen), Audit-Ereignisse und Audit-Kette.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import { pruefeAuditKette } from '@tcms/db';
import type { DienstKontext } from '../../kontext';
import { ladeKontext } from '../../kern/tcms-kontext';
import {
  ladeDurchfuehrung,
  ladeKontrollaufgabe,
  ladeNachweis,
  listeKontrollaufgaben,
} from './lesen';
import {
  beantrageEntfallen,
  beginneDurchfuehrung,
  bestaetigeDurchfuehrung,
  entferneNachweis,
  gegenzeichneDurchfuehrung,
  gibEntfallenFrei,
  haengeNachweisAn,
  legeNachtragAn,
  lehneEntfallenAb,
  reicheDurchfuehrungEin,
  speichereDurchfuehrung,
  weiseDurchfuehrungZurueck,
} from './operationen';
import { akteure, baueFall, fehlerVon, verweis, type Fall } from './testfall';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';

const vollstaendig = (ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' = 'OHNE_BEFUND') => ({
  schritte: [
    { erledigt: true, kommentar: 'erledigt' },
    { erledigt: true, kommentar: '' },
  ],
  werte: [
    { key: 'saldoShop', wert: 100, bemerkung: '', erklaert: false },
    { key: 'saldoFibu', wert: 100, bemerkung: '', erklaert: false },
  ],
  ergebnis,
  ergebnisKommentar: ergebnis === 'MIT_BEFUND' ? 'Differenz im Clearingkonto ungeklärt.' : null,
});

describe.skipIf(!AKTIV)('Durchführung: Operationen gegen PostgreSQL', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;
  const ziel = (durchfuehrungId: string, mandantId = '') => ({
    mandantId: mandantId || f.mandant,
    durchfuehrungId,
  });
  const audit = (objektId: string, aktion: string) =>
    f.tx((tx) => tx.auditEvent.findMany({ where: { objektId, aktion }, orderBy: { seq: 'asc' } }));
  /** Durchführung mit den nicht entfernten Nachweisen (wie jeder Leser). */
  const zeile = (id: string) =>
    f.tx((tx) =>
      tx.durchfuehrung.findUniqueOrThrow({
        where: { id },
        include: { nachweise: { where: { entferntAm: null } } },
      }),
    );
  /** Alle gespeicherten Verweise einer Durchführung, auch entfernte. */
  const alleNachweise = (durchfuehrungId: string) =>
    f.tx((tx) => tx.nachweis.findMany({ where: { durchfuehrungId } }));

  /** K1: beginnen, speichern, Nachweis, einreichen – alles durch die Hauptbearbeitung. */
  async function eingereicht(k: 'k1' | 'k2' = 'k1', ergebnis?: 'OHNE_BEFUND' | 'MIT_BEFUND') {
    const did = await f.durchfuehrung(k);
    const wer = k === 'k1' ? a.bearbeiter : a.ma;
    await f.dienst(wer, (ctx) =>
      speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig(ergebnis) }),
    );
    await f.dienst(wer, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }));
    await f.dienst(wer, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did)));
    return did;
  }

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
  });

  // ---------------------------------------------------------------------------
  // Sichtbarkeit: dieselbe Antwort für alles, was nicht sichtbar ist (TS-03)
  // ---------------------------------------------------------------------------

  describe('kein Existenz-Orakel über alle Operationen', () => {
    type Op = (ctx: DienstKontext, did: string, mandantId: string) => Promise<unknown>;
    const ops: [string, Op][] = [
      ['beginnen', (c, d, m) => beginneDurchfuehrung(c, { mandantId: m, durchfuehrungId: d })],
      [
        'speichern',
        (c, d, m) =>
          speichereDurchfuehrung(c, { mandantId: m, durchfuehrungId: d, ...vollstaendig() }),
      ],
      ['einreichen', (c, d, m) => reicheDurchfuehrungEin(c, { mandantId: m, durchfuehrungId: d })],
      [
        'anhängen',
        (c, d, m) => haengeNachweisAn(c, { mandantId: m, durchfuehrungId: d, verweis: verweis() }),
      ],
      [
        'entfernen',
        (c, d, m) => entferneNachweis(c, { mandantId: m, durchfuehrungId: d, nachweisId: 'x1' }),
      ],
      [
        'zurückweisen',
        (c, d, m) =>
          weiseDurchfuehrungZurueck(c, {
            mandantId: m,
            durchfuehrungId: d,
            begruendung: BEGRUENDUNG,
          }),
      ],
      [
        'gegenzeichnen',
        (c, d, m) => gegenzeichneDurchfuehrung(c, { mandantId: m, durchfuehrungId: d }),
      ],
      ['bestätigen', (c, d, m) => bestaetigeDurchfuehrung(c, { mandantId: m, durchfuehrungId: d })],
      [
        'entfallen beantragen',
        (c, d, m) =>
          beantrageEntfallen(c, { mandantId: m, durchfuehrungId: d, begruendung: BEGRUENDUNG }),
      ],
      [
        'entfallen freigeben',
        (c, d, m) => gibEntfallenFrei(c, { mandantId: m, durchfuehrungId: d }),
      ],
      [
        'entfallen ablehnen',
        (c, d, m) =>
          lehneEntfallenAb(c, { mandantId: m, durchfuehrungId: d, begruendung: BEGRUENDUNG }),
      ],
      [
        'nachtrag',
        (c, d, m) =>
          legeNachtragAn(c, { mandantId: m, durchfuehrungId: d, begruendung: BEGRUENDUNG }),
      ],
    ];

    it.each(ops)(
      '%s: fremder Tenant, fremder Mandant, Objekt eines anderen Mandanten, unbekannte ID',
      async (_n, op) => {
        const dA = await f.durchfuehrung('k1');
        const dB = await f.durchfuehrung('kB');
        const voll = { admin: true, bt: true, zustaendig: true, hb: true };
        const faelle: [Akteur, string, string][] = [
          // Bezug stimmt, Tenant nicht: RLS verbirgt alles.
          [f.kanzlei(f.p.bt, { ...voll, tenant: randomUUID() }), dA, f.mandant],
          // Bezug auf Mandant B, Pfad Mandant A.
          [f.kanzlei(f.p.bt, { ...voll, mandantId: f.mandantB }), dA, f.mandant],
          // Ohne Bezug (auch als Admin).
          [f.kanzlei(f.p.bt, { ...voll, mandantId: null }), dA, f.mandant],
          // Durchführung von Mandant B unter Mandant A (gleicher Tenant).
          [f.kanzlei(f.p.bt, voll), dB, f.mandant],
          // Unbekannte ID.
          [f.kanzlei(f.p.bt, voll), 'cunbekannt000000000000000', f.mandant],
          // Kontakt von Mandant B auf Mandant A; Kontakt ohne aktive Rolle.
          [f.kontakt(f.p.gvB, f.mandantB), dA, f.mandant],
          [a.ohneRolle, dA, f.mandant],
          // Mandantenkontakt auf eine Kanzlei-Kontrolle seines Mandanten.
          [a.gv, dA, f.mandant],
        ];
        for (const [akteur, did, m] of faelle) {
          const e = await fehlerVon(f.dienst(akteur, (ctx) => op(ctx, did, m)));
          expect(e.code, `${akteur.art} ${did === dB ? 'dB' : did}`).toBe('NICHT_GEFUNDEN');
          expect(e.message).toBe('NICHT_GEFUNDEN');
          expect(e.felder).toBeUndefined();
        }
        // Nichts geändert.
        expect((await zeile(dA)).status).toBe('GEPLANT');
        expect((await zeile(dB)).status).toBe('GEPLANT');
      },
    );

    it('TS-07: schreibende Operationen nehmen keinen Stichtag an', async () => {
      const did = await f.durchfuehrung('k1');
      const e = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          beginneDurchfuehrung(ctx, { ...ziel(did), stand: '2026-01-01' } as never),
        ),
      );
      expect(e.code).toBe('UNGUELTIG');
      expect(e.felder).toHaveProperty('eingabe');
      expect((await zeile(did)).status).toBe('GEPLANT');
    });
  });

  // ---------------------------------------------------------------------------
  // Beginnen, speichern, einreichen
  // ---------------------------------------------------------------------------

  describe('beginnen', () => {
    it('zugewiesene Person beginnt; Audit begonnen', async () => {
      const did = await f.durchfuehrung('k1');
      const r = await f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(did)));
      expect(r).toEqual({ durchfuehrungId: did, status: 'IN_DURCHFUEHRUNG' });
      const z = await zeile(did);
      expect(z.durchgefuehrtVon).toBe(f.p.bearbeiter);
      expect(z.begonnenAm?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
      const ev = await audit(did, 'tcms.durchfuehrung.begonnen');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actorId).toBe(f.p.bearbeiter);
    });

    it('Rolle fehlt: Kanzleiperson ohne Zuweisung → NICHT_BERECHTIGT mit Grund', async () => {
      const did = await f.durchfuehrung('k1');
      for (const wer of [a.kollege, a.bt, a.pruefer]) {
        const e = await fehlerVon(f.dienst(wer, (ctx) => beginneDurchfuehrung(ctx, ziel(did))));
        expect(e.code).toBe('NICHT_BERECHTIGT');
        expect(e.message).toMatch(/zugewiesene Person|Vertretung/);
      }
      // Kanzlei auf einer Mandanten-Kontrolle.
      const d2 = await f.durchfuehrung('k2');
      const e = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(d2))),
      );
      expect(e.code).toBe('NICHT_BERECHTIGT');
      expect(e.message).toBe('Diese Kontrolle führt der Mandant im Portal durch');
    });

    it('Status: vor Periodenende und nach Beginn → KONFLIKT', async () => {
      const zukunft = await f.durchfuehrung('k1', {
        periodeLabel: 'Dezember 2026',
        periodeVon: new Date('2026-12-01T00:00:00Z'),
        periodeBis: new Date('2026-12-31T00:00:00Z'),
        faelligAm: new Date('2027-01-30T00:00:00Z'),
      });
      const e1 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(zukunft))),
      );
      expect(e1.code).toBe('KONFLIKT');
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(did)));
      const e2 = await fehlerVon(
        f.dienst(a.vertretung, (ctx) => beginneDurchfuehrung(ctx, ziel(did))),
      );
      expect(e2.code).toBe('KONFLIKT');
    });

    it('TS-05: zwei gleichzeitige Beginne → genau einer, ein Audit-Ereignis', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await f.durchfuehrung('k1');
        const r = await Promise.allSettled([
          f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(did))),
          f.dienst(a.vertretung, (ctx) => beginneDurchfuehrung(ctx, ziel(did))),
        ]);
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        const abgelehnt = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
        expect(abgelehnt.reason.code).toBe('KONFLIKT');
        expect(await audit(did, 'tcms.durchfuehrung.begonnen')).toHaveLength(1);
      }
    });
  });

  describe('speichern', () => {
    it('speichert Schritte, Werte und Ergebnis; vor Beginn mit implizitem Beginn', async () => {
      const did = await f.durchfuehrung('k1');
      const r = await f.dienst(a.bearbeiter, (ctx) =>
        speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
      );
      expect(r.status).toBe('IN_DURCHFUEHRUNG');
      expect(r.pruefung.maengel).toEqual(['Nachweise: 0 von mindestens 1']);
      const z = await zeile(did);
      expect(z.werte).toEqual({
        saldoShop: { wert: 100, bemerkung: '', erklaert: false },
        saldoFibu: { wert: 100, bemerkung: '', erklaert: false },
      });
      expect(z.ergebnis).toBe('OHNE_BEFUND');
      expect(await audit(did, 'tcms.durchfuehrung.begonnen')).toHaveLength(1);
      const ev = await audit(did, 'tcms.durchfuehrung.gespeichert');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.detail).toMatchObject({ erledigt: 2, gesamt: 2, werte: 2, kanal: 'Kanzlei' });
    });

    it('Eingabe muss zur Kontrollversion passen (Schritte, Kennzahlen, Differenz)', async () => {
      const did = await f.durchfuehrung('k1');
      const basis = { ...ziel(did), ...vollstaendig() };
      const varianten = [
        { ...basis, schritte: [{ erledigt: true, kommentar: '' }] },
        { ...basis, werte: [{ key: 'fremd', wert: 1, bemerkung: '', erklaert: false }] },
        { ...basis, werte: [{ key: 'differenz', wert: 1, bemerkung: '', erklaert: false }] },
        { ...basis, werte: [{ key: '__proto__', wert: 1, bemerkung: '', erklaert: false }] },
      ];
      for (const v of varianten) {
        const e = await fehlerVon(f.dienst(a.bearbeiter, (ctx) => speichereDurchfuehrung(ctx, v)));
        expect(e.code).toBe('UNGUELTIG');
      }
      expect((await zeile(did)).status).toBe('GEPLANT');
    });

    it('nur zugewiesene Person; nach Einreichung → KONFLIKT', async () => {
      const did = await f.durchfuehrung('k1');
      const e = await fehlerVon(
        f.dienst(a.kollege, (ctx) =>
          speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
        ),
      );
      expect(e.code).toBe('NICHT_BERECHTIGT');
      const d2 = await eingereicht();
      const e2 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          speichereDurchfuehrung(ctx, { ...ziel(d2), ...vollstaendig() }),
        ),
      );
      expect(e2.code).toBe('KONFLIKT');
    });
  });

  describe('einreichen', () => {
    it('mit Mängeln → UNGUELTIG mit Mängelliste, ohne Änderung', async () => {
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(did)));
      const e = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did))),
      );
      expect(e.code).toBe('UNGUELTIG');
      expect(e.felder?.['maengel']).toEqual(
        expect.arrayContaining(['2 von 2 Schritten offen', 'Ergebnis nicht gewählt']),
      );
      expect((await zeile(did)).status).toBe('IN_DURCHFUEHRUNG');
    });

    it('vollständig → ZUR_GEGENZEICHNUNG, Nachweise gesperrt, Audit mit Verweisen', async () => {
      const did = await eingereicht();
      const z = await zeile(did);
      expect(z.status).toBe('ZUR_GEGENZEICHNUNG');
      expect(z.nachweise.every((n) => n.gesperrt)).toBe(true);
      const ev = await audit(did, 'tcms.durchfuehrung.eingereicht');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.detail).toMatchObject({
        nachweise: [{ id: z.nachweise[0]!.id, dokumentId: z.nachweise[0]!.dokumentId }],
      });
    });

    it('vor Beginn → KONFLIKT', async () => {
      const did = await f.durchfuehrung('k1');
      const e = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did))),
      );
      expect(e.code).toBe('KONFLIKT');
    });
  });

  // ---------------------------------------------------------------------------
  // Nachweise (Verweise, ADR 0001 §6)
  // ---------------------------------------------------------------------------

  describe('Nachweis anhängen', () => {
    it('speichert nur den geprüften Verweis; Audit mit vollständigem Verweis', async () => {
      const did = await f.durchfuehrung('k1');
      const v = verweis({ dokumentId: randomUUID().toUpperCase() });
      const r = await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: v }),
      );
      expect(r.nachweis).toMatchObject({
        dokumentId: (v.dokumentId as string).toLowerCase(),
        dateiname: 'Saldenliste.pdf',
        sha256: v.sha256,
        gesperrt: false,
        hochgeladenVon: f.p.bearbeiter,
      });
      expect((await zeile(did)).status).toBe('IN_DURCHFUEHRUNG');
      const ev = await audit(r.nachweis.id, 'tcms.durchfuehrung.nachweis_hochgeladen');
      expect(ev[0]!.detail).toMatchObject({
        durchfuehrungId: did,
        dokumentId: (v.dokumentId as string).toLowerCase(),
        sha256: v.sha256,
      });
    });

    it('ungültige Verweise → UNGUELTIG (dokumentId UUID, sha256, Größe, MIME, Name)', async () => {
      const did = await f.durchfuehrung('k1');
      for (const v of [
        verweis({ dokumentId: 'ab/abcdef' }),
        verweis({ sha256: 'A'.repeat(64) }),
        verweis({ groesse: 0 }),
        verweis({ mime: 'text/html; charset=utf-8' }),
        verweis({ dateiname: '../../etc/passwd' }),
        verweis({ speicherpfad: '/tmp/x' }),
      ]) {
        const e = await fehlerVon(
          f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: v })),
        );
        expect(e.code).toBe('UNGUELTIG');
      }
      expect((await zeile(did)).nachweise).toHaveLength(0);
    });

    it('derselbe Verweis nicht in einem fremden Mandanten (auch in anderer Schreibweise)', async () => {
      const dA = await f.durchfuehrung('k1');
      const dB = await f.durchfuehrung('kB');
      const v = verweis();
      await f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(dA), verweis: v }));
      const inB = f.kanzlei(f.p.bearbeiter, { hb: true, mandantId: f.mandantB });
      for (const dokumentId of [v.dokumentId as string, (v.dokumentId as string).toUpperCase()]) {
        const e = await fehlerVon(
          f.dienst(inB, (ctx) =>
            haengeNachweisAn(ctx, { ...ziel(dB, f.mandantB), verweis: { ...v, dokumentId } }),
          ),
        );
        expect(e.code).toBe('UNGUELTIG');
        expect(e.felder).toEqual({
          'verweis.dokumentId': ['Verweis kann hier nicht verwendet werden'],
        });
      }
      // Gleiche Dokument-ID mit anderem Inhalt im selben Mandanten: ebenso abgewiesen.
      const dA2 = await f.durchfuehrung('k1');
      const e2 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, { ...ziel(dA2), verweis: { ...v, sha256: 'b'.repeat(64) } }),
        ),
      );
      expect(e2.code).toBe('UNGUELTIG');
      // Gleiche Dokument-ID, gleicher Inhalt, anderer Durchführung desselben Mandanten: erlaubt.
      await f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(dA2), verweis: v }));
      expect((await zeile(dB)).nachweise).toHaveLength(0);
    });

    it('TS-05: gleichzeitig dieselbe Dokument-ID in zwei Mandanten → genau eine', async () => {
      const inB = f.kanzlei(f.p.bearbeiter, { hb: true, mandantId: f.mandantB });
      for (let runde = 0; runde < 3; runde++) {
        const dA = await f.durchfuehrung('k1');
        const dB = await f.durchfuehrung('kB');
        const v = verweis();
        const r = await Promise.allSettled([
          f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(dA), verweis: v })),
          f.dienst(inB, (ctx) => haengeNachweisAn(ctx, { ...ziel(dB, f.mandantB), verweis: v })),
        ]);
        expect(
          r.filter((x) => x.status === 'fulfilled'),
          `Runde ${runde}`,
        ).toHaveLength(1);
        const n = await f.tx((tx) =>
          tx.nachweis.count({ where: { dokumentId: v.dokumentId as string } }),
        );
        expect(n).toBe(1);
      }
    });

    it('gleicher Inhalt doppelt → KONFLIKT; nach Einreichung → KONFLIKT; fremde Person → NICHT_BERECHTIGT', async () => {
      const did = await f.durchfuehrung('k1');
      const v = verweis();
      await f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: v }));
      const e1 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, { ...ziel(did), verweis: { ...v, dokumentId: randomUUID() } }),
        ),
      );
      expect(e1.code).toBe('KONFLIKT');
      const e2 = await fehlerVon(
        f.dienst(a.kollege, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() })),
      );
      expect(e2.code).toBe('NICHT_BERECHTIGT');
      const d2 = await eingereicht();
      const e3 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => haengeNachweisAn(ctx, { ...ziel(d2), verweis: verweis() })),
      );
      expect(e3.code).toBe('KONFLIKT');
    });
  });

  describe('Nachweis entfernen', () => {
    it('vor Einreichung: Verweis als entfernt markiert, kein Lesepfad liefert ihn, Verweis im Audit', async () => {
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) =>
        speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
      );
      const v = verweis();
      const { nachweis } = await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: v }),
      );
      const r = await f.dienst(a.vertretung, (ctx) =>
        entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
      );
      expect(r).toEqual({ durchfuehrungId: did, nachweisId: nachweis.id });
      // Markiert statt gelöscht (Dokument-ID bleibt an Mandant und Inhalt gebunden).
      const gespeichert = await alleNachweise(did);
      expect(gespeichert).toHaveLength(1);
      expect(gespeichert[0]).toMatchObject({ id: nachweis.id, entferntVon: f.p.vertretung });
      expect(gespeichert[0]!.entferntAm).not.toBeNull();
      // Kein Lesepfad liefert den entfernten Verweis: Detail, Download, Kontext, Mängelprüfung.
      const d = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(did)));
      expect(d.nachweise).toEqual([]);
      const dl = await fehlerVon(
        f.dienst(a.bt, (ctx) =>
          ladeNachweis(ctx, { mandantId: f.mandant, nachweisId: nachweis.id }),
        ),
      );
      expect(dl.code).toBe('NICHT_GEFUNDEN');
      const k = await f.dienst(a.bt, (ctx) => ladeKontext(ctx, { mandantId: f.mandant }));
      expect(k?.durchfuehrungen.find((x) => x.id === did)?.nachweise).toBe(0);
      const ein = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did))),
      );
      expect(ein.code).toBe('UNGUELTIG');
      // Zweites Entfernen findet nichts mehr.
      const nochmal = await fehlerVon(
        f.dienst(a.vertretung, (ctx) =>
          entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
        ),
      );
      expect(nochmal.code).toBe('NICHT_GEFUNDEN');
      // Dieselbe Dokument-ID bleibt gebunden: mit anderem Inhalt unbrauchbar.
      const fremd = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, {
            ...ziel(did),
            verweis: { ...v, sha256: 'c'.repeat(64) },
          }),
        ),
      );
      expect(fremd.code).toBe('UNGUELTIG');
      const ev = await audit(nachweis.id, 'tcms.durchfuehrung.nachweis_entfernt');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actorId).toBe(f.p.vertretung);
      expect(ev[0]!.detail).toMatchObject({
        durchfuehrungId: did,
        dokumentId: v.dokumentId,
        sha256: v.sha256,
        dateiname: v.dateiname,
        groesse: v.groesse,
        mime: v.mime,
      });
    });

    it('gesperrt → KONFLIKT; fremder Nachweis → NICHT_GEFUNDEN; fremde Person → NICHT_BERECHTIGT', async () => {
      const did = await eingereicht();
      const n = (await zeile(did)).nachweise[0]!;
      // Zurückweisen entsperrt; davor ist der Nachweis gesperrt.
      const e1 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) => entferneNachweis(ctx, { ...ziel(did), nachweisId: n.id })),
      );
      expect(e1.code).toBe('KONFLIKT');
      const anderer = await f.durchfuehrung('k1');
      const { nachweis } = await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(anderer), verweis: verweis() }),
      );
      const e2 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
        ),
      );
      expect(e2.code).toBe('NICHT_GEFUNDEN');
      const e3 = await fehlerVon(
        f.dienst(a.kollege, (ctx) =>
          entferneNachweis(ctx, { ...ziel(anderer), nachweisId: nachweis.id }),
        ),
      );
      expect(e3.code).toBe('NICHT_BERECHTIGT');
      expect((await zeile(anderer)).nachweise).toHaveLength(1);
    });

    it('TS-05: Entfernen und Einreichen gleichzeitig → konsistent (nie eingereicht ohne Nachweis)', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await f.durchfuehrung('k1');
        await f.dienst(a.bearbeiter, (ctx) =>
          speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
        );
        const { nachweis } = await f.dienst(a.bearbeiter, (ctx) =>
          haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
        );
        await Promise.allSettled([
          f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did))),
          f.dienst(a.vertretung, (ctx) =>
            entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
          ),
        ]);
        const z = await zeile(did);
        if (z.status === 'ZUR_GEGENZEICHNUNG') {
          expect(z.nachweise).toHaveLength(1);
          expect(z.nachweise[0]!.gesperrt).toBe(true);
        } else {
          expect(z.nachweise).toHaveLength(0);
          expect((await alleNachweise(did))[0]!.entferntAm).not.toBeNull();
        }
      }
    });

    it('Portal: entfernte Anlage erscheint weder in der Aufgabe noch in der Aufgabenliste', async () => {
      const did = await f.durchfuehrung('k2');
      const { nachweis } = await f.dienst(a.ma, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
      );
      const vorher = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
      expect(vorher.nachweise.map((n) => n.id)).toEqual([nachweis.id]);
      await f.dienst(a.ma, (ctx) =>
        entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
      );
      const nachher = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
      expect(nachher.nachweise).toEqual([]);
      const liste = await f.dienst(a.ma, (ctx) =>
        listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
      );
      expect(liste.aufgaben.find((x) => x.id === did)?.nachweise).toBe(0);
      const dl = await fehlerVon(
        f.dienst(a.ma, (ctx) =>
          ladeNachweis(ctx, { mandantId: f.mandant, nachweisId: nachweis.id }),
        ),
      );
      expect(dl.code).toBe('NICHT_GEFUNDEN');
    });
  });

  // ---------------------------------------------------------------------------
  // Prüfen: zurückweisen, gegenzeichnen, bestätigen (Vier-Augen)
  // ---------------------------------------------------------------------------

  describe('zurückweisen', () => {
    it('Prüfer:in weist zurück; Nachweise entsperrt; Audit mit Begründung', async () => {
      const did = await eingereicht();
      const r = await f.dienst(a.pruefer, (ctx) =>
        weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      expect(r.status).toBe('ZURUECKGEWIESEN');
      const z = await zeile(did);
      expect(z.zurueckgewiesenVon).toBe(f.p.pruefer);
      expect(z.nachweise.every((n) => !n.gesperrt)).toBe(true);
      const ev = await audit(did, 'tcms.durchfuehrung.zurueckgewiesen');
      expect(ev[0]!.detail).toMatchObject({ begruendung: BEGRUENDUNG, nachweiseEntsperrt: 1 });
    });

    it('Vier-Augen: durchführende Person und Beteiligte (auch über entfernte Nachweise) → NICHT_BERECHTIGT', async () => {
      const did = await f.durchfuehrung('k1');
      // Vertretung lädt hoch und entfernt wieder: bleibt über das Audit beteiligt.
      const { nachweis } = await f.dienst(a.vertretung, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
      );
      await f.dienst(a.vertretung, (ctx) =>
        entferneNachweis(ctx, { ...ziel(did), nachweisId: nachweis.id }),
      );
      await f.dienst(a.bearbeiter, (ctx) =>
        speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
      );
      await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
      );
      await f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did)));
      // Vertretung ist zugleich Berufsträgerin mit Zuständigkeit: Vier-Augen gilt trotzdem.
      const vertretungBt = f.kanzlei(f.p.vertretung, { bt: true, zustaendig: true, admin: true });
      for (const wer of [a.bearbeiter, vertretungBt]) {
        const e = await fehlerVon(
          f.dienst(wer, (ctx) =>
            weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
          ),
        );
        expect(e.code).toBe('NICHT_BERECHTIGT');
        expect(e.message).toMatch(/Vier-Augen/);
      }
      const e2 = await fehlerVon(
        f.dienst(a.kollege, (ctx) =>
          weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e2.code).toBe('NICHT_BERECHTIGT');
      expect((await zeile(did)).status).toBe('ZUR_GEGENZEICHNUNG');
    });

    it('Begründung zu kurz → UNGUELTIG; nicht eingereicht → KONFLIKT', async () => {
      const did = await eingereicht();
      const e = await fehlerVon(
        f.dienst(a.pruefer, (ctx) =>
          weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: 'zu kurz' }),
        ),
      );
      expect(e.code).toBe('UNGUELTIG');
      const offen = await f.durchfuehrung('k1');
      const e2 = await fehlerVon(
        f.dienst(a.pruefer, (ctx) =>
          weiseDurchfuehrungZurueck(ctx, { ...ziel(offen), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e2.code).toBe('KONFLIKT');
    });
  });

  describe('gegenzeichnen', () => {
    it('ohne Befund durch die zugewiesene Gegenzeichnung; Nachweise gesperrt; Audit', async () => {
      const did = await eingereicht();
      const r = await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
      expect(r).toEqual({ durchfuehrungId: did, status: 'OHNE_BEFUND', feststellung: null });
      const z = await zeile(did);
      expect(z.gegengezeichnetVon).toBe(f.p.pruefer);
      expect(z.abgeschlossenAm).not.toBeNull();
      const ev = await audit(did, 'tcms.durchfuehrung.gegengezeichnet');
      expect(ev[0]!.detail).toMatchObject({
        ergebnis: 'OHNE_BEFUND',
        durchgefuehrtVon: f.p.bearbeiter,
      });
    });

    it('mit Befund: Feststellung im selben Zug; „NEIN" ohne Würdigungsrecht wird „UNKLAR" (TS-04)', async () => {
      const did = await eingereicht('k1', 'MIT_BEFUND');
      const feststellung = {
        titel: 'Differenz Clearingkonto',
        sachverhalt: 'Das Clearingkonto weist eine ungeklärte Differenz aus.',
        klasse: 'DURCHFUEHRUNGSMANGEL' as const,
        schwere: 'MITTEL' as const,
        auswirkung: 'NEIN' as const,
        risikoIds: [f.risiko],
      };
      const r = await f.dienst(a.pruefer, (ctx) =>
        gegenzeichneDurchfuehrung(ctx, { ...ziel(did), feststellung }),
      );
      expect(r.status).toBe('MIT_BEFUND');
      expect(r.feststellung?.nummer).toBe('F-2026-001');
      const fs = await f.tx((tx) =>
        tx.feststellung.findUniqueOrThrow({
          where: { id: r.feststellung!.id },
          include: { risiken: true },
        }),
      );
      expect(fs.auswirkung).toBe('UNKLAR');
      expect(fs.durchfuehrungId).toBe(did);
      expect(fs.risiken.map((x) => x.risikoId)).toEqual([f.risiko]);
      const ev = await audit(fs.id, 'tcms.feststellung.erfasst');
      expect(ev[0]!.detail).toMatchObject({ auswirkung: 'UNKLAR', auswirkungAngegeben: 'NEIN' });
      // Mit Würdigungsrecht bleibt „NEIN".
      const d2 = await eingereicht('k1', 'MIT_BEFUND');
      const r2 = await f.dienst(a.bt, (ctx) =>
        gegenzeichneDurchfuehrung(ctx, { ...ziel(d2), feststellung }),
      );
      const fs2 = await f.tx((tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: r2.feststellung!.id } }),
      );
      expect(fs2.auswirkung).toBe('NEIN');
    });

    it('Feststellung: Pflicht bei Befund, verboten ohne Befund, nur verknüpfte Risiken des Mandanten', async () => {
      const did = await eingereicht('k1', 'MIT_BEFUND');
      const basis = {
        titel: 'Differenz Clearingkonto',
        sachverhalt: 'Das Clearingkonto weist eine ungeklärte Differenz aus.',
        klasse: 'DURCHFUEHRUNGSMANGEL' as const,
        schwere: 'MITTEL' as const,
        auswirkung: 'UNKLAR' as const,
      };
      const e1 = await fehlerVon(
        f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
      );
      expect(e1.code).toBe('UNGUELTIG');
      const e2 = await fehlerVon(
        f.dienst(a.pruefer, (ctx) =>
          gegenzeichneDurchfuehrung(ctx, {
            ...ziel(did),
            feststellung: { ...basis, risikoIds: [f.risikoB] },
          }),
        ),
      );
      expect(e2.code).toBe('UNGUELTIG');
      expect(e2.felder).toHaveProperty(['feststellung.risikoIds']);
      const ohne = await eingereicht();
      const e3 = await fehlerVon(
        f.dienst(a.pruefer, (ctx) =>
          gegenzeichneDurchfuehrung(ctx, {
            ...ziel(ohne),
            feststellung: { ...basis, risikoIds: [f.risiko] },
          }),
        ),
      );
      expect(e3.code).toBe('UNGUELTIG');
      expect((await zeile(did)).status).toBe('ZUR_GEGENZEICHNUNG');
      expect(await f.tx((tx) => tx.feststellung.count({ where: { durchfuehrungId: did } }))).toBe(
        0,
      );
    });

    it('Vier-Augen und Rolle: durchführende Person, Beteiligte, Kollegen ohne Recht → NICHT_BERECHTIGT', async () => {
      const did = await eingereicht();
      // Die durchführende Person zeichnet nie selbst gegen – auch nicht als zuständige BT/Admin.
      for (const wer of [
        a.bearbeiter,
        f.kanzlei(f.p.bearbeiter, { bt: true, zustaendig: true, admin: true }),
      ]) {
        const e = await fehlerVon(
          f.dienst(wer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
        );
        expect(e.code).toBe('NICHT_BERECHTIGT');
      }
      for (const wer of [a.kollege, a.vertretung]) {
        const e = await fehlerVon(
          f.dienst(wer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
        );
        expect(e.code).toBe('NICHT_BERECHTIGT');
        expect(e.message).toMatch(/zugewiesene Gegenzeichnung/);
      }
      expect((await zeile(did)).status).toBe('ZUR_GEGENZEICHNUNG');
      // Die zugewiesene Gegenzeichnung ist nicht beteiligt und darf.
      await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
    });

    it('Vier-Augen: wer gespeichert hat, ist beteiligt – auch als zugewiesene Gegenzeichnung', async () => {
      // Beteiligung allein über das Audit (z. B. ein früher gespeicherter Stand dieser Person,
      // als sie noch Vertretung war): Die zugewiesene Gegenzeichnung darf dann nicht.
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) =>
        speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() }),
      );
      await f.dienst(a.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
      );
      // Beteiligung über das Audit (z. B. frühere Zuständigkeit): Audit-Ereignis des Prüfers.
      await f.tx(async (tx) => {
        const { schreibeAudit } = await import('@tcms/db');
        await schreibeAudit(tx, {
          actorId: f.p.pruefer,
          actorName: 'Prüfer',
          aktion: 'tcms.durchfuehrung.gespeichert',
          objektTyp: 'Durchfuehrung',
          objektId: did,
          programmId: f.programm,
          detail: {},
        });
      });
      await f.dienst(a.bearbeiter, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did)));
      const e = await fehlerVon(
        f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
      );
      expect(e.code).toBe('NICHT_BERECHTIGT');
      expect(e.message).toMatch(/Vier-Augen/);
    });

    it('TS-05: zwei gleichzeitige Gegenzeichnungen → genau eine, eine Feststellung, ein Audit', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await eingereicht('k1', 'MIT_BEFUND');
        const feststellung = {
          titel: 'Differenz Clearingkonto',
          sachverhalt: 'Das Clearingkonto weist eine ungeklärte Differenz aus.',
          klasse: 'DURCHFUEHRUNGSMANGEL' as const,
          schwere: 'MITTEL' as const,
          auswirkung: 'UNKLAR' as const,
          risikoIds: [f.risiko],
        };
        const r = await Promise.allSettled([
          f.dienst(a.pruefer, (ctx) =>
            gegenzeichneDurchfuehrung(ctx, { ...ziel(did), feststellung }),
          ),
          f.dienst(a.bt, (ctx) => gegenzeichneDurchfuehrung(ctx, { ...ziel(did), feststellung })),
        ]);
        expect(
          r.filter((x) => x.status === 'fulfilled'),
          `Runde ${runde}`,
        ).toHaveLength(1);
        expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
          'KONFLIKT',
        );
        expect(await f.tx((tx) => tx.feststellung.count({ where: { durchfuehrungId: did } }))).toBe(
          1,
        );
        expect(await audit(did, 'tcms.durchfuehrung.gegengezeichnet')).toHaveLength(1);
      }
    });

    it('TS-05: Gegenzeichnen und Zurückweisen gleichzeitig → genau eines wirkt', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await eingereicht();
        const r = await Promise.allSettled([
          f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
          f.dienst(a.bt, (ctx) =>
            weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
          ),
        ]);
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        const z = await zeile(did);
        expect(['OHNE_BEFUND', 'ZURUECKGEWIESEN']).toContain(z.status);
        expect(z.nachweise[0]!.gesperrt).toBe(z.status === 'OHNE_BEFUND');
      }
    });
  });

  describe('Portal: Mandanten-Kontrolle mit Bestätigung durch eine zweite Person', () => {
    it('Mitarbeiter führt durch, GV bestätigt, Kanzlei zeichnet gegen', async () => {
      const did = await eingereicht('k2');
      const ev = await audit(did, 'tcms.durchfuehrung.eingereicht');
      expect(ev[0]!.detail).toMatchObject({ kanal: 'Portal' });
      // Vor der Bestätigung keine Gegenzeichnung durch die Kanzlei.
      const e0 = await fehlerVon(
        f.dienst(a.bt, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
      );
      expect(e0.code).toBe('KONFLIKT');
      await f.dienst(a.gv, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did)));
      expect((await zeile(did)).mandantBestaetigtVon).toBe(f.p.gv);
      const r = await f.dienst(a.bt, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
      expect(r.status).toBe('OHNE_BEFUND');
    });

    it('Bestätigen: nicht durch Beteiligte, nicht durch die Kanzlei, nicht ohne Sichtbarkeit', async () => {
      const did = await eingereicht('k2');
      const e1 = await fehlerVon(f.dienst(a.ma, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did))));
      expect(e1.code).toBe('NICHT_BERECHTIGT');
      const e2 = await fehlerVon(f.dienst(a.bt, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did))));
      expect(e2.code).toBe('NICHT_BERECHTIGT');
      const e3 = await fehlerVon(f.dienst(a.ma3, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did))));
      expect(e3.code).toBe('NICHT_GEFUNDEN');
      expect((await zeile(did)).mandantBestaetigtVon).toBeNull();
    });

    it('Zurückgeben durch die zweite Person; nicht durch die durchführende Person', async () => {
      const did = await eingereicht('k2');
      const e = await fehlerVon(
        f.dienst(a.ma, (ctx) =>
          weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e.code).toBe('NICHT_BERECHTIGT');
      await f.dienst(a.tcb, (ctx) =>
        weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      const z = await zeile(did);
      expect(z.status).toBe('ZURUECKGEWIESEN');
      expect(z.zurueckgewiesenVon).toBe(f.p.tcb);
      const ev = await audit(did, 'tcms.durchfuehrung.zurueckgewiesen');
      expect(ev[0]!.detail).toMatchObject({ kanal: 'Portal' });
    });

    it('Kontakt ohne Zuweisung (Mitarbeiter) kann nicht durchführen; Kanzlei-Kontrolle unsichtbar', async () => {
      const did = await f.durchfuehrung('k2');
      const e = await fehlerVon(
        f.dienst(a.ma3, (ctx) => speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() })),
      );
      expect(e.code).toBe('NICHT_GEFUNDEN');
      // GV sieht die Aufgabe, ist aber nicht zugewiesen.
      const e2 = await fehlerVon(
        f.dienst(a.gv, (ctx) => speichereDurchfuehrung(ctx, { ...ziel(did), ...vollstaendig() })),
      );
      expect(e2.code).toBe('NICHT_BERECHTIGT');
    });

    it('TS-05: zwei gleichzeitige Bestätigungen → genau eine', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await eingereicht('k2');
        const r = await Promise.allSettled([
          f.dienst(a.gv, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did))),
          f.dienst(a.tcb, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(did))),
        ]);
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
          'KONFLIKT',
        );
        expect(await audit(did, 'tcms.durchfuehrung.mandant_bestaetigt')).toHaveLength(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Entfallen und Nachtrag
  // ---------------------------------------------------------------------------

  describe('Entfallen', () => {
    it('Antrag durch Bearbeitung, Freigabe durch eine zweite Person mit Würdigungsrecht', async () => {
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) =>
        beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      const r = await f.dienst(a.bt, (ctx) => gibEntfallenFrei(ctx, ziel(did)));
      expect(r.status).toBe('ENTFALLEN');
      const ev = await audit(did, 'tcms.durchfuehrung.entfallen');
      expect(ev[0]!.detail).toMatchObject({
        beantragtVon: f.p.bearbeiter,
        begruendung: BEGRUENDUNG,
      });
    });

    it('Freigabe: nie durch die antragstellende Person, nur mit Würdigungsrecht', async () => {
      const did = await f.durchfuehrung('k1');
      // Die Berufsträgerin beantragt selbst und darf dann nicht freigeben.
      await f.dienst(a.bt, (ctx) =>
        beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      const e1 = await fehlerVon(f.dienst(a.bt, (ctx) => gibEntfallenFrei(ctx, ziel(did))));
      expect(e1.code).toBe('NICHT_BERECHTIGT');
      expect(e1.message).toBe('Freigabe durch eine zweite Person');
      // Nicht-Berufsträger und Berufsträger ohne Zuständigkeit/Admin.
      for (const wer of [a.kollege, a.bearbeiter, f.kanzlei(f.p.kollege, { bt: true })]) {
        const e = await fehlerVon(f.dienst(wer, (ctx) => gibEntfallenFrei(ctx, ziel(did))));
        expect(e.code).toBe('NICHT_BERECHTIGT');
      }
      // Die antragstellende Person in anderer Schreibweise ist dieselbe Person.
      const btGross = f.kanzlei(f.p.bt.toUpperCase(), { bt: true, zustaendig: true });
      const e2 = await fehlerVon(f.dienst(btGross, (ctx) => gibEntfallenFrei(ctx, ziel(did))));
      expect(e2.code).toBe('NICHT_BERECHTIGT');
      expect((await zeile(did)).status).toBe('GEPLANT');
      await f.dienst(a.bt2, (ctx) => gibEntfallenFrei(ctx, ziel(did)));
      expect((await zeile(did)).status).toBe('ENTFALLEN');
    });

    it('Ablehnen mit Begründung, Zurückziehen ohne; Antrag nur einmal; Mandant darf nicht beantragen', async () => {
      const did = await f.durchfuehrung('k1');
      await f.dienst(a.bearbeiter, (ctx) =>
        beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      const e0 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e0.code).toBe('KONFLIKT');
      const e1 = await fehlerVon(
        f.dienst(a.bt, (ctx) => lehneEntfallenAb(ctx, { ...ziel(did), begruendung: 'kurz' })),
      );
      expect(e1.code).toBe('UNGUELTIG');
      await f.dienst(a.bearbeiter, (ctx) => lehneEntfallenAb(ctx, ziel(did)));
      const ev = await audit(did, 'tcms.durchfuehrung.entfallen_abgelehnt');
      expect(ev[0]!.detail).toMatchObject({ begruendung: '', beantragtVon: f.p.bearbeiter });
      const z = await zeile(did);
      expect(z.entfallenBegruendung).toBeNull();
      const d2 = await f.durchfuehrung('k2');
      const e2 = await fehlerVon(
        f.dienst(a.gv, (ctx) => beantrageEntfallen(ctx, { ...ziel(d2), begruendung: BEGRUENDUNG })),
      );
      expect(e2.code).toBe('NICHT_BERECHTIGT');
    });

    it('TS-05: Freigabe und Ablehnung gleichzeitig → genau eine Entscheidung', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await f.durchfuehrung('k1');
        await f.dienst(a.bearbeiter, (ctx) =>
          beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        );
        const r = await Promise.allSettled([
          f.dienst(a.bt, (ctx) => gibEntfallenFrei(ctx, ziel(did))),
          f.dienst(a.bt2, (ctx) =>
            lehneEntfallenAb(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
          ),
        ]);
        expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
          'KONFLIKT',
        );
        const n =
          (await audit(did, 'tcms.durchfuehrung.entfallen')).length +
          (await audit(did, 'tcms.durchfuehrung.entfallen_abgelehnt')).length;
        expect(n).toBe(1);
      }
    });
  });

  describe('Nachtrag', () => {
    it('zu abgeschlossener Durchführung: neue verknüpfte Durchführung, Original unverändert', async () => {
      const did = await eingereicht();
      await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
      const vorher = await zeile(did);
      const r = await f.dienst(a.bearbeiter, (ctx) =>
        legeNachtragAn(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
      );
      const neu = await zeile(r.durchfuehrungId);
      expect(neu).toMatchObject({
        nachtragZuId: did,
        status: 'GEPLANT',
        ausserplanmaessig: true,
        periodeLabel: 'September 2026 · Nachtrag',
        kontrolleStandId: vorher.kontrolleStandId,
      });
      expect(neu.faelligAm.toISOString()).toBe('2026-10-30T00:00:00.000Z');
      expect(await zeile(did)).toEqual(vorher);
      const ev = await audit(r.durchfuehrungId, 'tcms.durchfuehrung.nachtrag_angelegt');
      expect(ev[0]!.detail).toMatchObject({ nachtragZuId: did });
    });

    it('nur zu abgeschlossenen; nicht durch Mandantenkontakte oder Kollegen ohne Recht', async () => {
      const offen = await f.durchfuehrung('k1');
      const e1 = await fehlerVon(
        f.dienst(a.bearbeiter, (ctx) =>
          legeNachtragAn(ctx, { ...ziel(offen), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e1.code).toBe('KONFLIKT');
      const did = await eingereicht();
      await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
      const e2 = await fehlerVon(
        f.dienst(a.kollege, (ctx) =>
          legeNachtragAn(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        ),
      );
      expect(e2.code).toBe('NICHT_BERECHTIGT');
      const d2 = await eingereicht('k2');
      await f.dienst(a.gv, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(d2)));
      await f.dienst(a.bt, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(d2)));
      const e3 = await fehlerVon(
        f.dienst(a.gv, (ctx) => legeNachtragAn(ctx, { ...ziel(d2), begruendung: BEGRUENDUNG })),
      );
      expect(e3.code).toBe('NICHT_BERECHTIGT');
    });

    it('TS-05: zwei gleichzeitige Nachträge → genau einer', async () => {
      for (let runde = 0; runde < 3; runde++) {
        const did = await eingereicht();
        await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
        const r = await Promise.allSettled([
          f.dienst(a.bearbeiter, (ctx) =>
            legeNachtragAn(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
          ),
          f.dienst(a.bt, (ctx) => legeNachtragAn(ctx, { ...ziel(did), begruendung: BEGRUENDUNG })),
        ]);
        expect(
          r.filter((x) => x.status === 'fulfilled'),
          `Runde ${runde}`,
        ).toHaveLength(1);
        expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
          'KONFLIKT',
        );
        expect(await f.tx((tx) => tx.durchfuehrung.count({ where: { nachtragZuId: did } }))).toBe(
          1,
        );
      }
    });
  });

  it('die Audit-Kette des Tenants bleibt gültig', async () => {
    const k = await f.tx((tx) => pruefeAuditKette(tx));
    expect(k.gueltig).toBe(true);
  });
});
