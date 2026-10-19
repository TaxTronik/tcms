// =============================================================================
// Einrichtungsassistent gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app):
// Positivfall bis Version 1, Rechte (fremder Mandant/Tenant, Rolle fehlt,
// Mandantenkontakt), Eingabeprüfung, TS-05 (paralleles Anlegen) und Audit.
// Jede Datei arbeitet in einem eigenen, frischen Tenant (testwelt.ts).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EinrichtungViewSchema } from '@tcms/contract';
import { pruefeAuditKette, type PrismaClient } from '@tcms/db';
import { ladeEinrichtung, legeProgrammAn, speichereEinrichtungsschritt } from './einrichtung';
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
import { bereiteVor, personen, SCHRITT1, schritt3, testProfil } from './testprogramm';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Einrichtungsassistent (Service, PostgreSQL)', () => {
  let w: Welt;
  let zweite: PrismaClient;

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  const lies = (a = btA(w), mandantId = w.mandantA) =>
    im(a, (ctx) =>
      ladeEinrichtung(ctx, {
        mandantId,
        berufstraegerId: w.bt,
        bearbeitungId: w.hb,
        vertretungId: w.dritte,
      }),
    );
  const speichere = (
    a: ReturnType<typeof btA>,
    schritt: 1 | 2 | 3 | 4,
    daten: unknown,
    ziel: 'speichern' | 'weiter' = 'weiter',
    mandantId = w.mandantA,
  ) =>
    im(a, (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        mandantId,
        ziel,
        personen: personen(w),
        schritt,
        daten,
      } as never),
    );

  it('liest einen leeren Entwurf mit Plan und Prüfpunkten (JSON nach Vertrag)', async () => {
    const v = await lies();
    expect(EinrichtungViewSchema.parse(v)).toEqual(v);
    expect(v.programm).toBeNull();
    expect(v.eingerichtet).toBe(false);
    expect(v.entwurf?.abgeschlossen).toBe(0);
    // Vorbelegung der Freigabe: erste aktive gesetzliche Vertretung (keine inaktive Rolle).
    expect(v.entwurf?.freigabe.empfaengerId).toBe(w.gv);
    expect(v.gesetzlicheVertreter.sort()).toEqual([w.gv, w.gv2].sort());
    expect(v.darfBearbeiten).toBe(true);
    expect(v.pruefung.find((p) => p.schritt === 2)?.fehler.length).toBeGreaterThan(0);
    // Liest ohne Seiteneffekt: kein Programm, kein Audit.
    expect(await inWelt(w, (tx) => tx.tcmsProgramm.count())).toBe(0);
  });

  it('Schritt unvollständig mit „weiter": UNGUELTIG, nichts gespeichert', async () => {
    const f = await fehlerVon(
      speichere(btA(w), 1, {
        ...SCHRITT1,
        teilbereich: { ...SCHRITT1.teilbereich, abgrenzung: 'kurz' },
      }),
    );
    expect(f.code).toBe('UNGUELTIG');
    expect(
      Object.values(f.felder ?? {})
        .flat()
        .join(' '),
    ).toContain('Abgrenzungstext');
    expect(
      await inWelt(w, (tx) => tx.tcmsProgramm.count({ where: { mandantId: w.mandantA } })),
    ).toBe(0);
  });

  it('legt beim ersten Speichern das Programm an, prüft Schritte und schreibt Audit', async () => {
    const r = await speichere(hbA(w), 1, SCHRITT1);
    expect(r).toMatchObject({ angelegt: true, abgeschlossen: 1, geaendert: true });
    const audit = await auditZu(w, r.programmId);
    expect(audit.map((a) => a.aktion)).toEqual([
      'tcms.programm.angelegt',
      'tcms.setup.entwurf_gespeichert',
    ]);
    expect(audit[1]).toMatchObject({ actorId: w.hb, programmId: r.programmId });
    const zweiter = await speichere(hbA(w), 2, { profil: testProfil() });
    expect(zweiter).toMatchObject({ programmId: r.programmId, angelegt: false, abgeschlossen: 2 });
    const v = await lies();
    expect(v.entwurf?.gespeichertVon).toBe(w.hb);
    expect(v.plan?.risiken.length).toBeGreaterThan(0);
  });

  it('Schritt 3: Freigabe der Ziele nur durch eine aktive gesetzliche Vertretung dieses Mandanten', async () => {
    const s3 = schritt3(w);
    for (const empfaengerId of [w.tcb, w.inaktiv, w.gvB, randomUUID()]) {
      const f = await fehlerVon(
        speichere(btA(w), 3, { ziele: s3.ziele, freigabe: { anfordern: true, empfaengerId } }),
      );
      expect(f.code, empfaengerId).toBe('UNGUELTIG');
    }
    const ok = await speichere(btA(w), 3, {
      ziele: s3.ziele,
      freigabe: { anfordern: true, empfaengerId: w.gv2.toUpperCase() },
    });
    expect(ok.abgeschlossen).toBe(3);
    // IDs werden kanonisch (Kleinbuchstaben) gespeichert.
    expect((await lies()).entwurf?.freigabe.empfaengerId).toBe(w.gv2);
  });

  it('weist unbekannte Katalogcodes, unbekannte Felder und einen Stichtag ab', async () => {
    const r = await fehlerVon(
      speichere(btA(w), 4, { risiken: { 'EC-XXX-99': { uebernehmen: true, begruendung: '' } } }),
    );
    expect(r.code).toBe('UNGUELTIG');
    const a = btA(w);
    for (const eingabe of [
      {
        mandantId: w.mandantA,
        ziel: 'weiter',
        personen: personen(w),
        schritt: 1,
        daten: SCHRITT1,
        stand: '2026-01-01',
      },
      {
        mandantId: w.mandantA,
        ziel: 'weiter',
        personen: personen(w),
        schritt: 1,
        daten: SCHRITT1,
        tenantId: randomUUID(),
      },
      {
        mandantId: w.mandantA,
        ziel: 'anlegen',
        personen: personen(w),
        schritt: 1,
        daten: SCHRITT1,
      },
      { mandantId: w.mandantA, ziel: 'weiter', personen: personen(w), schritt: 6, daten: {} },
      {
        mandantId: w.mandantA,
        ziel: 'weiter',
        personen: { ...personen(w), kanzlei: ['x'] },
        schritt: 1,
        daten: SCHRITT1,
      },
    ]) {
      const f = await fehlerVon(
        im(a, (ctx) => speichereEinrichtungsschritt(ctx, eingabe as never)),
      );
      expect(f.code).toBe('UNGUELTIG');
    }
    const k = await fehlerVon(
      im(a, (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: w.mandantA,
          personen: personen(w),
          daten: {
            kontrollen: {
              'K-XX-99': {
                partei: 'KANZLEI',
                durchfuehrendId: null,
                vertretungId: null,
                gegenzeichnerId: null,
              },
            },
          },
        }),
      ),
    );
    expect(k.code).toBe('UNGUELTIG');
  });

  it('Rechte: Bearbeiten nur mit kannBearbeiten, sonst NICHT_BERECHTIGT; Lesen mit Bezug', async () => {
    const f = await fehlerVon(speichere(ohneRechtA(w), 1, SCHRITT1, 'speichern'));
    expect(f.code).toBe('NICHT_BERECHTIGT');
    const g = await fehlerVon(
      im(ohneRechtA(w), (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: w.mandantA,
          daten: { kontrollen: {} },
          personen: personen(w),
        }),
      ),
    );
    expect(g.code).toBe('NICHT_BERECHTIGT');
    expect((await lies(ohneRechtA(w))).darfBearbeiten).toBe(false);
  });

  it('fremder Mandant, fehlender Bezug, Mandantenkontakt, fremder Tenant, unbekannt: NICHT_GEFUNDEN', async () => {
    const akteure = [
      kanzlei(w, w.bt, w.mandantB, { admin: true, bt: true, zustaendig: true }), // Bezug auf B, Anfrage für A
      kanzlei(w, w.bt, null, { admin: true, bt: true }),
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
        () => lies(a),
        () => speichere(a, 1, SCHRITT1, 'speichern'),
        () =>
          im(a, (ctx) =>
            legeProgrammAn(ctx, {
              mandantId: w.mandantA,
              daten: { kontrollen: {} },
              personen: personen(w),
            }),
          ),
      ]) {
        const f = await fehlerVon(lauf());
        expect(f.code).toBe('NICHT_GEFUNDEN');
        expect(f.message).toBe('NICHT_GEFUNDEN');
      }
    }
    const unbekannt = randomUUID();
    const f = await fehlerVon(lies(btFuer(w, unbekannt), unbekannt));
    expect(f.code).toBe('NICHT_GEFUNDEN');
  });

  it('legt Version 1 an (Freigabe der Ziele über die ID, Nachricht ohne Namen, Audit, Kette)', async () => {
    const m = await neuerMandant(w);
    await bereiteVor(w, m.mandantId, m.gv);
    const r = await im(btFuer(w, m.mandantId), (ctx) =>
      legeProgrammAn(ctx, {
        mandantId: m.mandantId,
        daten: { kontrollen: {} },
        personen: personen(w),
      }),
    );
    expect(r.risiken).toBeGreaterThan(0);
    expect(r.kontrollen).toBeGreaterThan(0);
    expect(r.durchfuehrungen).toBeGreaterThan(0);
    expect(r.freigabeId).toBeTruthy();
    const [programm, freigabe, nachrichten, kette, audit] = await inWelt(w, async (tx) => [
      await tx.tcmsProgramm.findUniqueOrThrow({ where: { id: r.programmId } }),
      await tx.freigabe.findUniqueOrThrow({ where: { id: r.freigabeId! } }),
      await tx.nachricht.findMany({ where: { empfaengerId: m.gv } }),
      await pruefeAuditKette(tx),
      await tx.auditEvent.findMany({
        where: { programmId: r.programmId },
        orderBy: { pos: 'asc' },
      }),
    ]);
    expect(programm).toMatchObject({ status: 'AKTIV', setupEntwurf: null });
    expect(programm.version1Am).not.toBeNull();
    expect(freigabe).toMatchObject({
      art: 'ZIELE',
      empfaengerId: m.gv,
      status: 'OFFEN',
      codeHash: null,
    });
    expect(nachrichten.map((n) => n.zweck)).toEqual(['FREIGABE_ANGEFORDERT']);
    expect(nachrichten[0]).toMatchObject({
      mandantId: m.mandantId,
      empfaengerArt: 'KONTAKT',
      code: null,
      daten: { freigabeId: r.freigabeId, art: 'ZIELE', titel: freigabe.titel, version: null },
    });
    expect(kette.gueltig).toBe(true);
    const aktionen = audit.map((a) => a.aktion);
    expect(aktionen).toContain('tcms.programm.version1_angelegt');
    expect(aktionen).toContain('tcms.ziele.freigabe_angefordert');
    expect(audit.every((a) => a.actorId === w.bt)).toBe(true);
    // Eingerichtet: Lesen zeigt keinen Entwurf mehr, Ändern ist ein Konflikt.
    const v = await lies(btFuer(w, m.mandantId), m.mandantId);
    expect(v).toMatchObject({ eingerichtet: true, entwurf: null, plan: null });
    const f = await fehlerVon(
      speichere(btFuer(w, m.mandantId), 1, SCHRITT1, 'speichern', m.mandantId),
    );
    expect(f.code).toBe('KONFLIKT');
    const g = await fehlerVon(
      im(btFuer(w, m.mandantId), (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: m.mandantId,
          daten: { kontrollen: {} },
          personen: personen(w),
        }),
      ),
    );
    expect(g.code).toBe('KONFLIKT');
  });

  it('Version 1 erst nach Schritt 1–4', async () => {
    const m = await neuerMandant(w);
    const ohne = await fehlerVon(
      im(btFuer(w, m.mandantId), (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: m.mandantId,
          daten: { kontrollen: {} },
          personen: personen(w),
        }),
      ),
    );
    expect(ohne.code).toBe('UNGUELTIG');
    await speichere(btFuer(w, m.mandantId), 1, SCHRITT1, 'weiter', m.mandantId);
    const teil = await fehlerVon(
      im(btFuer(w, m.mandantId), (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: m.mandantId,
          daten: { kontrollen: {} },
          personen: personen(w),
        }),
      ),
    );
    expect(teil.code).toBe('UNGUELTIG');
    expect(
      await inWelt(w, (tx) =>
        tx.teilbereich.count({ where: { programm: { mandantId: m.mandantId } } }),
      ),
    ).toBe(0);
  });

  it('TS-05: gleichzeitiges erstes Speichern → genau ein Programm, die andere Anfrage KONFLIKT', async () => {
    const m = await neuerMandant(w);
    const a = btFuer(w, m.mandantId);
    const lauf = (client?: PrismaClient) =>
      im(
        a,
        (ctx) =>
          speichereEinrichtungsschritt(ctx, {
            mandantId: m.mandantId,
            ziel: 'speichern',
            personen: personen(w),
            schritt: 1,
            daten: SCHRITT1,
          }),
        client,
      );
    const e = nurEinErfolg(await gleichzeitig(w, [() => lauf(), () => lauf(zweite)]));
    expect(e.fehlerCode).toBe('KONFLIKT');
    const [programme, audit] = await inWelt(w, async (tx) => {
      const ids = (
        await tx.tcmsProgramm.findMany({ where: { mandantId: m.mandantId }, select: { id: true } })
      ).map((p) => p.id);
      return [
        ids.length,
        await tx.auditEvent.count({
          where: { aktion: 'tcms.programm.angelegt', objektId: { in: ids } },
        }),
      ];
    });
    expect(programme).toBe(1);
    expect(audit).toBe(1);
  });

  it('TS-05: gleichzeitiges „Version 1 anlegen" → genau einmal, die andere Anfrage KONFLIKT', async () => {
    const m = await neuerMandant(w);
    await bereiteVor(w, m.mandantId, m.gv);
    const a = btFuer(w, m.mandantId);
    const lauf = (client?: PrismaClient) =>
      im(
        a,
        (ctx) =>
          legeProgrammAn(ctx, {
            mandantId: m.mandantId,
            daten: { kontrollen: {} },
            personen: personen(w),
          }),
        client,
      );
    const e = nurEinErfolg(await gleichzeitig(w, [() => lauf(), () => lauf(zweite)]));
    expect(e.fehlerCode).toBe('KONFLIKT');
    const [tb, freigaben, v1] = await inWelt(w, async (tx) => {
      const p = await tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: m.mandantId } });
      return [
        await tx.teilbereich.count({ where: { programmId: p.id } }),
        await tx.freigabe.count({ where: { programmId: p.id } }),
        await tx.auditEvent.count({
          where: { aktion: 'tcms.programm.version1_angelegt', programmId: p.id },
        }),
      ];
    });
    expect(tb).toBe(1);
    expect(freigaben).toBe(1);
    expect(v1).toBe(1);
  });
});
