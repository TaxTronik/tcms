-- =============================================================================
-- Tax-CMS – Entfallen-Antrag einer Durchführung nur vollständig (Befund 102 d).
--
-- Ein Entfallen-Antrag besteht aus Begründung und antragstellender Person
-- (`entfallenBegruendung`, `entfallenVon`). Der Dienst setzt und leert beide
-- immer gemeinsam; die Vier-Augen-Prüfung der Freigabe (zweite Person) stützt
-- sich auf die gespeicherte antragstellende Person. Der CHECK schließt eine
-- Begründung ohne Person (und umgekehrt) für jede Rolle aus – zusätzlich zur
-- Prüfung des Dienstes (`zweitePerson`, fail closed).
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert. Wie die übrigen Nachträge setzt die Migration eine Datenbank
-- ohne Bestandsdaten voraus (ADR 0001 §4); kein Schreibweg erzeugt ein
-- unvollständiges Paar, eine solche Zeile ließe den CHECK scheitern (fail closed).
-- =============================================================================

-- AddCheckConstraint
ALTER TABLE "Durchfuehrung" ADD CONSTRAINT "Durchfuehrung_entfallen_antrag_check" CHECK (("entfallenBegruendung" IS NULL) = ("entfallenVon" IS NULL));
