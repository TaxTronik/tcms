-- =============================================================================
-- Tax-CMS – strukturierte Nachrichten im Postausgang (Stufe 4).
--
-- Die kanzleikonsole stellt Nachrichten mit eigenen Vorlagen zu: Eine offene
-- Nachricht trägt den Mandanten (Anker, Fremdschlüssel auf (tenant_id, id)),
-- die Empfängerart (Kontakt oder Kanzleiperson) und die Vorlagendaten je Zweck
-- (`daten`, JSON-Objekt ohne Geheimnis). Ein Bestätigungscode steht nur in
-- `code` und nur, solange die Nachricht offen ist; Zustellung (`zugestelltAm`)
-- und Verwerfen (`verworfenAm`: Freigabe erledigt, Code abgelaufen oder
-- ersetzt) leeren `code` und `text`. Die CHECKs erzwingen das für jede Rolle.
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert. Wie die früheren Nachträge setzt die Migration eine Datenbank
-- ohne Bestandsdaten voraus (ADR 0001 §4): Vorhandene Nachrichten lassen sie an
-- NOT NULL scheitern (fail closed), statt Mandant oder Vorlagendaten zu erfinden.
-- =============================================================================

-- CreateEnum
CREATE TYPE "NachrichtEmpfaengerArt" AS ENUM ('KONTAKT', 'KANZLEI');

-- AlterTable
ALTER TABLE "Nachricht" ADD COLUMN     "code" TEXT,
ADD COLUMN     "daten" JSONB NOT NULL,
ADD COLUMN     "empfaengerArt" "NachrichtEmpfaengerArt" NOT NULL,
ADD COLUMN     "mandantId" UUID NOT NULL,
ADD COLUMN     "verworfenAm" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Nachricht_tenant_id_mandantId_idx" ON "Nachricht"("tenant_id", "mandantId");

-- AddForeignKey
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint (Empfängerart folgt aus dem Zweck: nur Ereignismeldungen an die Kanzlei)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_empfaengerArt_check" CHECK (("zweck" = 'EREIGNIS_GEMELDET') = ("empfaengerArt" = 'KANZLEI'));

-- AddCheckConstraint (Vorlagendaten sind ein JSON-Objekt)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_daten_check" CHECK (jsonb_typeof("daten") = 'object');

-- AddCheckConstraint (Code: sechs Ziffern, nur beim Zweck FREIGABE_CODE)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_code_check" CHECK ("code" IS NULL OR ("zweck" = 'FREIGABE_CODE' AND "code" ~ '^[0-9]{6}$'));

-- AddCheckConstraint (offene Code-Nachricht ohne Code ist sinnlos)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_code_offen_check" CHECK ("zweck" <> 'FREIGABE_CODE' OR "code" IS NOT NULL OR "zugestelltAm" IS NOT NULL OR "verworfenAm" IS NOT NULL);

-- AddCheckConstraint (zugestellt oder verworfen: kein Klartext mehr)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_klartext_check" CHECK (("zugestelltAm" IS NULL AND "verworfenAm" IS NULL) OR ("code" IS NULL AND "text" = ''));

-- Eigentümer des neuen Typs
ALTER TYPE "NachrichtEmpfaengerArt" OWNER TO tcms_owner;
