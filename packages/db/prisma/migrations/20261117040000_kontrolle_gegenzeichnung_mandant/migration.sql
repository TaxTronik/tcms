-- =============================================================================
-- Tax-CMS – Gegenzeichnung beim Mandanten nur bei Kontrollen des Mandanten
-- (Befunde 9/10 der Prüfung vom 17.11.2026).
--
-- Bei `gegenzeichnungMandant` bestätigt eine zweite Person beim Mandanten im
-- Portal; das Portal zeigt Mandantenkontakten nur Kontrollen der Partei
-- MANDANT. Ein Kontrollstand der Partei KANZLEI mit Gegenzeichnung beim
-- Mandanten wäre nie abschließbar. Der Dienst prüft das in einer Regel für alle
-- Wege (packages/service/src/kern/zustaendigkeit.ts); die Datenbank hält es
-- zusätzlich fest.
--
-- Seed und Bestand erfüllen die Regel (Standardbelegung: nur K-EC-23, Partei
-- MANDANT). Ein Bestand aus dem früheren Fehler des Einrichtungsassistenten
-- lässt diese Migration scheitern statt still zu bleiben; er ist vorher
-- fachlich zu klären (neuer Kontrollstand, Durchführungen zurückweisen und
-- entfallen lassen).
-- =============================================================================

ALTER TABLE "KontrolleStand" ADD CONSTRAINT "KontrolleStand_gegenzeichnung_mandant_check" CHECK ("partei" = 'MANDANT' OR NOT "gegenzeichnungMandant");
