// =============================================================================
// RED TEAM RT4-T-04 — Angreifermodell A (Mandantenkontakt mit gültiger
// Bestätigung, Rolle MITARBEITER).
//
// Portal-Lesen gilt laut ADR 0001 §5 für gesetzliche Vertretung und
// Tax-Compliance-Beauftragte; Mitarbeitende erreichen nur ihnen Zugewiesenes.
// Die Portal-Übersicht (`ladePortalUebersicht`, P1) setzt das für gemeldete
// Ereignisse um: Mitarbeitende sehen nur, „was sie selbst gemeldet haben“.
//
// Der zweite Lesepfad derselben Daten, `GET …/portal/ereignisse`
// (`ladePortalMeldungen`, P3; in s7 um das Melderecht ergänzt), prüft nur
// `kannLesen` (irgendeine aktive Rolle) und liefert Mitarbeitenden alle
// Portal-Meldungen des Mandanten: Titel, Art, Status, Zeitpunkt und die
// meldende Person – etwa eine von der Geschäftsführung gemeldete
// „Verdacht auf Umsatzsteuerverkürzung in der Buchhaltung“.
//
// Der Test ist rot, solange Mitarbeitende über P3 fremde Meldungen lesen, und
// wird grün, sobald beide Pfade dieselbe Regel anwenden.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ladePortalMeldungen,
  meldeEreignis,
} from '../../bereiche/feststellungen-ereignisse/portal';
import {
  akteure,
  baueWelt,
  im,
  type Welt,
} from '../../bereiche/feststellungen-ereignisse/testwelt';
import { ladePortalUebersicht } from '../../bereiche/lesepfade/portal';

const AKTIV = process.env['DB_TESTS'] === '1';
const TITEL = 'Verdacht auf Umsatzsteuerverkürzung in der Buchhaltung';

describe.skipIf(!AKTIV)('RT4-T-04 Mitarbeitende lesen alle Portal-Meldungen', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;
  let id = '';

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    // Meldung der gesetzlichen Vertretung (nicht der Mitarbeiterin).
    const r = await im(A.gv, (ctx) =>
      meldeEreignis(ctx, {
        mandantId: w.mandant,
        typ: 'T-02',
        titel: TITEL,
        beschreibung: 'Die Geschäftsführung prüft den Verdacht intern.',
        datum: '2026-10-12',
        anlagen: [],
        zusageAenderungen: true,
      }),
    );
    id = r.id;
  });

  it('Gegenprobe: die Portal-Übersicht zeigt der Mitarbeiterin die fremde Meldung nicht', async () => {
    const u = await im(A.ma, (ctx) => ladePortalUebersicht(ctx, { mandantId: w.mandant }));
    expect(u.rechte.portalLesen).toBe(false);
    expect(u.meldungen.map((m) => m.id)).not.toContain(id);
    // GV sieht sie in beiden Pfaden.
    const gv = await im(A.gv, (ctx) => ladePortalMeldungen(ctx, { mandantId: w.mandant }));
    expect(gv.meldungen.map((m) => m.id)).toContain(id);
  });

  it('P3 liefert der Mitarbeiterin dieselbe Meldung mit Titel und meldender Person nicht aus', async () => {
    const l = await im(A.ma, (ctx) => ladePortalMeldungen(ctx, { mandantId: w.mandant }));
    const fremd = l.meldungen.filter((m) => m.gemeldetVon !== w.p.ma);
    // SICHERE ERWARTUNG: Mitarbeitende sehen wie in der Übersicht nur eigene Meldungen.
    expect(
      fremd.map((m) => `${m.titel} (${m.gemeldetVon})`),
      'fremde Portal-Meldungen für Mitarbeitende lesbar',
    ).toEqual([]);
  });
});
