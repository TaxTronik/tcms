// =============================================================================
// Lesepfad „Nachweise je Dokument" (DB_TESTS=1): aktive und entfernte
// Nachweise eines Mandanten zu einer Dokument-ID für den Abgleich der
// kanzleikonsole. Nur Kanzleipersonen mit Leserecht; Dokument-IDs anderer
// Mandanten und unbekannte ergeben dieselbe leere Liste (kein Existenz-Orakel).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { NachweiseJeDokumentSchema } from '@tcms/contract';
import { ladeNachweiseJeDokument } from './lesen';
import { entferneNachweis, haengeNachweisAn } from './operationen';
import { akteure, baueFall, fehlerVon, verweis, type Fall } from './testfall';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Nachweise je Dokument (Service, PostgreSQL)', () => {
  let f: Fall;
  let A: ReturnType<typeof akteure>;
  const dok = randomUUID();
  const dokB = randomUUID();
  let d1 = '';
  let d2 = '';
  let n1 = '';
  let n2 = '';

  const lies = (a: Parameters<Fall['dienst']>[0], eingabe: Record<string, unknown>) =>
    f.dienst(a, (ctx) => ladeNachweiseJeDokument(ctx, eingabe as never));

  beforeAll(async () => {
    f = await baueFall();
    A = akteure(f);
    d1 = await f.durchfuehrung('k1');
    d2 = await f.durchfuehrung('k1', { periodeLabel: 'Oktober 2026' });
    const v = verweis({ dokumentId: dok });
    n1 = (
      await f.dienst(A.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { mandantId: f.mandant, durchfuehrungId: d1, verweis: v }),
      )
    ).nachweis.id;
    n2 = (
      await f.dienst(A.bearbeiter, (ctx) =>
        haengeNachweisAn(ctx, { mandantId: f.mandant, durchfuehrungId: d2, verweis: v }),
      )
    ).nachweis.id;
    await f.dienst(A.bearbeiter, (ctx) =>
      entferneNachweis(ctx, { mandantId: f.mandant, durchfuehrungId: d2, nachweisId: n2 }),
    );
    // Dokument eines anderen Mandanten (B) im selben Tenant.
    const dB = await f.durchfuehrung('kB');
    await f.dienst(f.kanzlei(f.p.bearbeiter, { mandantId: f.mandantB, hb: true }), (ctx) =>
      haengeNachweisAn(ctx, {
        mandantId: f.mandantB,
        durchfuehrungId: dB,
        verweis: verweis({ dokumentId: dokB }),
      }),
    );
  });

  it('liefert aktive und entfernte Nachweise der Dokument-ID (Leserecht genügt)', async () => {
    for (const a of [A.bt, A.kollege]) {
      const r = await lies(a, { mandantId: f.mandant, dokumentId: dok.toUpperCase() });
      expect(NachweiseJeDokumentSchema.parse(r)).toEqual(r);
      expect(r).toEqual({
        dokumentId: dok,
        nachweise: [
          { id: n1, durchfuehrungId: d1, entfernt: false },
          { id: n2, durchfuehrungId: d2, entfernt: true },
        ],
      });
    }
  });

  it('Dokument-ID eines anderen Mandanten: dieselbe leere Liste wie eine unbekannte', async () => {
    const fremd = await lies(A.bt, { mandantId: f.mandant, dokumentId: dokB });
    const unbekannt = await lies(A.bt, { mandantId: f.mandant, dokumentId: randomUUID() });
    expect(fremd.nachweise).toEqual([]);
    expect(unbekannt.nachweise).toEqual([]);
    expect(Object.keys(fremd)).toEqual(Object.keys(unbekannt));
  });

  it('nur Kanzleipersonen mit Bezug: Kontakte, fremder Bezug, fremder Tenant, unbekannter Mandant → NICHT_GEFUNDEN', async () => {
    const unbekannt = randomUUID();
    const faelle: [Parameters<Fall['dienst']>[0], string][] = [
      [A.gv, f.mandant],
      [A.ma, f.mandant],
      [f.kanzlei(f.p.bt, { mandantId: null, admin: true }), f.mandant],
      [f.kanzlei(f.p.bt, { mandantId: f.mandantB, admin: true }), f.mandant],
      [f.kanzlei(f.p.bt, { tenant: randomUUID(), admin: true, zustaendig: true }), f.mandant],
      [f.kanzlei(f.p.bt, { mandantId: unbekannt, admin: true }), unbekannt],
    ];
    for (const [a, mandantId] of faelle) {
      const e = await fehlerVon(lies(a, { mandantId, dokumentId: dok }));
      expect(e.code, `${a.art} ${mandantId}`).toBe('NICHT_GEFUNDEN');
      expect(e.message).toBe('NICHT_GEFUNDEN');
    }
  });

  it('Eingabe streng: Dokument-ID Pflicht und UUID, keine Zusatzfelder', async () => {
    for (const eingabe of [
      { mandantId: f.mandant },
      { mandantId: f.mandant, dokumentId: 'ab/0123' },
      { mandantId: f.mandant, dokumentId: dok, durchfuehrungId: d1 },
    ]) {
      const e = await fehlerVon(lies(A.bt, eingabe));
      expect(e.code, JSON.stringify(eingabe)).toBe('UNGUELTIG');
    }
  });
});
