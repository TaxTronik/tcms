// =============================================================================
// Mandantenanker und Kontaktrollen gegen PostgreSQL (DB_TESTS=1): Rechte,
// Tenant- und Mandantentrennung, Eingaben, Audit, Regeln (ein Mandant je
// Kontakt, letzte GV mit offenen Freigaben) und TS-05 mit zwei Verbindungen.
// Eigene, zufällige Tenants: unabhängig vom Demo-Seed.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Akteur, KontaktRollenEingabe, MandantAnkerEingabe } from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { ladeKontakte, setzeKontaktRollen } from './kontakte';
import { setzeMandantAnker } from './mandant';
import { fehlerVon, im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Mandantenanker und Kontaktrollen gegen PostgreSQL', () => {
  const tenant = randomUUID();
  const tenantB = randomUUID();
  const person = randomUUID();
  const admin = (mandantId: string | null, t = tenant) =>
    kanzlei(person, mandantId, { tenantId: t, admin: true, bt: true });
  const ohneZustaendigkeit = (mandantId: string) =>
    kanzlei(randomUUID(), mandantId, { tenantId: tenant, bt: true });
  const anker = (mandantId: string, name = 'Muster GmbH', a: Akteur = admin(mandantId)) =>
    im(a, (ctx) =>
      setzeMandantAnker(ctx, { mandantId, name, rechtsform: 'KapG', datevNr: '4711' }),
    );
  const rollen = (
    mandantId: string,
    kontaktId: string,
    r: KontaktRollenEingabe['rollen'],
    a: Akteur = admin(mandantId),
  ) => im(a, (ctx) => setzeKontaktRollen(ctx, { mandantId, kontaktId, rollen: r, funktion: null }));
  const audit = (aktion: string, objektId: string) =>
    mitTenant(tenant, (tx) => tx.auditEvent.findMany({ where: { aktion, objektId } }));

  describe('Mandantenanker', () => {
    it('legt an, ändert, und protokolliert jede Änderung genau einmal', async () => {
      const m = randomUUID();
      const neu = await anker(m);
      expect(neu).toMatchObject({
        angelegt: true,
        geaendert: true,
        mandant: { id: m, aktiv: true },
      });
      const gleich = await anker(m);
      expect(gleich).toMatchObject({ angelegt: false, geaendert: false });
      const anders = await anker(m, 'Muster AG');
      expect(anders).toMatchObject({ geaendert: true, mandant: { name: 'Muster AG' } });
      expect(await audit('tcms.mandant.angelegt', m)).toHaveLength(1);
      const akt = await audit('tcms.mandant.aktualisiert', m);
      expect(akt).toHaveLength(1);
      expect(akt[0]).toMatchObject({
        actorId: person,
        detail: {
          felder: ['name'],
          vorher: { name: 'Muster GmbH' },
          nachher: { name: 'Muster AG' },
        },
      });
    });

    it('Rechte: ohne oder mit anderem Bezug NICHT_GEFUNDEN, ohne Zuständigkeit NICHT_BERECHTIGT', async () => {
      const m = randomUUID();
      await anker(m);
      for (const a of [admin(null), admin(randomUUID()), kontakt(randomUUID(), m, tenant)]) {
        expect((await fehlerVon(anker(m, 'X', a))).code).toBe('NICHT_GEFUNDEN');
      }
      const f = await fehlerVon(anker(m, 'X', ohneZustaendigkeit(m)));
      expect([f.code, f.grund]).toEqual(['NICHT_BERECHTIGT', 'BEARBEITEN']);
      expect(
        (await mitTenant(tenant, (tx) => tx.mandant.findFirst({ where: { id: m } })))?.name,
      ).toBe('Muster GmbH');
    });

    it('fremder Tenant: dieselbe ID ist je Tenant ein eigener Anker; keine Auskunft über den anderen', async () => {
      const m = randomUUID();
      await anker(m, 'Fremde GmbH', admin(m, tenantB));
      // Anlegen im eigenen Tenant gelingt wie bei einer unbekannten ID (kein Existenz-Orakel).
      const r = await anker(m, 'Eigene GmbH', admin(m));
      expect(r).toMatchObject({
        angelegt: true,
        geaendert: true,
        mandant: { id: m, name: 'Eigene GmbH' },
      });
      expect(JSON.stringify(r)).not.toContain('Fremde');
      const b = await mitTenant(tenantB, (tx) => tx.mandant.findFirst({ where: { id: m } }));
      expect(b?.name).toBe('Fremde GmbH');
      const eigen = await mitTenant(tenant, (tx) => tx.mandant.findFirst({ where: { id: m } }));
      expect(eigen?.name).toBe('Eigene GmbH');
      // Aktualisieren trifft nur den eigenen Anker.
      await anker(m, 'Eigene AG', admin(m));
      expect(
        (await mitTenant(tenantB, (tx) => tx.mandant.findFirst({ where: { id: m } })))?.name,
      ).toBe('Fremde GmbH');
    });

    it('ungültige Eingaben', async () => {
      const m = randomUUID();
      for (const e of [
        { mandantId: m, name: '', rechtsform: 'KapG' },
        { mandantId: m, name: 'A\u0000B', rechtsform: 'KapG' },
        { mandantId: m, name: 'A\u202eB', rechtsform: 'KapG' },
        { mandantId: m, name: 'x'.repeat(201), rechtsform: 'KapG' },
        { mandantId: m, name: 'A', rechtsform: 'KapG', datevNr: '47a1' },
        { mandantId: m, name: 'A', rechtsform: 'KapG', tenantId: tenantB },
      ]) {
        const f = await fehlerVon(
          im(admin(m), (ctx) => setzeMandantAnker(ctx, e as MandantAnkerEingabe)),
        );
        expect(f.code).toBe('UNGUELTIG');
      }
    });

    it('TS-05: paralleles Anlegen desselben Ankers ergibt genau ein Anlegen', async () => {
      // Mehrere Durchgänge, damit das Rennen ohne Sperre zuverlässig auftritt.
      for (let i = 0; i < 8; i++) {
        const m = randomUUID();
        const alle = await Promise.all([anker(m), anker(m), anker(m)]);
        expect(alle.filter((x) => x.angelegt)).toHaveLength(1);
        expect(await audit('tcms.mandant.angelegt', m)).toHaveLength(1);
        expect(await audit('tcms.mandant.aktualisiert', m)).toHaveLength(0);
      }
    });
  });

  describe('Kontaktrollen', () => {
    let mA = '';
    let mB = '';
    let programm = '';

    beforeAll(async () => {
      mA = randomUUID();
      mB = randomUUID();
      await anker(mA, 'Mandant A');
      await anker(mB, 'Mandant B');
      programm = await mitTenant(
        tenant,
        async (tx) =>
          (
            await tx.tcmsProgramm.create({
              data: { mandantId: mA, paketId: 'ecommerce', paketVersion: '1.0' },
            })
          ).id,
      );
    });

    const offeneFreigabe = (empfaengerId: string) =>
      mitTenant(tenant, (tx) =>
        tx.freigabe.create({
          data: {
            programmId: programm,
            art: 'BESCHREIBUNG',
            refId: 'r',
            titel: 'Beschreibung v1.0',
            angefordertVon: person,
            empfaengerId,
          },
        }),
      );

    it('setzt, ändert und deaktiviert Rollen (auditiert, nie gelöscht)', async () => {
      const k = randomUUID();
      const r1 = await rollen(mA, k, ['GESETZLICHER_VERTRETER']);
      expect(r1).toEqual({
        kontaktId: k,
        geaendert: true,
        rollen: [{ rolle: 'GESETZLICHER_VERTRETER', aktiv: true, funktion: null }],
      });
      const r2 = await rollen(mA, k, ['TAX_COMPLIANCE_BEAUFTRAGTER', 'MITARBEITER']);
      expect(
        r2.rollen
          .filter((r) => r.aktiv)
          .map((r) => r.rolle)
          .sort(),
      ).toEqual(['MITARBEITER', 'TAX_COMPLIANCE_BEAUFTRAGTER']);
      expect((await rollen(mA, k, ['TAX_COMPLIANCE_BEAUFTRAGTER', 'MITARBEITER'])).geaendert).toBe(
        false,
      );
      const r3 = await rollen(mA, k, []);
      expect(r3.rollen).toHaveLength(3);
      expect(r3.rollen.every((r) => !r.aktiv)).toBe(true);
      const ev = await audit('tcms.kontakt.rollen_gesetzt', k);
      expect(ev).toHaveLength(3);
      expect(ev[0]).toMatchObject({
        programmId: programm,
        detail: { mandantId: mA, vorher: [], nachher: ['GESETZLICHER_VERTRETER'] },
      });
      const liste = await im(admin(mA), (ctx) => ladeKontakte(ctx, { mandantId: mA }));
      expect(liste.kontakte.find((x) => x.kontaktId === k)?.rollen).toHaveLength(3);
    });

    // RT4-T-07: Früher wies der Dienst eine Kontakt-ID mit (auch deaktivierten)
    // Rollen bei einem anderen Mandanten mit KONFLIKT ab. Das verriet Personen
    // mit Bezug zu nur einem Mandanten, ob eine ID Kontakt eines anderen
    // Mandanten ist, und ließ fremde IDs dauerhaft belegen. Die Bindung
    // Kontakt → Mandant liegt bei der kanzleikonsole (`cli`); Rollen gelten je
    // Mandant und verleihen bei einem anderen Mandanten nichts (rechte.test.ts).
    it('Rollen je Mandant: keine tenantweite Prüfung, keine Belegung fremder IDs (RT4-T-07)', async () => {
      const k = randomUUID();
      await rollen(mA, k, ['MITARBEITER']);
      await rollen(mA, k, []); // deaktiviert bei A
      const b = await rollen(mB, k, ['MITARBEITER'], admin(mB));
      expect(b.geaendert).toBe(true);
      const zeilen = await mitTenant(tenant, (tx) =>
        tx.mandantKontaktRolle.findMany({
          where: { kontaktId: k },
          select: { mandantId: true, aktiv: true },
          orderBy: { mandantId: 'asc' },
        }),
      );
      expect(zeilen.map((z) => `${z.mandantId === mA ? 'A' : 'B'}:${z.aktiv}`).sort()).toEqual([
        'A:false',
        'B:true',
      ]);
      // Gleiche Antwort für unbekannte und anderweitig vergebene IDs, ohne Spur.
      const vorher = await mitTenant(tenant, (tx) => tx.auditEvent.count());
      const unbekannt = await rollen(mA, randomUUID(), []);
      const anderweitig = await rollen(mA, k, []);
      expect(unbekannt.geaendert).toBe(false);
      expect(anderweitig.geaendert).toBe(false);
      expect(await mitTenant(tenant, (tx) => tx.auditEvent.count())).toBe(vorher);
    });

    it('letzte GV mit offener Freigabe nicht ohne Ersatz entfernbar', async () => {
      const gv = randomUUID();
      await rollen(mA, gv, ['GESETZLICHER_VERTRETER']);
      // Andere aktive GV aus vorherigen Tests deaktivieren.
      await mitTenant(tenant, (tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { mandantId: mA, rolle: 'GESETZLICHER_VERTRETER', kontaktId: { not: gv } },
          data: { aktiv: false },
        }),
      );
      await offeneFreigabe(gv);
      const f = await fehlerVon(rollen(mA, gv, ['MITARBEITER']));
      expect(f.code).toBe('KONFLIKT');
      // Großschreibung der ID ändert nichts (gleiche Person).
      const g = await fehlerVon(rollen(mA, gv.toUpperCase(), []));
      expect(g.code).toBe('KONFLIKT');
      // Mit Ersatz-GV möglich.
      const ersatz = randomUUID();
      await rollen(mA, ersatz, ['GESETZLICHER_VERTRETER']);
      expect((await rollen(mA, gv, ['MITARBEITER'])).geaendert).toBe(true);
    });

    it('TS-05: zwei GV mit offenen Freigaben gleichzeitig entfernen → genau eine Änderung', async () => {
      const [g1, g2] = [randomUUID(), randomUUID()];
      await mitTenant(tenant, (tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { mandantId: mA, rolle: 'GESETZLICHER_VERTRETER' },
          data: { aktiv: false },
        }),
      );
      await rollen(mA, g1, ['GESETZLICHER_VERTRETER']);
      await rollen(mA, g2, ['GESETZLICHER_VERTRETER']);
      await offeneFreigabe(g1);
      await offeneFreigabe(g2);
      const ergebnis = await Promise.allSettled([rollen(mA, g1, []), rollen(mA, g2, [])]);
      const ok = ergebnis.filter((x) => x.status === 'fulfilled');
      const nein = ergebnis.filter((x) => x.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(nein).toHaveLength(1);
      expect((nein[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'KONFLIKT' });
      const gvAktiv = await mitTenant(tenant, (tx) =>
        tx.mandantKontaktRolle.count({
          where: { mandantId: mA, rolle: 'GESETZLICHER_VERTRETER', aktiv: true },
        }),
      );
      expect(gvAktiv).toBe(1);
    });

    // RT4-T-07: Zuordnungen zu verschiedenen Mandanten sperren sich nicht mehr
    // gegenseitig; je Mandant entsteht die Rolle genau einmal.
    it('TS-05: denselben Kontakt gleichzeitig einem Mandanten zuordnen → genau eine Rolle', async () => {
      const k = randomUUID();
      const ergebnis = await Promise.allSettled([
        rollen(mA, k, ['MITARBEITER']),
        rollen(mA, k, ['MITARBEITER']),
        rollen(mB, k, ['MITARBEITER'], admin(mB)),
      ]);
      expect(ergebnis.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
      const zeilen = await mitTenant(tenant, (tx) =>
        tx.mandantKontaktRolle.findMany({ where: { kontaktId: k }, select: { mandantId: true } }),
      );
      expect(zeilen.map((z) => (z.mandantId === mA ? 'A' : 'B')).sort()).toEqual(['A', 'B']);
    });

    it('Rechte und Trennung', async () => {
      const k = randomUUID();
      for (const a of [
        admin(null),
        admin(mB),
        kontakt(randomUUID(), mA, tenant),
        admin(mA, tenantB),
      ]) {
        expect((await fehlerVon(rollen(mA, k, ['MITARBEITER'], a))).code).toBe('NICHT_GEFUNDEN');
      }
      const nb = await fehlerVon(rollen(mA, k, ['MITARBEITER'], ohneZustaendigkeit(mA)));
      expect([nb.code, nb.grund]).toEqual(['NICHT_BERECHTIGT', 'BEARBEITEN']);
      // Lesen: Kanzleiperson mit Bezug ja, Mandantenkontakt und fremder Tenant nein.
      await im(ohneZustaendigkeit(mA), (ctx) => ladeKontakte(ctx, { mandantId: mA }));
      for (const a of [kontakt(randomUUID(), mA, tenant), admin(mA, tenantB), admin(mB)]) {
        expect((await fehlerVon(im(a, (ctx) => ladeKontakte(ctx, { mandantId: mA })))).code).toBe(
          'NICHT_GEFUNDEN',
        );
      }
      expect(
        await mitTenant(tenant, (tx) => tx.mandantKontaktRolle.count({ where: { kontaktId: k } })),
      ).toBe(0);
    });

    it('ungültige Eingaben', async () => {
      for (const e of [
        { mandantId: mA, kontaktId: 'x', rollen: [] },
        { mandantId: mA, kontaktId: randomUUID(), rollen: ['MITARBEITER', 'MITARBEITER'] },
        { mandantId: mA, kontaktId: randomUUID(), rollen: ['ADMIN'] },
        { mandantId: mA, kontaktId: randomUUID(), rollen: [], funktion: 'a\nb' },
        { mandantId: mA, kontaktId: randomUUID(), rollen: [], aktiv: true },
      ]) {
        const f = await fehlerVon(
          im(admin(mA), (ctx) => setzeKontaktRollen(ctx, e as KontaktRollenEingabe)),
        );
        expect(f.code).toBe('UNGUELTIG');
      }
    });
  });
});
