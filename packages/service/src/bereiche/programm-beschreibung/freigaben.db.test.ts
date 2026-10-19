// =============================================================================
// Freigaben gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app): Portal
// (lesen, Code anfordern, freigeben, Kenntnisnahme), Bestätigungscodes
// (Fehlversuche je Freigabe unter Sperre, Sperre, Ablauf auf echter Zeit,
// Einmalverwendung, keine Codes in Antworten/Audit), TS-06 (nur Empfänger,
// Neuadressierung durch die Kanzlei), Snapshot-Integrität, TS-05.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortalFreigabenViewSchema } from '@tcms/contract';
import { pruefeAuditKette, type PrismaClient } from '@tcms/db';
import {
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
} from './beschreibung';
import { MAX_FEHLVERSUCHE } from './code';
import {
  adressiereFreigabeNeu,
  bestaetigeKenntnisnahme,
  erteileFreigabe,
  fordereFreigabeCodeAn,
  ladePortalFreigaben,
} from './freigaben';
import {
  alsEigentuemerOhneTrigger,
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

describe.skipIf(!AKTIV)('Freigaben (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;
  let programmA = '';
  let zieleFreigabe = '';
  let beschreibungsFreigabe = '';
  let versionId = '';
  let kenntnisTcb = '';
  let kenntnisMa = '';
  let fremdeFreigabe = '';

  /** Code aus der jüngsten Code-Nachricht an die Person (wie die kanzleikonsole zustellt). */
  async function codeAusPostausgang(empfaengerId: string): Promise<string> {
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { empfaengerId, zweck: 'FREIGABE_CODE', zugestelltAm: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return /Bestätigungscode: (\d{6})/.exec(n.text)![1]!;
  }
  const falsch = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const fa = (freigabeId: string, mandantId = w.mandantA) => ({ mandantId, freigabeId });
  const freigabeZeile = (id: string) =>
    inWelt(w, (tx) => tx.freigabe.findUniqueOrThrow({ where: { id } }));
  async function weitereFreigabe(
    art: 'RISIKOAKZEPTANZ' | 'KENNTNISNAHME',
    empfaengerId: string,
    programmId = programmA,
  ) {
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId,
          art,
          refId: randomUUID(),
          titel: `${art} ${randomUUID().slice(0, 6)}`,
          inhalt: 'Inhalt zur Bestätigung',
          angefordertVon: w.bt,
          empfaengerId,
        },
      }),
    );
    return f.id;
  }

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
    programmA = await richteEin(w);
    zieleFreigabe = (
      await inWelt(w, (tx) =>
        tx.freigabe.findFirstOrThrow({ where: { programmId: programmA, art: 'ZIELE' } }),
      )
    ).id;
    const n = await im(hbA(w), (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: w.mandantA }));
    versionId = n.versionId;
    await im(hbA(w), (ctx) =>
      speichereBeschreibungsabschnitt(ctx, {
        mandantId: w.mandantA,
        versionId,
        key: 'kultur',
        bloecke: [{ typ: 'text', text: 'Kultur' }],
      }),
    );
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, { mandantId: w.mandantA, versionId }));
    await im(btA(w), (ctx) =>
      schliesseBeschreibungsreviewAb(ctx, { mandantId: w.mandantA, versionId }),
    );
    beschreibungsFreigabe = (
      await im(btA(w), (ctx) =>
        fordereBeschreibungsfreigabeAn(ctx, {
          mandantId: w.mandantA,
          versionId,
          empfaengerId: w.gv,
          verantwortung: { berufstraeger: null, bearbeitung: null },
          namen: [],
        }),
      )
    ).freigabeId;
    kenntnisTcb = await weitereFreigabe('KENNTNISNAHME', w.tcb);
    kenntnisMa = await weitereFreigabe('KENNTNISNAHME', w.ma);
    const m = await neuerMandant(w);
    const programmM = await richteEin(w, m.mandantId, m.gv);
    fremdeFreigabe = await weitereFreigabe('RISIKOAKZEPTANZ', m.gv, programmM);
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('Portal lesen: GV/TCB sehen alles des Mandanten, Mitarbeitende nur Eigenes; keine Codes', async () => {
    const gv = await im(kontakt(w, w.gv, w.mandantA), (ctx) =>
      ladePortalFreigaben(ctx, { mandantId: w.mandantA }),
    );
    expect(PortalFreigabenViewSchema.parse(gv)).toEqual(gv);
    expect(gv.istGesetzlicherVertreter).toBe(true);
    const ids = gv.freigaben.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([zieleFreigabe, beschreibungsFreigabe, kenntnisTcb, kenntnisMa]),
    );
    expect(ids).not.toContain(fremdeFreigabe);
    const b = gv.freigaben.find((f) => f.id === beschreibungsFreigabe)!;
    expect(b).toMatchObject({ darfFreigeben: true, istEmpfaenger: true, sperrgrund: null });
    expect(b.code).toMatchObject({ status: 'AKTIV', verbleibendeVersuche: MAX_FEHLVERSUCHE });
    expect(b.version?.snapshotGeprueft).toBe(true);
    expect(gv.freigaben.find((f) => f.id === kenntnisTcb)).toMatchObject({
      darfKenntnisnehmen: false,
      code: null,
    });
    expect(JSON.stringify(gv)).not.toMatch(/codeHash|codeFehlversuche/);
    const gespeichert = (await freigabeZeile(beschreibungsFreigabe)).codeHash!;
    expect(JSON.stringify(gv)).not.toContain(gespeichert);
    expect(JSON.stringify(gv)).not.toContain(await codeAusPostausgang(w.gv));

    const tcb = await im(kontakt(w, w.tcb, w.mandantA), (ctx) =>
      ladePortalFreigaben(ctx, { mandantId: w.mandantA }),
    );
    expect(tcb.freigaben.find((f) => f.id === beschreibungsFreigabe)).toMatchObject({
      darfFreigeben: false,
      sperrgrund: 'Freigaben sind der gesetzlichen Vertretung vorbehalten.',
      code: null,
    });
    const gv2 = await im(kontakt(w, w.gv2, w.mandantA), (ctx) =>
      ladePortalFreigaben(ctx, { mandantId: w.mandantA }),
    );
    expect(gv2.freigaben.find((f) => f.id === beschreibungsFreigabe)).toMatchObject({
      darfFreigeben: false,
      sperrgrund: 'Diese Freigabe ist an eine andere Person gerichtet.',
      code: null,
    });
    const ma = await im(kontakt(w, w.ma, w.mandantA), (ctx) =>
      ladePortalFreigaben(ctx, { mandantId: w.mandantA }),
    );
    expect(ma.freigaben.map((f) => f.id)).toEqual([kenntnisMa]);
    expect(ma.fruehere).toEqual([]);
  });

  it('Portal lesen: Kanzlei, fremder Mandant, inaktive/fehlende Rolle, fremder Tenant → NICHT_GEFUNDEN', async () => {
    for (const a of [
      btA(w),
      kontakt(w, w.gvB, w.mandantB),
      kontakt(w, w.inaktiv, w.mandantA),
      kontakt(w, randomUUID(), w.mandantA),
      kontakt(w, w.gv, w.mandantA, randomUUID()),
    ]) {
      const f = await fehlerVon(
        im(a, (ctx) => ladePortalFreigaben(ctx, { mandantId: w.mandantA })),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
  });

  it('TS-06: Code anfordern nur durch die adressierte GV; Fremdes unsichtbar', async () => {
    const vorher = await freigabeZeile(zieleFreigabe);
    const gv2 = await fehlerVon(
      im(kontakt(w, w.gv2, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(zieleFreigabe))),
    );
    expect(gv2).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      message: 'Diese Freigabe ist an eine andere Person gerichtet.',
    });
    const tcb = await fehlerVon(
      im(kontakt(w, w.tcb, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(zieleFreigabe))),
    );
    expect(tcb.code).toBe('NICHT_BERECHTIGT');
    // Adressiert, aber (nicht mehr) gesetzliche Vertretung: keine Freigabe mit Code.
    const anTcb = await weitereFreigabe('RISIKOAKZEPTANZ', w.tcb);
    const keineGv = await fehlerVon(
      im(kontakt(w, w.tcb, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(anTcb))),
    );
    expect(keineGv).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      message: 'Freigaben sind der gesetzlichen Vertretung vorbehalten.',
    });
    const ma = await fehlerVon(
      im(kontakt(w, w.ma, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(zieleFreigabe))),
    );
    expect(ma.code).toBe('NICHT_GEFUNDEN');
    const kenntnis = await fehlerVon(
      im(kontakt(w, w.gv, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(kenntnisTcb))),
    );
    expect(kenntnis.code).toBe('UNGUELTIG');
    for (const lauf of [
      () =>
        im(kontakt(w, w.gv, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(fremdeFreigabe))),
      () => im(kontakt(w, w.gv, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa('unbekannt'))),
      () => im(btA(w), (ctx) => fordereFreigabeCodeAn(ctx, fa(zieleFreigabe))),
      () =>
        im(kontakt(w, w.gv, w.mandantA, randomUUID()), (ctx) =>
          fordereFreigabeCodeAn(ctx, fa(zieleFreigabe)),
        ),
    ]) {
      expect((await fehlerVon(lauf())).code).toBe('NICHT_GEFUNDEN');
    }
    expect(await freigabeZeile(zieleFreigabe)).toEqual(vorher);
  });

  it('Code anfordern: neuer Code nur per Nachricht an die ID, nur Hash gespeichert, nie in Antwort/Audit', async () => {
    const r = await im(kontakt(w, w.gv, w.mandantA), (ctx) =>
      fordereFreigabeCodeAn(ctx, fa(zieleFreigabe)),
    );
    const code = await codeAusPostausgang(w.gv);
    const zeile = await freigabeZeile(zieleFreigabe);
    expect(zeile).toMatchObject({ codeFehlversuche: 0 });
    expect(zeile.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(zeile.codeHash).not.toContain(code);
    expect(JSON.stringify(r)).not.toContain(code);
    expect(Object.keys(r).sort()).toEqual(['codeAblauf', 'freigabeId']);
    const audit = await auditZu(w, zieleFreigabe);
    expect(audit.at(-1)).toMatchObject({ aktion: 'tcms.freigabe.code_angefordert', actorId: w.gv });
    expect(JSON.stringify(audit.map((a) => a.detail))).not.toContain(code);
  });

  it('Freigeben: falscher Code zählt unter Sperre, 5 Fehlversuche je Freigabe sperren (auch über neue Codes)', async () => {
    const id = await weitereFreigabe('RISIKOAKZEPTANZ', w.gv);
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    let code = await codeAusPostausgang(w.gv);
    for (const erwartet of [4, 3]) {
      const r = await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(code) }));
      expect(r).toEqual({
        freigegeben: false,
        freigabeId: id,
        grund: 'CODE_FALSCH',
        verbleibendeVersuche: erwartet,
      });
    }
    // Neuer Code setzt den Zähler nicht zurück.
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const neuer = await codeAusPostausgang(w.gv);
    expect(await freigabeZeile(id)).toMatchObject({ codeFehlversuche: 2 });
    // Der alte Code gilt nicht mehr (sofern er sich vom neuen unterscheidet).
    if (neuer !== code) {
      const alt = await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code }));
      expect(alt).toMatchObject({
        freigegeben: false,
        grund: 'CODE_FALSCH',
        verbleibendeVersuche: 2,
      });
    } else {
      await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(neuer) }));
    }
    code = neuer;
    await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(code) }));
    const letzter = await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(code) }));
    expect(letzter).toEqual({
      freigegeben: false,
      freigabeId: id,
      grund: 'GESPERRT',
      verbleibendeVersuche: 0,
    });
    const zeile = await freigabeZeile(id);
    expect(zeile).toMatchObject({
      status: 'OFFEN',
      codeHash: null,
      codeAblauf: null,
      codeFehlversuche: MAX_FEHLVERSUCHE,
    });
    // Gesperrt: auch der richtige Code und neue Codes helfen nicht.
    expect((await fehlerVon(im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code })))).code).toBe(
      'KONFLIKT',
    );
    expect((await fehlerVon(im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id))))).code).toBe(
      'KONFLIKT',
    );
    const audit = await auditZu(w, id);
    expect(audit.filter((a) => a.aktion === 'tcms.freigabe.code_falsch')).toHaveLength(
      MAX_FEHLVERSUCHE,
    );
    expect(audit.filter((a) => a.aktion === 'tcms.freigabe.code_gesperrt')).toHaveLength(1);
    expect(JSON.stringify(audit.map((a) => a.detail))).not.toContain(code);

    // Kanzlei adressiert neu (hier: dieselbe Person) → entsperrt, Audit.
    const n = await im(btA(w), (ctx) =>
      adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv }),
    );
    expect(n).toEqual({ freigabeId: id, vorherId: w.gv, empfaengerId: w.gv });
    expect(await freigabeZeile(id)).toMatchObject({
      codeHash: null,
      codeAblauf: null,
      codeFehlversuche: 0,
    });
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const ungueltig = await fehlerVon(
      im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: '12345' })),
    );
    expect(ungueltig.code).toBe('UNGUELTIG');
    const richtig = await im(gv, async (ctx) =>
      erteileFreigabe(ctx, { ...fa(id), code: await codeAusPostausgang(w.gv) }),
    );
    expect(richtig.freigegeben).toBe(true);
  });

  it('Freigeben: abgelaufener Code (echte Zeit) zählt nicht und gilt nicht', async () => {
    const id = await weitereFreigabe('RISIKOAKZEPTANZ', w.gv);
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const code = await codeAusPostausgang(w.gv);
    await inWelt(w, (tx) =>
      tx.freigabe.update({ where: { id }, data: { codeAblauf: new Date(Date.now() - 1000) } }),
    );
    const f = await fehlerVon(im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code })));
    expect(f).toMatchObject({ code: 'KONFLIKT' });
    expect(f.message).toContain('abgelaufen');
    expect((await freigabeZeile(id)).status).toBe('OFFEN');
    expect(await freigabeZeile(id)).toMatchObject({ codeFehlversuche: 0 });
  });

  it('TS-06: der richtige Code in der Hand einer anderen GV erteilt keine Freigabe', async () => {
    await im(kontakt(w, w.gv, w.mandantA), (ctx) =>
      fordereFreigabeCodeAn(ctx, fa(beschreibungsFreigabe)),
    );
    const code = await codeAusPostausgang(w.gv); // gültiger Code der Beschreibungsfreigabe (an gv)
    const f = await fehlerVon(
      im(kontakt(w, w.gv2, w.mandantA), (ctx) =>
        erteileFreigabe(ctx, { ...fa(beschreibungsFreigabe), code }),
      ),
    );
    expect(f.code).toBe('NICHT_BERECHTIGT');
    expect((await freigabeZeile(beschreibungsFreigabe)).status).toBe('OFFEN');
  });

  it('Beschreibung: veränderter Snapshot wird nicht freigegeben (fail closed, kein Versuch verbraucht)', async () => {
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(beschreibungsFreigabe)));
    const code = await codeAusPostausgang(w.gv);
    const original = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findUniqueOrThrow({ where: { id: versionId } }),
    );
    const verfaelscht = { ...(original.snapshot as Record<string, unknown>), nummer: '9.9' };
    // Die Laufzeitrolle kann eingefrorenen Inhalt nicht ändern (Trigger).
    await expect(
      inWelt(w, (tx) =>
        tx.beschreibungVersion.update({
          where: { id: versionId },
          data: { snapshot: verfaelscht },
        }),
      ),
    ).rejects.toThrow(/unveränderlich/);
    // Unterhalb des Dienstes verändert (Eigentümerrechte): der Hash fällt auf.
    const setze = (snapshot: unknown) =>
      alsEigentuemerOhneTrigger(
        w,
        'UPDATE "BeschreibungVersion" SET snapshot = $1::jsonb WHERE id = $2',
        JSON.stringify(snapshot),
        versionId,
      );
    expect(await setze(verfaelscht)).toBe(1);
    const f = await fehlerVon(
      im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(beschreibungsFreigabe), code })),
    );
    expect(f.code).toBe('KONFLIKT');
    expect(await freigabeZeile(beschreibungsFreigabe)).toMatchObject({ codeFehlversuche: 0 });
    expect(await setze(original.snapshot)).toBe(1);
  });

  it('Freigeben mit richtigem Code: Beschreibung unveränderlich freigegeben, Code nur einmal verwendbar', async () => {
    const gv = kontakt(w, w.gv, w.mandantA);
    const code = await codeAusPostausgang(w.gv);
    const vorher = await inWelt(w, (tx) =>
      tx.beschreibungVersion.findUniqueOrThrow({ where: { id: versionId } }),
    );
    const r = await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(beschreibungsFreigabe), code }));
    expect(r).toMatchObject({ freigegeben: true, freigabeId: beschreibungsFreigabe });
    const [freigabe, version, kette] = await inWelt(w, async (tx) => [
      await tx.freigabe.findUniqueOrThrow({ where: { id: beschreibungsFreigabe } }),
      await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: versionId } }),
      await pruefeAuditKette(tx),
    ]);
    expect(freigabe).toMatchObject({ status: 'FREIGEGEBEN', codeHash: null, codeAblauf: null });
    expect(version).toMatchObject({
      status: 'FREIGEGEBEN',
      freigegebenVon: w.gv,
      snapshotSha256: vorher.snapshotSha256,
    });
    expect(version.snapshot).toEqual(vorher.snapshot);
    expect(kette.gueltig).toBe(true);
    const audit = await auditZu(w, versionId);
    expect(audit.at(-1)).toMatchObject({ aktion: 'tcms.beschreibung.freigegeben', actorId: w.gv });
    const wieder = await fehlerVon(
      im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(beschreibungsFreigabe), code })),
    );
    expect(wieder.code).toBe('KONFLIKT');
    // Unveränderlich: Abschnitt speichern und Review sind Konflikte.
    for (const lauf of [
      () =>
        im(btA(w), (ctx) =>
          speichereBeschreibungsabschnitt(ctx, {
            mandantId: w.mandantA,
            versionId,
            key: 'kultur',
            bloecke: [{ typ: 'text', text: 'neu' }],
          }),
        ),
      () =>
        im(btA(w), (ctx) => gibBeschreibungZurReview(ctx, { mandantId: w.mandantA, versionId })),
    ]) {
      expect((await fehlerVon(lauf())).code).toBe('KONFLIKT');
    }
  });

  it('Ziele freigeben: alle offenen Ziele des Teilbereichs durch die GV', async () => {
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(zieleFreigabe)));
    const neu = await codeAusPostausgang(w.gv);
    expect(neu).toMatch(/^\d{6}$/);
    const r = await im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(zieleFreigabe), code: neu }));
    expect(r.freigegeben).toBe(true);
    const ziele = await inWelt(w, (tx) =>
      tx.complianceZiel.findMany({ where: { teilbereich: { programmId: programmA } } }),
    );
    expect(ziele.length).toBeGreaterThan(0);
    expect(ziele.every((z) => z.freigabe === 'FREIGEGEBEN' && z.freigegebenVon === w.gv)).toBe(
      true,
    );
  });

  it('TS-05: gleichzeitige Fehlversuche werden alle gezählt; gleichzeitiges Freigeben genau einmal', async () => {
    const id = await weitereFreigabe('RISIKOAKZEPTANZ', w.gv);
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const code = await codeAusPostausgang(w.gv);
    const fehl = await gleichzeitig(w, [
      () => im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(code) })),
      () => im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: falsch(code) }), zweite),
    ]);
    expect(fehl.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(await freigabeZeile(id)).toMatchObject({ codeFehlversuche: 2 });
    const e = nurEinErfolg(
      await gleichzeitig(w, [
        () => im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code })),
        () => im(gv, (ctx) => erteileFreigabe(ctx, { ...fa(id), code }), zweite),
      ]),
    );
    expect(e.fehlerCode).toBe('KONFLIKT');
    const audit = await auditZu(w, id);
    expect(audit.filter((a) => a.aktion === 'tcms.freigabe.erteilt')).toHaveLength(1);
  });

  it('Kenntnisnahme: nur die adressierte Person, genau einmal', async () => {
    const tcb = kontakt(w, w.tcb, w.mandantA);
    const gvF = await fehlerVon(
      im(kontakt(w, w.gv, w.mandantA), (ctx) =>
        bestaetigeKenntnisnahme(ctx, { ...fa(kenntnisTcb), gelesen: true }),
      ),
    );
    expect(gvF.code).toBe('NICHT_BERECHTIGT');
    const maF = await fehlerVon(
      im(kontakt(w, w.ma, w.mandantA), (ctx) =>
        bestaetigeKenntnisnahme(ctx, { ...fa(kenntnisTcb), gelesen: true }),
      ),
    );
    expect(maF.code).toBe('NICHT_GEFUNDEN');
    const ungelesen = await fehlerVon(
      im(tcb, (ctx) =>
        bestaetigeKenntnisnahme(ctx, { ...fa(kenntnisTcb), gelesen: false } as never),
      ),
    );
    expect(ungelesen.code).toBe('UNGUELTIG');
    const code = await fehlerVon(
      im(kontakt(w, w.gv, w.mandantA), (ctx) =>
        bestaetigeKenntnisnahme(ctx, { ...fa(zieleFreigabe), gelesen: true }),
      ),
    );
    expect(code.code).toBe('UNGUELTIG');
    const r = await im(tcb, (ctx) =>
      bestaetigeKenntnisnahme(ctx, { ...fa(kenntnisTcb), gelesen: true }),
    );
    expect(r.freigabeId).toBe(kenntnisTcb);
    const wieder = await fehlerVon(
      im(tcb, (ctx) => bestaetigeKenntnisnahme(ctx, { ...fa(kenntnisTcb), gelesen: true })),
    );
    expect(wieder.code).toBe('KONFLIKT');
    const audit = await auditZu(w, kenntnisTcb);
    expect(audit.map((a) => [a.aktion, a.actorId])).toEqual([
      ['tcms.freigabe.kenntnisnahme', w.tcb],
    ]);
  });

  it('Neuadressierung (TS-06): nur Kanzlei mit Bearbeitungsrecht, nur passende Kontakte, auditiert', async () => {
    const id = await weitereFreigabe('RISIKOAKZEPTANZ', w.gv);
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    for (const empfaengerId of [w.tcb, w.gvB, w.inaktiv, randomUUID()]) {
      const f = await fehlerVon(
        im(btA(w), (ctx) => adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId })),
      );
      expect(f.code, empfaengerId).toBe('UNGUELTIG');
    }
    expect(
      (
        await fehlerVon(
          im(ohneRechtA(w), (ctx) =>
            adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv2 }),
          ),
        )
      ).code,
    ).toBe('NICHT_BERECHTIGT');
    for (const lauf of [
      () => im(gv, (ctx) => adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv })),
      () =>
        im(btFuer(w, w.mandantB), (ctx) =>
          adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv2 }),
        ),
      () =>
        im(btA(w), (ctx) =>
          adressiereFreigabeNeu(ctx, { ...fa(fremdeFreigabe), empfaengerId: w.gv2 }),
        ),
      () =>
        im(
          kanzlei(w, w.bt, w.mandantA, {
            tenantId: randomUUID(),
            admin: true,
            bt: true,
            zustaendig: true,
          }),
          (ctx) => adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv2 }),
        ),
    ]) {
      expect((await fehlerVon(lauf())).code).toBe('NICHT_GEFUNDEN');
    }
    const r = await im(btA(w), (ctx) =>
      adressiereFreigabeNeu(ctx, { ...fa(id), empfaengerId: w.gv2.toUpperCase() }),
    );
    expect(r).toEqual({ freigabeId: id, vorherId: w.gv, empfaengerId: w.gv2 });
    expect(await freigabeZeile(id)).toMatchObject({
      empfaengerId: w.gv2,
      codeHash: null,
      codeAblauf: null,
    });
    const audit = await auditZu(w, id);
    expect(audit.at(-1)).toMatchObject({ aktion: 'tcms.freigabe.neu_adressiert', actorId: w.bt });
    expect(audit.at(-1)!.detail).toMatchObject({
      vorherId: w.gv,
      empfaengerId: w.gv2,
      codeZurueckgesetzt: true,
    });
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findMany({ where: { empfaengerId: w.gv2, zweck: 'FREIGABE_NEU_ADRESSIERT' } }),
    );
    expect(n).toHaveLength(1);
    const f = await freigabeZeile(id);
    expect(n[0]).toMatchObject({
      mandantId: w.mandantA,
      empfaengerArt: 'KONTAKT',
      code: null,
      daten: { freigabeId: id, art: f.art, titel: f.titel, version: null },
    });
    // Die frühere Empfängerin kann nichts mehr tun, die neue schon.
    expect((await fehlerVon(im(gv, (ctx) => fordereFreigabeCodeAn(ctx, fa(id))))).code).toBe(
      'NICHT_BERECHTIGT',
    );
    await im(kontakt(w, w.gv2, w.mandantA), (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    // Kenntnisnahme: an jeden aktiven Kontakt (auch Mitarbeitende).
    const k = await im(btA(w), (ctx) =>
      adressiereFreigabeNeu(ctx, { ...fa(kenntnisMa), empfaengerId: w.tcb }),
    );
    expect(k.empfaengerId).toBe(w.tcb);
    // Erledigt → Konflikt.
    expect(
      (
        await fehlerVon(
          im(btA(w), (ctx) =>
            adressiereFreigabeNeu(ctx, { ...fa(kenntnisTcb), empfaengerId: w.ma }),
          ),
        )
      ).code,
    ).toBe('KONFLIKT');
  });
});
