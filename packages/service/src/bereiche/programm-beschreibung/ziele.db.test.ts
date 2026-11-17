// =============================================================================
// Ziele-Freigabe nach Version 1 anfordern (Befund 11) gegen PostgreSQL
// (DB_TESTS=1, DATABASE_URL = tcms_app): Programm ohne Anforderung bei der
// Einrichtung, Empfänger nur aktive GV des Mandanten (TS-06), Rechte, höchstens
// eine offene Ziele-Freigabe (auch gleichzeitig, TS-05), danach Freigabe mit
// Code durch die GV, Audit.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZieleFreigabeAnfordernErgebnisSchema } from '@tcms/contract';
import { pruefeAuditKette, type PrismaClient } from '@tcms/db';
import { legeProgrammAn, speichereEinrichtungsschritt } from './einrichtung';
import { erteileFreigabe, fordereFreigabeCodeAn } from './freigaben';
import {
  baueWelt,
  btFuer,
  fehlerVon,
  gleichzeitig,
  im,
  inWelt,
  kanzlei,
  kontakt,
  neuerMandant,
  nurEinErfolg,
  zweiteVerbindung,
  type Welt,
} from './testwelt';
import { personen, SCHRITT1, schritt3, testProfil } from './testprogramm';
import { fordereZieleFreigabeAn } from './ziele';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Ziele-Freigabe anfordern (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  /** Mandant mit GV und TCB; Version 1 ohne Freigabeanforderung („später"). */
  async function ohneAnforderung(): Promise<{
    mandantId: string;
    gv: string;
    tcb: string;
    programmId: string;
  }> {
    const m = await neuerMandant(w);
    const tcb = randomUUID();
    await inWelt(w, (tx) =>
      tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: tcb, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
      }),
    );
    const a = btFuer(w, m.mandantId);
    const basis = { mandantId: m.mandantId, ziel: 'weiter' as const, personen: personen(w) };
    await im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, { ...basis, schritt: 1, daten: SCHRITT1 }),
    );
    await im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, { ...basis, schritt: 2, daten: { profil: testProfil() } }),
    );
    await im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        ...basis,
        schritt: 3,
        daten: { ziele: schritt3(w).ziele, freigabe: { anfordern: false, empfaengerId: null } },
      }),
    );
    await im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, { ...basis, schritt: 4, daten: { risiken: {} } }),
    );
    const r = await im(a, (ctx) =>
      legeProgrammAn(ctx, {
        mandantId: m.mandantId,
        daten: { kontrollen: {} },
        personen: personen(w),
      }),
    );
    expect(r.freigabeId).toBeNull();
    return { ...m, tcb, programmId: r.programmId };
  }

  const anfordern = (mandantId: string, empfaengerId: string, a = btFuer(w, mandantId)) =>
    im(a, (ctx) => fordereZieleFreigabeAn(ctx, { mandantId, empfaengerId }));

  const ziele = (programmId: string) =>
    inWelt(w, (tx) =>
      tx.complianceZiel.findMany({
        where: { teilbereich: { programmId } },
        orderBy: { id: 'asc' },
      }),
    );

  it('fordert nach Version 1 an: Ziele ausstehend, Freigabe an die GV, Nachricht und Audit', async () => {
    const m = await ohneAnforderung();
    expect((await ziele(m.programmId)).every((z) => z.freigabe === 'ENTWURF')).toBe(true);
    const r = await anfordern(m.mandantId, m.gv.toUpperCase());
    expect(ZieleFreigabeAnfordernErgebnisSchema.parse(r)).toEqual(r);
    const [freigabe, liste, nachrichten, audit, kette] = await inWelt(w, async (tx) => [
      await tx.freigabe.findUniqueOrThrow({ where: { id: r.freigabeId } }),
      await tx.complianceZiel.findMany({
        where: { teilbereich: { programmId: m.programmId } },
        orderBy: { id: 'asc' },
      }),
      await tx.nachricht.findMany({
        where: { empfaengerId: m.gv },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      await tx.auditEvent.findMany({
        where: { programmId: m.programmId, aktion: 'tcms.ziele.freigabe_angefordert' },
        orderBy: { pos: 'asc' },
      }),
      await pruefeAuditKette(tx),
    ]);
    expect(freigabe).toMatchObject({
      art: 'ZIELE',
      refId: r.teilbereichId,
      status: 'OFFEN',
      empfaengerId: m.gv,
      angefordertVon: w.bt,
      codeHash: null,
    });
    expect(freigabe.inhalt).toContain(liste[0]!.text);
    expect(r.ziele).toBe(liste.length);
    expect(liste.every((z) => z.freigabe === 'AUSSTEHEND')).toBe(true);
    expect(nachrichten.map((n) => [n.zweck, n.code])).toEqual([['FREIGABE_ANGEFORDERT', null]]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: w.bt, objektId: r.teilbereichId });
    expect(audit[0]!.detail).toMatchObject({ freigabeId: r.freigabeId, empfaengerId: m.gv });
    expect(kette.gueltig).toBe(true);

    // Höchstens eine offene Ziele-Freigabe: eine zweite Anforderung ist ein Konflikt.
    const f = await fehlerVon(anfordern(m.mandantId, m.gv));
    expect(f.code).toBe('KONFLIKT');

    // Die GV gibt mit Code frei; danach gibt es nichts mehr anzufordern.
    const gv = kontakt(w, m.gv, m.mandantId);
    await im(gv, (ctx) =>
      fordereFreigabeCodeAn(ctx, { mandantId: m.mandantId, freigabeId: r.freigabeId }),
    );
    const n = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { empfaengerId: m.gv, zweck: 'FREIGABE_CODE' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const erteilt = await im(gv, (ctx) =>
      erteileFreigabe(ctx, {
        mandantId: m.mandantId,
        freigabeId: r.freigabeId,
        code: n.code!,
      }),
    );
    expect(erteilt.freigegeben).toBe(true);
    expect((await ziele(m.programmId)).every((z) => z.freigabe === 'FREIGEGEBEN')).toBe(true);
    const g = await fehlerVon(anfordern(m.mandantId, m.gv));
    expect(g.code).toBe('KONFLIKT');
    expect(g.message).toContain('bereits');
  });

  it('TS-06: Empfänger nur eine aktive gesetzliche Vertretung dieses Mandanten', async () => {
    const m = await ohneAnforderung();
    for (const id of [m.tcb, w.gv, w.gvB, w.inaktiv, randomUUID()]) {
      const f = await fehlerVon(anfordern(m.mandantId, id));
      expect(f.code, id).toBe('UNGUELTIG');
    }
    expect((await ziele(m.programmId)).every((z) => z.freigabe === 'ENTWURF')).toBe(true);
    expect(
      await inWelt(w, (tx) => tx.freigabe.count({ where: { programmId: m.programmId } })),
    ).toBe(0);
  });

  it('Rechte: Bearbeiten nötig; fremder Mandant, Kontakt, fremder Tenant: NICHT_GEFUNDEN', async () => {
    const m = await ohneAnforderung();
    const ohne = await fehlerVon(anfordern(m.mandantId, m.gv, kanzlei(w, w.dritte, m.mandantId)));
    expect([ohne.code, ohne.grund]).toEqual(['NICHT_BERECHTIGT', 'BEARBEITEN']);
    for (const a of [
      kanzlei(w, w.bt, w.mandantB, { admin: true, bt: true, zustaendig: true }),
      kontakt(w, m.gv, m.mandantId),
      kanzlei(w, w.bt, m.mandantId, {
        tenantId: randomUUID(),
        admin: true,
        bt: true,
        zustaendig: true,
      }),
    ]) {
      const f = await fehlerVon(anfordern(m.mandantId, m.gv, a));
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
    expect(
      await inWelt(w, (tx) => tx.freigabe.count({ where: { programmId: m.programmId } })),
    ).toBe(0);
  });

  it('nur für ein eingerichtetes Programm (nicht im Entwurf des Assistenten)', async () => {
    const m = await neuerMandant(w);
    const ohneProgramm = await fehlerVon(anfordern(m.mandantId, m.gv));
    expect(ohneProgramm.code).toBe('KONFLIKT');
    await im(btFuer(w, m.mandantId), (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        mandantId: m.mandantId,
        ziel: 'speichern',
        personen: personen(w),
        schritt: 1,
        daten: SCHRITT1,
      }),
    );
    const imEntwurf = await fehlerVon(anfordern(m.mandantId, m.gv));
    expect(imEntwurf.code).toBe('KONFLIKT');
    expect(imEntwurf.message).toContain('noch kein Tax-CMS eingerichtet');
  });

  it('TS-05: gleichzeitige Anforderungen → genau eine Freigabe, die andere KONFLIKT', async () => {
    const m = await ohneAnforderung();
    const lauf = (client?: PrismaClient) =>
      im(
        btFuer(w, m.mandantId),
        (ctx) => fordereZieleFreigabeAn(ctx, { mandantId: m.mandantId, empfaengerId: m.gv }),
        client,
      );
    const e = nurEinErfolg(await gleichzeitig(w, [() => lauf(), () => lauf(zweite)]));
    expect(e.fehlerCode).toBe('KONFLIKT');
    expect(
      await inWelt(w, (tx) =>
        tx.freigabe.count({ where: { programmId: m.programmId, art: 'ZIELE', status: 'OFFEN' } }),
      ),
    ).toBe(1);
  });
});
