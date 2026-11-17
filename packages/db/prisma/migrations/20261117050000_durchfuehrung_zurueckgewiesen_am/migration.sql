-- =============================================================================
-- Tax-CMS – Zeitpunkt der Zurückweisung einer Durchführung (Befund 85).
--
-- Der abgeleitete Status zu einem Stichtag (`statusAm`, @tcms/domain) kannte
-- den Zeitpunkt der Zurückweisung nicht und zeigte „zurückgewiesen" rückwirkend
-- ab der Einreichung. Neu hält `zurueckgewiesenAm` die letzte Zurückweisung
-- fest (fachliche Zeit wie `eingereichtAm`); eine erneute Einreichung lässt
-- sie stehen. Zwischen Einreichung und Zurückweisung gilt die Durchführung
-- damit als „zur Gegenzeichnung", danach bis zur erneuten Einreichung als
-- „zurückgewiesen".
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert. Bestehende Zeilen bleiben NULL (keine Rückrechnung aus dem
-- Audit); für sie gilt die frühere Ableitung ab `eingereichtAm`.
-- =============================================================================

-- AlterTable
ALTER TABLE "Durchfuehrung" ADD COLUMN "zurueckgewiesenAm" TIMESTAMP(3);
