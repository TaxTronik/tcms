-- =============================================================================
-- Tax-CMS – CMS-Beschreibungen entstehen nur als Entwurf (Hinweis H4 aus RT4).
--
-- `snapshotGeprueft` vergleicht Snapshot und Hash derselben Zeile; der
-- Trigger `BeschreibungVersion_eingefroren` griff nur bei UPDATE und DELETE
-- eingefrorener Zeilen. Wer SQL ausführen kann, konnte deshalb eine Version
-- direkt als „freigegeben" einfügen oder einen Entwurf in einem Schritt auf
-- „freigegeben" setzen – mit passendem Hash und Person, ohne den Übergang
-- „beim Mandanten → freigegeben" (Restrisiko RT-02).
--
-- Neu, für jede Rolle (auch den Eigentümer, solange der Trigger aktiv ist):
--   - BEFORE INSERT: neue Zeilen nur im Anfangsstatus ENTWURF, ohne Review-,
--     Freigabe- und Snapshot-Angaben.
--   - BEFORE UPDATE einer nicht eingefrorenen Zeile (Entwurf, Kanzlei-Review):
--     kein Sprung nach „freigegeben" oder „abgelöst" und keine freigebende
--     Person bzw. Zeit; eingefroren wird nur über „beim Mandanten". Freigegeben
--     wird damit nur über den Übergang „beim Mandanten → freigegeben" (mit
--     Person und Zeitpunkt), den der bestehende Teil der Funktion regelt.
--
-- Keine neue Tabelle; RLS, Policy und Grants gelten unverändert. Bestehende
-- Zeilen bleiben unberührt (Trigger prüfen nur neue Schreibvorgänge).
-- =============================================================================

-- CreateFunction
CREATE FUNCTION "tcms_beschreibung_neu"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW."status"::text <> 'ENTWURF'
     OR NEW."reviewAngefordertVon" IS NOT NULL OR NEW."reviewAngefordertAm" IS NOT NULL
     OR NEW."reviewVon" IS NOT NULL OR NEW."reviewAm" IS NOT NULL
     OR NEW."freigabeAngefordertAm" IS NOT NULL
     OR NEW."freigegebenVon" IS NOT NULL OR NEW."freigegebenAm" IS NOT NULL
     OR NEW."snapshot" IS NOT NULL OR NEW."snapshotSha256" IS NOT NULL THEN
    RAISE EXCEPTION 'tcms: neue CMS-Beschreibung nur als Entwurf';
  END IF;
  RETURN NEW;
END
$fn$;

-- CreateTrigger
CREATE TRIGGER "BeschreibungVersion_neu" BEFORE INSERT ON "BeschreibungVersion" FOR EACH ROW EXECUTE FUNCTION "tcms_beschreibung_neu"();

-- ReplaceFunction (Übergänge aus Entwurf und Kanzlei-Review begrenzen)
CREATE OR REPLACE FUNCTION "tcms_beschreibung_eingefroren"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD."status"::text NOT IN ('BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW."status"::text IN ('FREIGEGEBEN', 'ABGELOEST')
       OR NEW."freigegebenVon" IS NOT NULL OR NEW."freigegebenAm" IS NOT NULL THEN
      RAISE EXCEPTION 'tcms: Freigabe einer CMS-Beschreibung nur aus „beim Mandanten"';
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

-- Eigentümer und Rechte der neuen Funktion
ALTER FUNCTION "tcms_beschreibung_neu"() OWNER TO tcms_owner;
REVOKE ALL ON FUNCTION "tcms_beschreibung_neu"() FROM PUBLIC;
