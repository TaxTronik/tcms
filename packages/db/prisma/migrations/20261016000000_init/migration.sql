-- CreateEnum
CREATE TYPE "PersonArt" AS ENUM ('KANZLEI', 'MANDANT');

-- CreateEnum
CREATE TYPE "KanzleiRolle" AS ENUM ('BERUFSTRAEGER', 'BEARBEITUNG');

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
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kuerzel" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "art" "PersonArt" NOT NULL,
    "kanzleiRolle" "KanzleiRolle",
    "istAdmin" BOOLEAN NOT NULL DEFAULT false,
    "mandantId" TEXT,
    "mandantRolle" "MandantRolle",
    "funktion" TEXT,
    "telefon" TEXT,
    "aktiv" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rechtsform" TEXT NOT NULL,
    "datevNr" TEXT,
    "aktiv" BOOLEAN NOT NULL DEFAULT true,
    "berufstraegerId" TEXT NOT NULL,
    "bearbeitungId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mandant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcmsProgramm" (
    "id" TEXT NOT NULL,
    "mandantId" TEXT NOT NULL,
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
    "programmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abgrenzung" TEXT NOT NULL,
    "einschluesse" TEXT[],
    "ausschluesse" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Teilbereich_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfilStand" (
    "id" TEXT NOT NULL,
    "programmId" TEXT NOT NULL,
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
    "risikoId" TEXT NOT NULL,
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
    "risikoId" TEXT NOT NULL,
    "kontrolleId" TEXT NOT NULL,

    CONSTRAINT "RisikoKontrolle_pkey" PRIMARY KEY ("risikoId","kontrolleId")
);

-- CreateTable
CREATE TABLE "Durchfuehrung" (
    "id" TEXT NOT NULL,
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
    "durchfuehrungId" TEXT NOT NULL,
    "dateiname" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "groesse" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "speicherpfad" TEXT NOT NULL,
    "gesperrt" BOOLEAN NOT NULL DEFAULT false,
    "hochgeladenVon" TEXT NOT NULL,
    "hochgeladenAm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nachweis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feststellung" (
    "id" TEXT NOT NULL,
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
    "feststellungId" TEXT NOT NULL,
    "risikoId" TEXT NOT NULL,

    CONSTRAINT "FeststellungRisiko_pkey" PRIMARY KEY ("feststellungId","risikoId")
);

-- CreateTable
CREATE TABLE "BetroffeneErklaerung" (
    "id" TEXT NOT NULL,
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
    "an" TEXT NOT NULL,
    "betreff" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nachricht_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "seq" SERIAL NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "Person_email_key" ON "Person"("email");

-- CreateIndex
CREATE INDEX "Person_mandantId_idx" ON "Person"("mandantId");

-- CreateIndex
CREATE INDEX "TcmsProgramm_mandantId_idx" ON "TcmsProgramm"("mandantId");

-- CreateIndex
CREATE INDEX "Teilbereich_programmId_idx" ON "Teilbereich"("programmId");

-- CreateIndex
CREATE INDEX "ProfilStand_programmId_gueltigAb_idx" ON "ProfilStand"("programmId", "gueltigAb");

-- CreateIndex
CREATE INDEX "ComplianceZiel_teilbereichId_idx" ON "ComplianceZiel"("teilbereichId");

-- CreateIndex
CREATE UNIQUE INDEX "Risiko_programmId_code_key" ON "Risiko"("programmId", "code");

-- CreateIndex
CREATE INDEX "RisikoStand_risikoId_gueltigAb_idx" ON "RisikoStand"("risikoId", "gueltigAb");

-- CreateIndex
CREATE INDEX "Uebersteuerung_risikoId_idx" ON "Uebersteuerung"("risikoId");

-- CreateIndex
CREATE UNIQUE INDEX "Kontrolle_programmId_code_key" ON "Kontrolle"("programmId", "code");

-- CreateIndex
CREATE INDEX "KontrolleStand_kontrolleId_gueltigAb_idx" ON "KontrolleStand"("kontrolleId", "gueltigAb");

-- CreateIndex
CREATE INDEX "Durchfuehrung_kontrolleId_periodeVon_idx" ON "Durchfuehrung"("kontrolleId", "periodeVon");

-- CreateIndex
CREATE INDEX "Durchfuehrung_faelligAm_idx" ON "Durchfuehrung"("faelligAm");

-- CreateIndex
CREATE INDEX "Nachweis_durchfuehrungId_idx" ON "Nachweis"("durchfuehrungId");

-- CreateIndex
CREATE UNIQUE INDEX "Feststellung_programmId_nummer_key" ON "Feststellung"("programmId", "nummer");

-- CreateIndex
CREATE UNIQUE INDEX "Massnahme_wiedervorlageNr_key" ON "Massnahme"("wiedervorlageNr");

-- CreateIndex
CREATE UNIQUE INDEX "Ereignis_nummer_key" ON "Ereignis"("nummer");

-- CreateIndex
CREATE INDEX "Ereignis_programmId_idx" ON "Ereignis"("programmId");

-- CreateIndex
CREATE INDEX "LandStand_programmId_land_stand_idx" ON "LandStand"("programmId", "land", "stand");

-- CreateIndex
CREATE UNIQUE INDEX "BeschreibungVersion_programmId_nummer_key" ON "BeschreibungVersion"("programmId", "nummer");

-- CreateIndex
CREATE INDEX "Freigabe_programmId_idx" ON "Freigabe"("programmId");

-- CreateIndex
CREATE INDEX "Freigabe_empfaengerId_status_idx" ON "Freigabe"("empfaengerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");

-- CreateIndex
CREATE INDEX "AuditEvent_programmId_seq_idx" ON "AuditEvent"("programmId", "seq");

-- CreateIndex
CREATE INDEX "AuditEvent_objektTyp_objektId_idx" ON "AuditEvent"("objektTyp", "objektId");

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_mandantId_fkey" FOREIGN KEY ("mandantId") REFERENCES "Mandant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TcmsProgramm" ADD CONSTRAINT "TcmsProgramm_mandantId_fkey" FOREIGN KEY ("mandantId") REFERENCES "Mandant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Teilbereich" ADD CONSTRAINT "Teilbereich_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfilStand" ADD CONSTRAINT "ProfilStand_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceZiel" ADD CONSTRAINT "ComplianceZiel_teilbereichId_fkey" FOREIGN KEY ("teilbereichId") REFERENCES "Teilbereich"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risiko" ADD CONSTRAINT "Risiko_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoStand" ADD CONSTRAINT "RisikoStand_risikoId_fkey" FOREIGN KEY ("risikoId") REFERENCES "Risiko"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Uebersteuerung" ADD CONSTRAINT "Uebersteuerung_risikoId_fkey" FOREIGN KEY ("risikoId") REFERENCES "Risiko"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kontrolle" ADD CONSTRAINT "Kontrolle_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KontrolleStand" ADD CONSTRAINT "KontrolleStand_kontrolleId_fkey" FOREIGN KEY ("kontrolleId") REFERENCES "Kontrolle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoKontrolle" ADD CONSTRAINT "RisikoKontrolle_risikoId_fkey" FOREIGN KEY ("risikoId") REFERENCES "Risiko"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RisikoKontrolle" ADD CONSTRAINT "RisikoKontrolle_kontrolleId_fkey" FOREIGN KEY ("kontrolleId") REFERENCES "Kontrolle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Durchfuehrung" ADD CONSTRAINT "Durchfuehrung_kontrolleId_fkey" FOREIGN KEY ("kontrolleId") REFERENCES "Kontrolle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Durchfuehrung" ADD CONSTRAINT "Durchfuehrung_kontrolleStandId_fkey" FOREIGN KEY ("kontrolleStandId") REFERENCES "KontrolleStand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nachweis" ADD CONSTRAINT "Nachweis_durchfuehrungId_fkey" FOREIGN KEY ("durchfuehrungId") REFERENCES "Durchfuehrung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_durchfuehrungId_fkey" FOREIGN KEY ("durchfuehrungId") REFERENCES "Durchfuehrung"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feststellung" ADD CONSTRAINT "Feststellung_nachkontrolleId_fkey" FOREIGN KEY ("nachkontrolleId") REFERENCES "Durchfuehrung"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeststellungRisiko" ADD CONSTRAINT "FeststellungRisiko_feststellungId_fkey" FOREIGN KEY ("feststellungId") REFERENCES "Feststellung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeststellungRisiko" ADD CONSTRAINT "FeststellungRisiko_risikoId_fkey" FOREIGN KEY ("risikoId") REFERENCES "Risiko"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetroffeneErklaerung" ADD CONSTRAINT "BetroffeneErklaerung_feststellungId_fkey" FOREIGN KEY ("feststellungId") REFERENCES "Feststellung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Massnahme" ADD CONSTRAINT "Massnahme_feststellungId_fkey" FOREIGN KEY ("feststellungId") REFERENCES "Feststellung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ereignis" ADD CONSTRAINT "Ereignis_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EreignisFolge" ADD CONSTRAINT "EreignisFolge_ereignisId_fkey" FOREIGN KEY ("ereignisId") REFERENCES "Ereignis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandStand" ADD CONSTRAINT "LandStand_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeschreibungVersion" ADD CONSTRAINT "BeschreibungVersion_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Freigabe" ADD CONSTRAINT "Freigabe_programmId_fkey" FOREIGN KEY ("programmId") REFERENCES "TcmsProgramm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
