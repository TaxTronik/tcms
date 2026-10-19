// =============================================================================
// Sperren der Rollen eines Mandanten (TS-05, RT4-T-05/06): `halteRollenFest`
// (Freigabe-Operationen, FOR KEY SHARE) und `sperreRollenZumAendern`
// (Rollenpflege, FOR UPDATE) schließen sich aus. Solange eine Operation die
// Rollen festhält, wartet jede Rollenänderung bis zu ihrem Commit – auch das
// Fenster zwischen Rollenprüfung und Commit ist damit zu (das Beweisszenario
// RT4-T-05 deckt nur die Wartezeit vor der Prüfung ab). Mehrere
// Freigabe-Operationen behindern sich gegenseitig nicht.
// =============================================================================

import { mitTenant } from '@tcms/db';
import { describe, expect, it } from 'vitest';
import { setzeKontaktRollen } from '../bereiche/lesepfade/kontakte';
import { baueWelt, btA, im, zweiteVerbindung } from '../bereiche/programm-beschreibung/testwelt';
import { halteRollenFest, sperreRollenZumAendern } from '../rollen';

const AKTIV = process.env['DB_TESTS'] === '1';

/** Zahl der Sitzungen dieser Datenbank, die auf eine Sperre warten. */
async function wartende(tenantId: string): Promise<number> {
  const [z] = await mitTenant(
    tenantId,
    (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return z?.n ?? 0;
}

async function bisWartend(tenantId: string, n: number): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if ((await wartende(tenantId)) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Kein Lauf wartet auf die Sperre');
}

describe.skipIf(!AKTIV)('Rollen festhalten und ändern (Sperren)', () => {
  it('eine Rollenänderung wartet, bis die festhaltende Operation abgeschlossen ist', async () => {
    const w = await baueWelt();
    const zweite = zweiteVerbindung();
    try {
      let loslassen!: () => void;
      const schranke = new Promise<void>((r) => (loslassen = r));
      let gehalten!: () => void;
      const haelt = new Promise<void>((r) => (gehalten = r));
      const halter = mitTenant(
        w.tenantId,
        async (tx) => {
          await halteRollenFest(tx, w.mandantA);
          gehalten();
          await schranke;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await haelt;
      let fertig = false;
      const aenderung = im(btA(w), (ctx) =>
        setzeKontaktRollen(ctx, {
          mandantId: w.mandantA,
          kontaktId: w.tcb,
          rollen: [],
          funktion: null,
        }),
      ).then((r) => {
        fertig = true;
        return r;
      });
      await bisWartend(w.tenantId, 1);
      expect(fertig, 'Rollenänderung trotz festgehaltener Rollen').toBe(false);
      loslassen();
      await halter;
      expect((await aenderung).geaendert).toBe(true);
    } finally {
      await zweite.$disconnect();
    }
  });

  it('mehrere Operationen halten die Rollen gleichzeitig fest; ändern wartet auf alle', async () => {
    const w = await baueWelt();
    const zweite = zweiteVerbindung();
    try {
      let loslassen!: () => void;
      const schranke = new Promise<void>((r) => (loslassen = r));
      let gehalten!: () => void;
      const haelt = new Promise<void>((r) => (gehalten = r));
      const halter = mitTenant(
        w.tenantId,
        async (tx) => {
          await halteRollenFest(tx, w.mandantA);
          gehalten();
          await schranke;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await haelt;
      // Zweite festhaltende Operation läuft ohne Warten durch.
      await mitTenant(w.tenantId, (tx) => halteRollenFest(tx, w.mandantA), { timeoutMs: 5_000 });
      let fertig = false;
      const aendern = mitTenant(w.tenantId, (tx) => sperreRollenZumAendern(tx, w.mandantA), {
        timeoutMs: 30_000,
      }).then(() => {
        fertig = true;
      });
      await bisWartend(w.tenantId, 1);
      expect(fertig).toBe(false);
      loslassen();
      await halter;
      await aendern;
      expect(fertig).toBe(true);
    } finally {
      await zweite.$disconnect();
    }
  });
});
