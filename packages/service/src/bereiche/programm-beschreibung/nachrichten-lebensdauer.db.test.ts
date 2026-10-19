// =============================================================================
// Lebensdauer und Sparsamkeit der Code-Nachrichten (Stufe 4, DB_TESTS=1):
// Ein Bestätigungscode steht im Klartext nur in der offenen Nachricht. Gilt er
// nicht mehr – Freigabe erteilt, Code abgelaufen, neu angefordert (ersetzt),
// gesperrt, neu adressiert oder Freigabe unbekannt –, liefert der nächste
// Abruf die Nachricht nicht mehr aus und leert `code` und `text`
// (`verworfenAm`), mit Audit-Eintrag ohne Code. Nachrichten ohne Code bleiben
// unberührt.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_FEHLVERSUCHE } from './code';
import { adressiereFreigabeNeu, erteileFreigabe, fordereFreigabeCodeAn } from './freigaben';
import { ladeOffeneNachrichten, legeNachrichtAn, MAX_CODE_PRUEFUNG_JE_ABRUF } from './nachrichten';
import { richteEin } from './testprogramm';
import { baueWelt, btA, im, imSystem, inWelt, kontakt, system, type Welt } from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Lebensdauer der Code-Nachrichten (Service, PostgreSQL)', () => {
  let w: Welt;
  let programmA = '';

  /** Freigabe mit Code an die gesetzliche Vertretung `gv` von Mandant A. */
  async function freigabe(empfaengerId = w.gv): Promise<string> {
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programmA,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: `Risikoakzeptanz ${randomUUID().slice(0, 6)}`,
          inhalt: 'Inhalt zur Freigabe',
          angefordertVon: w.bt,
          empfaengerId,
        },
      }),
    );
    return f.id;
  }

  /** Code anfordern wie im Portal; liefert die ID der neuen Code-Nachricht und den Code. */
  async function codeAnfordern(freigabeId: string, empfaengerId = w.gv) {
    await im(kontakt(w, empfaengerId, w.mandantA), (ctx) =>
      fordereFreigabeCodeAn(ctx, { mandantId: w.mandantA, freigabeId }),
    );
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { zweck: 'FREIGABE_CODE', daten: { path: ['freigabeId'], equals: freigabeId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return { id: n.id, code: n.code! };
  }

  const abruf = () => imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, { limit: 100 }));
  const zeile = (id: string) =>
    inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id } }));
  const verworfenAudit = (id: string) =>
    inWelt(w, (tx) =>
      tx.auditEvent.findMany({ where: { aktion: 'tcms.nachricht.verworfen', objektId: id } }),
    );

  /** Erwartet: nicht ausgeliefert, Klartext leer, genau ein Audit mit Grund ohne Code. */
  async function erwarteVerworfen(id: string, code: string, grund: string, inAntwort = false) {
    const r = await abruf();
    expect(r.nachrichten.map((n) => n.id)).not.toContain(id);
    // (Nur wenn keine andere, gültige Nachricht denselben Code trägt.)
    if (!inAntwort) expect(JSON.stringify(r)).not.toContain(code);
    const z = await zeile(id);
    expect(z).toMatchObject({ code: null, text: '', zugestelltAm: null });
    expect(z.verworfenAm).not.toBeNull();
    expect(JSON.stringify(z.daten)).not.toContain(code);
    const audit = await verworfenAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ zweck: 'FREIGABE_CODE', grund, systemakteur: true });
    expect(JSON.stringify(audit[0])).not.toContain(code);
    // Ein weiterer Abruf verwirft nicht noch einmal.
    await abruf();
    expect(await verworfenAudit(id)).toHaveLength(1);
  }

  beforeAll(async () => {
    w = await baueWelt();
    programmA = await richteEin(w);
  });

  it('ein gültiger Code wird ausgeliefert (mit strukturierten Daten), ein ersetzter nicht mehr', async () => {
    const f = await freigabe();
    const alt = await codeAnfordern(f);
    const r1 = await abruf();
    expect(r1.nachrichten.find((n) => n.id === alt.id)).toMatchObject({
      zweck: 'FREIGABE_CODE',
      daten: { freigabeId: f, code: alt.code },
    });
    const neu = await codeAnfordern(f);
    const r2 = await abruf();
    expect(r2.nachrichten.find((n) => n.id === neu.id)).toMatchObject({
      daten: { freigabeId: f, code: neu.code },
    });
    await erwarteVerworfen(alt.id, alt.code, 'CODE_UNGUELTIG');
  });

  it('Freigabe erteilt: der Code wird nicht mehr ausgeliefert und geleert', async () => {
    const f = await freigabe();
    const n = await codeAnfordern(f);
    const e = await im(kontakt(w, w.gv, w.mandantA), (ctx) =>
      erteileFreigabe(ctx, { mandantId: w.mandantA, freigabeId: f, code: n.code }),
    );
    expect(e).toMatchObject({ freigegeben: true });
    await erwarteVerworfen(n.id, n.code, 'FREIGABE_NICHT_OFFEN');
  });

  it('Code abgelaufen: nicht mehr ausgeliefert und geleert', async () => {
    const f = await freigabe();
    const n = await codeAnfordern(f);
    await inWelt(w, (tx) =>
      tx.freigabe.update({ where: { id: f }, data: { codeAblauf: new Date(Date.now() - 1000) } }),
    );
    await erwarteVerworfen(n.id, n.code, 'CODE_ABGELAUFEN');
  });

  it('neu adressiert bzw. gesperrt: der alte Code wird nicht mehr ausgeliefert', async () => {
    const f1 = await freigabe();
    const n1 = await codeAnfordern(f1);
    await im(btA(w), (ctx) =>
      adressiereFreigabeNeu(ctx, { mandantId: w.mandantA, freigabeId: f1, empfaengerId: w.gv2 }),
    );
    await erwarteVerworfen(n1.id, n1.code, 'CODE_UNGUELTIG');

    const f2 = await freigabe();
    const n2 = await codeAnfordern(f2);
    await inWelt(w, (tx) =>
      tx.freigabe.update({ where: { id: f2 }, data: { codeFehlversuche: MAX_FEHLVERSUCHE } }),
    );
    await erwarteVerworfen(n2.id, n2.code, 'CODE_UNGUELTIG');
  });

  it('Code-Nachricht zu einer unbekannten Freigabe oder einem fremden Mandanten: verworfen', async () => {
    const ohne = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        daten: {
          freigabeId: 'ckunbekanntefreigabe0000',
          art: 'RISIKOAKZEPTANZ',
          titel: 'Unbekannt',
          version: null,
          code: '654321',
          gueltigBis: new Date(Date.now() + 86_400_000).toISOString(),
          sha256: null,
        },
        betreff: 'B',
        text: 'Ihr Bestätigungscode: 654321',
      }),
    );
    await erwarteVerworfen(ohne, '654321', 'FREIGABE_NICHT_OFFEN');

    // Gültige Freigabe von Mandant A, aber die Nachricht nennt Mandant B.
    const f = await freigabe();
    const n = await codeAnfordern(f);
    const fremd = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.mandantB,
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        daten: {
          freigabeId: f,
          art: 'RISIKOAKZEPTANZ',
          titel: 'Fremd',
          version: null,
          code: n.code,
          gueltigBis: new Date(Date.now() + 86_400_000).toISOString(),
          sha256: null,
        },
        betreff: 'B',
        text: 'T',
      }),
    );
    await erwarteVerworfen(fremd, n.code, 'FREIGABE_NICHT_OFFEN', true);
    // Die echte Nachricht derselben Freigabe bleibt auslieferbar.
    expect((await abruf()).nachrichten.map((x) => x.id)).toContain(n.id);
  });

  it('begrenzte Prüfung je Abruf: Ungeprüftes wird nie ausgeliefert, der Rest beim nächsten Abruf geleert', async () => {
    const w2 = await baueWelt();
    const n = MAX_CODE_PRUEFUNG_JE_ABRUF + 1;
    const basis = Date.now() - 3_600_000;
    await inWelt(w2, (tx) =>
      tx.nachricht.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          mandantId: w2.mandantA,
          empfaengerId: w2.gv,
          empfaengerArt: 'KONTAKT' as const,
          zweck: 'FREIGABE_CODE' as const,
          betreff: 'B',
          text: 'Ihr Bestätigungscode: 135790',
          daten: { freigabeId: 'ckunbekanntefreigabe0000' },
          code: '135790',
          createdAt: new Date(basis + i * 1000),
        })),
      }),
    );
    const abrufW2 = () => imSystem(system(w2), (ctx) => ladeOffeneNachrichten(ctx, { limit: 1 }));
    const offen = () =>
      inWelt(w2, (tx) => tx.nachricht.count({ where: { zugestelltAm: null, verworfenAm: null } }));
    expect(await abrufW2()).toEqual({ nachrichten: [] });
    expect(await offen()).toBe(1);
    expect(await abrufW2()).toEqual({ nachrichten: [] });
    expect(await offen()).toBe(0);
    expect(await inWelt(w2, (tx) => tx.nachricht.count({ where: { code: { not: null } } }))).toBe(
      0,
    );
  });

  it('Nachrichten ohne Code bleiben unberührt; kein Code in irgendeinem Audit-Detail', async () => {
    const ohneCode = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.tcb,
        zweck: 'FREIGABE_ANGEFORDERT',
        daten: { freigabeId: 'ckfreigabe0000000000000z', art: 'ZIELE', titel: 'Z', version: null },
        betreff: 'B',
        text: 'T',
      }),
    );
    const r = await abruf();
    expect(r.nachrichten.map((n) => n.id)).toContain(ohneCode);
    expect(await zeile(ohneCode)).toMatchObject({ verworfenAm: null, text: 'T' });
    const codes = (
      await inWelt(w, (tx) =>
        tx.nachricht.findMany({ where: { zweck: 'FREIGABE_CODE' }, select: { text: true } }),
      )
    )
      .map((n) => /(\d{6})/.exec(n.text)?.[1])
      .filter((c): c is string => !!c);
    const audit = JSON.stringify(
      await inWelt(w, (tx) => tx.auditEvent.findMany({ select: { detail: true } })),
    );
    for (const c of codes) expect(audit).not.toContain(c);
  });
});
