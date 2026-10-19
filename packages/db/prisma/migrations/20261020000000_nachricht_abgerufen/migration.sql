-- =============================================================================
-- Tax-CMS – erste Auslieferung einer Nachricht (Hinweis H2 aus RT4).
--
-- Eine Meldung „zugestellt" bzw. „unzustellbar" der kanzleikonsole geht dem
-- Verwerfen nur vor, wenn sie die Nachricht vor dem Verwerfen abgeholt hatte.
-- Bisher galt das ungeprüft: Auch eine verworfene, nie ausgelieferte
-- Nachricht ließ sich als zugestellt melden und erschien an der Freigabe als
-- ZUGESTELLT. Neu hält `abgerufenAm` die erste Auslieferung durch den Abruf
-- fest (echte Zeit); der CHECK erlaubt zugestellt bzw. unzustellbar neben
-- verworfen nur nach einer Auslieferung – für jede Rolle, zusätzlich zur
-- Prüfung des Dienstes unter Zeilensperre (409).
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert. Wie die übrigen Nachträge setzt die Migration eine Datenbank
-- ohne Bestandsdaten voraus (ADR 0001 §4): Eine bereits verworfene und
-- zugestellte Nachricht ließe den CHECK scheitern (fail closed).
-- =============================================================================

-- AlterTable
ALTER TABLE "Nachricht" ADD COLUMN "abgerufenAm" TIMESTAMP(3);

-- AddCheckConstraint (verworfen und nie ausgeliefert: weder zugestellt noch unzustellbar)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_verworfen_ausgeliefert_check" CHECK ("verworfenAm" IS NULL OR "abgerufenAm" IS NOT NULL OR ("zugestelltAm" IS NULL AND "unzustellbarAm" IS NULL));
