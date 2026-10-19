-- =============================================================================
-- Produktions-Bootstrap (tcms-migrate, Schritt 1; Betriebsschnittstelle
-- Stufe 2). Läuft mit psql als Superuser (TCMS_DB_SUPERUSER_URL) in der
-- Datenbank des Tax-CMS, aufgerufen von migrate.sh.
--
-- Die Passwörter liest psql selbst aus der Umgebung (`\getenv`), sie stehen
-- weder in einer Kommandozeile noch in dieser Datei. Rollenattribute und
-- Rechte kommen aus derselben Quelle wie in der Entwicklung (`rollen.psql`).
-- =============================================================================

\set ON_ERROR_STOP on
\set VERBOSITY terse
\set SHOW_CONTEXT never

SELECT rolsuper AS tcms_ist_superuser
FROM pg_catalog.pg_roles WHERE rolname = current_user \gset
\if :tcms_ist_superuser
\else
  DO $kein$ BEGIN RAISE EXCEPTION 'TCMS_DB_SUPERUSER_URL verwendet keinen Superuser'; END $kein$;
\endif

\getenv tcms_owner_passwort TCMS_DB_OWNER_PASSWORD
\getenv tcms_app_passwort TCMS_DB_APP_PASSWORD
\ir ../prisma/init/rollen.psql
\unset tcms_owner_passwort
\unset tcms_app_passwort
