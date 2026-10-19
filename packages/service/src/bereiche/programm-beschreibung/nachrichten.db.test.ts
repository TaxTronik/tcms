// =============================================================================
// Postausgang gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app): nur
// Kanzleipersonen mit Verwaltungsrecht, tenantweit (RLS), Adressierung über
// IDs (TS-06), Abruf protokolliert, Zustellung idempotent (auch gleichzeitig):
// `zugestelltAm` gesetzt, Text geleert.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NachrichtenOffenSchema } from '@tcms/contract';
import type { PrismaClient } from '@tcms/db';
import {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  legeNachrichtAn,
} from './nachrichten';
import {
  baueWelt,
  fehlerVon,
  gleichzeitig,
  hbA,
  im,
  inWelt,
  kanzlei,
  kontakt,
  zweiteVerbindung,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Postausgang (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;
  const admin = (tenantId?: string) =>
    kanzlei(w, randomUUID(), null, { admin: true, ...(tenantId ? { tenantId } : {}) });
  let ids: string[] = [];

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
    ids = await inWelt(w, async (tx) => {
      const a = await legeNachrichtAn(tx, {
        empfaengerId: w.gv,
        zweck: 'FREIGABE_CODE',
        betreff: 'B1',
        text: 'Code 123456',
      });
      const b = await legeNachrichtAn(tx, {
        empfaengerId: w.tcb,
        zweck: 'FREIGABE_ANGEFORDERT',
        betreff: 'B2',
        text: 'T2',
      });
      const c = await legeNachrichtAn(tx, {
        empfaengerId: w.gv2,
        zweck: 'FREIGABE_NEU_ADRESSIERT',
        betreff: 'B3',
        text: 'T3',
      });
      return [a, b, c];
    });
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('Anlage nur mit Personen-ID und bekanntem Zweck (TS-06, fail closed)', async () => {
    for (const n of [
      { empfaengerId: 'Jana Weller', zweck: 'FREIGABE_CODE' },
      { empfaengerId: `${randomUUID()}x`, zweck: 'FREIGABE_CODE' },
      { empfaengerId: randomUUID(), zweck: 'UNBEKANNT' },
    ]) {
      await expect(
        inWelt(w, (tx) => legeNachrichtAn(tx, { ...n, betreff: 'x', text: 'x' } as never)),
      ).rejects.toThrow(/Empfänger|Nachrichtenzweck/);
    }
    // Schreibweise der ID wird kanonisch gespeichert.
    const id = randomUUID();
    const nid = await inWelt(w, (tx) =>
      legeNachrichtAn(tx, {
        empfaengerId: id.toUpperCase(),
        zweck: 'FREIGABE_ANGEFORDERT',
        betreff: 'K',
        text: 'K',
      }),
    );
    const z = await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: nid } }));
    expect(z.empfaengerId).toBe(id);
    await inWelt(w, (tx) => tx.nachricht.delete({ where: { id: nid } }));
  });

  it('liefert offene Nachrichten nach Alter, begrenzt; Abruf im Audit (ohne Text)', async () => {
    const r = await im(admin(), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(NachrichtenOffenSchema.parse(r)).toEqual(r);
    expect(r.nachrichten.map((n) => n.id)).toEqual(ids);
    expect(r.nachrichten[0]).toMatchObject({
      empfaengerId: w.gv,
      zweck: 'FREIGABE_CODE',
      betreff: 'B1',
      text: 'Code 123456',
    });
    const zwei = await im(admin(), (ctx) => ladeOffeneNachrichten(ctx, { limit: 2 }));
    expect(zwei.nachrichten).toHaveLength(2);
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.findMany({
        where: { aktion: 'tcms.nachricht.abgerufen' },
        orderBy: { pos: 'asc' },
      }),
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]!.detail).toEqual({ anzahl: 3, ids });
    expect(JSON.stringify(audit.map((a) => a.detail))).not.toContain('123456');
    for (const limit of [0, 101, 1.5]) {
      expect(
        (await fehlerVon(im(admin(), (ctx) => ladeOffeneNachrichten(ctx, { limit })))).code,
      ).toBe('UNGUELTIG');
    }
  });

  it('nur Verwaltungsrecht: andere Kanzleipersonen und Kontakte → NICHT_GEFUNDEN', async () => {
    const btOhneAdmin = kanzlei(w, w.bt, w.mandantA, { bt: true, zustaendig: true });
    for (const a of [hbA(w), btOhneAdmin, kontakt(w, w.gv, w.mandantA)]) {
      expect((await fehlerVon(im(a, (ctx) => ladeOffeneNachrichten(ctx, {})))).code).toBe(
        'NICHT_GEFUNDEN',
      );
      expect(
        (
          await fehlerVon(
            im(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[1]! })),
          )
        ).code,
      ).toBe('NICHT_GEFUNDEN');
    }
  });

  it('fremder Tenant: sieht nichts und stellt nichts zu', async () => {
    const fremd = admin(randomUUID());
    expect(await im(fremd, (ctx) => ladeOffeneNachrichten(ctx, {}))).toEqual({ nachrichten: [] });
    const r = await im(fremd, (ctx) =>
      bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[1]! }),
    );
    expect(r).toEqual({ nachrichtId: ids[1], zugestellt: true });
    expect(
      await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: ids[1] } })),
    ).toMatchObject({ zugestelltAm: null, text: 'T2' });
  });

  it('Zustellung setzt zugestelltAm und leert den Text (Code verlässt das Tax-CMS), idempotent, Audit einmal', async () => {
    const a = admin();
    const r = await im(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[0]! }));
    expect(r).toEqual({ nachrichtId: ids[0], zugestellt: true });
    expect(
      await im(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: ids[0]! })),
    ).toEqual(r);
    expect(
      await im(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: 'unbekannt' })),
    ).toEqual({
      nachrichtId: 'unbekannt',
      zugestellt: true,
    });
    const [zeile, audit] = await inWelt(w, async (tx) => [
      await tx.nachricht.findUniqueOrThrow({ where: { id: ids[0] } }),
      await tx.auditEvent.findMany({
        where: { aktion: 'tcms.nachricht.zugestellt', objektId: ids[0] },
      }),
    ]);
    const offen = await im(a, (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(zeile.zugestelltAm).not.toBeNull();
    expect(zeile.text).toBe('');
    expect(offen.nachrichten.map((n) => n.id)).not.toContain(ids[0]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).not.toContain('123456');
    expect(audit[0]!.detail).toEqual({ zweck: 'FREIGABE_CODE', empfaengerId: w.gv });
    expect(
      (await fehlerVon(im(a, (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: 'x y' }))))
        .code,
    ).toBe('UNGUELTIG');
  });

  it('gleichzeitige Zustellbestätigung: beide „zugestellt", genau ein Audit-Eintrag', async () => {
    const id = ids[2]!;
    const e = await gleichzeitig(w, [
      () => im(admin(), (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: id })),
      () => im(admin(), (ctx) => bestaetigeNachrichtZustellung(ctx, { nachrichtId: id }), zweite),
    ]);
    expect(e.every((x) => x.status === 'fulfilled')).toBe(true);
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.count({ where: { aktion: 'tcms.nachricht.zugestellt', objektId: id } }),
    );
    expect(audit).toBe(1);
  });
});
