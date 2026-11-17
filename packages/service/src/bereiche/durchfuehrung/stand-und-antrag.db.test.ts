// =============================================================================
// Gesehener Stand und Entfallen-Antrag der Durchführung gegen PostgreSQL
// (DB_TESTS=1): Speichern und Einreichen nur auf dem gesehenen Inhalt (TS-05,
// Befund 113), eingereichter und gegengezeichneter Inhalt im Audit gebunden
// (Befund 101), Entfallen-Freigabe nur für den gesehenen Antrag (Befund 16),
// offener Antrag sperrt das Durchführen und verschwindet nicht in der
// Neuplanung (Befunde 13, 102, 106), Antragsbegründung nicht im Portal
// (Befund 109), Antrag nur vollständig (CHECK, Befund 102 d), verworfene
// Feststellung deckt keinen Befund (Befunde 40, 103), Grenzen für Nachweise
// (Befund 108).
// =============================================================================

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DF_MAX_NACHWEIS_VERWEISE, DF_MAX_NACHWEISE, type Akteur } from '@tcms/contract';
import { dbAbgewiesen, regel } from '@tcms/db/testhilfe';
import { addTage } from '@tcms/domain';
import { planeDurchfuehrungenNeu } from '../risiken-kontrollen/planung';
import { ladeDurchfuehrung, ladeKontrollaufgabe } from './lesen';
import {
  beantrageEntfallen,
  beginneDurchfuehrung,
  gegenzeichneDurchfuehrung,
  haengeNachweisAn,
  lehneEntfallenAb,
  weiseDurchfuehrungZurueck,
} from './operationen';
import {
  akteure,
  baueFall,
  fehlerVon,
  gesehen,
  gibFrei,
  reicheEin,
  speichere,
  verweis,
  type Fall,
} from './testfall';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';
const ANDERE = 'Eine ganz andere Begründung, die die freigebende Person nie gesehen hat.';
const tag = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const vollstaendig = (ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' = 'OHNE_BEFUND', wert = 100) => ({
  schritte: [
    { erledigt: true, kommentar: 'erledigt' },
    { erledigt: true, kommentar: '' },
  ],
  werte: [
    { key: 'saldoShop', wert, bemerkung: '', erklaert: false },
    { key: 'saldoFibu', wert, bemerkung: '', erklaert: false },
  ],
  ergebnis,
  ergebnisKommentar: ergebnis === 'MIT_BEFUND' ? 'Differenz im Clearingkonto ungeklärt.' : null,
});

describe.skipIf(!AKTIV)('Durchführung: gesehener Stand und Entfallen-Antrag', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;
  const ziel = (durchfuehrungId: string) => ({ mandantId: f.mandant, durchfuehrungId });
  const audit = (objektId: string, aktion: string) =>
    f.tx((tx) => tx.auditEvent.findMany({ where: { objektId, aktion }, orderBy: { pos: 'asc' } }));
  const zeile = (id: string) => f.tx((tx) => tx.durchfuehrung.findUnique({ where: { id } }));
  const merkmal = (wer: Akteur, did: string) => f.dienst(wer, (ctx) => gesehen(ctx, did));

  async function mitNachweis(k: 'k1' | 'k2', wer: Akteur, ergebnis?: 'MIT_BEFUND') {
    const did = await f.durchfuehrung(k);
    await f.dienst(wer, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig(ergebnis) }));
    await f.dienst(wer, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }));
    return did;
  }

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
  });

  // ------------------------------------------------------------------ Befund 113
  it('Speichern auf veraltetem Stand: 409 statt stillem Überschreiben; Einreichen nur des gesehenen Stands', async () => {
    const did = await f.durchfuehrung('k1');
    const anfang = await merkmal(a.bearbeiter, did);
    // Durchführende Person speichert; die Vertretung hält noch den Anfangsstand.
    const r = await f.dienst(a.bearbeiter, (ctx) =>
      speichere(ctx, { ...ziel(did), ...vollstaendig('OHNE_BEFUND', 100), bisher: anfang }),
    );
    const e = await fehlerVon(
      f.dienst(a.vertretung, (ctx) =>
        speichere(ctx, { ...ziel(did), ...vollstaendig('OHNE_BEFUND', 7), bisher: anfang }),
      ),
    );
    expect(e.code).toBe('KONFLIKT');
    const z = await zeile(did);
    expect(z!.werte).toMatchObject({ saldoShop: { wert: 100 } });
    // Detail nennt dasselbe Merkmal wie das Ergebnis des Speicherns.
    const d = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(did)));
    expect(d.inhalt).toBe(r.inhalt);

    await f.dienst(a.bearbeiter, (ctx) =>
      haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
    );
    const e2 = await fehlerVon(
      f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, { ...ziel(did), bisher: anfang })),
    );
    expect(e2.code).toBe('KONFLIKT');
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, { ...ziel(did), bisher: r.inhalt }));
    expect((await zeile(did))!.status).toBe('ZUR_GEGENZEICHNUNG');
  });

  // ------------------------------------------------------------------ Befund 101
  it('Eingereichter und gegengezeichneter Inhalt stehen im Audit (Merkmal und Inhalt)', async () => {
    const did = await mitNachweis('k1', a.bearbeiter);
    const inhalt = await merkmal(a.bearbeiter, did);
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, ziel(did)));
    const [ein] = await audit(did, 'tcms.durchfuehrung.eingereicht');
    expect(ein!.detail).toMatchObject({
      inhalt,
      eingereicht: {
        ergebnis: 'OHNE_BEFUND',
        werte: { saldoShop: { wert: 100 }, saldoFibu: { wert: 100 } },
        schritte: [{ erledigt: true, kommentar: 'erledigt' }, { erledigt: true }],
      },
    });
    // Nach Zurückweisung und Überschreiben bleibt der eingereichte Wert im Audit.
    await f.dienst(a.pruefer, (ctx) =>
      weiseDurchfuehrungZurueck(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
    );
    await f.dienst(a.bearbeiter, (ctx) =>
      speichere(ctx, { ...ziel(did), ...vollstaendig('OHNE_BEFUND', 250) }),
    );
    const neu = await merkmal(a.bearbeiter, did);
    expect(neu).not.toBe(inhalt);
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, ziel(did)));
    await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
    const eingereicht = await audit(did, 'tcms.durchfuehrung.eingereicht');
    expect(eingereicht.map((x) => (x.detail as { inhalt: string }).inhalt)).toEqual([inhalt, neu]);
    const [gz] = await audit(did, 'tcms.durchfuehrung.gegengezeichnet');
    expect(gz!.detail).toMatchObject({ inhalt: neu });
  });

  // ------------------------------------------------------------------ Befund 16
  it('Entfallen freigeben nur für den gesehenen Antrag: zurückgezogen und neu gestellt → 409', async () => {
    const did = await f.durchfuehrung('k1');
    await f.dienst(a.bearbeiter, (ctx) =>
      beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
    );
    const gesehenerAntrag = (await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(did))))
      .entfallenAntrag!;
    expect(gesehenerAntrag).toMatch(/^[0-9a-f]{64}$/);
    await f.dienst(a.bearbeiter, (ctx) => lehneEntfallenAb(ctx, ziel(did)));
    await f.dienst(a.bearbeiter, (ctx) =>
      beantrageEntfallen(ctx, { ...ziel(did), begruendung: ANDERE }),
    );
    const e = await fehlerVon(
      f.dienst(a.bt, (ctx) => gibFrei(ctx, { ...ziel(did), antrag: gesehenerAntrag })),
    );
    expect(e.code).toBe('KONFLIKT');
    expect((await zeile(did))!.status).toBe('GEPLANT');
    const aktuell = (await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(did))))
      .entfallenAntrag!;
    await f.dienst(a.bt, (ctx) => gibFrei(ctx, { ...ziel(did), antrag: aktuell }));
    const [frei] = await audit(did, 'tcms.durchfuehrung.entfallen');
    expect(frei!.detail).toMatchObject({ begruendung: ANDERE, antrag: aktuell });
  });

  // ------------------------------------------------------------- Befunde 102/106
  it('Offener Entfallen-Antrag sperrt Speichern, Nachweise und Einreichen (Kennzeichen = Operation)', async () => {
    const did = await mitNachweis('k1', a.bearbeiter);
    await f.dienst(a.bt, (ctx) =>
      beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
    );
    const d = await f.dienst(a.bearbeiter, (ctx) => ladeDurchfuehrung(ctx, ziel(did)));
    expect(d.rechte.bearbeiten).toEqual({
      erlaubt: false,
      grund: 'Entfallen beantragt — zuerst über den Antrag entscheiden',
      verweigerung: null,
    });
    for (const op of [
      (ctx: Parameters<typeof speichere>[0]): Promise<unknown> =>
        speichere(ctx, { ...ziel(did), ...vollstaendig() }),
      (ctx: Parameters<typeof speichere>[0]): Promise<unknown> => reicheEin(ctx, ziel(did)),
      (ctx: Parameters<typeof speichere>[0]): Promise<unknown> =>
        haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }),
    ]) {
      const e = await fehlerVon(f.dienst(a.bearbeiter, op));
      expect(e.code).toBe('KONFLIKT');
    }
    // Nach der Entscheidung (abgelehnt) wieder bearbeitbar; der Antrag ist weg.
    await f.dienst(a.bt2, (ctx) =>
      lehneEntfallenAb(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
    );
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, ziel(did)));
    const z = await zeile(did);
    expect([z!.status, z!.entfallenBegruendung, z!.entfallenVon]).toEqual([
      'ZUR_GEGENZEICHNUNG',
      null,
      null,
    ]);
  });

  it('Portal: offener Antrag sperrt mit neutralem Grund; Begründung und Kanzlei-Kennzeichen verraten ihn nicht (Befund 109)', async () => {
    const did = await f.durchfuehrung('k2');
    await f.dienst(a.ma, (ctx) => beginneDurchfuehrung(ctx, ziel(did)));
    const vorher = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
    await f.dienst(a.bt, (ctx) =>
      beantrageEntfallen(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
    );
    const nachher = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
    expect(nachher.entfallenBegruendung).toBeNull();
    expect(nachher.rechte.entfallenFreigeben).toEqual(vorher.rechte.entfallenFreigeben);
    expect(nachher.rechte.entfallenAblehnen).toEqual(vorher.rechte.entfallenAblehnen);
    expect(nachher.rechte.entfallenFreigeben).toMatchObject({ verweigerung: 'PARTEI' });
    expect(nachher.rechte.bearbeiten.erlaubt).toBe(false);
    expect(nachher.rechte.bearbeiten.grund).not.toMatch(/Entfallen/);
    const e = await fehlerVon(
      f.dienst(a.ma, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig() })),
    );
    expect(e.code).toBe('KONFLIKT');
    expect(e.message).not.toMatch(/Entfallen|Begründung/);
    // Nach der Freigabe zeigt das Portal die Begründung des Entfallens.
    await f.dienst(a.bt2, (ctx) => gibFrei(ctx, ziel(did)));
    const entfallen = await f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
    expect([entfallen.status, entfallen.entfallenBegruendung]).toEqual(['ENTFALLEN', BEGRUENDUNG]);
  });

  it('Rest eines Antrags an einer abgeschlossenen Durchführung zählt nicht als offen (Befund 102 a)', async () => {
    const did = await mitNachweis('k1', a.bearbeiter);
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, ziel(did)));
    await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
    // Altbestand: Antrag an einer schon abgeschlossenen Zeile (vor dieser Regel möglich).
    await f.tx((tx) =>
      tx.durchfuehrung.update({
        where: { id: did },
        data: { entfallenBegruendung: BEGRUENDUNG, entfallenVon: f.p.bearbeiter },
      }),
    );
    const d = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(did)));
    expect([d.entfallenBegruendung, d.entfallenVon, d.entfallenAntrag]).toEqual([null, null, null]);
    expect(d.rechte.entfallenFreigeben.grund).toBe('Kein Antrag offen');
  });

  // --------------------------------------------------------------- Befund 102 d
  it('CHECK: Begründung des Antrags nur zusammen mit der antragstellenden Person', async () => {
    const did = await f.durchfuehrung('k1');
    await dbAbgewiesen(
      f.tx((tx) =>
        tx.durchfuehrung.update({
          where: { id: did },
          data: { entfallenBegruendung: BEGRUENDUNG },
        }),
      ),
      regel.check('Durchfuehrung', 'Durchfuehrung_entfallen_antrag_check'),
    );
    await dbAbgewiesen(
      f.tx((tx) =>
        tx.durchfuehrung.update({ where: { id: did }, data: { entfallenVon: f.p.bearbeiter } }),
      ),
      regel.check('Durchfuehrung', 'Durchfuehrung_entfallen_antrag_check'),
    );
  });

  // ------------------------------------------------------------------ Befund 13
  it('Neuplanung löscht keine geplante Durchführung mit offenem Entfallen-Antrag', async () => {
    await f.tx((tx) =>
      tx.tcmsProgramm.update({
        where: { id: f.programm },
        data: { wirksamAb: tag('2026-01-01'), wirksamBis: tag('2026-12-31') },
      }),
    );
    const nov = await f.durchfuehrung('k1', {
      periodeLabel: 'November 2026',
      periodeVon: tag('2026-11-01'),
      periodeBis: tag('2026-11-30'),
      faelligAm: tag('2026-12-30'),
    });
    const dez = await f.durchfuehrung('k1', {
      periodeLabel: 'Dezember 2026',
      periodeVon: tag('2026-12-01'),
      periodeBis: tag('2026-12-31'),
      faelligAm: tag('2027-01-30'),
    });
    await f.dienst(a.bearbeiter, (ctx) =>
      beantrageEntfallen(ctx, { ...ziel(nov), begruendung: BEGRUENDUNG }),
    );
    const heute = tag('2026-10-16');
    const r = await f.tx((tx) =>
      planeDurchfuehrungenNeu(tx, {
        programmId: f.programm,
        kontrolleId: f.k1.id,
        code: 'K-T-01',
        standId: f.k1.standId,
        faelligNachTagen: 30,
        turnusVorher: 'MONATLICH',
        turnusNachher: 'QUARTALSWEISE',
        heute,
        zeitpunkt: addTage(heute, 0),
      }),
    );
    expect(r?.entfernt).toContain('Dezember 2026');
    expect(r?.entfernt).not.toContain('November 2026');
    expect(await zeile(dez)).toBeNull();
    const bleibt = await zeile(nov);
    expect([bleibt?.status, bleibt?.entfallenBegruendung]).toEqual(['GEPLANT', BEGRUENDUNG]);
  });

  // ------------------------------------------------------------- Befunde 40/103
  it('Gegenzeichnung mit Befund: eine verworfene Feststellung deckt keinen Befund ab', async () => {
    const did = await mitNachweis('k1', a.bearbeiter, 'MIT_BEFUND');
    await f.dienst(a.bearbeiter, (ctx) => reicheEin(ctx, ziel(did)));
    await f.tx((tx) =>
      tx.feststellung.create({
        data: {
          programmId: f.programm,
          nummer: `2026-F-${randomBytes(2).toString('hex')}`,
          titel: 'Falsch zugeordnet',
          sachverhalt: 'Wurde der falschen Durchführung zugeordnet.',
          quelle: 'KONTROLLE',
          quelleText: 'K-T-01',
          durchfuehrungId: did,
          klasse: 'HINWEIS',
          schwere: 'GERING',
          auswirkung: 'NEIN',
          status: 'VERWORFEN',
          erfasstVon: f.p.bearbeiter,
        },
      }),
    );
    const e = await fehlerVon(
      f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
    );
    expect([e.code, e.felder]).toEqual([
      'UNGUELTIG',
      { feststellung: ['Pflicht bei Ergebnis „mit Befund"'] },
    ]);
    const r = await f.dienst(a.pruefer, (ctx) =>
      gegenzeichneDurchfuehrung(ctx, {
        ...ziel(did),
        feststellung: {
          titel: 'Differenz Clearingkonto',
          sachverhalt: 'Die Differenz im Clearingkonto ist nicht geklärt.',
          klasse: 'DURCHFUEHRUNGSMANGEL',
          schwere: 'MITTEL',
          auswirkung: 'UNKLAR',
          risikoIds: [f.risiko],
        },
      }),
    );
    expect(r.status).toBe('MIT_BEFUND');
    const neu = await f.tx((tx) =>
      tx.feststellung.findUniqueOrThrow({ where: { id: r.feststellung!.id } }),
    );
    expect(neu.status).toBe('ERFASST');
  });

  // ------------------------------------------------------------------ Befund 108
  it('Portal-Anlagen: Dateityp und Größe wie Portal-Meldungen; Höchstzahlen je Durchführung', async () => {
    const did = await f.durchfuehrung('k2');
    for (const [over, feld] of [
      [{ mime: 'text/html' }, 'verweis.mime'],
      [{ groesse: 20 * 1024 * 1024 }, 'verweis.groesse'],
    ] as const) {
      const e = await fehlerVon(
        f.dienst(a.ma, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis(over) })),
      );
      expect(e.code).toBe('UNGUELTIG');
      expect(Object.keys(e.felder ?? {})).toEqual([feld]);
    }
    // Kanzlei: Typ und Größe bestimmt die kanzleikonsole (unverändert zulässig).
    const k1 = await f.durchfuehrung('k1');
    await f.dienst(a.bearbeiter, (ctx) =>
      haengeNachweisAn(ctx, { ...ziel(k1), verweis: verweis({ mime: 'text/html' }) }),
    );

    const zeilen = (anzahl: number, entfernt: boolean) =>
      Array.from({ length: anzahl }, () => {
        const v = verweis();
        return {
          durchfuehrungId: did,
          dokumentId: v.dokumentId,
          dateiname: v.dateiname,
          mime: v.mime,
          groesse: v.groesse,
          sha256: v.sha256,
          hochgeladenVon: f.p.ma,
          ...(entfernt ? { entferntAm: new Date(), entferntVon: f.p.ma } : {}),
        };
      });
    await f.dienst(a.ma, (ctx) => beginneDurchfuehrung(ctx, ziel(did)));
    await f.tx((tx) => tx.nachweis.createMany({ data: zeilen(DF_MAX_NACHWEISE, false) }));
    const e1 = await fehlerVon(
      f.dienst(a.ma, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() })),
    );
    expect(e1.code).toBe('KONFLIKT');
    // Entfernen und erneut Anhängen ist ebenfalls begrenzt (alle Verweise zählen).
    await f.tx((tx) =>
      tx.nachweis.updateMany({
        where: { durchfuehrungId: did },
        data: { entferntAm: new Date(), entferntVon: f.p.ma },
      }),
    );
    await f.tx((tx) =>
      tx.nachweis.createMany({ data: zeilen(DF_MAX_NACHWEIS_VERWEISE - DF_MAX_NACHWEISE, true) }),
    );
    const e2 = await fehlerVon(
      f.dienst(a.ma, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() })),
    );
    expect(e2.code).toBe('KONFLIKT');
  });
});
