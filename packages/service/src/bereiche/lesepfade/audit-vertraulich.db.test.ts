// =============================================================================
// Audit und vertrauliche Feststellungen (DB_TESTS=1, tcms-s11, tcms-s12,
// Fachkonzept §13, RT-01): Inhalte vertraulicher Feststellungen und ihrer
// Maßnahmen (Quelle, Begründungen, Maßnahmentexte, Namen und IDs Beteiligter,
// Detail) sieht im tenantweiten Audit nur, wer die Feststellung lesen darf
// (`kannVertraulichLesen` mit dem Mandantenbezug der Anfrage).
//
// tcms-s12 (Produktentscheidung vom 21.10.2026): Die Kanzleileitung
// (Admins/Partner) liest alles, auch ohne oder mit fremdem Bezug – Inhalte,
// Namen, IDs und alle Hashes. Weil heute nur sie das Audit liest, prüfen die
// Tests der Maskierung Personen ohne Verwaltungsrecht über `leseAuditSeite`
// (die Seite ohne die Verwaltungsprüfung, nicht exportiert): Wer die
// Feststellung nicht lesen darf, erhält eine maskierte Variante (Positivliste)
// und ab der ersten maskierten Position keine Hashes. Die Kettenprüfung rechnet
// über die vollständigen Einträge und gibt keine Inhalte aus.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuditListeAntwortSchema,
  type Akteur,
  type AuditListeAntwort,
  type AuditListenEintrag,
} from '@tcms/contract';
import { schreibeAudit } from '@tcms/db';
import {
  entscheideP153,
  erfasseFeststellung,
  legeMassnahmeAn,
  setzeVertraulich,
} from '../feststellungen-ereignisse/feststellungen';
import {
  akteure,
  baueWelt,
  fehlerVon,
  im,
  inTenant,
  kanzlei,
  type Welt,
} from '../feststellungen-ereignisse/testwelt';
import { ladeAudit, leseAuditSeite, pruefeAudit } from './audit';

const AKTIV = process.env['DB_TESTS'] === '1';

const QUELLE = 'Hinweis aus der Geheimakte 77';
const SACHVERHALT =
  'Vertraulicher Sachverhalt: Restsaldo auf dem Treuhandkonto des Gesellschafters.';
const BEGRUENDUNG_P153 = 'Berichtigung geboten, Begründung nur für Beteiligte bestimmt (Geheim).';
const MASSNAHME = 'Korrektur am Geheimkonto vorbereiten';

/** Schlüssel einer maskierten Variante (Positivliste, sortiert). */
const MASKIERT_FELDER = [
  'akteurArt',
  'aktion',
  'at',
  'mandantId',
  'maskiert',
  'objektId',
  'objektTyp',
  'pos',
  'programmId',
  'vertraulich',
];

describe.skipIf(!AKTIV)('Audit: vertrauliche Feststellungen (Service, PostgreSQL)', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;
  let F = { id: '', nummer: '' };
  let G = { id: '', nummer: '' };
  /** Maßnahmen von F: die angelegte und die Wiedervorlage aus der §-153-Würdigung. */
  let massnahmenF = new Set<string>();
  /** Admin/Partner ohne Mandantenbezug (Kanzleileitung, Verwaltung des tenantweiten Audits). */
  let verwaltung: Akteur;
  /** Admin mit Bezug zu einem anderen Mandanten desselben Tenants. */
  let adminFremd: Akteur;
  /** Nicht-Admin mit Bezug zum Mandanten, weder zuständig noch beteiligt. */
  let unbeteiligt: Akteur;
  /** Nicht-Admin, persönlich beteiligt (Maßnahme von F), ohne Mandantenbezug in dieser Anfrage. */
  let beteiligtOhneBezug: Akteur;
  /** Nicht-Admin, persönlich beteiligt (§-153 von F), mit Bezug zu einem anderen Mandanten. */
  let beteiligtFremd: Akteur;

  const lade = async (a: Akteur): Promise<AuditListeAntwort> => {
    const s = await im(a, (ctx) => ladeAudit(ctx, { limit: 500 }));
    expect(AuditListeAntwortSchema.parse(s)).toEqual(s);
    return s;
  };
  /** Seite ohne Verwaltungsprüfung: Maskierung für Personen ohne Verwaltungsrecht. */
  const ladeOhneVerwaltung = async (a: Akteur): Promise<AuditListeAntwort> => {
    const s = await im(a, (ctx) => leseAuditSeite(ctx, { limit: 500 }));
    expect(AuditListeAntwortSchema.parse(s)).toEqual(s);
    return s;
  };
  const zuF = (e: AuditListenEintrag) =>
    (e.objektTyp === 'Feststellung' && e.objektId === F.id) ||
    (e.objektTyp === 'Massnahme' && massnahmenF.has(e.objektId));

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    verwaltung = kanzlei(w.tenant, randomUUID(), null, { admin: true });
    adminFremd = kanzlei(w.tenant, randomUUID(), w.fremd, { admin: true, bt: true });
    unbeteiligt = kanzlei(w.tenant, randomUUID(), w.mandant, { bt: true });
    beteiligtOhneBezug = kanzlei(w.tenant, w.p.hb, null);
    beteiligtFremd = kanzlei(w.tenant, w.p.zbt, w.fremd, { bt: true, zustaendig: true });
    const erfasse = (a: Akteur, titel: string, quelleText: string) =>
      im(a, (ctx) =>
        erfasseFeststellung(ctx, {
          mandantId: w.mandant,
          titel,
          sachverhalt: SACHVERHALT,
          quelle: 'HINWEIS',
          quelleText,
          klasse: 'STEUERLICHER_FEHLER',
          schwere: 'HOCH',
          auswirkung: 'JA',
        }),
      );
    // G (nicht vertraulich) zuerst: Position 1, vor jedem vertraulichen Eintrag.
    G = await erfasse(A.hb, 'Offene Feststellung zum Clearingkonto', 'Hinweis Buchhaltung');
    F = await erfasse(A.admin, 'Treuhandkonto Gesellschafter', QUELLE);
    await im(A.zbt, (ctx) =>
      entscheideP153(ctx, {
        mandantId: w.mandant,
        feststellungId: F.id,
        entscheidung: 'BERICHTIGUNG',
        begruendung: BEGRUENDUNG_P153,
        frist: '2026-12-31',
        bisher: null,
      }),
    );
    await im(A.hb, (ctx) =>
      legeMassnahmeAn(ctx, {
        mandantId: w.mandant,
        feststellungId: F.id,
        beschreibung: MASSNAHME,
        verantwortlich: { id: w.p.hb, art: 'KANZLEI' },
        frist: '2026-12-31',
      }),
    );
    massnahmenF = new Set(
      (
        await inTenant(w, (tx) =>
          tx.massnahme.findMany({
            where: { feststellungId: F.id },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
        )
      ).map((m) => m.id),
    );
    expect(massnahmenF.size).toBe(2);
    await im(A.zbt, (ctx) =>
      setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: F.id, vertraulich: true }),
    );
    // Danach noch ein nicht vertraulicher Eintrag (Maßnahme an G).
    await im(A.hb, (ctx) =>
      legeMassnahmeAn(ctx, {
        mandantId: w.mandant,
        feststellungId: G.id,
        beschreibung: 'Clearingkonto abstimmen',
        verantwortlich: { id: w.p.hb, art: 'KANZLEI' },
        frist: '2027-01-15',
      }),
    );
  });

  // tcms-s12, angepasst: Bis tcms-s11 sah die Verwaltung ohne Bezug hier nur maskierte Einträge.
  // Produktentscheidung vom 21.10.2026: Die Kanzleileitung liest alles, unabhängig von Bezug
  // und Beteiligung – mit Namen, IDs, Details und allen Hashes.
  it('Kanzleileitung ohne Bezug (Verwaltung): alle Einträge zu F und ihren Maßnahmen lesbar, mit Namen, Details und Hashes', async () => {
    const s = await lade(verwaltung);
    expect(s.eintraege.some((e) => e.maskiert)).toBe(false);
    const f = s.eintraege.filter(zuF);
    expect(f).toHaveLength(6);
    const erfasst = f.find((e) => e.aktion === 'tcms.feststellung.erfasst');
    expect(erfasst).toMatchObject({
      maskiert: false,
      actorId: w.p.admin,
      actorName: A.admin.name,
      detail: expect.objectContaining({ quelle: QUELLE }),
    });
    const json = JSON.stringify(f);
    // Die §-153-Begründung steht nie im Audit (nur Entscheidung und Frist).
    for (const inhalt of [QUELLE, MASSNAHME, 'BERICHTIGUNG', '2026-12-31', w.p.zbt, A.zbt.name]) {
      expect(json, inhalt).toContain(inhalt);
    }
    for (const e of s.eintraege) {
      if (e.maskiert) throw new Error('maskiert');
      expect(e.hash, `pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
      expect(e.prevHash, `pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(s.kopf?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Ohne Leserecht (Nicht-Admin mit Bezug, unbeteiligt): Einträge zu F und ihrer Maßnahme nur maskiert, ohne Inhalte und Personen', async () => {
    const s = await ladeOhneVerwaltung(unbeteiligt);
    const f = s.eintraege.filter(zuF);
    // erfasst, §-153, Status, zwei Maßnahmen, vertraulich
    expect(f).toHaveLength(6);
    expect(new Set(f.map((e) => e.aktion))).toEqual(
      new Set([
        'tcms.feststellung.erfasst',
        'tcms.feststellung.p153_entschieden',
        'tcms.feststellung.status',
        'tcms.massnahme.angelegt',
        'tcms.feststellung.vertraulich',
      ]),
    );
    for (const e of f) {
      expect(e.maskiert, e.aktion).toBe(true);
      expect(Object.keys(e).sort(), e.aktion).toEqual(MASKIERT_FELDER);
      expect(e).toMatchObject({
        akteurArt: 'KANZLEI',
        vertraulich: true,
        mandantId: w.mandant,
        programmId: w.programm,
      });
    }
    // G bleibt lesbar (nicht vertraulich).
    const g = s.eintraege.filter((e) => e.objektId === G.id);
    expect(g.length).toBeGreaterThan(0);
    for (const e of g) expect(e).toMatchObject({ maskiert: false, actorId: w.p.hb });
    const json = JSON.stringify(s);
    for (const geheim of [
      QUELLE,
      'Geheimakte',
      BEGRUENDUNG_P153.slice(0, 20),
      MASSNAHME,
      'BERICHTIGUNG',
      '2026-12-31',
      w.p.admin,
      w.p.zbt,
      ...[A.admin.name, A.zbt.name].filter((n) => n !== A.hb.name),
    ]) {
      expect(json, geheim).not.toContain(geheim);
    }
  });

  it('Hashes nur vor der ersten maskierten Position (danach ließen sie maskierte Inhalte bestätigen)', async () => {
    const s = await ladeOhneVerwaltung(unbeteiligt);
    const erste = Math.min(...s.eintraege.filter((e) => e.maskiert).map((e) => e.pos));
    const offen = s.eintraege.filter((e) => !e.maskiert);
    const davor = offen.filter((e) => e.pos < erste);
    const danach = offen.filter((e) => e.pos > erste);
    expect(davor.length).toBeGreaterThan(0);
    expect(danach.length).toBeGreaterThan(0);
    for (const e of davor) {
      expect(e.hash, `pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
      expect(e.prevHash, `pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const e of danach) expect([e.pos, e.hash, e.prevHash]).toEqual([e.pos, null, null]);
    expect(s.kopf?.pos).toBe(Math.max(...s.eintraege.map((e) => e.pos)));
    expect(s.kopf?.hash).toBeNull();
  });

  // tcms-s12, angepasst: Admin mit fremdem Bezug sah bis tcms-s11 maskiert, jetzt alles
  // (Kanzleileitung). Persönlich Beteiligte ohne Verwaltungsrecht bleiben ohne Bezug maskiert.
  it('Admin mit Bezug zu einem anderen Mandanten (Kanzleileitung): alles lesbar, alle Hashes', async () => {
    const s = await lade(adminFremd);
    expect(s.eintraege.filter(zuF)).toHaveLength(6);
    expect(s.eintraege.some((e) => e.maskiert)).toBe(false);
    expect(JSON.stringify(s)).toContain(QUELLE);
    expect(s.kopf?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Persönlich Beteiligte ohne Verwaltungsrecht ohne Bezug oder mit fremdem Bezug: maskiert (fail closed)', async () => {
    for (const a of [beteiligtOhneBezug, beteiligtFremd]) {
      const s = await ladeOhneVerwaltung(a);
      const f = s.eintraege.filter(zuF);
      expect(f, a.id).toHaveLength(6);
      expect(
        f.every((e) => e.maskiert),
        a.id,
      ).toBe(true);
      expect(s.kopf?.hash, a.id).toBeNull();
      expect(JSON.stringify(s), a.id).not.toContain(QUELLE);
    }
  });

  it('Beteiligte mit Bezug (Admin, zuständige BT, Hauptbearbeitung, auch persönlich beteiligt): alles lesbar, alle Hashes', async () => {
    for (const [a, laden] of [
      [A.admin, lade],
      [A.adminOhneBt, lade],
      [A.zbt, ladeOhneVerwaltung],
      [A.hb, ladeOhneVerwaltung],
    ] as const) {
      const s = await laden(a);
      expect(s.eintraege.every((e) => !e.maskiert)).toBe(true);
      const erfasst = s.eintraege.find(
        (e) => e.objektId === F.id && e.aktion === 'tcms.feststellung.erfasst',
      );
      expect(erfasst).toMatchObject({
        maskiert: false,
        actorId: w.p.admin,
        detail: expect.objectContaining({ quelle: QUELLE }),
      });
      for (const e of s.eintraege) {
        if (e.maskiert) throw new Error('maskiert');
        expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(s.kopf?.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('Beteiligte ohne Verwaltungsrecht lesen das tenantweite Audit nicht (unverändert)', async () => {
    for (const a of [A.zbt, A.hb]) {
      expect(await fehlerVon(im(a, (ctx) => ladeAudit(ctx, {})))).toMatchObject({
        code: 'NICHT_BERECHTIGT',
        grund: 'VERWALTUNG',
      });
    }
  });

  it('Kettenprüfung: vollständig über die unmaskierten Einträge, Antwort ohne Inhalte', async () => {
    const alle = await inTenant(w, (tx) => tx.auditEvent.count());
    for (const a of [verwaltung, A.admin]) {
      const r = await im(a, (ctx) => pruefeAudit(ctx, {}));
      expect(r).toEqual({
        status: 'INTAKT',
        geprueft: alle,
        bruchBei: null,
        grund: null,
        weiterAb: null,
      });
    }
  });

  it('Akteursart maskierter Einträge: System nach Kennzeichnung, Mandant bei Kontakt-ID (jede Schreibweise), ohne ID null', async () => {
    await inTenant(w, async (tx) => {
      const eintrag = (actorId: string | null, detail: Record<string, unknown>) =>
        schreibeAudit(tx, {
          actorId,
          actorName: 'Testakteur Geheim',
          aktion: 'tcms.feststellung.test',
          objektTyp: 'Feststellung',
          objektId: F.id,
          programmId: w.programm,
          detail,
        });
      await eintrag(randomUUID(), { systemakteur: true, notiz: 'Geheim' });
      await eintrag(w.p.gv.toUpperCase(), { notiz: 'Geheim' });
      await eintrag(null, { notiz: 'Geheim' });
      // Akteur-ID ohne UUID-Form (Altbestand): kein Kontakt, die Seite scheitert nicht.
      await eintrag('kein-uuid', { notiz: 'Geheim' });
    });
    const s = await ladeOhneVerwaltung(unbeteiligt);
    const test = s.eintraege.filter((e) => e.aktion === 'tcms.feststellung.test');
    expect(test.map((e) => (e.maskiert ? e.akteurArt : 'OFFEN'))).toEqual([
      'SYSTEM',
      'MANDANT',
      null,
      'KANZLEI',
    ]);
    expect(JSON.stringify(test)).not.toContain('Geheim');
  });

  it('Vertraulichkeit aufgehoben: wieder lesbar, Hashes vollständig', async () => {
    expect((await ladeOhneVerwaltung(unbeteiligt)).eintraege.some((e) => e.maskiert)).toBe(true);
    await im(A.zbt, (ctx) =>
      setzeVertraulich(ctx, { mandantId: w.mandant, feststellungId: F.id, vertraulich: false }),
    );
    const s = await ladeOhneVerwaltung(unbeteiligt);
    expect(s.eintraege.some((e) => e.maskiert)).toBe(false);
    expect(
      s.eintraege.find((e) => zuF(e) && e.aktion === 'tcms.feststellung.erfasst'),
    ).toMatchObject({ detail: expect.objectContaining({ quelle: QUELLE }) });
    expect(s.kopf?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!AKTIV)(
  'Audit: Kettenprüfung über maskierte Einträge (Service, PostgreSQL)',
  () => {
    it('ein gefälschter Eintrag zu einer vertraulichen Feststellung bricht die Kette; die Liste zeigt ihn der Leitung, sonst maskiert', async () => {
      const w = await baueWelt();
      const verwaltung = kanzlei(w.tenant, randomUUID(), null, { admin: true });
      const unbeteiligt = kanzlei(w.tenant, randomUUID(), w.mandant, { bt: true });
      const f = await inTenant(w, (tx) =>
        tx.feststellung.create({
          data: {
            programmId: w.programm,
            nummer: `F-${randomUUID().slice(0, 8)}`,
            titel: 'Vertraulich',
            sachverhalt: 'Vertraulicher Sachverhalt.',
            quelle: 'HINWEIS',
            quelleText: 'Hinweis',
            klasse: 'STEUERLICHER_FEHLER',
            schwere: 'HOCH',
            auswirkung: 'JA',
            vertraulich: true,
            erfasstVon: w.p.zbt,
          },
        }),
      );
      const gefaelscht = await inTenant(w, async (tx) => {
        await schreibeAudit(tx, {
          actorId: w.p.zbt,
          actorName: 'Kanzlei',
          aktion: 'tcms.feststellung.erfasst',
          objektTyp: 'Feststellung',
          objektId: f.id,
          programmId: w.programm,
          detail: { quelle: 'Geheim' },
        });
        const letzter = await tx.auditEvent.findFirstOrThrow({ orderBy: { pos: 'desc' } });
        // Passender Vorgänger, aber Inhalt passt nicht zum Hash.
        const z = await tx.auditEvent.create({
          data: {
            pos: letzter.pos + 1,
            kettenVersion: 2,
            at: new Date(),
            actorId: w.p.zbt,
            actorName: 'Fälscher',
            aktion: 'tcms.feststellung.p153_entschieden',
            objektTyp: 'Feststellung',
            objektId: f.id,
            programmId: w.programm,
            detail: { entscheidung: 'KEINE_PFLICHT' },
            prevHash: letzter.hash,
            hash: randomBytes(32).toString('hex'),
          },
        });
        return z.pos;
      });
      const r = await im(verwaltung, (ctx) => pruefeAudit(ctx, {}));
      expect(r).toEqual({
        status: 'GEBROCHEN',
        geprueft: gefaelscht - 1,
        bruchBei: gefaelscht,
        grund: 'Inhalt wurde verändert',
        weiterAb: null,
      });
      // tcms-s12: Die Kanzleileitung sieht den gefälschten Eintrag vollständig (bis tcms-s11
      // maskiert); wer die Feststellung nicht lesen darf, weiterhin nur maskiert.
      const s = await im(verwaltung, (ctx) => ladeAudit(ctx, {}));
      expect(s.eintraege.find((e) => e.pos === gefaelscht)).toMatchObject({
        maskiert: false,
        aktion: 'tcms.feststellung.p153_entschieden',
        actorName: 'Fälscher',
        detail: { entscheidung: 'KEINE_PFLICHT' },
      });
      const m = await im(unbeteiligt, (ctx) => leseAuditSeite(ctx, {}));
      expect(m.eintraege.find((e) => e.pos === gefaelscht)).toMatchObject({
        maskiert: true,
        aktion: 'tcms.feststellung.p153_entschieden',
      });
      expect(JSON.stringify(m)).not.toContain('KEINE_PFLICHT');
      expect(JSON.stringify(m)).not.toContain('Fälscher');
    });
  },
);
