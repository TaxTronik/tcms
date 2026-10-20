// =============================================================================
// Beweis gegen PostgreSQL (DB_TESTS=1): Die Meldung eines Prisma-Fehlers
// enthält Quelltext der aufrufenden Stelle. Ein Abgleich gegen diese Meldung
// besteht mit dem Namen einer Regel, die gar nicht abgewiesen hat; der Helfer
// `dbAbgewiesen` (db-fehler.ts) liest nur die Meldung des Servers.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant } from '../tenant';
import { dbAbgewiesen, dbFehlerAus, regel } from './db-fehler';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Abweisungen der Datenbank nur über die Meldung des Servers', () => {
  let app: PrismaClient;
  beforeAll(() => {
    app = erzeugeClient(process.env['DATABASE_URL']);
  });
  afterAll(async () => {
    await app?.$disconnect();
  });

  /** Audit-Eintrag mit Position 0 in einem leeren Tenant: verletzt nur `AuditEvent_pos_check`. */
  const positionNull = () =>
    mitTenant(
      randomUUID(),
      (tx) =>
        // Erwartet wäre hier etwa "AuditEvent_tenant_id_pos_key" (eine andere Regel).
        tx.auditEvent.create({
          data: {
            pos: 0,
            kettenVersion: 2,
            at: new Date(),
            actorName: 'Test',
            aktion: 'tcms.test.position',
            objektTyp: 'Test',
            objektId: 'position',
            detail: {},
            prevHash: randomBytes(32).toString('hex'),
            hash: randomBytes(32).toString('hex'),
          },
        }),
      { client: app },
    );

  it('die Meldung des Prisma-Fehlers nennt eine Regel aus dem Quelltext, die nicht abwies', async () => {
    const fehler = await positionNull().then(
      () => null,
      (e: unknown) => e,
    );
    expect(fehler).toBeInstanceOf(Error);
    // Ein `toThrow(/AuditEvent_tenant_id_pos_key/)` bestünde hier: Der Name steht
    // im angehängten Codeausschnitt (Kommentar über dem Aufruf).
    expect((fehler as Error).message.includes('AuditEvent_tenant_id_pos_key')).toBe(true);
    // Die Datenbank wies aber am CHECK ab.
    expect(dbFehlerAus(fehler)).toEqual({
      sqlstate: '23514',
      meldung: 'new row for relation "AuditEvent" violates check constraint "AuditEvent_pos_check"',
      prisma: expect.stringMatching(/^P\d{4}$/),
    });
  });

  it('dbAbgewiesen besteht nur mit der Regel, die abgewiesen hat', async () => {
    await dbAbgewiesen(positionNull(), regel.check('AuditEvent', 'AuditEvent_pos_check'));
    const falsch = await dbAbgewiesen(
      positionNull(),
      regel.eindeutig('AuditEvent_tenant_id_pos_key'),
    ).then(
      () => 'bestanden',
      () => 'abgewiesen',
    );
    expect(falsch).toBe('abgewiesen');
  });
});
