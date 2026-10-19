// =============================================================================
// Freigaben und Rollen gleichzeitig (TS-05, RT4-T-05/06): Jede Operation, die
// eine Freigabe anlegt, neu adressiert oder erteilt, prüft die Rolle des
// Empfängers bzw. der handelnden Person erst unter `halteRollenFest`. Wird die
// Rolle währenddessen entzogen und festgeschrieben, sieht die Operation das
// und legt nichts an bzw. erteilt nichts. Die Beweistests RT4-T-05/06 decken
// Erteilen und Neuadressieren; hier zusätzlich das Fenster nach der Prüfung
// und das Anlegen (Ziele mit Version 1, Beschreibung).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { DienstFehler } from '@tcms/contract';
import type { PrismaClient } from '@tcms/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mitRollenentzugWaehrend } from '../../__tests__/sperr-hilfen';
import {
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
} from './beschreibung';
import { legeProgrammAn } from './einrichtung';
import { adressiereFreigabeNeu, erteileFreigabe, fordereFreigabeCodeAn } from './freigaben';
import { bereiteVor, personen, richteEin } from './testprogramm';
import {
  baueWelt,
  btFuer,
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

  it('Version 1 mit Ziele-Freigabe: entzogene GV → UNGUELTIG, kein Programm, keine Freigabe', async () => {
    const { mandantId, gv } = await neuerMandant(w);
    await bereiteVor(w, mandantId, gv);
    const e = await mitRollenentzugWaehrend({
      tenantId: w.tenantId,
      mandantId,
      kontaktId: gv,
      client: zweite,
      operation: () =>
        im(btFuer(w, mandantId), (ctx) =>
          legeProgrammAn(ctx, { mandantId, daten: { kontrollen: {} }, personen: personen(w) }),
        ),
    });
    expect(code(e)).toBe('UNGUELTIG');
    expect(await inWelt(w, (tx) => tx.freigabe.count({ where: { programm: { mandantId } } }))).toBe(
      0,
    );
  });

  it('Beschreibung anfordern: entzogene GV → UNGUELTIG, Version bleibt in der Kanzlei-Review', async () => {
    const { mandantId, gv } = await neuerMandant(w);
    await richteEin(w, mandantId, gv);
    const bt = btFuer(w, mandantId);
    const v = await im(bt, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId }));
    const ziel = { mandantId, versionId: v.versionId };
    await im(bt, (ctx) =>
      speichereBeschreibungsabschnitt(ctx, {
        ...ziel,
        key: 'kultur',
        bloecke: [{ typ: 'text', text: 'Kultur der Steuerehrlichkeit.' }],
      }),
    );
    await im(bt, (ctx) => gibBeschreibungZurReview(ctx, ziel));
    // Review durch eine zweite Person (Vier-Augen).
    await im({ ...bt, id: w.hb }, (ctx) => schliesseBeschreibungsreviewAb(ctx, ziel));
    const e = await mitRollenentzugWaehrend({
      tenantId: w.tenantId,
      mandantId,
      kontaktId: gv,
      client: zweite,
      operation: () =>
        im(bt, (ctx) =>
          fordereBeschreibungsfreigabeAn(ctx, {
            ...ziel,
            empfaengerId: gv,
            verantwortung: { berufstraeger: null, bearbeitung: null },
            namen: [],
          }),
        ),
    });
    expect(code(e)).toBe('UNGUELTIG');
    const status = await inWelt(
      w,
      async (tx) =>
        (await tx.beschreibungVersion.findUniqueOrThrow({ where: { id: v.versionId } })).status,
    );
    expect(status).toBe('KANZLEI_REVIEW');
  });

  it('Neuadressieren: an eine eben entzogene GV → UNGUELTIG, Empfänger unverändert', async () => {
    const { mandantId, gv } = await neuerMandant(w);
    const programm = await richteEin(w, mandantId, gv);
    const vorher = randomUUID();
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programm,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: 'Risikoakzeptanz EC-UST-01',
          angefordertVon: w.bt,
          empfaengerId: vorher,
        },
      }),
    );
    const e = await mitRollenentzugWaehrend({
      tenantId: w.tenantId,
      mandantId,
      kontaktId: gv,
      client: zweite,
      operation: () =>
        im(btFuer(w, mandantId), (ctx) =>
          adressiereFreigabeNeu(ctx, { mandantId, freigabeId: f.id, empfaengerId: gv }),
        ),
    });
    expect(code(e)).toBe('UNGUELTIG');
    const nachher = await inWelt(w, (tx) => tx.freigabe.findUniqueOrThrow({ where: { id: f.id } }));
    expect(nachher.empfaengerId).toBe(vorher);
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
