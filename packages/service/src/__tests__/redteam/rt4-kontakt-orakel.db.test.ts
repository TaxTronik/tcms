// =============================================================================
// RED TEAM RT4-T-07 — Angreifermodell A (Kanzleiperson mit gültiger
// Bestätigung und Bearbeitungsrecht für genau einen Mandanten).
//
// AGENTS.md/ADR: Fremde Mandanten und Objekte → „nicht gefunden“, nie ein
// Hinweis auf ihre Existenz. `pruefeKanzleiPersonen` beschränkt sich deshalb
// ausdrücklich auf den Mandanten der Anfrage („eine tenantweite Suche verriete,
// ob eine ID bei einem anderen Mandanten als Kontakt existiert“).
//
// `setzeKontaktRollen` (PUT …/kontakte) zählt dagegen tenantweit, ob der
// Kontakt bei einem ANDEREN Mandanten eine (auch deaktivierte) Rolle hat, und
// antwortet dann `409 KONFLIKT`. Mit `rollen: []` ist die Abfrage ohne
// Nebenwirkung: Ein unbekannter Kontakt ergibt `geaendert: false` (kein
// Schreiben, kein Audit), ein Kontakt eines fremden Mandanten `KONFLIKT`. Eine
// Person mit Bezug nur zu Mandant A erfährt so, ob eine Personen-ID Kontakt
// eines anderen Mandanten der Kanzlei ist bzw. war (Personen anderer
// Mandanten, Modell A), unbemerkt im Audit.
//
// Der Test ist rot, solange beide Fälle unterscheidbar sind.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { DienstFehler } from '@tcms/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { setzeKontaktRollen } from '../../bereiche/lesepfade/kontakte';
import {
  baueWelt,
  btA,
  im,
  inWelt,
  type Welt,
} from '../../bereiche/programm-beschreibung/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT4-T-07 Kontaktrollen verraten Kontakte fremder Mandanten', () => {
  let w: Welt;

  beforeAll(async () => {
    w = await baueWelt();
  });

  /** Antwort auf eine nebenwirkungsfreie Probe (keine Rollen setzen). */
  async function probe(kontaktId: string): Promise<string> {
    try {
      const r = await im(btA(w), (ctx) =>
        setzeKontaktRollen(ctx, { mandantId: w.mandantA, kontaktId, rollen: [], funktion: null }),
      );
      return `200 geaendert=${String(r.geaendert)}`;
    } catch (e) {
      if (e instanceof DienstFehler) return e.code;
      throw e;
    }
  }

  it('Kontakt von Mandant B und unbekannte ID ergeben dieselbe Antwort, ohne Spur', async () => {
    const auditVorher = await inWelt(w, (tx) => tx.auditEvent.count());
    const unbekannt = await probe(randomUUID());
    const fremd = await probe(w.gvB);
    // Die Probe schreibt nichts (kein Audit, keine Rolle bei Mandant A).
    expect(await inWelt(w, (tx) => tx.auditEvent.count())).toBe(auditVorher);
    expect(
      await inWelt(w, (tx) =>
        tx.mandantKontaktRolle.count({ where: { mandantId: w.mandantA, kontaktId: w.gvB } }),
      ),
    ).toBe(0);
    // SICHERE ERWARTUNG: kein Unterschied zwischen fremdem und unbekanntem Kontakt.
    expect(fremd, `Existenz-Orakel: unbekannt → ${unbekannt}, Kontakt von B → ${fremd}`).toBe(
      unbekannt,
    );
  });
});
