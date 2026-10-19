-- =============================================================================
-- DB-Bootstrap für Entwicklung, CI und Tests (ADR 0001 §4).
--
-- Legt die beiden Rollen des Tax-CMS idempotent an und richtet das Schema
-- `public` der aktuellen Datenbank ein. Muss als Superuser mit psql laufen
-- (z. B. im Compose-Init-Verzeichnis oder `psql -U postgres -d <db> -f …`),
-- und zwar vor der ersten Migration; die Init-Migration bricht ohne diese
-- Rollen ab.
--
-- Rollenattribute und Rechte stehen nur in `rollen.psql` (gemeinsam mit dem
-- Produktions-Bootstrap des Images tcms-migrate, packages/db/betrieb/).
--
-- Passwörter sind fix und gleich dem Rollennamen. NICHT für Produktion – dort
-- setzt tcms-migrate die Zufallspasswörter aus TCMS_DB_OWNER_PASSWORD und
-- TCMS_DB_APP_PASSWORD (ADR §8). Rollen sind clusterweit; der Rest gilt für
-- die aktuelle Datenbank.
-- =============================================================================

\set tcms_owner_passwort tcms_owner
\set tcms_app_passwort tcms_app
\ir rollen.psql
\unset tcms_owner_passwort
\unset tcms_app_passwort
