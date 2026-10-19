// =============================================================================
// CMS-Beschreibung gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app):
// Versionen, Abschnitte, Kanzlei-Review (Vier-Augen unter Sperre), Freigabe
// anfordern (Snapshot, SHA-256, Code nur als Hash, Nachricht über die ID),
// Rechte, Mandanten-/Tenant-Trennung, TS-05 und Audit.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BausteinSatzSchema,
  BeschreibungSnapshotSchema,
  BeschreibungViewSchema,
} from '@tcms/contract';
import { pruefeAuditKette, type PrismaClient } from '@tcms/db';
import { pruefeSnapshot } from './bausteine';
import {
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  ladeBeschreibung,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
  weiseBeschreibungsreviewZurueck,
} from './beschreibung';
import { CODE_GUELTIG_TAGE } from './code';
import {
  auditZu,
  baueWelt,
  btA,
  btFuer,
  fehlerVon,
  gleichzeitig,
  hbA,
  im,
  inWelt,
  kanzlei,
  kontakt,
  neuerMandant,
  nurEinErfolg,
  ohneRechtA,
  zweiteVerbindung,
  type Welt,
} from './testwelt';
import { richteEin } from './testprogramm';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Abschnitt 2 braucht noch die Wesentlichkeitsgrenzen je Ziel.';

describe.skipIf(!AKTIV)('CMS-Beschreibung (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;
  let programmA: string;

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
    programmA = await richteEin(w);
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  const v = (versionId: string, mandantId = w.mandantA) => ({ mandantId, versionId });
  const anfordern = (versionId: string, empfaengerId = w.gv, mandantId = w.mandantA) => ({
    ...v(versionId, mandantId),
    empfaengerId,
    verantwortung: {
      berufstraeger: { id: w.bt, name: 'StB Test Berufsträgerin' },
      bearbeitung: { id: w.hb, name: 'Test Bearbeitung' },
    },
    namen: [
      { id: w.gv, name: 'Gesetzliche Vertretung Test' },
      { id: w.tcb, name: 'TCB Test' },
    ],
  });
  const text = (t: string) => [{ typ: 'text' as const, text: t }];
  const neueVersion = (a = hbA(w), mandantId = w.mandantA) =>
    im(a, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId }));
  const abschnitt = (versionId: string, t: string, a = hbA(w)) =>
    im(a, (ctx) =>
      speichereBeschreibungsabschnitt(ctx, { ...v(versionId), key: 'kultur', bloecke: text(t) }),
    );

  /** Version bis „Review abgeschlossen" (Text von hb, Review durch bt). */
  async function bisReview(): Promise<string> {
    const n = await neueVersion();
    await abschnitt(n.versionId, `Kultur ${randomUUID()}`);
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, v(n.versionId)));
    await im(btA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, v(n.versionId)));
    return n.versionId;
  }

  let erste = '';

  it('legt die erste Version aus dem Gerüst an; eine zweite offene Version ist ein KONFLIKT', async () => {
    const leer = await im(btA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }));
    expect(leer.programmId).toBe(programmA);
    expect(leer.versionen).toEqual([]);
    const n = await neueVersion();
    expect(n).toMatchObject({ nummer: '1.0', basis: null });
    erste = n.versionId;
    const f = await fehlerVon(neueVersion(btA(w)));
    expect(f.code).toBe('KONFLIKT');
    const audit = await auditZu(w, n.versionId);
    expect(audit.map((a) => [a.aktion, a.actorId])).toEqual([
      ['tcms.beschreibung.version_angelegt', w.hb],
    ]);
  });

  it('speichert Abschnitte nur im Entwurf; ohne Änderung kein Audit; Eingaben geprüft', async () => {
    const r = await abschnitt(erste, 'Unsere Compliance-Kultur.\r\n');
    expect(r.geaendert).toBe(true);
    const gleich = await abschnitt(erste, 'Unsere Compliance-Kultur.');
    expect(gleich.geaendert).toBe(false);
    const audit = await auditZu(w, erste);
    expect(audit.filter((a) => a.aktion === 'tcms.beschreibung.abschnitt_geaendert')).toHaveLength(
      1,
    );
    for (const bloecke of [
      [{ typ: 'text', text: 'x'.repeat(20_001) }],
      [
        { typ: 'baustein', art: 'ZIELE' },
        { typ: 'baustein', art: 'ZIELE' },
      ],
      [{ typ: 'baustein', art: 'UNBEKANNT' }],
      [],
    ]) {
      const f = await fehlerVon(
        im(hbA(w), (ctx) =>
          speichereBeschreibungsabschnitt(ctx, { ...v(erste), key: 'kultur', bloecke } as never),
        ),
      );
      expect(f.code).toBe('UNGUELTIG');
    }
    const k = await fehlerVon(
      im(hbA(w), (ctx) =>
        speichereBeschreibungsabschnitt(ctx, {
          ...v(erste),
          key: 'fremd',
          bloecke: text('x'),
        } as never),
      ),
    );
    expect(k.code).toBe('UNGUELTIG');
  });

  it('Vier-Augen: die letzte Bearbeitung schließt die Review nicht ab (auch nicht in anderer Schreibweise)', async () => {
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, v(erste)));
    const k = await fehlerVon(abschnitt(erste, 'Änderung in der Review'));
    expect(k.code).toBe('KONFLIKT');
    const gross = kanzlei(w, w.hb.toUpperCase(), w.mandantA, { hb: true });
    for (const a of [hbA(w), gross]) {
      const f = await fehlerVon(im(a, (ctx) => schliesseBeschreibungsreviewAb(ctx, v(erste))));
      expect([f.code, f.grund]).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);
      expect(f.message).toContain('zweite Person');
    }
    const ok = await im(btA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, v(erste)));
    expect(ok.status).toBe('KANZLEI_REVIEW');
    const nochmal = await fehlerVon(
      im(btA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, v(erste))),
    );
    expect(nochmal.code).toBe('KONFLIKT');
    const audit = await auditZu(w, erste);
    expect(audit.at(-1)).toMatchObject({
      aktion: 'tcms.beschreibung.review_abgeschlossen',
      actorId: w.bt,
    });
    expect((audit.at(-1)!.detail as Record<string, unknown>)['letzteBearbeitung']).toBe(w.hb);
  });

  it('Freigabe anfordern: nur nach Review, nur an eine aktive GV des Mandanten (ID)', async () => {
    const n = await neueVersion(btA(w), w.mandantB).catch(() => null);
    expect(n).toBeNull(); // Mandant B hat kein Programm
    for (const empfaenger of [w.tcb, w.gvB, w.inaktiv, randomUUID()]) {
      const f = await fehlerVon(
        im(btA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(erste, empfaenger))),
      );
      expect(f.code, empfaenger).toBe('UNGUELTIG');
    }
  });

  it('Freigabe anfordern friert den Inhalt ein (SHA-256), Code nur als Hash, Nachricht über die ID', async () => {
    const vorher = Date.now();
    const r = await im(btA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(erste)));
    const [version, freigabe, nachrichten] = await inWelt(w, async (tx) => [
      await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: erste } }),
      await tx.freigabe.findUniqueOrThrow({ where: { id: r.freigabeId } }),
      await tx.nachricht.findMany({ where: { empfaengerId: w.gv, zweck: 'FREIGABE_CODE' } }),
    ]);
    expect(version.status).toBe('BEIM_MANDANTEN');
    expect(version.snapshotSha256).toBe(r.snapshotSha256);
    expect(pruefeSnapshot(version.snapshot, version.snapshotSha256)).toBe(true);
    const snap = version.snapshot as {
      bausteine: { VERANTWORTUNG: { rollen: { name: string }[] } };
    };
    expect(snap.bausteine.VERANTWORTUNG.rollen.map((x) => x.name)).toContain(
      'StB Test Berufsträgerin',
    );
    // Neue Snapshots: Gegenzeichnung beim Mandanten als Feld, nie als Textendung;
    // der eingefrorene Inhalt erfüllt sogar die strenge Form der lebenden Bausteine.
    const verantwortung = BeschreibungSnapshotSchema.parse(version.snapshot).bausteine!
      .VERANTWORTUNG!;
    expect(verantwortung.kontrollen.length).toBeGreaterThan(0);
    expect(BausteinSatzSchema.shape.VERANTWORTUNG.parse(verantwortung)).toEqual(verantwortung);
    for (const x of verantwortung.kontrollen) {
      expect(typeof x.gegenzeichnungMandant, x.code).toBe('boolean');
      expect(x.gegenzeichnung, x.code).not.toMatch(/\(Mandant\)/);
      if (x.gegenzeichnungMandant) expect(x.gegenzeichnungId, x.code).toBe(x.vertretungId);
    }
    expect(freigabe).toMatchObject({
      art: 'BESCHREIBUNG',
      refId: erste,
      empfaengerId: w.gv,
      status: 'OFFEN',
    });
    expect(freigabe.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(freigabe.codeFehlversuche).toBe(0);
    // Frist auf echter Zeit (nicht Testuhr 2026-10-19).
    const ablauf = freigabe.codeAblauf!.getTime();
    expect(ablauf).toBeGreaterThanOrEqual(vorher + CODE_GUELTIG_TAGE * 86_400_000 - 1000);
    expect(ablauf).toBeLessThanOrEqual(Date.now() + CODE_GUELTIG_TAGE * 86_400_000 + 1000);
    expect(nachrichten).toHaveLength(1);
    const code = /Bestätigungscode: (\d{6})/.exec(nachrichten[0]!.text)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(nachrichten[0]!.text).toContain(r.snapshotSha256);
    expect(nachrichten[0]!.text).not.toContain('Gesetzliche Vertretung Test');
    // Strukturiert (Stufe 4): Mandant, Empfängerart, Vorlagendaten; Code nur in `code`.
    expect(nachrichten[0]).toMatchObject({
      mandantId: w.mandantA,
      empfaengerArt: 'KONTAKT',
      code,
      daten: {
        freigabeId: r.freigabeId,
        art: 'BESCHREIBUNG',
        titel: `CMS-Beschreibung v${version.nummer}`,
        version: version.nummer,
        gueltigBis: freigabe.codeAblauf!.toISOString(),
        sha256: r.snapshotSha256,
      },
    });
    expect(JSON.stringify(nachrichten[0]!.daten)).not.toContain(code!);
    // Kein Code in Antwort und Audit.
    expect(JSON.stringify(r)).not.toContain(code!);
    const audit = await auditZu(w, erste);
    expect(audit.at(-1)).toMatchObject({
      aktion: 'tcms.beschreibung.freigabe_angefordert',
      actorId: w.bt,
    });
    for (const a of await inWelt(w, (tx) => tx.auditEvent.findMany())) {
      expect(JSON.stringify(a.detail)).not.toContain(code!);
    }
    // Eingefroren: keine Änderung, kein zweites Anfordern, keine Review mehr.
    for (const lauf of [
      () => abschnitt(erste, 'nachträglich'),
      () => im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, v(erste))),
      () => im(btA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(erste))),
      () =>
        im(btA(w), (ctx) =>
          weiseBeschreibungsreviewZurueck(ctx, { ...v(erste), begruendung: BEGRUENDUNG }),
        ),
    ]) {
      expect((await fehlerVon(lauf())).code).toBe('KONFLIKT');
    }
    const nach = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findUniqueOrThrow({ where: { id: erste } }),
    );
    expect(nach.snapshotSha256).toBe(version.snapshotSha256);
    expect(nach.abschnitte).toEqual(version.abschnitte);
  });

  it('neue Anforderung zieht eine offene ältere zurück (Code verfällt)', async () => {
    const zweite = await bisReview();
    const r = await im(btA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(zweite)));
    expect(r.zurueckgezogen).toEqual(['1.0']);
    const [alt, alteFreigabe] = await inWelt(w, async (tx) => [
      await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: erste } }),
      await tx.freigabe.findFirstOrThrow({ where: { refId: erste } }),
    ]);
    expect(alt.status).toBe('ABGELOEST');
    expect(alteFreigabe).toMatchObject({ status: 'ABGELEHNT', codeHash: null, codeAblauf: null });
  });

  it('Zurückweisen der Review: Begründung ≥ 30 Zeichen, zurück in den Entwurf, Audit mit Begründung', async () => {
    const n = await neueVersion();
    await abschnitt(n.versionId, 'Entwurfstext');
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, v(n.versionId)));
    const kurz = await fehlerVon(
      im(btA(w), (ctx) =>
        weiseBeschreibungsreviewZurueck(ctx, { ...v(n.versionId), begruendung: 'zu kurz' }),
      ),
    );
    expect(kurz.code).toBe('UNGUELTIG');
    const r = await im(btA(w), (ctx) =>
      weiseBeschreibungsreviewZurueck(ctx, { ...v(n.versionId), begruendung: BEGRUENDUNG }),
    );
    expect(r.status).toBe('ENTWURF');
    const audit = await auditZu(w, n.versionId);
    expect(audit.at(-1)).toMatchObject({
      aktion: 'tcms.beschreibung.review_zurueckgewiesen',
      actorId: w.bt,
    });
    const lesen = await im(btA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }));
    expect(BeschreibungViewSchema.parse(lesen)).toEqual(lesen);
    expect(lesen.zurueckweisungen.at(-1)).toMatchObject({
      versionId: n.versionId,
      begruendung: BEGRUENDUNG,
    });
    const gelesen = lesen.versionen.find((x) => x.id === n.versionId)!;
    expect(gelesen.letzteBearbeitung).toBe(w.hb);
    expect(lesen.freigaben.find((f) => f.refId === erste)?.codeStatus).toBe('KEIN');
    expect(lesen.versionen.find((x) => x.id === erste)?.snapshotGeprueft).toBe(true);
    expect(JSON.stringify(lesen)).not.toMatch(/codeHash|codeFehlversuche/);
  });

  it('Rechte: ohne Bearbeitungsrecht NICHT_BERECHTIGT; Lesen mit Bezug erlaubt', async () => {
    const n = (
      await im(btA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }))
    ).versionen.at(-1)!;
    for (const lauf of [
      () => neueVersion(ohneRechtA(w)),
      () => abschnitt(n.id, 'x', ohneRechtA(w)),
      () => im(ohneRechtA(w), (ctx) => gibBeschreibungZurReview(ctx, v(n.id))),
      () => im(ohneRechtA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, v(n.id))),
      () =>
        im(ohneRechtA(w), (ctx) =>
          weiseBeschreibungsreviewZurueck(ctx, { ...v(n.id), begruendung: BEGRUENDUNG }),
        ),
      () => im(ohneRechtA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(n.id))),
    ]) {
      expect(await fehlerVon(lauf())).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'BEARBEITEN',
      });
    }
    const lesen = await im(ohneRechtA(w), (ctx) =>
      ladeBeschreibung(ctx, { mandantId: w.mandantA }),
    );
    expect(lesen.darfBearbeiten).toBe(false);
  });

  it('fremder Mandant, Kontakt, fremder Tenant, Version eines anderen Mandanten: NICHT_GEFUNDEN', async () => {
    const m = await neuerMandant(w);
    await richteEin(w, m.mandantId, m.gv);
    const fremd = await neueVersion(btFuer(w, m.mandantId), m.mandantId);
    const n = (
      await im(btA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }))
    ).versionen.at(-1)!;
    const akteure = [
      btFuer(w, m.mandantId), // Bezug auf anderen Mandanten
      kontakt(w, w.gv, w.mandantA),
      kanzlei(w, w.bt, w.mandantA, {
        tenantId: randomUUID(),
        admin: true,
        bt: true,
        zustaendig: true,
      }),
    ];
    for (const a of akteure) {
      for (const lauf of [
        () => im(a, (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA })),
        () => neueVersion(a),
        () => abschnitt(n.id, 'x', a),
        () => im(a, (ctx) => gibBeschreibungZurReview(ctx, v(n.id))),
        () => im(a, (ctx) => schliesseBeschreibungsreviewAb(ctx, v(n.id))),
        () => im(a, (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(n.id))),
      ]) {
        const f = await fehlerVon(lauf());
        expect(f.code).toBe('NICHT_GEFUNDEN');
        expect(f.message).toBe('NICHT_GEFUNDEN');
      }
    }
    // Version des anderen Mandanten über den eigenen Mandanten adressiert.
    for (const lauf of [
      () => abschnitt(fremd.versionId, 'x', btA(w)),
      () => im(btA(w), (ctx) => gibBeschreibungZurReview(ctx, v(fremd.versionId))),
      () => im(btA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, v(fremd.versionId))),
      () =>
        im(btA(w), (ctx) =>
          weiseBeschreibungsreviewZurueck(ctx, { ...v(fremd.versionId), begruendung: BEGRUENDUNG }),
        ),
      () => im(btA(w), (ctx) => fordereBeschreibungsfreigabeAn(ctx, anfordern(fremd.versionId))),
      () => abschnitt('unbekannt123', 'x', btA(w)),
    ]) {
      expect((await fehlerVon(lauf())).code).toBe('NICHT_GEFUNDEN');
    }
    const unveraendert = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findUniqueOrThrow({ where: { id: fremd.versionId } }),
    );
    expect(unveraendert.status).toBe('ENTWURF');
  });

  it('TS-05: gleichzeitige neue Versionen und gleichzeitige Übergänge → genau eine Änderung', async () => {
    const m = await neuerMandant(w);
    await richteEin(w, m.mandantId, m.gv);
    const a = btFuer(w, m.mandantId);
    const anlage = nurEinErfolg(
      await gleichzeitig(w, [
        () => im(a, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId })),
        () => im(a, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId }), zweite),
      ]),
    );
    expect(anlage.fehlerCode).toBe('KONFLIKT');
    const versionen = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findMany({ where: { programm: { mandantId: m.mandantId } } }),
    );
    expect(versionen).toHaveLength(1);
    const id = versionen[0]!.id;
    const vm = { mandantId: m.mandantId, versionId: id };

    const review = nurEinErfolg(
      await gleichzeitig(w, [
        () => im(a, (ctx) => gibBeschreibungZurReview(ctx, vm)),
        () => im(a, (ctx) => gibBeschreibungZurReview(ctx, vm), zweite),
      ]),
    );
    expect(review.fehlerCode).toBe('KONFLIKT');

    // Zwei verschiedene zweite Personen schließen gleichzeitig ab: genau eine.
    const p1 = kanzlei(w, randomUUID(), m.mandantId, { admin: true });
    const p2 = kanzlei(w, randomUUID(), m.mandantId, { admin: true });
    const abschluss = nurEinErfolg(
      await gleichzeitig(w, [
        () => im(p1, (ctx) => schliesseBeschreibungsreviewAb(ctx, vm)),
        () => im(p2, (ctx) => schliesseBeschreibungsreviewAb(ctx, vm), zweite),
      ]),
    );
    expect(abschluss.fehlerCode).toBe('KONFLIKT');

    const anf = {
      mandantId: m.mandantId,
      versionId: id,
      empfaengerId: m.gv,
      verantwortung: { berufstraeger: null, bearbeitung: null },
      namen: [],
    };
    const freigabe = nurEinErfolg(
      await gleichzeitig(w, [
        () => im(a, (ctx) => fordereBeschreibungsfreigabeAn(ctx, anf)),
        () => im(a, (ctx) => fordereBeschreibungsfreigabeAn(ctx, anf), zweite),
      ]),
    );
    expect(freigabe.fehlerCode).toBe('KONFLIKT');
    const [freigaben, audit, kette] = await inWelt(w, async (tx) => [
      await tx.freigabe.count({ where: { refId: id } }),
      await tx.auditEvent.findMany({ where: { objektId: id }, orderBy: { pos: 'asc' } }),
      await pruefeAuditKette(tx),
    ]);
    expect(freigaben).toBe(1);
    expect(audit.map((x) => x.aktion)).toEqual([
      'tcms.beschreibung.version_angelegt',
      'tcms.beschreibung.review_angefordert',
      'tcms.beschreibung.review_abgeschlossen',
      'tcms.beschreibung.freigabe_angefordert',
    ]);
    expect(kette.gueltig).toBe(true);
  });

  it('Lesen zum Stichtag: spätere Schritte ausgeblendet (historisch, schreibgeschützt)', async () => {
    const lesen = await im(btA(w), (ctx) =>
      ladeBeschreibung(ctx, { mandantId: w.mandantA, stand: '2026-10-18' }),
    );
    expect(lesen.historisch).toBe(true);
    expect(lesen.darfBearbeiten).toBe(false);
    // Alle Versionen entstanden mit der Testuhr am 2026-10-19.
    expect(lesen.versionen).toEqual([]);
    const f = await fehlerVon(
      im(btA(w), (ctx) =>
        ladeBeschreibung(ctx, { mandantId: w.mandantA, stand: '18.10.2026' } as never),
      ),
    );
    expect(f.code).toBe('UNGUELTIG');
  });
});
