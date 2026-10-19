// =============================================================================
// RED TEAM RT-03 — Angreifermodell C/F (Tenant-Admin bzw. SQL als tcms_app):
// Seitenkanal über die globale Audit-Sequenz.
//
// `AuditEvent.seq` ist ein globaler SERIAL (eine einzige Sequenz
// `AuditEvent_seq_seq` für ALLE Tenants, Init-Migration). `seq` wird jedem
// Tenant-Admin in `GET /v1/audit` ausgeliefert (AuditListeAntwort: `seq`,
// Cursor `weiter`, `kopf.seq`). Lücken in der eigenen seq-Folge verraten damit,
// wie viele Audit-Ereignisse ANDERE Kanzleien (Tenants) dazwischen geschrieben
// haben – ein tenantübergreifender Aktivitäts-Seitenkanal.
//
// Dieser Test schreibt A1, dann (anderer Tenant) B1, dann A2 und prüft, dass
// die beiden Einträge desselben Tenants aufeinanderfolgende seq-Werte haben
// (sichere Erwartung: Nummerierung je Tenant, keine fremden Lücken). Solange
// die Sequenz global ist, entsteht eine Lücke und der Test schlägt fehl.
// Einordnung: niedrig/Hinweis (Metadaten-Leak über Aktivitätsvolumen).
//
// Angepasste Annahme (tcms-rtfix): Die nach außen gegebene Position ist jetzt
// die Spalte `pos` (je Tenant); `seq` bleibt technischer, globaler Schlüssel
// und verlässt den Dienst nicht mehr. Der Test liest daher `pos`; das
// Schutzziel (aufeinanderfolgende eigene Positionen) ist unverändert.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { mitTenant, schreibeAudit } from '@tcms/db';
import { baueWelt } from '../../bereiche/feststellungen-ereignisse/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT-03 globale Audit-Sequenz als Tenant-Seitenkanal', () => {
  it('eine fremde Audit-Schreibung reißt eine Lücke in die seq-Folge des eigenen Tenants', async () => {
    const w = await baueWelt();
    const obj = `rt03-${Date.now()}`;

    const seqVon = async (tenant: string, objektId: string) =>
      mitTenant(tenant, async (tx) => {
        await schreibeAudit(tx, {
          actorId: null,
          actorName: 'RT-03',
          aktion: 'tcms.rt.test',
          objektTyp: 'RT',
          objektId,
        });
        const row = await tx.auditEvent.findFirstOrThrow({
          where: { objektId },
          select: { pos: true },
        });
        return row.pos;
      });

    const a1 = await seqVon(w.tenant, `${obj}-A1`);
    await seqVon(w.tenantB, `${obj}-B1`); // fremder Tenant schreibt dazwischen
    const a2 = await seqVon(w.tenant, `${obj}-A2`);

    // SICHERE ERWARTUNG: Zwei aufeinanderfolgende eigene Audit-Einträge haben
    // aufeinanderfolgende Positionen; eine fremde Schreibung bleibt unsichtbar.
    expect(
      a2 - a1,
      'globale seq: fremde Audit-Aktivität über die Lücke in der eigenen Kette erkennbar',
    ).toBe(1);
  });
});
