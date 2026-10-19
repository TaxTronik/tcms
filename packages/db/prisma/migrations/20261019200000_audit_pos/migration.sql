-- =============================================================================
-- Tax-CMS – Audit-Position je Tenant (RT-03).
--
-- `seq` ist ein globaler SERIAL über alle Tenants. Wurde er ausgegeben,
-- verrieten Lücken in der eigenen Folge, wie viele Audit-Ereignisse andere
-- Kanzleien dazwischen geschrieben haben (Seitenkanal). Neu ist `pos`, die
-- laufende Position je Tenant (1, 2, 3, …): `schreibeAudit` vergibt sie unter
-- der Tenant-Sperre als Vorgänger-`pos` + 1; (tenant_id, pos) ist eindeutig.
-- Alle Ausgaben (Audit-Liste, Cursor, Kettenstand, Kettenprüfung, Verläufe)
-- nutzen `pos`; `seq` bleibt technischer Schlüssel und verlässt den Dienst nicht.
--
-- Keine neue Tabelle: RLS, Policy und Grants (nur SELECT/INSERT) der
-- Init-Migration gelten unverändert. Wie die Welle-2-Nachträge setzt die
-- Migration eine Datenbank ohne Bestandsdaten voraus (ADR 0001 §4): Vorhandene
-- Audit-Zeilen lassen sie an NOT NULL scheitern (fail closed), statt Positionen
-- nachträglich zu erfinden.
-- =============================================================================

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN "pos" INTEGER NOT NULL;

-- AddCheckConstraint
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_pos_check" CHECK ("pos" >= 1);

-- CreateIndex (Cursor der Audit-Liste und Kettenprüfung je Tenant)
CREATE UNIQUE INDEX "AuditEvent_tenant_id_pos_key" ON "AuditEvent"("tenant_id", "pos");

-- DropIndex (ersetzt durch den eindeutigen Schlüssel auf pos)
DROP INDEX "AuditEvent_tenant_id_seq_idx";

-- DropIndex / CreateIndex (Filter nach Programm bzw. Aktion mit Cursor auf pos)
DROP INDEX "AuditEvent_tenant_id_programmId_seq_idx";
CREATE INDEX "AuditEvent_tenant_id_programmId_pos_idx" ON "AuditEvent"("tenant_id", "programmId", "pos");

DROP INDEX "AuditEvent_tenant_id_aktion_seq_idx";
CREATE INDEX "AuditEvent_tenant_id_aktion_pos_idx" ON "AuditEvent"("tenant_id", "aktion", "pos");
