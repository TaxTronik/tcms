-- =============================================================================
-- Tax-CMS – Idempotenzschlüssel für Portal-Meldungen (tcms-s10).
--
-- Die kanzleikonsole setzt je Portal-Meldung einen eigenen Schlüssel (UUID),
-- damit sie eine Meldung mit unklarem Ausgang gefahrlos wiederholen und die
-- Anlagen danach an das Ereignis binden kann. Je Tenant, Mandant, meldender
-- Person und Schlüssel höchstens eine Zeile (eindeutiger Index, auch gegen
-- gleichzeitige Anfragen); jede Zeile zeigt auf genau ein Ereignis desselben
-- Tenants. Der Dienst serialisiert gleiche Schlüssel zusätzlich mit einer
-- transaktionsgebundenen Sperre.
--
-- Neue Tabelle mit tenant_id, ENABLE + FORCE RLS, Policy tcms_tenant wie in der
-- Init-Migration. Die App-Rolle liest, legt an und löscht (abgelaufene
-- Schlüssel), ändert aber keine Zeile (kein UPDATE): Bindung und Inhalt eines
-- Schlüssels sind unveränderlich.
-- =============================================================================

-- CreateTable
CREATE TABLE "PortalMeldungIdempotenz" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT tcms_aktueller_tenant(),
    "mandantId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "schluessel" UUID NOT NULL,
    "inhaltSha256" TEXT NOT NULL,
    "ereignisId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalMeldungIdempotenz_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalMeldungIdempotenz_schluessel_key" ON "PortalMeldungIdempotenz"("tenant_id", "mandantId", "personId", "schluessel");

-- CreateIndex
CREATE UNIQUE INDEX "PortalMeldungIdempotenz_ereignis_key" ON "PortalMeldungIdempotenz"("tenant_id", "ereignisId");

-- AddForeignKey
ALTER TABLE "PortalMeldungIdempotenz" ADD CONSTRAINT "PortalMeldungIdempotenz_tenant_id_mandantId_fkey" FOREIGN KEY ("tenant_id", "mandantId") REFERENCES "Mandant"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalMeldungIdempotenz" ADD CONSTRAINT "PortalMeldungIdempotenz_tenant_id_ereignisId_fkey" FOREIGN KEY ("tenant_id", "ereignisId") REFERENCES "Ereignis"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint (Inhalt nur als SHA-256, hex)
ALTER TABLE "PortalMeldungIdempotenz" ADD CONSTRAINT "PortalMeldungIdempotenz_inhaltSha256_check" CHECK ("inhaltSha256" ~ '^[0-9a-f]{64}$');

-- Eigentümer, Rechte und Row Level Security (wie die Tabellen der Init-Migration)
ALTER TABLE "PortalMeldungIdempotenz" OWNER TO tcms_owner;
REVOKE ALL ON TABLE "PortalMeldungIdempotenz" FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE "PortalMeldungIdempotenz" TO tcms_app;
ALTER TABLE "PortalMeldungIdempotenz" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortalMeldungIdempotenz" FORCE ROW LEVEL SECURITY;
CREATE POLICY tcms_tenant ON "PortalMeldungIdempotenz" AS PERMISSIVE FOR ALL TO PUBLIC USING (tenant_id = tcms_aktueller_tenant()) WITH CHECK (tenant_id = tcms_aktueller_tenant());
