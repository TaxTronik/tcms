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
import { dbAbgewiesen, regel } from '@tcms/db/testhilfe';
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
  TEST_PORTS,
  TEST_UHR,
  zweiteVerbindung,
  type Welt,
} from './testwelt';
import { imDienst } from '../../kontext';
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
    // „Heute" kommt aus der Uhr des Kontexts, nicht aus der Systemzeit.
    expect(v.heute).toBe(TEST_UHR.heute());
    expect(v.entwurf?.abgeschlossen).toBe(0);
    // Vorbelegung der Freigabe: erste aktive gesetzliche Vertretung (keine inaktive Rolle).
    expect(v.entwurf?.freigabe.empfaengerId).toBe(w.gv);
    expect(v.gesetzlicheVertreter.sort()).toEqual([w.gv, w.gv2].sort());
    expect(v.darfBearbeiten).toBe(true);
    expect(v.pruefung.find((p) => p.schritt === 2)?.fehler.length).toBeGreaterThan(0);
    // Liest ohne Seiteneffekt: kein Programm, kein Audit.
    expect(await inWelt(w, (tx) => tx.tcmsProgramm.count())).toBe(0);
  });

  it('ohne Entwurf und ohne Zuständigkeit: unbekannte Personen null, nie leer (Vertrag)', async () => {
    // kanzleikonsole s7nach (Bergkamm der Demo): ohne berufstraegerId/bearbeitungId
    // belegte der Plan Personen mit '' vor.
    for (const personenQuery of [
      {},
      { berufstraegerId: w.bt },
      { bearbeitungId: w.hb, vertretungId: w.dritte },
    ]) {
      const v = await im(btA(w), (ctx) =>
        ladeEinrichtung(ctx, { mandantId: w.mandantA, ...personenQuery }),
      );
      const wo = JSON.stringify(personenQuery);
      expect(EinrichtungViewSchema.parse(v), wo).toEqual(v);
      const zust = v.plan!.kontrollen.map((k) => k.zust);
      expect(zust.length, wo).toBeGreaterThan(0);
      for (const z of zust) {
        for (const id of [z.durchfuehrendId, z.vertretungId, z.gegenzeichnerId]) {
          expect(id === null || id.length === 36, wo).toBe(true);
        }
      }
      // Unbekannte Zuständigkeit bleibt offen und erscheint als Prüfpunkt von Schritt 5.
      if (!('bearbeitungId' in personenQuery)) {
        expect(
          zust.some((z) => z.partei === 'KANZLEI' && z.durchfuehrendId === null),
          wo,
        ).toBe(true);
        expect(v.pruefung.find((p) => p.schritt === 5)?.fehler.length, wo).toBeGreaterThan(0);
      }
    }
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
    expect([f.code, f.grund]).toEqual(['NICHT_BERECHTIGT', 'BEARBEITEN']);
    const g = await fehlerVon(
      im(ohneRechtA(w), (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: w.mandantA,
          daten: { kontrollen: {} },
          personen: personen(w),
        }),
      ),
    );
    expect([g.code, g.grund]).toEqual(['NICHT_BERECHTIGT', 'BEARBEITEN']);
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
    // Auch eingerichtet trägt die Antwort „heute" der Uhr (Vertrag streng geprüft).
    expect(EinrichtungViewSchema.parse(v)).toEqual(v);
    expect(v.heute).toBe(TEST_UHR.heute());
    const andereUhr = {
      jetzt: () => new Date('2027-03-05T07:00:00.000Z'),
      heute: () => '2027-03-05',
    };
    const spaeter = await imDienst(
      btFuer(w, m.mandantId),
      { ...TEST_PORTS, uhr: andereUhr },
      (ctx) => ladeEinrichtung(ctx, { mandantId: m.mandantId }),
    );
    expect(spaeter.heute).toBe('2027-03-05');
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

  it('TS-05: Speichern und „Version 1 anlegen" nur auf dem gesehenen Entwurf (sonst KONFLIKT)', async () => {
    const m = await neuerMandant(w);
    await bereiteVor(w, m.mandantId, m.gv);
    const a = btFuer(w, m.mandantId);
    const b = kanzlei(w, w.hb, m.mandantId, { hb: true });
    const gesehen = (await lies(a, m.mandantId)).entwurf!.stand!;
    expect(gesehen).toBe(4);
    // B speichert Schritt 3 mit „weiter" (andere Ziele) auf dem gesehenen Stand.
    const s3 = schritt3(w);
    const ziele = s3.ziele.map((z, i) => (i === 0 ? { ...z, aktiv: false } : z));
    const rb = await im(b, (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        mandantId: m.mandantId,
        ziel: 'weiter',
        personen: personen(w),
        gesehen,
        schritt: 3,
        daten: { ziele, freigabe: { anfordern: true, empfaengerId: m.gv } },
      }),
    );
    expect(rb.stand).toBe(gesehen + 1);
    // A speichert bzw. legt auf dem alten Stand an: KONFLIKT, nichts geändert.
    const s = await fehlerVon(
      im(a, (ctx) =>
        speichereEinrichtungsschritt(ctx, {
          mandantId: m.mandantId,
          ziel: 'weiter',
          personen: personen(w),
          gesehen,
          schritt: 3,
          daten: { ziele: s3.ziele, freigabe: s3.freigabe },
        }),
      ),
    );
    expect(s.code).toBe('KONFLIKT');
    const f = await fehlerVon(
      im(a, (ctx) =>
        legeProgrammAn(ctx, {
          mandantId: m.mandantId,
          daten: { kontrollen: {} },
          personen: personen(w),
          gesehen,
        }),
      ),
    );
    expect(f.code).toBe('KONFLIKT');
    const nachher = await lies(a, m.mandantId);
    expect(nachher.eingerichtet).toBe(false);
    expect(nachher.entwurf!.ziele[0]!.aktiv).toBe(false);
    // Mit dem neuen Stand gelingt es.
    const r = await im(a, (ctx) =>
      legeProgrammAn(ctx, {
        mandantId: m.mandantId,
        daten: { kontrollen: {} },
        personen: personen(w),
        gesehen: nachher.entwurf!.stand!,
      }),
    );
    expect(r.ziele).toBe(s3.ziele.length - 1);
  });

  it('Version 1: Audit-Spur je Ziel, übernommenem Risiko und Kontrolle (mit Zuständigkeit)', async () => {
    const m = await neuerMandant(w);
    await bereiteVor(w, m.mandantId, m.gv);
    const r = await im(btFuer(w, m.mandantId), (ctx) =>
      legeProgrammAn(ctx, {
        mandantId: m.mandantId,
        daten: { kontrollen: {} },
        personen: personen(w),
      }),
    );
    const [audit, ziele, risiken, kontrollen, kette] = await inWelt(w, async (tx) => [
      await tx.auditEvent.findMany({
        where: { programmId: r.programmId },
        orderBy: { pos: 'asc' },
      }),
      await tx.complianceZiel.findMany({
        where: { teilbereich: { programmId: r.programmId } },
        orderBy: { id: 'asc' },
      }),
      await tx.risiko.findMany({
        where: { programmId: r.programmId, entscheidung: 'UEBERNOMMEN' },
        orderBy: { id: 'asc' },
      }),
      await tx.kontrolle.findMany({
        where: { programmId: r.programmId },
        include: { staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] } },
        orderBy: { id: 'asc' },
      }),
      await pruefeAuditKette(tx),
    ]);
    expect(kette.gueltig).toBe(true);
    const zu = (aktion: string, id: string) =>
      audit.filter((x) => x.aktion === aktion && x.objektId === id);
    for (const z of ziele) {
      const e = zu('tcms.ziel.angelegt', z.id);
      expect(e).toHaveLength(1);
      expect(e[0]!.detail).toMatchObject({
        text: z.text,
        wesentlichkeitEur: z.wesentlichkeitEur,
        risikoappetit: z.risikoappetit,
      });
    }
    for (const x of risiken) {
      expect(zu('tcms.risiko.aufgenommen', x.id), x.code).toHaveLength(1);
    }
    for (const k of kontrollen) {
      const e = zu('tcms.kontrolle.angelegt', k.id);
      expect(e, k.code).toHaveLength(1);
      const s = k.staende[0]!;
      expect(e[0]!.detail, k.code).toMatchObject({
        code: k.code,
        zustaendigkeit: {
          partei: s.partei,
          durchfuehrend: s.durchfuehrendId,
          vertretung: s.vertretungId,
          gegenzeichnung: s.gegenzeichnerId,
          gegenzeichnungMandant: s.gegenzeichnungMandant,
        },
      });
    }
    // Das Sammelereignis bleibt das erste Ereignis der Folge von Version 1.
    const erstes = audit.findIndex((x) => x.aktion === 'tcms.programm.version1_angelegt');
    expect(audit.findIndex((x) => x.aktion === 'tcms.kontrolle.angelegt')).toBeGreaterThan(erstes);
  });

  // ---------------------------------------------------------------------------
  // Zuständigkeiten (Befunde 9/10/41/117): eine Regel mit Verantwortliche ändern
  // ---------------------------------------------------------------------------

  /** Mandant mit GV, TCB und Mitarbeit, Schritte 1–4 fertig; Plan aus dem Lesen. */
  async function mandantMitKontakten() {
    const m = await neuerMandant(w);
    const tcb = randomUUID();
    const ma = randomUUID();
    const frueher = randomUUID();
    await inWelt(w, async (tx) => {
      await tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: tcb, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
      });
      await tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: ma, rolle: 'MITARBEITER' },
      });
      await tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: frueher, rolle: 'MITARBEITER', aktiv: false },
      });
    });
    await bereiteVor(w, m.mandantId, m.gv);
    const a = btFuer(w, m.mandantId);
    const v = await lies(a, m.mandantId);
    const plan = v.plan!.kontrollen;
    // Je Partei eine Kontrolle des Plans, Schlüsselkontrollen bevorzugt.
    const je = (partei: 'KANZLEI' | 'MANDANT') =>
      plan.find((k) => k.zust.partei === partei && k.schluessel) ??
      plan.find((k) => k.zust.partei === partei && !['K-EC-20', 'K-EC-24'].includes(k.code));
    const kanzleiK = je('KANZLEI')!;
    const mandantK = je('MANDANT')!;
    expect(kanzleiK).toBeTruthy();
    expect(mandantK).toBeTruthy();
    return { ...m, tcb, ma, frueher, a, kanzleiK, mandantK };
  }

  const anlegen = (
    a: ReturnType<typeof btA>,
    mandantId: string,
    kontrollen: Record<string, unknown>,
    p = personen(w),
  ) =>
    im(a, (ctx) => legeProgrammAn(ctx, { mandantId, daten: { kontrollen } as never, personen: p }));
  const meldungen = (f: { felder?: Record<string, string[]> }) =>
    Object.values(f.felder ?? {})
      .flat()
      .join('\n');

  it('Kanzleikontrolle mit Gegenzeichnung beim Mandanten: Speichern „weiter" und Anlegen abgewiesen, nichts angelegt', async () => {
    const m = await mandantMitKontakten();
    const falsch = {
      [m.kanzleiK.code]: {
        partei: 'KANZLEI',
        durchfuehrendId: w.hb,
        vertretungId: w.dritte,
        gegenzeichnerId: m.gv,
      },
    };
    const s = await fehlerVon(
      im(m.a, (ctx) =>
        speichereEinrichtungsschritt(ctx, {
          mandantId: m.mandantId,
          ziel: 'weiter',
          personen: personen(w),
          schritt: 5,
          daten: { kontrollen: falsch },
        } as never),
      ),
    );
    expect(s.code).toBe('UNGUELTIG');
    expect(meldungen(s)).toContain(
      `${m.kanzleiK.code}: Eine Gegenzeichnung beim Mandanten gibt es nur bei Kontrollen des Mandanten`,
    );
    const f = await fehlerVon(anlegen(m.a, m.mandantId, falsch));
    expect(f.code).toBe('UNGUELTIG');
    expect(meldungen(f)).toContain('Gegenzeichnung beim Mandanten gibt es nur');
    // Auch der Parteiwechsel der Demo mit stehengebliebener Mandanten-Gegenzeichnung (K-EC-23).
    const g = await fehlerVon(
      anlegen(m.a, m.mandantId, {
        [m.mandantK.code]: {
          partei: 'KANZLEI',
          durchfuehrendId: w.hb,
          vertretungId: w.dritte,
          gegenzeichnerId: m.tcb,
        },
      }),
    );
    expect(g.code).toBe('UNGUELTIG');
    expect(
      await inWelt(w, (tx) =>
        tx.tcmsProgramm.count({ where: { mandantId: m.mandantId, status: 'AKTIV' } }),
      ),
    ).toBe(0);
  });

  it('Mandantenkontrolle: Gegenzeichnung beim Mandanten nur durch die Vertretung (Anzeige = Wahl)', async () => {
    const m = await mandantMitKontakten();
    const f = await fehlerVon(
      anlegen(m.a, m.mandantId, {
        [m.mandantK.code]: {
          partei: 'MANDANT',
          durchfuehrendId: m.tcb,
          vertretungId: m.ma,
          gegenzeichnerId: m.gv,
        },
      }),
    );
    expect(f.code).toBe('UNGUELTIG');
    expect(meldungen(f)).toContain('als Gegenzeichnung die Vertretung wählen');
    const r = await anlegen(m.a, m.mandantId, {
      [m.mandantK.code]: {
        partei: 'MANDANT',
        durchfuehrendId: m.tcb,
        vertretungId: m.ma,
        gegenzeichnerId: m.ma,
      },
    });
    const stand = await inWelt(w, (tx) =>
      tx.kontrolleStand.findFirstOrThrow({
        where: { kontrolle: { programmId: r.programmId, code: m.mandantK.code } },
      }),
    );
    expect(stand).toMatchObject({
      partei: 'MANDANT',
      durchfuehrendId: m.tcb,
      vertretungId: m.ma,
      gegenzeichnerId: m.ma,
      gegenzeichnungMandant: true,
    });
    // Rückhalt der Datenbank: Kanzleikontrolle mit Gegenzeichnung beim Mandanten nie.
    await dbAbgewiesen(
      inWelt(w, (tx) =>
        tx.kontrolleStand.update({
          where: { id: stand.id },
          data: { partei: 'KANZLEI' },
        }),
      ),
      regel.check('KontrolleStand', 'KontrolleStand_gegenzeichnung_mandant_check'),
    );
  });

  it('Kanzleiseite fail closed: Kontakte des Mandanten (auch frühere) sind keine Kanzleipersonen', async () => {
    const m = await mandantMitKontakten();
    for (const id of [m.gv, m.frueher]) {
      // Auch wenn die kanzleikonsole die ID in der Liste der Kanzlei führt.
      const p = { ...personen(w), kanzlei: [...personen(w).kanzlei, id] };
      for (const feld of ['durchfuehrendId', 'vertretungId'] as const) {
        const zust = {
          partei: 'KANZLEI',
          durchfuehrendId: w.hb,
          vertretungId: w.dritte,
          gegenzeichnerId: w.bt,
          [feld]: id,
        };
        const f = await fehlerVon(anlegen(m.a, m.mandantId, { [m.kanzleiK.code]: zust }, p));
        expect(f.code, `${id} ${feld}`).toBe('UNGUELTIG');
        expect(meldungen(f), feld).toContain('gehört nicht (mehr) zur Partei Kanzlei');
      }
    }
    expect(
      await inWelt(w, (tx) =>
        tx.tcmsProgramm.count({ where: { mandantId: m.mandantId, status: 'AKTIV' } }),
      ),
    ).toBe(0);
  });

  it('unbekannte Personen werden gemeldet statt geleert; Lesen kennt die gewählte Gegenzeichnung jeder Kontrolle', async () => {
    const m = await mandantMitKontakten();
    const g = randomUUID();
    const p = { ...personen(w), kanzlei: [...personen(w).kanzlei, g] };
    const mitG = {
      [m.mandantK.code]: {
        partei: 'MANDANT',
        durchfuehrendId: m.tcb,
        vertretungId: m.ma,
        gegenzeichnerId: g,
      },
    };
    await im(m.a, (ctx) =>
      speichereEinrichtungsschritt(ctx, {
        mandantId: m.mandantId,
        ziel: 'speichern',
        personen: p,
        schritt: 5,
        daten: { kontrollen: mitG },
      } as never),
    );
    // GET ohne vollständige Liste: die Kanzlei-Gegenzeichnung G einer Mandantenkontrolle bleibt.
    const v = await lies(m.a, m.mandantId);
    const k = v.plan!.kontrollen.find((x) => x.code === m.mandantK.code)!;
    expect(k.zust.gegenzeichnerId).toBe(g);
    expect(v.pruefung.find((x) => x.schritt === 5)!.fehler.join('\n')).not.toContain(
      `${m.mandantK.code}:`,
    );
    // Anlegen mit einer Person, die die kanzleikonsole nicht (mehr) führt: gemeldet, nicht null.
    const unbekannt = randomUUID();
    const f = await fehlerVon(
      anlegen(m.a, m.mandantId, {
        [m.kanzleiK.code]: {
          partei: 'KANZLEI',
          durchfuehrendId: w.hb,
          vertretungId: unbekannt,
          gegenzeichnerId: w.bt,
        },
      }),
    );
    expect(f.code).toBe('UNGUELTIG');
    expect(meldungen(f)).toContain(`${m.kanzleiK.code}: Die Vertretung gehört nicht (mehr)`);
  });

  it('Vorbelegung aus allen aktiven Rollen eines Kontakts (wie die Risikoaufnahme)', async () => {
    // X: GV (zuerst) und TCB; Y: Mitarbeit. TCB ist X, Vertretung Y.
    const m = await neuerMandant(w);
    const y = randomUUID();
    await inWelt(w, async (tx) => {
      await tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: m.gv, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
      });
      await tx.mandantKontaktRolle.create({
        data: { mandantId: m.mandantId, kontaktId: y, rolle: 'MITARBEITER' },
      });
    });
    const v = await lies(btFuer(w, m.mandantId), m.mandantId);
    const mandantSeite = v.plan!.kontrollen.filter(
      (k) => k.zust.partei === 'MANDANT' && !['K-EC-20', 'K-EC-24'].includes(k.code),
    );
    expect(mandantSeite.length).toBeGreaterThan(0);
    for (const k of mandantSeite) {
      expect(k.zust.durchfuehrendId, k.code).toBe(m.gv);
      expect(k.zust.vertretungId, k.code).toBe(y);
    }
    // Z: TCB zuerst, GV später und einzige GV – die Freigabe der Ziele wird vorbelegt.
    const n = await neuerMandant(w);
    const z = randomUUID();
    await inWelt(w, async (tx) => {
      await tx.mandantKontaktRolle.updateMany({
        where: { mandantId: n.mandantId },
        data: { aktiv: false },
      });
      await tx.mandantKontaktRolle.create({
        data: { mandantId: n.mandantId, kontaktId: z, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
      });
      await tx.mandantKontaktRolle.create({
        data: { mandantId: n.mandantId, kontaktId: z, rolle: 'GESETZLICHER_VERTRETER' },
      });
    });
    const vn = await lies(btFuer(w, n.mandantId), n.mandantId);
    expect(vn.entwurf?.freigabe).toEqual({ anfordern: true, empfaengerId: z });
  });
});
