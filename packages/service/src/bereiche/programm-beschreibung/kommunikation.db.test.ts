// =============================================================================
// Kommunikation (Freigaben-Historie) gegen PostgreSQL (DB_TESTS=1): Kanzlei mit
// Bezug, Status zum Stichtag, keine Codes; fremder Mandant/Tenant, Kontakt,
// fehlender Bezug → NICHT_GEFUNDEN; Stichtag geprüft.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FreigabenHistorieSchema } from '@tcms/contract';
import { ladeFreigabenHistorie } from './kommunikation';
import { richteEin } from './testprogramm';
import {
  baueWelt,
  btA,
  btFuer,
  fehlerVon,
  im,
  inWelt,
  kanzlei,
  kontakt,
  ohneRechtA,
  TEST_CODES,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Freigaben-Historie (Service, PostgreSQL)', () => {
  let w: Welt;
  let programmA = '';
  let spaeterErledigt = '';

  beforeAll(async () => {
    w = await baueWelt();
    programmA = await richteEin(w);
    // Am 10.10. angefordert, am 19.10. erledigt, mit (veraltetem) Code-Zustand.
    spaeterErledigt = (
      await inWelt(w, (tx) =>
        tx.freigabe.create({
          data: {
            programmId: programmA,
            art: 'RISIKOAKZEPTANZ',
            refId: randomUUID(),
            titel: 'Risikoakzeptanz EC-UST-01',
            angefordertVon: w.bt,
            angefordertAm: new Date('2026-10-10T08:00:00Z'),
            empfaengerId: w.gv,
            status: 'FREIGEGEBEN',
            erledigtAm: new Date('2026-10-19T08:00:00Z'),
            anmerkung: 'später',
            codeHash: 'b'.repeat(64),
            codeSchluesselId: TEST_CODES.aktuelleId,
            codeFehlversuche: 1,
            codeAblauf: new Date(Date.now() + 86_400_000),
          },
        }),
      )
    ).id;
  });

  it('liefert die Historie im aktuellen Stand ohne Codes (Vertrag geprüft)', async () => {
    const h = await im(btA(w), (ctx) => ladeFreigabenHistorie(ctx, { mandantId: w.mandantA }));
    expect(FreigabenHistorieSchema.parse(h)).toEqual(h);
    expect(h.historisch).toBe(false);
    expect(h.freigaben.map((f) => f.art).sort()).toEqual(['RISIKOAKZEPTANZ', 'ZIELE']);
    expect(h.freigaben.find((f) => f.id === spaeterErledigt)).toMatchObject({
      status: 'FREIGEGEBEN',
      anmerkung: 'später',
      codeStatus: 'AKTIV',
    });
    expect(JSON.stringify(h)).not.toMatch(/b{64}|codeHash|codeFehlversuche/);
  });

  it('zum Stichtag: später Angefordertes fehlt, später Erledigtes gilt als offen', async () => {
    const h = await im(ohneRechtA(w), (ctx) =>
      ladeFreigabenHistorie(ctx, { mandantId: w.mandantA, stand: '2026-10-15' }),
    );
    expect(h).toMatchObject({ stand: '2026-10-15', historisch: true });
    expect(h.freigaben).toHaveLength(1);
    expect(h.freigaben[0]).toMatchObject({
      id: spaeterErledigt,
      status: 'OFFEN',
      erledigtAm: null,
      anmerkung: null,
      codeStatus: 'KEIN',
      codeAblauf: null,
    });
  });

  it('Kontakt, fremder Mandant, fehlender Bezug, fremder Tenant → NICHT_GEFUNDEN; Stichtag geprüft', async () => {
    for (const a of [
      kontakt(w, w.gv, w.mandantA),
      btFuer(w, w.mandantB),
      kanzlei(w, w.bt, null, { admin: true }),
      kanzlei(w, w.bt, w.mandantA, {
        tenantId: randomUUID(),
        admin: true,
        bt: true,
        zustaendig: true,
      }),
    ]) {
      const f = await fehlerVon(
        im(a, (ctx) => ladeFreigabenHistorie(ctx, { mandantId: w.mandantA })),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
    for (const stand of ['2026-13-01', '2026-02-30', '15.10.2026']) {
      const f = await fehlerVon(
        im(btA(w), (ctx) => ladeFreigabenHistorie(ctx, { mandantId: w.mandantA, stand })),
      );
      expect(f.code, stand).toBe('UNGUELTIG');
    }
  });
});
