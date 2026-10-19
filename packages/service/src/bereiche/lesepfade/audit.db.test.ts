// =============================================================================
// Audit lesen und Kette prüfen gegen PostgreSQL (DB_TESTS=1), in eigenen
// Tenants: nur Admins, Seiten mit Cursor, Filter, Tenant-Trennung, Prüfung
// seitenweise mit Fortsetzung und Erkennung manipulierter Einträge
// (gleiches Ergebnis wie `pruefeKette` aus @tcms/domain).
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuditListeAntwortSchema,
  MAX_AUDIT_JE_SEITE,
  MAX_AUDIT_SEQ,
  type AuditListeEingabe,
  type AuditPruefenAntwort,
} from '@tcms/contract';
import { mitTenant, schreibeAudit, type Tx } from '@tcms/db';
import { pruefeKette } from '@tcms/domain/audit';
import { ladeAudit, pruefeAudit } from './audit';
import { fehlerVon, im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Audit gegen PostgreSQL', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const admin = kanzlei(randomUUID(), null, { tenantId: tenant, admin: true, bt: true });
  let programm = '';

  const schreibe = (tx: Tx, aktion: string, programmId: string | null = null) =>
    schreibeAudit(tx, {
      actorId: admin.id,
      actorName: 'Admin',
      aktion,
      objektTyp: 'Test',
      objektId: aktion,
      programmId,
      detail: { n: aktion },
    });

  beforeAll(async () => {
    await mitTenant(tenant, async (tx) => {
      await tx.mandant.create({ data: { id: mandant, name: 'Audit GmbH', rechtsform: 'KapG' } });
      programm = (
        await tx.tcmsProgramm.create({
          data: { mandantId: mandant, paketId: 'ecommerce', paketVersion: '1.0' },
        })
      ).id;
      for (let i = 1; i <= 7; i++) {
        await schreibe(tx, `tcms.test.${i % 2 ? 'a' : 'b'}${i}`, i <= 3 ? programm : null);
      }
    });
  });

  const lade = (e: AuditListeEingabe, a = admin) => im(a, (ctx) => ladeAudit(ctx, e));

  describe('ladeAudit', () => {
    it('Seiten aufsteigend (nach) und absteigend (vor) mit Cursor', async () => {
      const s1 = await lade({ limit: 3 });
      expect(AuditListeAntwortSchema.parse(s1)).toEqual(s1);
      expect(s1.eintraege.map((e) => e.aktion)).toEqual([
        'tcms.test.a1',
        'tcms.test.b2',
        'tcms.test.a3',
      ]);
      expect(s1.weiter).toBe(s1.eintraege[2]!.seq);
      const s2 = await lade({ limit: 3, nach: s1.weiter! });
      const s3 = await lade({ limit: 3, nach: s2.weiter! });
      expect(s3.eintraege).toHaveLength(1);
      expect(s3.weiter).toBeNull();
      const neu = await lade({ limit: 2, vor: MAX_AUDIT_SEQ });
      expect(neu.eintraege.map((e) => e.aktion)).toEqual(['tcms.test.a7', 'tcms.test.b6']);
      expect(neu.kopf?.seq).toBe(neu.eintraege[0]!.seq);
    });

    it('Filter: Programm, Mandant, Aktionspräfix; Mandant je Eintrag', async () => {
      const p = await lade({ programmId: programm });
      expect(p.eintraege).toHaveLength(3);
      expect(p.eintraege.every((e) => e.mandantId === mandant)).toBe(true);
      const m = await lade({ mandantId: mandant });
      expect(m.eintraege.map((e) => e.seq)).toEqual(p.eintraege.map((e) => e.seq));
      const b = await lade({ aktion: 'tcms.test.b' });
      expect(b.eintraege.map((e) => e.aktion)).toEqual([
        'tcms.test.b2',
        'tcms.test.b4',
        'tcms.test.b6',
      ]);
      expect((await lade({ mandantId: randomUUID() })).eintraege).toEqual([]);
    });

    it('nur Admins; andere Tenants sehen nichts davon', async () => {
      for (const a of [
        kanzlei(randomUUID(), mandant, { tenantId: tenant, bt: true, zustaendig: true }),
        kontakt(randomUUID(), mandant, tenant),
      ]) {
        expect((await fehlerVon(im(a, (ctx) => ladeAudit(ctx, {})))).code).toBe('NICHT_BERECHTIGT');
      }
      const fremd = kanzlei(randomUUID(), null, { tenantId: randomUUID(), admin: true });
      const f = await im(fremd, (ctx) => ladeAudit(ctx, { programmId: programm }));
      expect(f.eintraege).toEqual([]);
      expect(f.kopf).toBeNull();
    });

    it('ungültige Eingaben', async () => {
      for (const e of [
        { limit: MAX_AUDIT_JE_SEITE + 1 },
        { limit: 0 },
        { nach: MAX_AUDIT_SEQ + 1 },
        { nach: -1 },
        { nach: 1, vor: 5 },
        { programmId: programm, mandantId: mandant },
        { aktion: 'TCMS' },
        { programmId: "x' OR 1=1" },
        { tenantId: randomUUID() },
      ]) {
        expect((await fehlerVon(lade(e as AuditListeEingabe))).code).toBe('UNGUELTIG');
      }
    });
  });

  describe('pruefeAudit', () => {
    const pruefe = (ab?: number, opts?: { zeitbudgetMs?: number; seite?: number }, a = admin) =>
      im(a, (ctx) => pruefeAudit(ctx, ab === undefined ? {} : { ab }, opts));

    it('intakt; seitenweise mit Fortsetzung zum gleichen Ergebnis', async () => {
      const ganz = await pruefe();
      expect(ganz).toEqual({
        status: 'INTAKT',
        geprueft: 7,
        bruchBei: null,
        grund: null,
        weiterAb: null,
      });
      let ab: number | undefined;
      let summe = 0;
      let r: AuditPruefenAntwort;
      let aufrufe = 0;
      do {
        r = await pruefe(ab, { zeitbudgetMs: 0, seite: 2 });
        summe += r.geprueft;
        ab = r.weiterAb ?? undefined;
        aufrufe++;
      } while (r.status === 'ABGEBROCHEN' && aufrufe < 20);
      expect(r.status).toBe('INTAKT');
      expect(summe).toBe(7);
      expect(aufrufe).toBeGreaterThan(1);
    });

    it('erkennt einen manipulierten Eintrag wie pruefeKette (auch in der Fortsetzung)', async () => {
      const t = randomUUID();
      const a = kanzlei(randomUUID(), null, { tenantId: t, admin: true });
      const { gefaelscht, davor } = await mitTenant(t, async (tx) => {
        for (let i = 0; i < 3; i++) await schreibe(tx, `tcms.test.ok${i}`);
        const letzter = await tx.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } });
        // Ein angehängter Eintrag mit passendem Vorgänger, aber falschem Inhalts-Hash.
        const z = await tx.auditEvent.create({
          data: {
            kettenVersion: 2,
            at: new Date(),
            actorId: a.id,
            actorName: 'Fälscher',
            aktion: 'tcms.test.falsch',
            objektTyp: 'Test',
            objektId: 'x',
            detail: {},
            prevHash: letzter.hash,
            hash: randomBytes(32).toString('hex'),
          },
        });
        await schreibe(tx, 'tcms.test.danach');
        // seq ist tenantübergreifend: der Vorgänger ist nicht zwingend seq − 1.
        return { gefaelscht: z.seq, davor: letzter.seq };
      });
      const r = await pruefe(undefined, {}, a);
      expect(r).toMatchObject({ status: 'GEBROCHEN', bruchBei: gefaelscht, geprueft: 3 });
      const domain = await mitTenant(t, async (tx) =>
        pruefeKette(t, await tx.auditEvent.findMany({ orderBy: { seq: 'asc' } })),
      );
      expect({ bruchBei: r.bruchBei, grund: r.grund }).toEqual({
        bruchBei: domain.bruchBei,
        grund: domain.grund,
      });
      // Fortsetzung direkt vor dem gefälschten Eintrag erkennt ihn ebenso.
      const fort = await pruefe(davor, { seite: 1 }, a);
      expect(fort).toMatchObject({ status: 'GEBROCHEN', bruchBei: gefaelscht, geprueft: 0 });
    });

    it('nur Admins; unbekannter Fortsetzungspunkt ungültig', async () => {
      const ohne = kanzlei(randomUUID(), mandant, { tenantId: tenant, bt: true, zustaendig: true });
      expect((await fehlerVon(pruefe(undefined, {}, ohne))).code).toBe('NICHT_BERECHTIGT');
      expect((await fehlerVon(pruefe(MAX_AUDIT_SEQ))).code).toBe('UNGUELTIG');
    });
  });
});
