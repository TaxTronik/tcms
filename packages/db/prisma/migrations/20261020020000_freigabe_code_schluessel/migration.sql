-- =============================================================================
-- Tax-CMS – Bestätigungscodes mit geheimem Schlüssel (Hinweis H5 aus RT4).
--
-- Bisher stand neben einer offenen Freigabe ein SHA-256 des 6-stelligen Codes
-- (an die Freigabe gebunden). Wer die Datenbank lesen kann, probierte die
-- 10^6 möglichen Codes offline durch. Neu rechnet der Dienst einen
-- HMAC-SHA-256 mit einem Schlüssel aus der Umgebung (`TCMS_CODE_SCHLUESSEL`,
-- nie in der Datenbank) und speichert dazu die Kennung des Schlüssels
-- (`codeSchluesselId`, aus dem Schlüssel abgeleitet, 16 hex). Mehrere
-- Schlüssel sind für die Rotation möglich (der erste signiert neue Codes).
--
-- Bestehende offene Codes (Hash ohne Kennung, früheres Verfahren) gelten ab
-- dieser Migration als abgelaufen: Der Dienst nimmt sie nicht mehr an, ohne
-- einen Fehlversuch zu zählen, und verlangt eine Neuanforderung; der Abruf
-- verwirft ihre offenen Code-Nachrichten (Grund CODE_ABGELAUFEN). Die Zeilen
-- selbst bleiben unverändert (keine Umgehung von RLS in der Migration).
--
-- Keine neue Tabelle; RLS, Policy und Grants gelten unverändert. Der CHECK
-- erlaubt eine Kennung nur neben einem Hash und nur im Format 16 hex.
-- =============================================================================

-- AlterTable
ALTER TABLE "Freigabe" ADD COLUMN "codeSchluesselId" TEXT;

-- AddCheckConstraint (Kennung nur neben einem Hash, Format 16 hex)
ALTER TABLE "Freigabe" ADD CONSTRAINT "Freigabe_code_schluessel_check" CHECK ("codeSchluesselId" IS NULL OR ("codeHash" IS NOT NULL AND "codeSchluesselId" ~ '^[0-9a-f]{16}$'));
