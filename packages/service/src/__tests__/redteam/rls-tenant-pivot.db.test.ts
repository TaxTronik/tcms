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
// Hinweis zur Einordnung: Es wurde KEINE konkrete SQL-Injection im Code
// gefunden (alle $queryRaw/$executeRaw sind parametrisierte Tagged Templates).
// Der Befund ist ein Defense-in-Depth-Mangel: RLS schützt die Mandantentrennung
// NICHT gegen beliebiges SQL derselben Rolle.
//
// Angepasst (tcms-rtfix, Entscheidung des Produktverantwortlichen, ADR 0001
// §10 „Bekannte Restrisiken"): Das Restrisiko wird dokumentiert, die
// Voraussetzung „keine Injection" maschinell abgesichert (statischer Test
// `packages/db/src/__tests__/roh-sql.test.ts`) und `mitTenant` prüft vor dem
// Commit, dass `tcms.tenant_id` unverändert ist. Dieser Test prüft das NEUE
// Schutzziel – ein in `mitTenant` umgesetzter Tenant-Kontext führt zum
// Rollback: kein Ergebnis verlässt die Transaktion, keine fremde Zeile wird
// geschrieben – und kennzeichnet die verbleibenden Restfälle (reiner
// SQL-Zugriff der Rolle außerhalb von `mitTenant`, Umsetzen und Zurücksetzen
// in derselben Transaktion) ausdrücklich als bekanntes Restrisiko. Die
// Restfall-Tests beschreiben den Ist-Zustand; schließt eine spätere Stufe die
// Lücke (z. B. Tenant-Bindung per SECURITY DEFINER), scheitern sie und das ADR
// ist nachzuziehen.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant, TenantFehler } from '@tcms/db';
import { baueWelt } from '../../bereiche/feststellungen-ereignisse/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT-02 RLS-Tenant-Pivot durch tcms_app', () => {
  it('eine zweite set_config-Anweisung in mitTenant führt zum Rollback (Lesen über Tenantgrenze)', async () => {
    const w = await baueWelt();
    let innen: { name: string }[] | null = null;

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
      innen = await tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM "Mandant" WHERE id = ${w.mandantB}::uuid`;
      return innen;
    }).catch((e: unknown) => e);

    // SICHERES SCHUTZZIEL: mitTenant rollt zurück und wirft; das Gelesene
    // verlässt die Transaktion nicht (keine Antwort mit Daten von Tenant B).
    expect(gelesen, 'Ergebnis eines umgesetzten Tenant-Kontexts verlässt mitTenant').toBeInstanceOf(
      TenantFehler,
    );
    // Innerhalb der Transaktion bleibt der Pivot möglich (Restrisiko, ADR §10):
    // nur der Rückweg ist abgeschnitten.
    expect(innen).toHaveLength(1);
  });

  it('der Pivot in mitTenant schreibt keine Zeile des fremden Tenants (Rollback)', async () => {
    const w = await baueWelt();
    const neuerName = `gekapert-${Date.now()}`;

    const ergebnis = await mitTenant(w.tenant, async (tx) => {
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantB}, true)`;
      // UPDATE über die Tenantgrenze (RLS WITH CHECK greift nicht, da der GUC
      // nun auf Tenant B zeigt).
      await tx.$executeRaw`UPDATE "Mandant" SET name = ${neuerName} WHERE id = ${w.mandantB}::uuid`;
    }).catch((e: unknown) => e);
    expect(ergebnis).toBeInstanceOf(TenantFehler);

    const name = await mitTenant(w.tenantB, (tx) =>
      tx.mandant.findFirstOrThrow({ where: { id: w.mandantB }, select: { name: true } }),
    );
    // SICHERE ERWARTUNG: Der Schreibzugriff aus einer Tenant-A-Transaktion darf
    // Tenant B nicht verändern.
    expect(name.name, 'RLS-Trennung verhindert tenantübergreifendes Schreiben nicht').not.toBe(
      neuerName,
    );
  });

  it('RESTRISIKO (bekannt, ADR 0001 §10): reiner SQL-Zugriff der Rolle außerhalb von mitTenant', async () => {
    // Wer beliebiges SQL als tcms_app ausführen kann (Injection, gestohlene
    // DATABASE_URL), setzt den GUC selbst. RLS hält das nicht auf; Gegenmittel
    // sind die erzwungene Parametrisierung und der Schutz der Zugangsdaten.
    const w = await baueWelt();
    const rolle = erzeugeClient(process.env['DATABASE_URL']);
    try {
      const fremd = await rolle.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantB}, true)`;
        return tx.$queryRaw<{ name: string }[]>`
          SELECT name FROM "Mandant" WHERE id = ${w.mandantB}::uuid`;
      });
      expect(fremd.length, 'Restrisiko dokumentiert: Rolle liest jeden Tenant').toBe(1);
    } finally {
      await rolle.$disconnect();
    }
  });

  it('RESTRISIKO (bekannt, ADR 0001 §10): Umsetzen und Zurücksetzen in derselben Transaktion', async () => {
    // Die Prüfung vor dem Commit sieht nur den Endzustand. Setzt beliebiges
    // SQL den Kontext um und wieder zurück, bleibt der Eingriff unerkannt.
    const w = await baueWelt();
    const neuerName = `zurueckgesetzt-${Date.now()}`;
    await mitTenant(w.tenant, async (tx) => {
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantB}, true)`;
      await tx.$executeRaw`UPDATE "Mandant" SET name = ${neuerName} WHERE id = ${w.mandantB}::uuid`;
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenant}, true)`;
    });
    const name = await mitTenant(w.tenantB, (tx) =>
      tx.mandant.findFirstOrThrow({ where: { id: w.mandantB }, select: { name: true } }),
    );
    expect(name.name, 'Restrisiko dokumentiert: Zurücksetzen vor dem Commit unerkannt').toBe(
      neuerName,
    );
  });
});
