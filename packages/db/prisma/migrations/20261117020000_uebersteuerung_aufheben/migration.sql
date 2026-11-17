-- =============================================================================
-- Tax-CMS – Übersteuerung aufheben (Befund 4 der Gesamtprüfung vom 17.11.2026).
--
-- Eine freigegebene Übersteuerung der Nettoklasse lässt sich aufheben; danach
-- gilt wieder der berechnete Wert (AGENTS.md Regel 2). Die Aufhebung hält
-- Person und Zeitpunkt an der Übersteuerung fest, damit ein historischer
-- Stichtag die Übersteuerung bis zur Aufhebung weiter anwendet. Die
-- Begründung steht im Audit (`tcms.risiko.uebersteuerung_aufgehoben`).
--
-- Keine neue Tabelle; RLS, Policy und Grants gelten unverändert. Der CHECK
-- verlangt Person und Zeitpunkt nur gemeinsam und nur im Status AUFGEHOBEN.
-- =============================================================================

-- AlterTable
ALTER TABLE "Uebersteuerung" ADD COLUMN "aufgehobenVon" TEXT;
ALTER TABLE "Uebersteuerung" ADD COLUMN "aufgehobenAm" TIMESTAMP(3);

-- AddCheckConstraint
ALTER TABLE "Uebersteuerung" ADD CONSTRAINT "Uebersteuerung_aufgehoben_check" CHECK (("aufgehobenVon" IS NULL) = ("aufgehobenAm" IS NULL) AND ("aufgehobenAm" IS NULL OR "status" = 'AUFGEHOBEN'));
