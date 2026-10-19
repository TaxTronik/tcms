// =============================================================================
// Freigaben und Rollen gleichzeitig (TS-05, RT4-T-05): Erteilen prüft die
// Rolle der handelnden Person erst unter `halteRollenFest`. Wird die Rolle
// währenddessen entzogen und festgeschrieben, sieht die Operation das und
// erteilt nichts. Der Beweistest RT4-T-05 deckt die Wartezeit vor der
// Zeilensperre; hier das Fenster danach.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { DienstFehler } from '@tcms/contract';
import type { PrismaClient } from '@tcms/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mitRollenentzugWaehrend } from '../../__tests__/sperr-hilfen';
import { erteileFreigabe, fordereFreigabeCodeAn } from './freigaben';
import { richteEin } from './testprogramm';
import {
  baueWelt,
  im,
  inWelt,
  kontakt,
  neuerMandant,
  zweiteVerbindung,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

const code = (e: PromiseSettledResult<unknown>) =>
  e.status === 'rejected' && e.reason instanceof DienstFehler ? e.reason.code : e.status;

describe.skipIf(!AKTIV)('Freigaben: Rollen unter der Sperre der Rollenpflege', () => {
  let w: Welt;
  let zweite: PrismaClient;

  beforeAll(async () => {
    w = await baueWelt();
    zweite = zweiteVerbindung();
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('Erteilen: Rolle nach der Prüfung entzogen wartet bis zum Commit; mit eben entzogener Rolle → NICHT_GEFUNDEN', async () => {
    const { mandantId, gv } = await neuerMandant(w);
    const programm = await richteEin(w, mandantId, gv);
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programm,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: 'Risikoakzeptanz EC-UST-01',
          angefordertVon: w.bt,
          empfaengerId: gv,
        },
      }),
    );
    const person = kontakt(w, gv, mandantId);
    await im(person, (ctx) => fordereFreigabeCodeAn(ctx, { mandantId, freigabeId: f.id }));
    const { code: c } = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { zweck: 'FREIGABE_CODE', daten: { path: ['freigabeId'], equals: f.id } },
        select: { code: true },
      }),
    );
    const e = await mitRollenentzugWaehrend({
      tenantId: w.tenantId,
      mandantId,
      kontaktId: gv,
      client: zweite,
      operation: () =>
        im(person, (ctx) => erteileFreigabe(ctx, { mandantId, freigabeId: f.id, code: c! })),
    });
    expect(code(e)).toBe('NICHT_GEFUNDEN');
    const nachher = await inWelt(w, (tx) => tx.freigabe.findUniqueOrThrow({ where: { id: f.id } }));
    expect(nachher.status).toBe('OFFEN');
  });
});
