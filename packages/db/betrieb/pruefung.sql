-- =============================================================================
-- Prüfung nach Bootstrap und Migration (tcms-migrate, Schritt 3;
-- Betriebsschnittstelle Stufe 2, ADR 0001 §4 und §10.1). Läuft mit psql als
-- tcms_owner (nur Katalogabfragen, keine Daten) und bricht mit allen Befunden
-- ab. Ausgaben nennen Rollen, Tabellen und Regeln, nie Werte.
--
--   Rollen   tcms_app: kein Superuser, NOBYPASSRLS, kein CREATEROLE/CREATEDB/
--            REPLICATION, Login, keine Mitgliedschaft (auch nicht tcms_owner),
--            besitzt nichts; tcms_owner: kein Superuser, NOBYPASSRLS.
--   Tabellen alle Tabellen in `public`, Eigentümer tcms_owner; jede außer
--            `_prisma_migrations` (Ledger) und `akteur_jti` (ADR §4, ohne
--            Tenant) hat ENABLE + FORCE ROW LEVEL SECURITY und eine Policy.
--   Rechte   tcms_app nirgends TRUNCATE/REFERENCES/TRIGGER (TRUNCATE umgeht
--            RLS), auf AuditEvent kein UPDATE/DELETE, auf akteur_jti genau
--            SELECT/INSERT/DELETE, auf dem Ledger nichts; kein CREATE im Schema
--            für tcms_app und PUBLIC, kein TEMP in der Datenbank.
-- =============================================================================

\set ON_ERROR_STOP on
\set VERBOSITY terse
\set SHOW_CONTEXT never
SET client_min_messages = warning;

DO $pruefung$
DECLARE
  befunde text[] := '{}';
  app oid;
  owner oid;
  r record;
BEGIN
  SELECT oid INTO app FROM pg_catalog.pg_roles WHERE rolname = 'tcms_app';
  SELECT oid INTO owner FROM pg_catalog.pg_roles WHERE rolname = 'tcms_owner';
  IF app IS NULL OR owner IS NULL THEN
    RAISE EXCEPTION 'Prüfung fehlgeschlagen: Rolle tcms_app oder tcms_owner fehlt';
  END IF;

  -- Rollen ---------------------------------------------------------------------
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE oid = app;
  IF r.rolsuper THEN befunde := befunde || 'tcms_app ist Superuser'::text; END IF;
  IF r.rolbypassrls THEN befunde := befunde || 'tcms_app hat BYPASSRLS'::text; END IF;
  IF r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    befunde := befunde || 'tcms_app hat CREATEROLE, CREATEDB oder REPLICATION'::text;
  END IF;
  IF NOT r.rolcanlogin THEN befunde := befunde || 'tcms_app kann sich nicht anmelden'::text; END IF;
  IF pg_catalog.pg_has_role(app, owner, 'MEMBER') THEN
    befunde := befunde || 'tcms_app ist Mitglied von tcms_owner'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = app) THEN
    befunde := befunde || 'tcms_app ist Mitglied einer anderen Rolle'::text;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles s
    WHERE (s.rolsuper OR s.rolbypassrls) AND pg_catalog.pg_has_role(app, s.oid, 'MEMBER')
  ) THEN
    befunde := befunde || 'tcms_app erreicht eine Rolle mit Superuser oder BYPASSRLS'::text;
  END IF;
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE oid = owner;
  IF r.rolsuper OR r.rolbypassrls THEN
    befunde := befunde || 'tcms_owner ist Superuser oder hat BYPASSRLS'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = app)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = app)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = app)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typowner = app) THEN
    befunde := befunde || 'tcms_app besitzt Objekte in dieser Datenbank'::text;
  END IF;

  -- Tabellen -------------------------------------------------------------------
  FOR r IN
    SELECT n.nspname, c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp\_%'
    ORDER BY n.nspname, c.relname
  LOOP
    IF r.nspname <> 'public' THEN
      befunde := befunde || pg_catalog.format('Tabelle außerhalb von public: %I.%I', r.nspname, r.relname);
      CONTINUE;
    END IF;
    IF r.relowner <> owner THEN
      befunde := befunde || pg_catalog.format('Tabelle %I gehört nicht tcms_owner', r.relname);
    END IF;
    IF pg_catalog.has_table_privilege(app, r.oid, 'TRUNCATE')
       OR pg_catalog.has_table_privilege(app, r.oid, 'REFERENCES')
       OR pg_catalog.has_table_privilege(app, r.oid, 'TRIGGER') THEN
      befunde := befunde || pg_catalog.format('tcms_app hat TRUNCATE/REFERENCES/TRIGGER auf %I', r.relname);
    END IF;
    IF r.relname = '_prisma_migrations' THEN
      IF pg_catalog.has_table_privilege(app, r.oid, 'SELECT')
         OR pg_catalog.has_table_privilege(app, r.oid, 'INSERT')
         OR pg_catalog.has_table_privilege(app, r.oid, 'UPDATE')
         OR pg_catalog.has_table_privilege(app, r.oid, 'DELETE') THEN
        befunde := befunde || 'tcms_app hat Rechte auf dem Migrations-Ledger'::text;
      END IF;
    ELSIF r.relname = 'akteur_jti' THEN
      IF NOT (pg_catalog.has_table_privilege(app, r.oid, 'SELECT')
              AND pg_catalog.has_table_privilege(app, r.oid, 'INSERT')
              AND pg_catalog.has_table_privilege(app, r.oid, 'DELETE'))
         OR pg_catalog.has_table_privilege(app, r.oid, 'UPDATE') THEN
        befunde := befunde || 'tcms_app hat auf akteur_jti nicht genau SELECT/INSERT/DELETE'::text;
      END IF;
    ELSE
      IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
        befunde := befunde || pg_catalog.format('Tabelle %I ohne ENABLE+FORCE ROW LEVEL SECURITY', r.relname);
      END IF;
      IF r.policies = 0 THEN
        befunde := befunde || pg_catalog.format('Tabelle %I ohne Policy', r.relname);
      END IF;
    END IF;
  END LOOP;
  IF to_regclass('public."AuditEvent"') IS NULL THEN
    befunde := befunde || 'Tabelle AuditEvent fehlt'::text;
  ELSIF pg_catalog.has_table_privilege(app, 'public."AuditEvent"', 'UPDATE')
     OR pg_catalog.has_table_privilege(app, 'public."AuditEvent"', 'DELETE') THEN
    befunde := befunde || 'tcms_app darf AuditEvent ändern oder löschen'::text;
  END IF;

  -- Schema und Datenbank ---------------------------------------------------------
  IF pg_catalog.has_schema_privilege(app, 'public', 'CREATE') THEN
    befunde := befunde || 'tcms_app darf im Schema public anlegen'::text;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a
    WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
  ) THEN
    befunde := befunde || 'PUBLIC darf im Schema public anlegen'::text;
  END IF;
  IF pg_catalog.has_database_privilege(app, pg_catalog.current_database(), 'TEMPORARY') THEN
    befunde := befunde || 'tcms_app darf temporäre Tabellen anlegen'::text;
  END IF;

  IF pg_catalog.cardinality(befunde) > 0 THEN
    RAISE EXCEPTION 'Prüfung fehlgeschlagen: %', pg_catalog.array_to_string(befunde, '; ');
  END IF;
END
$pruefung$;

\pset tuples_only on
\pset format unaligned
SELECT pg_catalog.format(
  'tcms-migrate: Prüfung bestanden (Rollen tcms_owner und tcms_app, %s Tabellen mit RLS)',
  count(*))
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND c.relrowsecurity AND c.relforcerowsecurity;
