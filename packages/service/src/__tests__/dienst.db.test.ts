// Ende-zu-Ende gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app):
// Dienstkontext, Audit mit Akteur, Rollen der Mandantenseite.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import { mitTenant, pruefeAuditKette } from '@tcms/db';
import { verweisAblage } from '../ablage';
import { mitAudit } from '../audit';
import { echteUhr, imDienst, keinPersonenVerzeichnis } from '../kontext';
import { kannLesen, kannPortalLesen } from '../rechte';
import { ladeKontaktRollen } from '../rollen';

const AKTIV = process.env['DB_TESTS'] === '1';
const PORTS = { uhr: echteUhr, personen: keinPersonenVerzeichnis, ablage: verweisAblage };

describe.skipIf(!AKTIV)('Dienstkontext gegen PostgreSQL', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const mandantA = randomUUID();
  const mandantA2 = randomUUID();
  const mandantB = randomUUID();
  const gv = randomUUID();
  const ehemals = randomUUID();

  const kanzlei: Akteur = {
    art: 'KANZLEI',
    tenantId: tenantA,
    id: randomUUID(),
    name: 'StB Prüferin',
    istAdmin: false,
    istBerufstraeger: true,
    mandant: { id: mandantA, zustaendigBerufstraeger: true, hauptbearbeitung: false },
  };
  const kontakt = (id: string, mandantId = mandantA): Akteur => ({
    art: 'MANDANT',
    tenantId: tenantA,
    id,
    name: 'Kontakt',
    mandantId,
  });

  beforeAll(async () => {
    await mitTenant(tenantA, async (tx) => {
      for (const id of [mandantA, mandantA2]) {
        await tx.mandant.create({ data: { id, name: 'A', rechtsform: 'KapG' } });
      }
      await tx.mandantKontaktRolle.createMany({
        data: [
          { mandantId: mandantA, kontaktId: gv, rolle: 'GESETZLICHER_VERTRETER' },
          {
            mandantId: mandantA,
            kontaktId: ehemals,
            rolle: 'GESETZLICHER_VERTRETER',
            aktiv: false,
          },
          // Rolle desselben Kontakts bei einem anderen Mandanten.
          { mandantId: mandantA2, kontaktId: ehemals, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
        ],
      });
    });
    await mitTenant(tenantB, (tx) =>
      tx.mandant.create({ data: { id: mandantB, name: 'B', rechtsform: 'KapG' } }),
    );
  });

  afterAll(async () => {
    // Keine Aufräumarbeiten nötig: zufällige Tenants.
  });

  it('läuft im Tenant des Akteurs und sieht keine Daten anderer Tenants', async () => {
    const sicht = await imDienst(kanzlei, PORTS, async (ctx) => ({
      eigene: await ctx.tx.mandant.findUnique({ where: { id: mandantA } }),
      fremde: await ctx.tx.mandant.findUnique({ where: { id: mandantB } }),
    }));
    expect(sicht.eigene?.id).toBe(mandantA);
    expect(sicht.fremde).toBeNull();
  });

  it('mitAudit schreibt Akteur-ID und -Name in die Kette des Tenants', async () => {
    await imDienst(kanzlei, PORTS, (ctx) =>
      mitAudit(ctx, async (tx) => {
        await tx.mandant.update({ where: { id: mandantA }, data: { name: 'A neu' } });
        return {
          wert: null,
          protokoll: {
            aktion: 'tcms.mandant.geaendert',
            objektTyp: 'Mandant',
            objektId: mandantA,
            programmId: null,
          },
        };
      }),
    );
    const [letzter, kette] = await mitTenant(tenantA, async (tx) => [
      await tx.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } }),
      await pruefeAuditKette(tx),
    ]);
    expect(letzter).toMatchObject({
      tenantId: tenantA,
      actorId: kanzlei.id,
      actorName: 'StB Prüferin',
      aktion: 'tcms.mandant.geaendert',
    });
    expect(Math.abs(letzter.at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(kette.gueltig).toBe(true);
  });

  it('eine Änderung ohne Protokoll wird zurückgerollt', async () => {
    await expect(
      imDienst(kanzlei, PORTS, (ctx) =>
        mitAudit(ctx, async (tx) => {
          await tx.mandant.update({ where: { id: mandantA }, data: { name: 'ohne Protokoll' } });
          return { wert: null, protokoll: [] };
        }),
      ),
    ).rejects.toThrow(/ohne Audit-Eintrag/);
    const m = await mitTenant(tenantA, (tx) =>
      tx.mandant.findUniqueOrThrow({ where: { id: mandantA } }),
    );
    expect(m.name).not.toBe('ohne Protokoll');
  });

  it('lädt nur aktive Rollen des Kontakts beim eigenen Mandanten', async () => {
    const lade = (a: Akteur) => imDienst(a, PORTS, (ctx) => ladeKontaktRollen(ctx.tx, ctx.akteur));
    const rollenGv = await lade(kontakt(gv));
    expect(rollenGv.map((r) => r.rolle)).toEqual(['GESETZLICHER_VERTRETER']);
    expect(kannPortalLesen(kontakt(gv), mandantA, rollenGv)).toBe(true);

    // deaktivierte Rolle bei A, aktive Rolle bei A2: für A kein Zugriff
    const rollenEhemals = await lade(kontakt(ehemals));
    expect(rollenEhemals).toEqual([]);
    expect(kannLesen(kontakt(ehemals), mandantA, rollenEhemals)).toBe(false);
    const rollenA2 = await lade(kontakt(ehemals, mandantA2));
    expect(kannLesen(kontakt(ehemals, mandantA2), mandantA2, rollenA2)).toBe(true);
    expect(kannLesen(kontakt(ehemals, mandantA2), mandantA, rollenA2)).toBe(false);

    // gleicher Kontakt in einem fremden Tenant: keine Rollen
    const fremd = { ...kontakt(gv), tenantId: tenantB } as Akteur;
    expect(await lade(fremd)).toEqual([]);
    expect(await lade(kanzlei)).toEqual([]);
  });
});
