-- =============================================================================
-- Tax-CMS – Zustellstatus „unzustellbar" im Postausgang (Stufe 4).
--
-- Kann die kanzleikonsole eine Nachricht nicht zustellen (Empfänger gehört
-- nicht zum Mandanten, kein bestätigter Portalzugang, Frist abgelaufen), meldet
-- ihr Systemakteur das mit Grund. Die Nachricht ist danach abgeschlossen wie
-- bei der Zustellung: kein Klartext und kein Code mehr, kein erneuter Abruf.
-- „Zugestellt" und „unzustellbar" schließen sich aus; der Grund steht genau
-- dann, wenn die Nachricht unzustellbar ist. Die CHECKs erzwingen das für jede
-- Rolle (auch neben dem bedingten Update des Dienstes).
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert. Bestehende Zeilen erfüllen die neuen CHECKs (neue Spalten NULL).
-- =============================================================================

-- CreateEnum
CREATE TYPE "NachrichtUnzustellbarGrund" AS ENUM ('EMPFAENGER_UNGUELTIG', 'KEIN_PORTALZUGANG', 'ABGELAUFEN', 'SONSTIGES');

-- AlterTable
ALTER TABLE "Nachricht" ADD COLUMN     "unzustellbarAm" TIMESTAMP(3),
ADD COLUMN     "unzustellbarGrund" "NachrichtUnzustellbarGrund";

-- AddCheckConstraint (Grund genau bei „unzustellbar")
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_unzustellbar_grund_check" CHECK (("unzustellbarAm" IS NULL) = ("unzustellbarGrund" IS NULL));

-- AddCheckConstraint (zugestellt und unzustellbar schließen sich aus)
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_zustellung_check" CHECK ("zugestelltAm" IS NULL OR "unzustellbarAm" IS NULL);

-- AlterCheckConstraint (offene Code-Nachricht ohne Code ist sinnlos; unzustellbar ist abgeschlossen)
ALTER TABLE "Nachricht" DROP CONSTRAINT "Nachricht_code_offen_check";
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_code_offen_check" CHECK ("zweck" <> 'FREIGABE_CODE' OR "code" IS NOT NULL OR "zugestelltAm" IS NOT NULL OR "verworfenAm" IS NOT NULL OR "unzustellbarAm" IS NOT NULL);

-- AlterCheckConstraint (zugestellt, verworfen oder unzustellbar: kein Klartext mehr)
ALTER TABLE "Nachricht" DROP CONSTRAINT "Nachricht_klartext_check";
ALTER TABLE "Nachricht" ADD CONSTRAINT "Nachricht_klartext_check" CHECK (("zugestelltAm" IS NULL AND "verworfenAm" IS NULL AND "unzustellbarAm" IS NULL) OR ("code" IS NULL AND "text" = ''));

-- Eigentümer des neuen Typs
ALTER TYPE "NachrichtUnzustellbarGrund" OWNER TO tcms_owner;
