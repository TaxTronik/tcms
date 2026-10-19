// =============================================================================
// RED TEAM RT-02 — Angreifermodell F (Laufzeitrolle `tcms_app` mit beliebigem
// SQL über eine hypothetische Injection).
//
// Die Mandantentrennung (ADR 0001 §4) beruht auf RLS mit der Policy
// `tenant_id = tcms_aktueller_tenant()`, wobei `tcms_aktueller_tenant()` den
// transaktionslokalen GUC `tcms.tenant_id` liest. Diesen GUC darf JEDE Rolle
// setzen – auch `tcms_app`. `mitTenant` setzt ihn zwar aus dem Akteur, aber
// jede weitere SQL-Anweisung derselben Transaktion (z. B. aus einer Injection)
// kann ihn mit `set_config('tcms.tenant_id', <fremder Tenant>, true)`
// überschreiben und so die RLS-Trennung vollständig aufheben: Lesen UND
// Schreiben über Tenantgrenzen hinweg.
//
// Dieser Test belegt den Pivot innerhalb EINER `tcms_app`-Transaktion (wie sie
// eine Injection im Anfragekontext hätte). Er schlägt fehl, solange der GUC
// durch die Laufzeitrolle frei überschreibbar ist; mit einer gegen
// Überschreiben gehärteten Tenant-Bindung (z. B. nicht-USERSET-GUC per
// SECURITY-DEFINER-Setup oder Rolle je Tenant) würde er grün.
//
// Hinweis zur Einordnung: Es wurde KEINE konkrete SQL-Injection im Code
// gefunden (alle $queryRaw/$executeRaw sind parametrisierte Tagged Templates).
// Der Befund ist ein Defense-in-Depth-Mangel: RLS schützt die Mandantentrennung
// NICHT gegen beliebiges SQL derselben Rolle.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { mitTenant } from '@tcms/db';
import { baueWelt } from '../../bereiche/feststellungen-ereignisse/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT-02 RLS-Tenant-Pivot durch tcms_app', () => {
  it('eine zweite set_config-Anweisung hebt die Mandantentrennung auf (Lesen über Tenantgrenze)', async () => {
    const w = await baueWelt();

    // Eine Transaktion im Tenant A (wie eine normale Anfrage). Darin eine
    // zweite Anweisung, die den Tenant-GUC auf Tenant B umbiegt und dessen
    // Mandant liest – genau das, was eine Injection im Anfragekontext täte.
    const gelesen = await mitTenant(w.tenant, async (tx) => {
      // Gegenprobe: im korrekten Kontext ist Tenant B unsichtbar.
      const vorher = await tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM "Mandant" WHERE id = ${w.mandantB}::uuid`;
      expect(vorher.length).toBe(0);

      // Angriff: Tenant-GUC der laufenden Transaktion überschreiben.
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantB}, true)`;
      return tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM "Mandant" WHERE id = ${w.mandantB}::uuid`;
    });

    // SICHERE ERWARTUNG: Auch nach einem erneuten set_config darf die
    // Laufzeitrolle keine Zeile eines anderen Tenants sehen. Tatsächlich sieht
    // sie Mandant B – die Trennung ist aufgehoben.
    expect(
      gelesen.length,
      'RLS-Trennung durch set_config aufgehoben: fremder Tenant lesbar',
    ).toBe(0);
  });

  it('der Pivot erlaubt auch Schreibzugriff über die Tenantgrenze', async () => {
    const w = await baueWelt();
    const neuerName = `gekapert-${Date.now()}`;

    await mitTenant(w.tenant, async (tx) => {
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantB}, true)`;
      // UPDATE über die Tenantgrenze (RLS WITH CHECK greift nicht, da der GUC
      // nun auf Tenant B zeigt).
      await tx.$executeRaw`UPDATE "Mandant" SET name = ${neuerName} WHERE id = ${w.mandantB}::uuid`;
    });

    const name = await mitTenant(w.tenantB, (tx) =>
      tx.mandant.findFirstOrThrow({ where: { id: w.mandantB }, select: { name: true } }),
    );
    // SICHERE ERWARTUNG: Der Schreibzugriff aus einer Tenant-A-Transaktion darf
    // Tenant B nicht verändern.
    expect(name.name, 'RLS-Trennung verhindert tenantübergreifendes Schreiben nicht').not.toBe(
      neuerName,
    );
  });
});
