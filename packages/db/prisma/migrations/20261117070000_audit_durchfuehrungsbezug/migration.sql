-- =============================================================================
-- Tax-CMS – Durchführungsbezug der Audit-Einträge mit Index (Befunde 98, 110).
--
-- Verlauf und Beteiligte einer Durchführung lesen außer den Einträgen der
-- Durchführung selbst (objektTyp/objektId, Index vorhanden) auch Einträge
-- anderer Objekte, die sie im Detail nennen: `detail.durchfuehrungId`
-- (Nachweise, Feststellungen aus Gegenzeichnung und Nachkontrolle) und
-- `detail.nachtragZuId` (Nachtrag zu dieser Durchführung). Dafür gab es keinen
-- Index: Jede Detailansicht und jede Portal-Aufgabe las das Audit des ganzen
-- Tenants.
--
-- Ein Ausdrucksindex auf `detail->>'…'` hilft nicht: Unter RLS darf PostgreSQL
-- eine Bedingung der Abfrage nur vor der Policy auswerten (also als
-- Indexbedingung nutzen), wenn sie LEAKPROOF ist; `->>`
-- (jsonb_object_field_text) ist es nicht, und LEAKPROOF-Funktionen kann nur ein
-- Superuser anlegen. Deshalb zwei gespeicherte, generierte Spalten: Ihr
-- Vergleich ist ein gewöhnliches `text = text` (LEAKPROOF) und nutzt den
-- Teilindex je Tenant. Sie leiten sich nur aus `detail` ab – Hash und
-- Kettenprüfung bleiben unverändert, schreiben kann sie niemand (GENERATED).
-- Prisma kennt die Spalten nicht (Zugriff nur per Raw-SQL im Dienst).
--
-- Keine neue Tabelle: RLS, Policy und Grants (tcms_app nur SELECT/INSERT)
-- gelten unverändert. Das Hinzufügen schreibt die Tabelle einmal neu (Sperre
-- für die Dauer der Migration).
-- =============================================================================

-- AlterTable
ALTER TABLE "AuditEvent"
  ADD COLUMN "detailDurchfuehrungId" TEXT GENERATED ALWAYS AS ("detail" ->> 'durchfuehrungId') STORED,
  ADD COLUMN "detailNachtragZuId" TEXT GENERATED ALWAYS AS ("detail" ->> 'nachtragZuId') STORED;

-- CreateIndex (Teilindex: nur Einträge mit Bezug)
CREATE INDEX "AuditEvent_tenant_id_detailDurchfuehrungId_idx"
  ON "AuditEvent"("tenant_id", "detailDurchfuehrungId")
  WHERE "detailDurchfuehrungId" IS NOT NULL;
CREATE INDEX "AuditEvent_tenant_id_detailNachtragZuId_idx"
  ON "AuditEvent"("tenant_id", "detailNachtragZuId")
  WHERE "detailNachtragZuId" IS NOT NULL;
