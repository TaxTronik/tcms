// =============================================================================
// Bestätigungscodes mit geheimem Schlüssel (Hinweis H5 aus RT4), gegen
// PostgreSQL: In der Datenbank steht nur ein HMAC mit einem Schlüssel aus der
// Umgebung und dessen Kennung – ohne den Schlüssel ist der Code nicht
// nachzurechnen. Rotation: neue Codes mit dem ersten Schlüssel, offene mit
// dem früheren weiter prüfbar; ist der Schlüssel entfernt oder stammt der
// Hash aus dem früheren Verfahren (SHA-256 ohne Kennung), gilt der Code als
// abgelaufen – Neuanforderung, kein Fehlversuch, der Abruf verwirft die
// Nachricht. Ohne Schlüsselbund stellt der Dienst keinen Code aus.
// =============================================================================

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { abgewiesenOhneDb, dbAbgewiesen, regel } from '@tcms/db/testhilfe';
import { imDienst, imSystemdienst, type DienstKontext } from '../../kontext';
import { erzeugeCodeSchluessel, type CodeSchluessel } from './code';
import { erteileFreigabe, fordereFreigabeCodeAn, ladePortalFreigaben } from './freigaben';
import { ladeOffeneNachrichten } from './nachrichten';
import { richteEin } from './testprogramm';
import {
  baueWelt,
  fehlerVon,
  inWelt,
  kontakt,
  system,
  TEST_PORTS,
  TEST_UHR,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const schluessel = () => randomBytes(32).toString('base64url');

describe.skipIf(!AKTIV)('Bestätigungscodes mit geheimem Schlüssel (H5)', () => {
  let w: Welt;
  let programm = '';
  const A = schluessel();
  const B = schluessel();
  const nurA = erzeugeCodeSchluessel([A]);
  const BvorA = erzeugeCodeSchluessel([B, A]);
  const nurB = erzeugeCodeSchluessel([B]);

  const alsGv = <T>(codes: CodeSchluessel | undefined, fn: (ctx: DienstKontext) => Promise<T>) =>
    imDienst(kontakt(w, w.gv, w.mandantA), { ...TEST_PORTS, codes }, fn);
  const fa = (freigabeId: string) => ({ mandantId: w.mandantA, freigabeId });

  async function freigabe(): Promise<string> {
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programm,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: `Risikoakzeptanz ${randomUUID().slice(0, 6)}`,
          angefordertVon: w.bt,
          empfaengerId: w.gv,
        },
      }),
    );
    return f.id;
  }
  async function letzterCode(freigabeId: string): Promise<{ id: string; code: string }> {
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { zweck: 'FREIGABE_CODE', daten: { path: ['freigabeId'], equals: freigabeId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return { id: n.id, code: n.code! };
  }
  const zeile = (id: string) => inWelt(w, (tx) => tx.freigabe.findUniqueOrThrow({ where: { id } }));

  beforeAll(async () => {
    w = await baueWelt();
    programm = await richteEin(w);
  });

  it('speichert nur den HMAC mit dem ersten Schlüssel und dessen Kennung, nie den Schlüssel', async () => {
    const id = await freigabe();
    await alsGv(BvorA, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const { code } = await letzterCode(id);
    const f = await zeile(id);
    const nachricht = `tcms|freigabe-code|v2|${id}|${code}`;
    expect(f.codeHash).toBe(createHmac('sha256', B).update(nachricht).digest('hex'));
    expect(f.codeSchluesselId).toBe(BvorA.aktuelleId);
    // Ohne Schlüssel nicht nachzurechnen: weder SHA-256 (früheres Verfahren) noch HMAC mit A.
    expect(f.codeHash).not.toBe(
      createHash('sha256').update(`tcms|freigabe-code|v1|${id}|${code}`).digest('hex'),
    );
    expect(f.codeHash).not.toBe(createHmac('sha256', A).update(nachricht).digest('hex'));
    const alles = JSON.stringify(
      await inWelt(w, async (tx) => [
        await tx.freigabe.findMany(),
        await tx.auditEvent.findMany({ select: { detail: true } }),
      ]),
    );
    expect(alles).not.toContain(B);
    expect(alles).not.toContain(A);
  });

  it('Rotation: ein mit dem früheren Schlüssel ausgestellter Code bleibt prüfbar, solange er in der Liste steht', async () => {
    const id = await freigabe();
    await alsGv(nurA, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const { code } = await letzterCode(id);
    const r = await alsGv(BvorA, (ctx) => erteileFreigabe(ctx, { ...fa(id), code }));
    expect(r.freigegeben).toBe(true);
  });

  it('entfernter Schlüssel: Code gilt als abgelaufen, kein Fehlversuch, Abruf verwirft, Neuanforderung hilft', async () => {
    const id = await freigabe();
    await alsGv(nurA, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const alt = await letzterCode(id);
    const e = await fehlerVon(
      alsGv(nurB, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: alt.code })),
    );
    expect(e.code).toBe('KONFLIKT');
    expect(e.message).toMatch(/abgelaufen/);
    expect((await zeile(id)).codeFehlversuche).toBe(0);
    const portal = await alsGv(nurB, (ctx) => ladePortalFreigaben(ctx, { mandantId: w.mandantA }));
    expect(portal.freigaben.find((f) => f.id === id)?.code?.status).toBe('ABGELAUFEN');
    // Abruf mit nur B: Die Nachricht mit dem nicht mehr prüfbaren Code wird verworfen.
    const abruf = await imSystemdienst(system(w), { uhr: TEST_UHR, codes: nurB }, (ctx) =>
      ladeOffeneNachrichten(ctx, { limit: 100 }),
    );
    expect(abruf.nachrichten.map((n) => n.id)).not.toContain(alt.id);
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { aktion: 'tcms.nachricht.verworfen', objektId: alt.id },
      }),
    );
    expect(audit.detail).toMatchObject({ grund: 'CODE_ABGELAUFEN' });
    await alsGv(nurB, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const neu = await letzterCode(id);
    expect(
      (await alsGv(nurB, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: neu.code }))).freigegeben,
    ).toBe(true);
  });

  it('früheres Verfahren (SHA-256 ohne Kennung, offene Freigabe vor der Umstellung): abgelaufen, Neuanforderung verlangt', async () => {
    const id = await freigabe();
    const code = '482913';
    await inWelt(w, (tx) =>
      tx.freigabe.update({
        where: { id },
        data: {
          codeHash: createHash('sha256')
            .update(`tcms|freigabe-code|v1|${id}|${code}`)
            .digest('hex'),
          codeAblauf: new Date(Date.now() + 86_400_000),
        },
      }),
    );
    const e = await fehlerVon(alsGv(nurA, (ctx) => erteileFreigabe(ctx, { ...fa(id), code })));
    expect([e.code, e.message]).toEqual([
      'KONFLIKT',
      'Der Code ist abgelaufen. Bitte fordern Sie einen neuen Code an.',
    ]);
    expect((await zeile(id)).codeFehlversuche).toBe(0);
    const portal = await alsGv(nurA, (ctx) => ladePortalFreigaben(ctx, { mandantId: w.mandantA }));
    expect(portal.freigaben.find((f) => f.id === id)?.code?.status).toBe('ABGELAUFEN');
    await alsGv(nurA, (ctx) => fordereFreigabeCodeAn(ctx, fa(id)));
    const neu = await letzterCode(id);
    expect(
      (await alsGv(nurA, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: neu.code }))).freigegeben,
    ).toBe(true);
  });

  it('ohne Schlüsselbund stellt der Dienst keinen Code aus und prüft keinen (fail closed)', async () => {
    const id = await freigabe();
    const ohneSchluessel = '[service] Kein Code-Schlüssel konfiguriert';
    await abgewiesenOhneDb(
      alsGv(undefined, (ctx) => fordereFreigabeCodeAn(ctx, fa(id))),
      ohneSchluessel,
    );
    await abgewiesenOhneDb(
      alsGv(undefined, (ctx) => erteileFreigabe(ctx, { ...fa(id), code: '123456' })),
      ohneSchluessel,
    );
    expect(await zeile(id)).toMatchObject({
      codeHash: null,
      codeSchluesselId: null,
      codeFehlversuche: 0,
    });
  });

  it('die Datenbank nimmt eine Kennung nur neben einem Hash und nur als 16 hex (CHECK)', async () => {
    const id = await freigabe();
    for (const data of [
      { codeSchluesselId: '0123456789abcdef' },
      { codeHash: 'a'.repeat(64), codeSchluesselId: 'ABCDEF0123456789' },
      { codeHash: 'a'.repeat(64), codeSchluesselId: '0123' },
    ]) {
      await dbAbgewiesen(
        inWelt(w, (tx) => tx.freigabe.update({ where: { id }, data })),
        regel.check('Freigabe', 'Freigabe_code_schluessel_check'),
        JSON.stringify(data),
      );
    }
  });
});
