-- =============================================================================
-- Tax-CMS – Init-Migration des headless Dienstes (ADR 0001 §4).
--
-- Ersetzt die Init-Migration des Prototyps (kein Bestandsschutz, ADR §4).
-- Voraussetzung: packages/db/prisma/init/01_bootstrap.sql hat die Rollen
-- `tcms_owner` (Eigentümer, nur Migrationen) und `tcms_app` (Laufzeit,
-- NOBYPASSRLS, kein Superuser) angelegt. Fehlen sie oder ist die App-Rolle zu
-- mächtig, bricht die Migration ab (fail closed).
--
-- Mandantentrennung:
--   - Jede Fachtabelle hat `tenant_id uuid NOT NULL`. Der Spaltenstandard
--     übernimmt den Tenant aus dem Transaktionskontext (`tcms.tenant_id`,
--     gesetzt von `mitTenant`); ohne Kontext ist er NULL und das INSERT
--     scheitert an NOT NULL.
--   - ENABLE + FORCE ROW LEVEL SECURITY und genau eine Policy je Tabelle:
--     USING/WITH CHECK `tenant_id = tcms_aktueller_tenant()`.
--   - `tcms_aktueller_tenant()` ist `current_setting('tcms.tenant_id', true)::uuid`
--     mit einer Formprüfung davor: leerer oder ungültiger Kontext ergibt NULL
--     und damit keine Zeile, statt eines Cast-Fehlers (ADR §4, Aufgabe
--     tcms-data 1). Alle Bezeichner sind schema-qualifiziert, damit ein
--     manipulierter search_path den Ausdruck nicht umlenken kann.
--   - Fremdschlüssel laufen über (tenant_id, id). FK-Prüfungen umgehen RLS;
--     erst der zusammengesetzte Schlüssel verhindert Verweise auf Objekte
--     eines anderen Tenants (und damit auch ein Existenz-Orakel über FK-Fehler).
--
-- Rechte der Laufzeitrolle: nur DML (kein TRUNCATE/REFERENCES/TRIGGER), das
-- Audit nur SELECT/INSERT, `akteur_jti` nur SELECT/INSERT/DELETE.
-- =============================================================================

DO $pruefung$
DECLARE
  app pg_catalog.pg_roles%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tcms_owner') THEN
    RAISE EXCEPTION 'Rolle tcms_owner fehlt – zuerst prisma/init/01_bootstrap.sql ausführen';
  END IF;
  SELECT * INTO app FROM pg_catalog.pg_roles WHERE rolname = 'tcms_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rolle tcms_app fehlt – zuerst prisma/init/01_bootstrap.sql ausführen';
  END IF;
  IF app.rolsuper OR app.rolbypassrls OR app.rolcreaterole OR app.rolcreatedb OR app.rolreplication THEN
    RAISE EXCEPTION 'Rolle tcms_app ist zu mächtig (SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION)';
  END IF;
  IF pg_catalog.pg_has_role('tcms_app', 'tcms_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Rolle tcms_app darf nicht Mitglied von tcms_owner sein';
  END IF;
END
$pruefung$;

-- Tenant aus dem Transaktionskontext; NULL bei fehlendem oder ungültigem Wert.
CREATE FUNCTION "tcms_aktueller_tenant"() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN pg_catalog.current_setting('tcms.tenant_id', true)
         OPERATOR(pg_catalog.~) '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN pg_catalog.current_setting('tcms.tenant_id', true)::pg_catalog.uuid
  END
$fn$;

-- CreateEnum
CREATE TYPE "MandantRolle" AS ENUM ('GESETZLICHER_VERTRETER', 'TAX_COMPLIANCE_BEAUFTRAGTER', 'MITARBEITER');

-- CreateEnum
CREATE TYPE "Turnus" AS ENUM ('KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH');

-- CreateEnum
CREATE TYPE "ProgrammStatus" AS ENUM ('ENTWURF', 'AKTIV');

-- CreateEnum
CREATE TYPE "Klasse" AS ENUM ('GERING', 'MITTEL', 'HOCH', 'KRITISCH');

-- CreateEnum
CREATE TYPE "FreigabeStand" AS ENUM ('ENTWURF', 'AUSSTEHEND', 'FREIGEGEBEN');

-- CreateEnum
CREATE TYPE "Herkunft" AS ENUM ('KATALOG', 'BERATER');

-- CreateEnum
CREATE TYPE "RisikoEntscheidung" AS ENUM ('VORGESCHLAGEN', 'UEBERNOMMEN', 'ABGELEHNT');

-- CreateEnum
CREATE TYPE "RisikoFreigabe" AS ENUM ('IDENTIFIZIERT', 'BEWERTET', 'ZUR_FREIGABE', 'FREIGEGEBEN');

-- CreateEnum
CREATE TYPE "Schaden" AS ENUM ('N', 'M', 'H');

-- CreateEnum
CREATE TYPE "Wahrscheinlichkeit" AS ENUM ('SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG');

-- CreateEnum
CREATE TYPE "GovernanceTyp" AS ENUM ('FP', 'FF', 'IN');

-- CreateEnum
CREATE TYPE "UebersteuerungSicht" AS ENUM ('DESIGN', 'BETRIEB');

-- CreateEnum
CREATE TYPE "UebersteuerungStatus" AS ENUM ('BEANTRAGT', 'FREIGEGEBEN', 'ABGELEHNT', 'AUFGEHOBEN');

-- CreateEnum
CREATE TYPE "KontrollArt" AS ENUM ('P', 'D', 'K');

-- CreateEnum
CREATE TYPE "Ausfuehrung" AS ENUM ('M', 'IT', 'A');

-- CreateEnum
CREATE TYPE "Partei" AS ENUM ('KANZLEI', 'MANDANT');

-- CreateEnum
CREATE TYPE "Design" AS ENUM ('ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL');

-- CreateEnum
CREATE TYPE "DurchfuehrungStatus" AS ENUM ('GEPLANT', 'IN_DURCHFUEHRUNG', 'ZUR_GEGENZEICHNUNG', 'ZURUECKGEWIESEN', 'OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN');

-- CreateEnum
CREATE TYPE "Ergebnis" AS ENUM ('OHNE_BEFUND', 'MIT_BEFUND');

-- CreateEnum
CREATE TYPE "FeststellungStatus" AS ENUM ('ERFASST', 'IN_WUERDIGUNG', 'MASSNAHMEN_OFFEN', 'NACHKONTROLLE', 'GESCHLOSSEN', 'VERWORFEN');

-- CreateEnum
CREATE TYPE "FeststellungQuelle" AS ENUM ('KONTROLLE', 'EREIGNIS', 'STICHPROBE', 'HINWEIS', 'AUSSENPRUEFUNG');

-- CreateEnum
CREATE TYPE "FeststellungKlasse" AS ENUM ('DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS');

-- CreateEnum
CREATE TYPE "Auswirkung" AS ENUM ('JA', 'NEIN', 'UNKLAR');

-- CreateEnum
CREATE TYPE "P153Entscheidung" AS ENUM ('BERICHTIGUNG', 'KEINE_PFLICHT', 'WEITERE_KLAERUNG', 'UEBERGABE');

-- CreateEnum
CREATE TYPE "MassnahmeStatus" AS ENUM ('OFFEN', 'ERLEDIGT');

-- CreateEnum
CREATE TYPE "EreignisStatus" AS ENUM ('NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN');

-- CreateEnum
CREATE TYPE "EreignisQuelle" AS ENUM ('PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL');

-- CreateEnum
CREATE TYPE "FolgeArt" AS ENUM ('RISIKO_NEU_BEWERTEN', 'RISIKO_AKTIVIEREN', 'KONTROLLE_AUSSERPLANMAESSIG', 'PROFIL_AENDERN', 'FESTSTELLUNG_ANLEGEN', 'HINWEIS');

-- CreateEnum
CREATE TYPE "FolgeStatus" AS ENUM ('VORGESCHLAGEN', 'ANGELEGT', 'ERLEDIGT', 'VERWORFEN');

-- CreateEnum
CREATE TYPE "DatenQuelle" AS ENUM ('MANUELL', 'CSV');

-- CreateEnum
CREATE TYPE "BeschreibungStatus" AS ENUM ('ENTWURF', 'KANZLEI_REVIEW', 'BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST');

-- CreateEnum
CREATE TYPE "FreigabeArt" AS ENUM ('ZIELE', 'BESCHREIBUNG', 'RISIKOAKZEPTANZ', 'AUFKLAERUNG', 'KENNTNISNAHME');

-- CreateEnum
CREATE TYPE "FreigabeStatus" AS ENUM ('OFFEN', 'FREIGEGEBEN', 'ABGELEHNT');

-- CreateTable
CREATE TABLE "Mandant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "name" TEXT NOT NULL,
    "rechtsform" TEXT NOT NULL,
    "datevNr" TEXT,
    "aktiv" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mandant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MandantKontaktRolle" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "mandantId" UUID NOT NULL,
    "kontaktId" UUID NOT NULL,
    "rolle" "MandantRolle" NOT NULL,
    "funktion" TEXT,
    "aktiv" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MandantKontaktRolle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcmsProgramm" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "mandantId" UUID NOT NULL,
    "paketId" TEXT NOT NULL,
    "paketVersion" TEXT NOT NULL,
    "status" "ProgrammStatus" NOT NULL DEFAULT 'ENTWURF',
    "erklaerungsTurnus" "Turnus" NOT NULL DEFAULT 'MONATLICH',
    "angemessenheitStichtag" DATE,
    "wirksamAb" DATE,
    "wirksamBis" DATE,
    "setupEntwurf" JSONB,
    "version1Am" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TcmsProgramm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Teilbereich" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abgrenzung" TEXT NOT NULL,
    "einschluesse" TEXT[] NOT NULL,
    "ausschluesse" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Teilbereich_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilStand" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "antworten" JSONB NOT NULL,
    "gueltigAb" TIMESTAMP(3) NOT NULL,
    "gueltigBis" TIMESTAMP(3),
    "erstelltVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfilStand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceZiel" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "teilbereichId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "wesentlichkeitEur" INTEGER NOT NULL,
    "risikoappetit" "Klasse" NOT NULL DEFAULT 'MITTEL',
    "freigabe" "FreigabeStand" NOT NULL DEFAULT 'ENTWURF',
    "freigegebenAm" TIMESTAMP(3),
    "freigegebenVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceZiel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Risiko" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "herkunft" "Herkunft" NOT NULL DEFAULT 'KATALOG',
    "kern" BOOLEAN NOT NULL DEFAULT false,
    "entscheidung" "RisikoEntscheidung" NOT NULL DEFAULT 'VORGESCHLAGEN',
    "vorschlagsgrund" TEXT,
    "ablehnungsgrund" TEXT,
    "freigabe" "RisikoFreigabe" NOT NULL DEFAULT 'IDENTIFIZIERT',
    "freigabeEingereichtVon" TEXT,
    "freigegebenVon" TEXT,
    "freigegebenAm" TIMESTAMP(3),
    "ownerId" TEXT,
    "neuBewerten" BOOLEAN NOT NULL DEFAULT false,
    "aktivAb" TIMESTAMP(3) NOT NULL,
    "inaktivAb" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Risiko_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RisikoStand" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "risikoId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "titel" TEXT NOT NULL,
    "fehlerquelle" TEXT NOT NULL,
    "folge" TEXT NOT NULL,
    "normanker" JSONB NOT NULL,
    "s" "Schaden" NOT NULL,
    "w" "Wahrscheinlichkeit" NOT NULL,
    "r" INTEGER NOT NULL,
    "gt" "GovernanceTyp" NOT NULL,
    "modell" TEXT NOT NULL,
    "gueltigAb" TIMESTAMP(3) NOT NULL,
    "gueltigBis" TIMESTAMP(3),
    "erstelltVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RisikoStand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Uebersteuerung" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "risikoId" TEXT NOT NULL,
    "sicht" "UebersteuerungSicht" NOT NULL,
    "klasse" "Klasse" NOT NULL,
    "berechnet" "Klasse" NOT NULL,
    "begruendung" TEXT NOT NULL,
    "status" "UebersteuerungStatus" NOT NULL DEFAULT 'BEANTRAGT',
    "beantragtVon" TEXT NOT NULL,
    "beantragtAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entschiedenVon" TEXT,
    "entschiedenAm" TIMESTAMP(3),

    CONSTRAINT "Uebersteuerung_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kontrolle" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "herkunft" "Herkunft" NOT NULL DEFAULT 'KATALOG',
    "aktivAb" TIMESTAMP(3) NOT NULL,
    "entfallenAb" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kontrolle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KontrolleStand" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "kontrolleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "titel" TEXT NOT NULL,
    "ziel" TEXT NOT NULL,
    "art" "KontrollArt" NOT NULL,
    "ausfuehrung" "Ausfuehrung" NOT NULL,
    "vorlageTurnus" "Turnus" NOT NULL,
    "vorlageAnlass" BOOLEAN NOT NULL,
    "abweichungTurnus" "Turnus",
    "abweichungAnlass" BOOLEAN,
    "abweichungBegruendung" TEXT,
    "abweichungFreigegebenVon" TEXT,
    "partei" "Partei" NOT NULL,
    "schluessel" BOOLEAN NOT NULL,
    "durchfuehrendId" TEXT,
    "vertretungId" TEXT,
    "gegenzeichnerId" TEXT,
    "gegenzeichnungMandant" BOOLEAN NOT NULL DEFAULT false,
    "nachweis" TEXT NOT NULL,
    "mindestNachweise" INTEGER NOT NULL,
    "schritte" JSONB NOT NULL,
    "kennzahlen" JSONB NOT NULL,
    "toleranzEur" DECIMAL(14,2),
    "faelligNachTagen" INTEGER NOT NULL,
    "design" "Design" NOT NULL DEFAULT 'NICHT_BEURTEILT',
    "designVon" TEXT,
    "designAm" TIMESTAMP(3),
    "designBegruendung" TEXT,
    "gueltigAb" TIMESTAMP(3) NOT NULL,
    "gueltigBis" TIMESTAMP(3),
    "erstelltVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KontrolleStand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RisikoKontrolle" (
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "risikoId" TEXT NOT NULL,
    "kontrolleId" TEXT NOT NULL,

    CONSTRAINT "RisikoKontrolle_pkey" PRIMARY KEY ("risikoId", "kontrolleId")
);

-- CreateTable
CREATE TABLE "Durchfuehrung" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "kontrolleId" TEXT NOT NULL,
    "kontrolleStandId" TEXT NOT NULL,
    "periodeLabel" TEXT NOT NULL,
    "periodeVon" DATE NOT NULL,
    "periodeBis" DATE NOT NULL,
    "faelligAm" DATE NOT NULL,
    "status" "DurchfuehrungStatus" NOT NULL DEFAULT 'GEPLANT',
    "ausserplanmaessig" BOOLEAN NOT NULL DEFAULT false,
    "anlass" TEXT,
    "ereignisFolgeId" TEXT,
    "schritte" JSONB NOT NULL DEFAULT '[]',
    "werte" JSONB NOT NULL DEFAULT '{}',
    "ergebnis" "Ergebnis",
    "ergebnisKommentar" TEXT,
    "durchgefuehrtVon" TEXT,
    "begonnenAm" TIMESTAMP(3),
    "eingereichtAm" TIMESTAMP(3),
    "mandantBestaetigtVon" TEXT,
    "gegengezeichnetVon" TEXT,
    "abgeschlossenAm" TIMESTAMP(3),
    "zurueckgewiesenVon" TEXT,
    "zurueckweisungsgrund" TEXT,
    "entfallenBegruendung" TEXT,
    "entfallenVon" TEXT,
    "entfallenAm" TIMESTAMP(3),
    "nachtragZuId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Durchfuehrung_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nachweis" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "durchfuehrungId" TEXT NOT NULL,
    "dokumentId" TEXT NOT NULL,
    "dateiname" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "groesse" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "gesperrt" BOOLEAN NOT NULL DEFAULT false,
    "hochgeladenVon" TEXT NOT NULL,
    "hochgeladenAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nachweis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feststellung" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "nummer" TEXT NOT NULL,
    "titel" TEXT NOT NULL,
    "sachverhalt" TEXT NOT NULL,
    "quelle" "FeststellungQuelle" NOT NULL,
    "quelleText" TEXT NOT NULL,
    "durchfuehrungId" TEXT,
    "ereignisId" TEXT,
    "klasse" "FeststellungKlasse" NOT NULL,
    "schwere" "Klasse" NOT NULL,
    "auswirkung" "Auswirkung" NOT NULL,
    "ursache" TEXT,
    "status" "FeststellungStatus" NOT NULL DEFAULT 'ERFASST',
    "vertraulich" BOOLEAN NOT NULL DEFAULT false,
    "p153Entscheidung" "P153Entscheidung",
    "p153Begruendung" TEXT,
    "p153Frist" DATE,
    "p153EntschiedenVon" TEXT,
    "p153EntschiedenAm" TIMESTAMP(3),
    "nachkontrolleId" TEXT,
    "verwerfenBegruendung" TEXT,
    "verwerfenBeantragtVon" TEXT,
    "verwerfenBestaetigtVon" TEXT,
    "erfasstVon" TEXT NOT NULL,
    "erfasstAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geschlossenAm" TIMESTAMP(3),

    CONSTRAINT "Feststellung_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeststellungRisiko" (
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "feststellungId" TEXT NOT NULL,
    "risikoId" TEXT NOT NULL,

    CONSTRAINT "FeststellungRisiko_pkey" PRIMARY KEY ("feststellungId", "risikoId")
);

-- CreateTable
CREATE TABLE "BetroffeneErklaerung" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "feststellungId" TEXT NOT NULL,
    "steuerart" TEXT NOT NULL,
    "land" TEXT NOT NULL,
    "zeitraum" TEXT NOT NULL,
    "auswirkungEur" DECIMAL(14,2),

    CONSTRAINT "BetroffeneErklaerung_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Massnahme" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "feststellungId" TEXT NOT NULL,
    "wiedervorlageNr" INTEGER NOT NULL,
    "beschreibung" TEXT NOT NULL,
    "verantwortlich" TEXT NOT NULL,
    "frist" DATE NOT NULL,
    "status" "MassnahmeStatus" NOT NULL DEFAULT 'OFFEN',
    "erledigtAm" TIMESTAMP(3),
    "erledigtVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Massnahme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ereignis" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "nummer" TEXT NOT NULL,
    "typ" TEXT NOT NULL,
    "titel" TEXT NOT NULL,
    "beschreibung" TEXT NOT NULL,
    "quelle" "EreignisQuelle" NOT NULL,
    "gemeldetVon" TEXT,
    "gemeldetAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ereignisDatum" DATE NOT NULL,
    "status" "EreignisStatus" NOT NULL DEFAULT 'NEU',
    "verwerfenBegruendung" TEXT,
    "triagiertVon" TEXT,
    "triagiertAm" TIMESTAMP(3),

    CONSTRAINT "Ereignis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EreignisFolge" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "ereignisId" TEXT NOT NULL,
    "art" "FolgeArt" NOT NULL,
    "ziel" TEXT,
    "text" TEXT NOT NULL,
    "zustaendig" TEXT,
    "frist" DATE,
    "status" "FolgeStatus" NOT NULL DEFAULT 'VORGESCHLAGEN',
    "objektId" TEXT,
    "erledigtAm" TIMESTAMP(3),

    CONSTRAINT "EreignisFolge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandStand" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "land" TEXT NOT NULL,
    "fernverkaeufeLfdEur" DECIMAL(14,2) NOT NULL,
    "fernverkaeufeVorjahrEur" DECIMAL(14,2) NOT NULL,
    "lagerSeit" TEXT,
    "oss" BOOLEAN NOT NULL,
    "lokaleUstNr" BOOLEAN NOT NULL,
    "zmRelevant" BOOLEAN NOT NULL DEFAULT false,
    "steuersaetzeGeprueftAm" DATE,
    "stand" DATE NOT NULL,
    "quelle" "DatenQuelle" NOT NULL DEFAULT 'MANUELL',
    "erfasstVon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandStand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BeschreibungVersion" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "nummer" TEXT NOT NULL,
    "status" "BeschreibungStatus" NOT NULL DEFAULT 'ENTWURF',
    "abschnitte" JSONB NOT NULL,
    "reviewAngefordertVon" TEXT,
    "reviewAngefordertAm" TIMESTAMP(3),
    "reviewVon" TEXT,
    "reviewAm" TIMESTAMP(3),
    "freigabeAngefordertAm" TIMESTAMP(3),
    "freigegebenVon" TEXT,
    "freigegebenAm" TIMESTAMP(3),
    "snapshot" JSONB,
    "snapshotSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erstelltVon" TEXT,

    CONSTRAINT "BeschreibungVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Freigabe" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "programmId" TEXT NOT NULL,
    "art" "FreigabeArt" NOT NULL,
    "refId" TEXT NOT NULL,
    "titel" TEXT NOT NULL,
    "inhalt" TEXT,
    "angefordertVon" TEXT NOT NULL,
    "angefordertAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "empfaengerId" TEXT NOT NULL,
    "codeHash" TEXT,
    "codeAblauf" TIMESTAMP(3),
    "status" "FreigabeStatus" NOT NULL DEFAULT 'OFFEN',
    "anmerkung" TEXT,
    "erledigtAm" TIMESTAMP(3),

    CONSTRAINT "Freigabe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nachricht" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "an" TEXT NOT NULL,
    "betreff" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nachricht_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "seq" SERIAL NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "kettenVersion" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "aktion" TEXT NOT NULL,
    "objektTyp" TEXT NOT NULL,
    "objektId" TEXT NOT NULL,
    "programmId" TEXT,
    "detail" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "akteur_jti" (
    "jti" TEXT NOT NULL,
    "exp" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "akteur_jti_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mandant_tenant_id_id_key" ON "Mandant"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Mandant_tenant_id_name_idx" ON "Mandant"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MandantKontaktRolle_tenant_id_mandantId_kontaktId_rolle_key" ON "MandantKontaktRolle"("tenant_id", "mandantId", "kontaktId", "rolle");

-- CreateIndex
CREATE INDEX "MandantKontaktRolle_tenant_id_kontaktId_idx" ON "MandantKontaktRolle"("tenant_id", "kontaktId");

-- CreateIndex
CREATE UNIQUE INDEX "TcmsProgramm_tenant_id_id_key" ON "TcmsProgramm"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TcmsProgramm_tenant_id_mandantId_key" ON "TcmsProgramm"("tenant_id", "mandantId");

-- CreateIndex
CREATE UNIQUE INDEX "Teilbereich_tenant_id_id_key" ON "Teilbereich"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Teilbereich_tenant_id_programmId_idx" ON "Teilbereich"("tenant_id", "programmId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilStand_tenant_id_programmId_version_key" ON "ProfilStand"("tenant_id", "programmId", "version");

-- CreateIndex
CREATE INDEX "ProfilStand_tenant_id_programmId_gueltigAb_idx" ON "ProfilStand"("tenant_id", "programmId", "gueltigAb");

-- CreateIndex
CREATE INDEX "ComplianceZiel_tenant_id_teilbereichId_idx" ON "ComplianceZiel"("tenant_id", "teilbereichId");

-- CreateIndex
CREATE UNIQUE INDEX "Risiko_tenant_id_id_key" ON "Risiko"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Risiko_tenant_id_programmId_code_key" ON "Risiko"("tenant_id", "programmId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RisikoStand_tenant_id_risikoId_version_key" ON "RisikoStand"("tenant_id", "risikoId", "version");

-- CreateIndex
CREATE INDEX "RisikoStand_tenant_id_risikoId_gueltigAb_idx" ON "RisikoStand"("tenant_id", "risikoId", "gueltigAb");

-- CreateIndex
CREATE INDEX "Uebersteuerung_tenant_id_risikoId_idx" ON "Uebersteuerung"("tenant_id", "risikoId");

-- CreateIndex
CREATE UNIQUE INDEX "Kontrolle_tenant_id_id_key" ON "Kontrolle"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Kontrolle_tenant_id_programmId_code_key" ON "Kontrolle"("tenant_id", "programmId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "KontrolleStand_tenant_id_id_key" ON "KontrolleStand"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KontrolleStand_tenant_id_kontrolleId_version_key" ON "KontrolleStand"("tenant_id", "kontrolleId", "version");

-- CreateIndex
CREATE INDEX "KontrolleStand_tenant_id_kontrolleId_gueltigAb_idx" ON "KontrolleStand"("tenant_id", "kontrolleId", "gueltigAb");

-- CreateIndex
CREATE INDEX "RisikoKontrolle_tenant_id_kontrolleId_idx" ON "RisikoKontrolle"("tenant_id", "kontrolleId");

-- CreateIndex
CREATE UNIQUE INDEX "Durchfuehrung_tenant_id_id_key" ON "Durchfuehrung"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Durchfuehrung_tenant_id_kontrolleId_periodeVon_idx" ON "Durchfuehrung"("tenant_id", "kontrolleId", "periodeVon");

-- CreateIndex
CREATE INDEX "Durchfuehrung_tenant_id_faelligAm_idx" ON "Durchfuehrung"("tenant_id", "faelligAm");

-- CreateIndex
CREATE INDEX "Nachweis_tenant_id_durchfuehrungId_idx" ON "Nachweis"("tenant_id", "durchfuehrungId");

-- CreateIndex
CREATE UNIQUE INDEX "Feststellung_tenant_id_id_key" ON "Feststellung"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Feststellung_tenant_id_programmId_nummer_key" ON "Feststellung"("tenant_id", "programmId", "nummer");

-- CreateIndex
CREATE INDEX "FeststellungRisiko_tenant_id_risikoId_idx" ON "FeststellungRisiko"("tenant_id", "risikoId");

-- CreateIndex
CREATE INDEX "BetroffeneErklaerung_tenant_id_feststellungId_idx" ON "BetroffeneErklaerung"("tenant_id", "feststellungId");

-- CreateIndex
CREATE UNIQUE INDEX "Massnahme_tenant_id_wiedervorlageNr_key" ON "Massnahme"("tenant_id", "wiedervorlageNr");

-- CreateIndex
CREATE INDEX "Massnahme_tenant_id_feststellungId_idx" ON "Massnahme"("tenant_id", "feststellungId");

-- CreateIndex
CREATE UNIQUE INDEX "Ereignis_tenant_id_id_key" ON "Ereignis"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ereignis_tenant_id_nummer_key" ON "Ereignis"("tenant_id", "nummer");

-- CreateIndex
CREATE INDEX "Ereignis_tenant_id_programmId_idx" ON "Ereignis"("tenant_id", "programmId");

-- CreateIndex
CREATE INDEX "EreignisFolge_tenant_id_ereignisId_idx" ON "EreignisFolge"("tenant_id", "ereignisId");

-- CreateIndex
CREATE INDEX "LandStand_tenant_id_programmId_land_stand_idx" ON "LandStand"("tenant_id", "programmId", "land", "stand");

-- CreateIndex
CREATE UNIQUE INDEX "BeschreibungVersion_tenant_id_programmId_nummer_key" ON "BeschreibungVersion"("tenant_id", "programmId", "nummer");

-- CreateIndex
CREATE INDEX "Freigabe_tenant_id_programmId_idx" ON "Freigabe"("tenant_id", "programmId");

-- CreateIndex
CREATE INDEX "Freigabe_tenant_id_empfaengerId_status_idx" ON "Freigabe"("tenant_id", "empfaengerId", "status");

-- CreateIndex
CREATE INDEX "Nachricht_tenant_id_createdAt_idx" ON "Nachricht"("tenant_id", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_tenant_id_hash_key" ON "AuditEvent"("tenant_id", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_tenant_id_prevHash_key" ON "AuditEvent"("tenant_id", "prevHash");

-- CreateIndex
CREATE INDEX "AuditEvent_tenant_id_seq_idx" ON "AuditEvent"("tenant_id", "seq");

-- CreateIndex
CREATE INDEX "AuditEvent_tenant_id_programmId_seq_idx" ON "AuditEvent"("tenant_id", "programmId", "seq");

-- CreateIndex
CREATE INDEX "AuditEvent_tenant_id_objektTyp_objektId_idx" ON "AuditEvent"("tenant_id", "objektTyp", "objektId");

-- AddForeignKey
ALTER TABLE "MandantKontaktRolle" ADD CONSTRAINT "MandantKontaktRolle_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TcmsProgramm" ADD CONSTRAINT "TcmsProgramm_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Teilbereich" ADD CONSTRAINT "Teilbereich_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilStand" ADD CONSTRAINT "ProfilStand_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceZiel" ADD CONSTRAINT "ComplianceZiel_tenant_id_teilbereichId_fkey" FOREIGN KEY ("tenant_id", "teilbereichId") REFERENCES "Teilbereich"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risiko" ADD CONSTRAINT "Risiko_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoStand" ADD CONSTRAINT "RisikoStand_tenant_id_risikoId_fkey" FOREIGN KEY ("tenant_id", "risikoId") REFERENCES "Risiko"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Uebersteuerung" ADD CONSTRAINT "Uebersteuerung_tenant_id_risikoId_fkey" FOREIGN KEY ("tenant_id", "risikoId") REFERENCES "Risiko"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kontrolle" ADD CONSTRAINT "Kontrolle_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KontrolleStand" ADD CONSTRAINT "KontrolleStand_tenant_id_kontrolleId_fkey" FOREIGN KEY ("tenant_id", "kontrolleId") REFERENCES "Kontrolle"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoKontrolle" ADD CONSTRAINT "RisikoKontrolle_tenant_id_risikoId_fkey" FOREIGN KEY ("tenant_id", "risikoId") REFERENCES "Risiko"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoKontrolle" ADD CONSTRAINT "RisikoKontrolle_tenant_id_kontrolleId_fkey" FOREIGN KEY ("tenant_id", "kontrolleId") REFERENCES "Kontrolle"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Durchfuehrung" ADD CONSTRAINT "Durchfuehrung_tenant_id_kontrolleId_fkey" FOREIGN KEY ("tenant_id", "kontrolleId") REFERENCES "Kontrolle"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Durchfuehrung" ADD CONSTRAINT "Durchfuehrung_tenant_id_kontrolleStandId_fkey" FOREIGN KEY ("tenant_id", "kontrolleStandId") REFERENCES "KontrolleStand"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nachweis" ADD CONSTRAINT "Nachweis_tenant_id_durchfuehrungId_fkey" FOREIGN KEY ("tenant_id", "durchfuehrungId") REFERENCES "Durchfuehrung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_tenant_id_durchfuehrungId_fkey" FOREIGN KEY ("tenant_id", "durchfuehrungId") REFERENCES "Durchfuehrung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_tenant_id_nachkontrolleId_fkey" FOREIGN KEY ("tenant_id", "nachkontrolleId") REFERENCES "Durchfuehrung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeststellungRisiko" ADD CONSTRAINT "FeststellungRisiko_tenant_id_feststellungId_fkey" FOREIGN KEY ("tenant_id", "feststellungId") REFERENCES "Feststellung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeststellungRisiko" ADD CONSTRAINT "FeststellungRisiko_tenant_id_risikoId_fkey" FOREIGN KEY ("tenant_id", "risikoId") REFERENCES "Risiko"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetroffeneErklaerung" ADD CONSTRAINT "BetroffeneErklaerung_tenant_id_feststellungId_fkey" FOREIGN KEY ("tenant_id", "feststellungId") REFERENCES "Feststellung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Massnahme" ADD CONSTRAINT "Massnahme_tenant_id_feststellungId_fkey" FOREIGN KEY ("tenant_id", "feststellungId") REFERENCES "Feststellung"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ereignis" ADD CONSTRAINT "Ereignis_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EreignisFolge" ADD CONSTRAINT "EreignisFolge_tenant_id_ereignisId_fkey" FOREIGN KEY ("tenant_id", "ereignisId") REFERENCES "Ereignis"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandStand" ADD CONSTRAINT "LandStand_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeschreibungVersion" ADD CONSTRAINT "BeschreibungVersion_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Freigabe" ADD CONSTRAINT "Freigabe_tenant_id_programmId_fkey" FOREIGN KEY ("tenant_id", "programmId") REFERENCES "TcmsProgramm"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- TS-05: höchstens ein offener Stand je versioniertem Objekt. Zusammen mit den
-- eindeutigen Versionsnummern scheitert eine Versionsgabelung in der
-- Datenbank, auch wenn zwei Transaktionen denselben Stand fortschreiben.
-- -----------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "RisikoStand_offen_key" ON "RisikoStand"("tenant_id", "risikoId") WHERE "gueltigBis" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "KontrolleStand_offen_key" ON "KontrolleStand"("tenant_id", "kontrolleId") WHERE "gueltigBis" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ProfilStand_offen_key" ON "ProfilStand"("tenant_id", "programmId") WHERE "gueltigBis" IS NULL;

-- -----------------------------------------------------------------------------
-- Eigentümer, Rechte und Row Level Security
-- -----------------------------------------------------------------------------

ALTER FUNCTION "tcms_aktueller_tenant"() OWNER TO tcms_owner;
REVOKE ALL ON FUNCTION "tcms_aktueller_tenant"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "tcms_aktueller_tenant"() TO tcms_app;

DO $rls$
DECLARE
  -- Alle mandantengebundenen Tabellen. Eine neue Tabelle ohne Eintrag hier
  -- fällt im generischen RLS-Test (packages/db/src/__tests__/rls.db.test.ts) auf.
  tabellen text[] := ARRAY[
    'Mandant', 'MandantKontaktRolle', 'TcmsProgramm', 'Teilbereich', 'ProfilStand',
    'ComplianceZiel', 'Risiko', 'RisikoStand', 'Uebersteuerung', 'Kontrolle',
    'KontrolleStand', 'RisikoKontrolle', 'Durchfuehrung', 'Nachweis', 'Feststellung',
    'FeststellungRisiko', 'BetroffeneErklaerung', 'Massnahme', 'Ereignis', 'EreignisFolge',
    'LandStand', 'BeschreibungVersion', 'Freigabe', 'Nachricht', 'AuditEvent'
  ];
  t text;
  typ record;
BEGIN
  FOREACH t IN ARRAY tabellen LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO tcms_owner', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
    IF t = 'AuditEvent' THEN
      -- Audit nur anhängen (Regel 1, ADR §4).
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO tcms_app', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO tcms_app', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tcms_tenant ON %I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = tcms_aktueller_tenant()) '
      'WITH CHECK (tenant_id = tcms_aktueller_tenant())', t);
  END LOOP;

  FOR typ IN
    SELECT t2.typname FROM pg_catalog.pg_type t2
    JOIN pg_catalog.pg_namespace n ON n.oid = t2.typnamespace
    WHERE n.nspname = 'public' AND t2.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE %I OWNER TO tcms_owner', typ.typname);
  END LOOP;
END
$rls$;

-- Die Sequenz gehört über OWNED BY bereits tcms_owner (ALTER TABLE … OWNER).
REVOKE ALL ON SEQUENCE "AuditEvent_seq_seq" FROM PUBLIC;
GRANT USAGE ON SEQUENCE "AuditEvent_seq_seq" TO tcms_app;

-- Einmal-IDs der Akteursbestätigung: nicht mandantengebunden, ohne RLS.
ALTER TABLE "akteur_jti" OWNER TO tcms_owner;
REVOKE ALL ON TABLE "akteur_jti" FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE "akteur_jti" TO tcms_app;
