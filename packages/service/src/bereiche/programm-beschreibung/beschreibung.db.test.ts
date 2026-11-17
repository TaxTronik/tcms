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
import {
  AUDIT_SPERRE,
  mitTenant,
  pruefeAuditKette,
  tenantSperre,
  type PrismaClient,
} from '@tcms/db';
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
import { speichereEinrichtungsschritt } from './einrichtung';
import { adressiereFreigabeNeu, erteileFreigabe } from './freigaben';
import { ladeFreigabenHistorie } from './kommunikation';
import { imDienst } from '../../kontext';
import { CODE_GUELTIG_TAGE } from './code';
import {
  gesehen,
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
  TEST_PORTS,
  warteAufSperrwartende,
  zweiteVerbindung,
  type Welt,
} from './testwelt';
import { personen, richteEin, SCHRITT1 } from './testprogramm';

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
    await im(btA(w), async (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(n.versionId))),
    );
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

  it('Richtungssteuerzeichen: neue Texte abgewiesen; gespeicherte bleiben lesbar und gehen beim Speichern nicht verloren (tcms-s9)', async () => {
    for (const t of ['Betrag \u202e001\u202c EUR', 'Text \u2066isoliert\u2069']) {
      const f = await fehlerVon(abschnitt(erste, t));
      expect(f.code).toBe('UNGUELTIG');
      expect(JSON.stringify(f.felder)).toContain('Unzulässige Zeichen');
    }
    // Altbestand: ein Text aus der Zeit vor der Regel, unterhalb des Dienstes gespeichert.
    const alt = 'Ziele \u2067alt\u2069 aus der Zeit vor der Regel';
    await inWelt(w, async (tx) => {
      const v0 = await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: erste } });
      const abschnitte = (v0.abschnitte as { key: string }[]).filter((a) => a.key !== 'ziele');
      abschnitte.push({ key: 'ziele', bloecke: [{ typ: 'text', text: alt }] } as never);
      await tx.beschreibungVersion.update({ where: { id: erste }, data: { abschnitte } });
    });
    // Ein anderer Abschnitt wird gespeichert: der alte Text bleibt (früher: leerer Block).
    await abschnitt(erste, 'Kultur nach der Regel.');
    const b = await im(hbA(w), (ctx) => ladeBeschreibung(ctx, { mandantId: w.mandantA }));
    expect(BeschreibungViewSchema.parse(b)).toEqual(b);
    const ver = b.versionen.find((x) => x.id === erste)!;
    expect(ver.abschnitte.find((a) => a.key === 'ziele')?.bloecke).toEqual(text(alt));
    expect(ver.abschnitte.find((a) => a.key === 'kultur')?.bloecke).toEqual(
      text('Kultur nach der Regel.'),
    );
  });

  it('Vier-Augen: die letzte Bearbeitung schließt die Review nicht ab (auch nicht in anderer Schreibweise)', async () => {
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, v(erste)));
    const k = await fehlerVon(abschnitt(erste, 'Änderung in der Review'));
    expect(k.code).toBe('KONFLIKT');
    const gross = kanzlei(w, w.hb.toUpperCase(), w.mandantA, { hb: true });
    for (const a of [hbA(w), gross]) {
      const f = await fehlerVon(
        im(a, async (ctx) => schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(erste)))),
      );
      expect([f.code, f.grund]).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);
      expect(f.message).toContain('zweite Person');
    }
    const ok = await im(btA(w), async (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(erste))),
    );
    expect(ok.status).toBe('KANZLEI_REVIEW');
    const nochmal = await fehlerVon(
      im(btA(w), async (ctx) =>
        schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(erste))),
      ),
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
      () =>
        im(ohneRechtA(w), async (ctx) =>
          schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(n.id))),
        ),
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
        () =>
          im(a, async (ctx) => schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(n.id)))),
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
      () =>
        im(btA(w), async (ctx) =>
          schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, v(fremd.versionId))),
        ),
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
        () => im(p1, async (ctx) => schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, vm))),
        () =>
          im(
            p2,
            async (ctx) => schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, vm)),
            zweite,
          ),
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

  // ---------------------------------------------------------------------------
  // Prüfung vom 17.11.2026 (Befunde 15, 19/58, 59, 60, 100)
  // ---------------------------------------------------------------------------

  /** Eigener Mandant mit eingerichtetem Programm (unabhängig von den Versionen oben). */
  async function eigenerMandant() {
    const m = await neuerMandant(w);
    await richteEin(w, m.mandantId, m.gv);
    return { ...m, a: btFuer(w, m.mandantId), hb: kanzlei(w, w.hb, m.mandantId, { hb: true }) };
  }
  const vom = (mandantId: string, versionId: string) => ({ mandantId, versionId });
  const imUhr = <T>(a: Parameters<typeof im>[0], tag: string, fn: Parameters<typeof im<T>>[1]) =>
    imDienst(
      a,
      { ...TEST_PORTS, uhr: { jetzt: () => new Date(`${tag}T09:00:00.000Z`), heute: () => tag } },
      fn,
    );

  it('Vier-Augen: keine bearbeitende Person schließt ab, auch nach einem Fremd-Edit (Befund 100)', async () => {
    const m = await eigenerMandant();
    const n = await im(m.hb, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId }));
    const ab = (t: string, a: Parameters<typeof im>[0]) =>
      im(a, (ctx) =>
        speichereBeschreibungsabschnitt(ctx, {
          ...vom(m.mandantId, n.versionId),
          key: 'kultur',
          bloecke: text(t),
        }),
      );
    await ab('Text der Hauptbearbeitung, fast vollständig.', m.hb);
    await ab('Text der Hauptbearbeitung, fast vollständig, mit Komma.', m.a); // Fremd-Edit (BT)
    await im(m.hb, (ctx) => gibBeschreibungZurReview(ctx, vom(m.mandantId, n.versionId)));
    for (const a of [m.hb, m.a]) {
      const f = await fehlerVon(
        im(a, async (ctx) =>
          schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, vom(m.mandantId, n.versionId))),
        ),
      );
      expect([f.code, f.grund], a.id).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);
    }
    const lesen = await im(m.a, (ctx) => ladeBeschreibung(ctx, { mandantId: m.mandantId }));
    expect(lesen.versionen.at(-1)!.bearbeitende).toEqual([w.hb, w.bt]);
    // Eine dritte Person (Kanzleileitung) schließt ab; das Audit nennt alle Bearbeitenden.
    const dritte = kanzlei(w, randomUUID(), m.mandantId, { admin: true });
    await im(dritte, async (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, vom(m.mandantId, n.versionId))),
    );
    const audit = await auditZu(w, n.versionId);
    expect(audit.at(-1)!.detail).toMatchObject({
      bearbeitende: [w.hb, w.bt],
      abschnitteSha256: lesen.versionen.at(-1)!.abschnitteSha256,
    });
  });

  it('Review-Abschluss gilt nur dem gesehenen Text (Befund 15)', async () => {
    const m = await eigenerMandant();
    const n = await im(m.hb, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId }));
    const id = vom(m.mandantId, n.versionId);
    const ab = (t: string) =>
      im(m.hb, (ctx) =>
        speichereBeschreibungsabschnitt(ctx, { ...id, key: 'kultur', bloecke: text(t) }),
      );
    await ab('Erster Text zur Review.');
    await im(m.hb, (ctx) => gibBeschreibungZurReview(ctx, id));
    // B lädt die Version (gesehener Text) …
    const alt = (
      await im(m.a, (ctx) => ladeBeschreibung(ctx, { mandantId: m.mandantId }))
    ).versionen.at(-1)!.abschnitteSha256!;
    // … A weist zurück, ändert den Text und gibt erneut zur Review.
    await im(m.hb, (ctx) =>
      weiseBeschreibungsreviewZurueck(ctx, { ...id, begruendung: BEGRUENDUNG }),
    );
    await ab('Geänderter Text, den B nie gesehen hat.');
    await im(m.hb, (ctx) => gibBeschreibungZurReview(ctx, id));
    const f = await fehlerVon(
      im(m.a, (ctx) => schliesseBeschreibungsreviewAb(ctx, { ...id, abschnitteSha256: alt })),
    );
    expect(f.code).toBe('KONFLIKT');
    const v0 = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findUniqueOrThrow({ where: { id: n.versionId } }),
    );
    expect(v0.reviewVon).toBeNull();
    const neu = (
      await im(m.a, (ctx) => ladeBeschreibung(ctx, { mandantId: m.mandantId }))
    ).versionen.at(-1)!.abschnitteSha256!;
    expect(neu).not.toBe(alt);
    const r = await im(m.a, (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, { ...id, abschnitteSha256: neu }),
    );
    expect(r.status).toBe('KANZLEI_REVIEW');
  });

  it('neue Version und Freigabe nur für ein eingerichtetes Programm (Befund 59)', async () => {
    const m = await neuerMandant(w);
    const a = btFuer(w, m.mandantId);
    await im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        mandantId: m.mandantId,
        ziel: 'speichern',
        personen: personen(w),
        schritt: 1,
        daten: SCHRITT1,
      }),
    );
    const f = await fehlerVon(
      im(a, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId })),
    );
    expect(f.code).toBe('KONFLIKT');
    expect(f.message).toContain('noch kein Tax-CMS eingerichtet');
    expect(
      await inWelt(w, (tx) =>
        tx.beschreibungVersion.count({ where: { programm: { mandantId: m.mandantId } } }),
      ),
    ).toBe(0);
  });

  it('Freigeben (GV) und neue Anforderung gleichzeitig: kein falsches Zurückziehen, keine Verklemmung (Befunde 19/58)', async () => {
    const m = await eigenerMandant();
    // V1 beim Mandanten (Code angefordert), V2 mit abgeschlossener Review.
    const bis = async () => {
      const n = await im(m.hb, (ctx) =>
        legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId }),
      );
      const id = vom(m.mandantId, n.versionId);
      await im(m.hb, (ctx) =>
        speichereBeschreibungsabschnitt(ctx, { ...id, key: 'kultur', bloecke: text(randomUUID()) }),
      );
      await im(m.hb, (ctx) => gibBeschreibungZurReview(ctx, id));
      await im(m.a, async (ctx) => schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, id)));
      return n.versionId;
    };
    const anf = (versionId: string) => ({
      ...vom(m.mandantId, versionId),
      empfaengerId: m.gv,
      verantwortung: { berufstraeger: null, bearbeitung: null },
      namen: [],
    });
    const v1 = await bis();
    const f1 = await im(m.a, (ctx) => fordereBeschreibungsfreigabeAn(ctx, anf(v1)));
    const v2 = await bis();
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { empfaengerId: m.gv, zweck: 'FREIGABE_CODE' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const gv = kontakt(w, m.gv, m.mandantId);
    // Reihenfolge erzwingen: Eine Testtransaktion hält die Audit-Sperre. Das Freigeben (T_B)
    // ändert F1 und V1 und wartet vor dem Commit; erst dann startet die Anforderung (T_A).
    let loesen!: () => void;
    const ende = new Promise<void>((r) => (loesen = r));
    let gesperrt!: () => void;
    const bereit = new Promise<void>((r) => (gesperrt = r));
    const halter = mitTenant(
      w.tenantId,
      async (tx) => {
        await tenantSperre(tx, AUDIT_SPERRE);
        gesperrt();
        await ende;
      },
      { timeoutMs: 20_000 },
    );
    await bereit;
    const tB = im(gv, (ctx) =>
      erteileFreigabe(ctx, { mandantId: m.mandantId, freigabeId: f1.freigabeId, code: n.code! }),
    );
    expect(await warteAufSperrwartende(w, 1)).toBe(true);
    const tA = im(m.a, (ctx) => fordereBeschreibungsfreigabeAn(ctx, anf(v2)), zweite);
    expect(await warteAufSperrwartende(w, 2)).toBe(true);
    loesen();
    await halter;
    // Beide gelingen (keine Verklemmung, kein 500); nichts wird fälschlich zurückgezogen.
    const [freigeben, anfordern2] = await Promise.all([tB, tA]);
    expect(freigeben.freigegeben).toBe(true);
    expect(anfordern2.zurueckgezogen).toEqual([]);
    const [alt, audit] = await inWelt(w, async (tx) => [
      await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: v1 } }),
      await tx.auditEvent.findMany({ where: { objektId: v1 }, orderBy: { pos: 'asc' } }),
    ]);
    expect(alt.status).toBe('FREIGEGEBEN');
    expect(audit.map((x) => x.aktion)).not.toContain('tcms.beschreibung.freigabe_zurueckgezogen');
  });

  it('Stichtag: Snapshot erst ab Anforderung, Bearbeitende bis zum Stichtag, Empfänger zum Stichtag (Befund 60)', async () => {
    const m = await neuerMandant(w);
    const gv2 = randomUUID();
    await inWelt(w, (tx) =>
      tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: gv2, rolle: 'GESETZLICHER_VERTRETER' },
      }),
    );
    await richteEin(w, m.mandantId, m.gv);
    const a = btFuer(w, m.mandantId);
    const hb = kanzlei(w, w.hb, m.mandantId, { hb: true });
    // Version am 21.10. angelegt, am 25.10. geprüft und eingefroren (fachliche Zeit); die
    // Textänderung und die Neuadressierung stehen mit echter Zeit (danach) im Audit.
    const n = await imUhr(hb, '2026-10-21', (ctx) =>
      legeBeschreibungsversionAn(ctx, { mandantId: m.mandantId }),
    );
    const id = vom(m.mandantId, n.versionId);
    await im(hb, (ctx) =>
      speichereBeschreibungsabschnitt(ctx, { ...id, key: 'kultur', bloecke: text('Kultur') }),
    );
    await imUhr(hb, '2026-10-25', (ctx) => gibBeschreibungZurReview(ctx, id));
    await imUhr(a, '2026-10-25', async (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, await gesehen(ctx.tx, id)),
    );
    const fr = await imUhr(a, '2026-10-25', (ctx) =>
      fordereBeschreibungsfreigabeAn(ctx, {
        ...id,
        empfaengerId: m.gv,
        verantwortung: { berufstraeger: null, bearbeitung: null },
        namen: [],
      }),
    );
    // Danach (echte Zeit) neu adressiert.
    await im(a, (ctx) =>
      adressiereFreigabeNeu(ctx, {
        mandantId: m.mandantId,
        freigabeId: fr.freigabeId,
        empfaengerId: gv2,
      }),
    );
    const zum = (stand: string) =>
      imUhr(a, '2026-11-30', (ctx) => ladeBeschreibung(ctx, { mandantId: m.mandantId, stand }));
    // 22.10.: Entwurf ohne Snapshot; Textänderungen danach gekennzeichnet; Bearbeitende bis dahin.
    const frueh = await zum('2026-10-22');
    expect(BeschreibungViewSchema.parse(frueh)).toEqual(frueh);
    const vf = frueh.versionen.find((x) => x.id === n.versionId)!;
    expect(vf).toMatchObject({
      anzeige: 'ENTWURF',
      snapshot: null,
      snapshotSha256: null,
      snapshotGeprueft: null,
      abschnitteSpaeterGeaendert: true,
      abschnitteSha256: null,
      letzteBearbeitung: w.hb, // angelegt von hb, Änderung erst danach (echte Zeit)
    });
    // 25.10.: angefordert; der Empfänger ist der am Stichtag, nicht der neu adressierte.
    const spaet = await zum('2026-10-25');
    expect(spaet.versionen.find((x) => x.id === n.versionId)!.snapshotSha256).toBe(
      fr.snapshotSha256,
    );
    expect(spaet.freigaben.find((x) => x.id === fr.freigabeId)!.empfaengerId).toBe(m.gv);
    const heute = await imUhr(a, '2026-11-30', (ctx) =>
      ladeBeschreibung(ctx, { mandantId: m.mandantId }),
    );
    expect(heute.freigaben.find((x) => x.id === fr.freigabeId)!.empfaengerId).toBe(gv2);
    expect(heute.versionen.find((x) => x.id === n.versionId)!.abschnitteSpaeterGeaendert).toBe(
      false,
    );
    const historie = await imUhr(a, '2026-11-30', (ctx) =>
      ladeFreigabenHistorie(ctx, { mandantId: m.mandantId, stand: '2026-10-25' }),
    );
    expect(historie.freigaben.find((x) => x.id === fr.freigabeId)!.empfaengerId).toBe(m.gv);
  });
});
