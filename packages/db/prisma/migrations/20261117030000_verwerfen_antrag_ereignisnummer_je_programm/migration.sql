-- =============================================================================
-- Tax-CMS – Kennung des Verwerfen-Antrags und Ereignisnummern je Programm.
--
-- 1. Verwerfen-Antrag (Feststellung, Ereignis): Jeder Antrag erhält eine neue
--    Kennung `verwerfenAntragId` (UUID). Die Bestätigung der zweiten Person
--    nennt die Kennung des Antrags, den sie gesehen hat; der Dienst vergleicht
--    sie unter der Zeilensperre (sonst 409). Zurückziehen und Neustellen mit
--    anderer Begründung ergibt so eine andere Kennung. Die Spalte ist nie leer:
--    Der Standardwert füllt bestehende Zeilen (auch offene Anträge) beim
--    Anlegen der Spalte; der Dienst setzt bei jedem Antrag eine neue Kennung.
--
-- 2. Ereignisnummern `<Jahr>-T-<nnnn>` laufen je Programm (wie die
--    Feststellungsnummern), nicht mehr je Kanzlei: Mandantenkontakte sehen ihre
--    Nummern im Portal, und Lücken einer kanzleiweiten Folge verrieten das
--    Meldeaufkommen anderer Mandanten. Der eindeutige Schlüssel wird
--    (tenant_id, programmId, nummer); bestehende Nummern sind je Tenant
--    eindeutig und damit auch je Programm, sie bleiben unverändert.
--
-- Keine neue Tabelle: RLS, Policy und Grants der Init-Migration gelten
-- unverändert.
-- =============================================================================

-- AlterTable
ALTER TABLE "Feststellung" ADD COLUMN "verwerfenAntragId" UUID NOT NULL DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "Ereignis" ADD COLUMN "verwerfenAntragId" UUID NOT NULL DEFAULT gen_random_uuid();

-- DropIndex
DROP INDEX "Ereignis_tenant_id_nummer_key";

-- CreateIndex
CREATE UNIQUE INDEX "Ereignis_tenant_id_programmId_nummer_key" ON "Ereignis"("tenant_id", "programmId", "nummer");
