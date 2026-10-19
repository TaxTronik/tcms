-- =============================================================================
-- DB-Bootstrap für Entwicklung, CI und Tests (ADR 0001 §4).
--
-- Legt die beiden Rollen des Tax-CMS idempotent an und richtet das Schema
-- `public` der aktuellen Datenbank ein. Muss als Superuser laufen (z. B. im
-- Compose-Init-Verzeichnis oder `psql -U postgres -d <db> -f …`), und zwar vor
-- der ersten Migration; die Init-Migration bricht ohne diese Rollen ab.
--
--   tcms_owner  Eigentümer der Tabellen, nur für Migrationen und Seed.
--               Kein Superuser, kein BYPASSRLS: auch der Seed läuft im
--               Tenant-Kontext (FORCE ROW LEVEL SECURITY).
--   tcms_app    Laufzeitrolle des Dienstes und der Demo. NOBYPASSRLS, kein
--               Superuser, keine Mitgliedschaft in tcms_owner, nur DML (die
--               Grants je Tabelle setzt die Migration).
--
-- Passwörter sind fix und gleich dem Rollennamen. NICHT für Produktion – dort
-- legt der Betrieb (kanzleikonsole, ADR §8) die Rollen mit Zufallspasswörtern
-- an. Rollen sind clusterweit; der Rest gilt für die aktuelle Datenbank.
-- =============================================================================

DO $rollen$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tcms_owner') THEN
    CREATE ROLE tcms_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS PASSWORD 'tcms_owner';
  ELSE
    ALTER ROLE tcms_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS PASSWORD 'tcms_owner';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tcms_app') THEN
    CREATE ROLE tcms_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS NOINHERIT PASSWORD 'tcms_app';
  ELSE
    ALTER ROLE tcms_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS NOINHERIT PASSWORD 'tcms_app';
  END IF;

  -- Die Laufzeitrolle darf keine Rolle übernehmen können, die Tabellen besitzt
  -- oder RLS umgeht (SET ROLE). Bestehende Mitgliedschaften werden entfernt.
  IF pg_catalog.pg_has_role('tcms_app', 'tcms_owner', 'MEMBER') THEN
    REVOKE tcms_owner FROM tcms_app;
  END IF;
END
$rollen$;

-- Schema: nur der Eigentümer legt Objekte an; die App-Rolle darf es benutzen.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO tcms_owner;
GRANT USAGE ON SCHEMA public TO tcms_app;

-- Temporäre Objekte braucht die Laufzeitrolle nicht.
DO $temp$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tcms_owner, tcms_app', current_database());
END
$temp$;
