-- =============================================================================
-- Tax-CMS – Schema-Nachträge der Welle 2 (Aufgabe tcms-int 2d, Vorschläge der
-- Bereiche durchfuehrung, risiken-kontrollen, feststellungen-ereignisse,
-- programm-beschreibung und lesepfade).
--
-- Keine neuen Tabellen: RLS, Policies und Grants der Init-Migration gelten
-- unverändert. Neue Funktion und neuer Enum gehören tcms_owner.
--
-- Bestandsdaten gibt es nicht (ADR 0001 §4). Die Migration setzt frische
-- Datenbanken voraus und konvertiert nichts: Zeilen im Altformat lassen sie
-- scheitern (NOT NULL ohne Standard, CHECK, eindeutige Teilindizes) statt sie
-- stillschweigend zu übernehmen (fail closed). Datenmigrationen als
-- tcms_owner sähen wegen FORCE ROW LEVEL SECURITY ohnehin keine Zeilen.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Mandant: Primärschlüssel (tenant_id, id) statt global id. Dieselbe
-- Mandanten-ID der kanzleikonsole kann in zwei Tenants bestehen; das Anlegen
-- scheitert nie an einer unsichtbaren Zeile eines anderen Tenants (kein
-- Existenz-Orakel). Die Fremdschlüssel liefen schon über (tenant_id, id) und
-- verweisen jetzt auf den Primärschlüssel.
-- -----------------------------------------------------------------------------

-- DropForeignKey
ALTER TABLE "MandantKontaktRolle" DROP CONSTRAINT "MandantKontaktRolle_tenant_id_mandantId_fkey";

-- DropForeignKey
ALTER TABLE "TcmsProgramm" DROP CONSTRAINT "TcmsProgramm_tenant_id_mandantId_fkey";

-- DropIndex
DROP INDEX "Mandant_tenant_id_id_key";

-- AlterTable
ALTER TABLE "Mandant" DROP CONSTRAINT "Mandant_pkey",
ADD CONSTRAINT "Mandant_pkey" PRIMARY KEY ("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "MandantKontaktRolle" ADD CONSTRAINT "MandantKontaktRolle_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TcmsProgramm" ADD CONSTRAINT "TcmsProgramm_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Freigabe: Fehlversuche des Bestätigungscodes als eigene Spalte (bisher im
-- Format `v1:<n>:<hex>` in codeHash). codeHash ist nur noch der SHA-256 (hex).
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Freigabe" ADD COLUMN "codeFehlversuche" INTEGER NOT NULL DEFAULT 0;

-- AddCheckConstraint
ALTER TABLE "Freigabe" ADD CONSTRAINT "Freigabe_codeFehlversuche_check" CHECK ("codeFehlversuche" BETWEEN 0 AND 5);

-- AddCheckConstraint
ALTER TABLE "Freigabe" ADD CONSTRAINT "Freigabe_codeHash_check" CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$');

-- -----------------------------------------------------------------------------
-- Nachricht (Postausgang): Empfänger als Personen-ID, Zweck, Zustellung.
-- `an` (Adresse als Text) entfällt (TS-06).
-- -----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "NachrichtZweck" AS ENUM ('FREIGABE_ANGEFORDERT', 'FREIGABE_CODE', 'FREIGABE_NEU_ADRESSIERT', 'EREIGNIS_GEMELDET');

-- DropIndex
DROP INDEX "Nachricht_tenant_id_createdAt_idx";

-- AlterTable
ALTER TABLE "Nachricht" DROP COLUMN "an",
ADD COLUMN     "empfaengerId" UUID NOT NULL,
ADD COLUMN     "zugestelltAm" TIMESTAMP(3),
ADD COLUMN     "zweck" "NachrichtZweck" NOT NULL;

-- CreateIndex
CREATE INDEX "Nachricht_tenant_id_zugestelltAm_createdAt_idx" ON "Nachricht"("tenant_id", "zugestelltAm", "createdAt");

-- -----------------------------------------------------------------------------
-- Nachweis: Entfernen markiert den Verweis, statt ihn zu löschen.
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Nachweis" ADD COLUMN     "entferntAm" TIMESTAMP(3),
ADD COLUMN     "entferntVon" TEXT;

-- CreateIndex
CREATE INDEX "Nachweis_tenant_id_dokumentId_idx" ON "Nachweis"("tenant_id", "dokumentId");

-- -----------------------------------------------------------------------------
-- Ereignis: Antragsteller:in des Verwerfens als Spalte statt Audit-Lesung.
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "Ereignis" ADD COLUMN     "verwerfenBeantragtVon" TEXT;

-- -----------------------------------------------------------------------------
-- Audit: Suche nach Aktion je Tenant (Lesepfade, Filter `aktion`).
-- -----------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "AuditEvent_tenant_id_aktion_seq_idx" ON "AuditEvent"("tenant_id", "aktion", "seq");

-- -----------------------------------------------------------------------------
-- TS-05: eindeutige Teilindizes. Die Operationen prüfen unter Zeilensperre;
-- die Indizes sichern dasselbe in der Datenbank (Verletzung → KONFLIKT).
-- -----------------------------------------------------------------------------

-- CreateIndex: höchstens ein offener Nachtrag je Durchführung
CREATE UNIQUE INDEX "Durchfuehrung_nachtrag_offen_key" ON "Durchfuehrung"("tenant_id", "nachtragZuId") WHERE "nachtragZuId" IS NOT NULL AND "status" IN ('GEPLANT', 'IN_DURCHFUEHRUNG', 'ZUR_GEGENZEICHNUNG', 'ZURUECKGEWIESEN');

-- CreateIndex: höchstens eine beantragte Übersteuerung je (Risiko, Sicht)
CREATE UNIQUE INDEX "Uebersteuerung_beantragt_key" ON "Uebersteuerung"("tenant_id", "risikoId", "sicht") WHERE "status" = 'BEANTRAGT';

-- CreateIndex: höchstens eine offene Risikoakzeptanz je Risiko
CREATE UNIQUE INDEX "Freigabe_risikoakzeptanz_offen_key" ON "Freigabe"("tenant_id", "refId") WHERE "art" = 'RISIKOAKZEPTANZ' AND "status" = 'OFFEN';

-- -----------------------------------------------------------------------------
-- CMS-Beschreibung: Ab dem Einfrieren (beim Mandanten, freigegeben, abgelöst)
-- sind Inhalt und Metadaten unveränderlich (AGENTS.md Regel 3). Erlaubt sind
-- nur die Statusübergänge BEIM_MANDANTEN → FREIGEGEBEN (mit freigegebenVon/Am)
-- und BEIM_MANDANTEN/FREIGEGEBEN → ABGELOEST; Löschen ist ausgeschlossen. Der
-- Trigger gilt für jede Rolle; nur der Eigentümer (Migrationen) kann ihn
-- abschalten.
-- -----------------------------------------------------------------------------

-- CreateFunction
CREATE FUNCTION "tcms_beschreibung_eingefroren"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD."status"::text NOT IN ('BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tcms: eingefrorene CMS-Beschreibung kann nicht gelöscht werden';
  END IF;
  IF ROW(NEW."id", NEW."tenant_id", NEW."programmId", NEW."nummer", NEW."abschnitte",
         NEW."reviewAngefordertVon", NEW."reviewAngefordertAm", NEW."reviewVon", NEW."reviewAm",
         NEW."freigabeAngefordertAm", NEW."snapshot", NEW."snapshotSha256", NEW."createdAt",
         NEW."erstelltVon")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."tenant_id", OLD."programmId", OLD."nummer", OLD."abschnitte",
         OLD."reviewAngefordertVon", OLD."reviewAngefordertAm", OLD."reviewVon", OLD."reviewAm",
         OLD."freigabeAngefordertAm", OLD."snapshot", OLD."snapshotSha256", OLD."createdAt",
         OLD."erstelltVon") THEN
    RAISE EXCEPTION 'tcms: eingefrorene CMS-Beschreibung ist unveränderlich';
  END IF;
  IF OLD."status"::text = 'BEIM_MANDANTEN' AND NEW."status"::text = 'FREIGEGEBEN' THEN
    IF NEW."freigegebenVon" IS NULL OR NEW."freigegebenAm" IS NULL THEN
      RAISE EXCEPTION 'tcms: Freigabe ohne freigebende Person und Zeitpunkt';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."freigegebenVon", NEW."freigegebenAm")
     IS DISTINCT FROM ROW(OLD."freigegebenVon", OLD."freigegebenAm") THEN
    RAISE EXCEPTION 'tcms: eingefrorene CMS-Beschreibung ist unveränderlich';
  END IF;
  IF NEW."status" = OLD."status"
     OR (OLD."status"::text IN ('BEIM_MANDANTEN', 'FREIGEGEBEN') AND NEW."status"::text = 'ABGELOEST') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tcms: unzulässiger Statusübergang einer eingefrorenen CMS-Beschreibung';
END
$fn$;

-- CreateTrigger
CREATE TRIGGER "BeschreibungVersion_eingefroren" BEFORE UPDATE OR DELETE ON "BeschreibungVersion" FOR EACH ROW EXECUTE FUNCTION "tcms_beschreibung_eingefroren"();

-- -----------------------------------------------------------------------------
-- Eigentümer und Rechte der neuen Objekte
-- -----------------------------------------------------------------------------

ALTER FUNCTION "tcms_beschreibung_eingefroren"() OWNER TO tcms_owner;
REVOKE ALL ON FUNCTION "tcms_beschreibung_eingefroren"() FROM PUBLIC;
ALTER TYPE "NachrichtZweck" OWNER TO tcms_owner;
