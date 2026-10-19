// =============================================================================
// Systemakteur Ende-zu-Ende über das gesamte Endpunktregister (DB_TESTS=1):
// der Dienst wie in Produktion (alle Routen aus `registriereAlle`, Abgleich
// mit dem Register) mit PostgreSQL als Laufzeitrolle tcms_app. Für jeden
// Endpunkt mit Akteursbestätigung schickt ein Systemakteur eine signierte
// Anfrage: 404 überall außer den zwei Nachrichten-Endpunkten, die gelingen.
// Personen erhalten auf den Nachrichten-Endpunkten 404. Kein Audit-Eintrag
// außer denen der Nachrichten.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { ENDPUNKT_LISTE, bodySha256 } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { legeNachrichtAn } from '@tcms/service';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Routen } from '../routen';
import { registriereAlle } from '../routen/index';
import {
  aufbau,
  beispielPfad,
  bestaetigtSenden,
  claims,
  json,
  mandantClaims,
  systemClaims,
} from './hilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const T = randomUUID();
const M = randomUUID();
const NACHRICHTEN = ['nachrichtZugestelltMelden', 'nachrichtenOffenLesen'];
const LEER = bodySha256(new Uint8Array());

describe.skipIf(!AKTIV)('Systemakteur über alle Endpunkte (Dienst + PostgreSQL)', () => {
  const t = aufbau({
    register: ENDPUNKT_LISTE,
    routen: registriereAlle as unknown as (r: Routen<unknown>) => void,
    daten: {
      mitTenant: (tenantId, fn) => mitTenant(tenantId, fn as (tx: Tx) => Promise<never>),
      ping: async () => undefined,
    },
  });
  let nachrichtId = '';

  beforeAll(async () => {
    nachrichtId = await mitTenant(T, async (tx) => {
      await tx.mandant.create({ data: { id: M, name: 'System-Test GmbH', rechtsform: 'KapG' } });
      return legeNachrichtAn(tx, {
        mandantId: M,
        empfaengerId: randomUUID(),
        zweck: 'FREIGABE_ANGEFORDERT',
        daten: {
          freigabeId: 'ckfreigabe0000000000000a',
          art: 'ZIELE',
          titel: 'Ziele',
          version: null,
        },
        betreff: 'B',
        text: 'T',
      });
    });
  });

  it('404 auf jedem Endpunkt außer den zwei Nachrichten-Endpunkten', async () => {
    const vorher = await mitTenant(T, (tx) => tx.auditEvent.count());
    let geprueft = 0;
    for (const e of ENDPUNKT_LISTE) {
      if (!e.akteur || NACHRICHTEN.includes(e.name)) continue;
      const ziel = beispielPfad(e.pfad, M);
      const r = await bestaetigtSenden(t.app, {
        methode: e.methode,
        ziel,
        roheClaims: systemClaims({ tnt: T, req: { m: e.methode, p: ziel, b: LEER } }),
      });
      expect(r.status, e.name).toBe(404);
      expect(await json(r), e.name).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
      geprueft++;
    }
    expect(geprueft).toBe(ENDPUNKT_LISTE.length - 1 - NACHRICHTEN.length);
    expect(await mitTenant(T, (tx) => tx.auditEvent.count())).toBe(vorher);
  });

  it('die zwei Nachrichten-Endpunkte gelingen nur für den Systemakteur', async () => {
    const offen = '/v1/nachrichten/offen';
    const zugestellt = `/v1/nachrichten/${nachrichtId}/zugestellt`;
    const personen = (m: 'GET' | 'POST', p: string) => [
      claims({
        tnt: T,
        rol: { adm: true, bt: true },
        cli: { id: M, bt: true, hb: true },
        req: { m, p, b: LEER },
      }),
      mandantClaims(M, { tnt: T, req: { m, p, b: LEER } }),
    ];
    for (const [m, p] of [
      ['GET', offen],
      ['POST', zugestellt],
    ] as const) {
      for (const c of personen(m, p)) {
        const r = await bestaetigtSenden(t.app, { methode: m, ziel: p, roheClaims: c });
        expect(r.status, `${c.knd} ${m} ${p}`).toBe(404);
      }
    }
    const r1 = await bestaetigtSenden(t.app, {
      ziel: offen,
      roheClaims: systemClaims({ tnt: T, req: { m: 'GET', p: offen, b: LEER } }),
    });
    expect(r1.status).toBe(200);
    const ids = ((await json(r1))['daten'] as { nachrichten: { id: string }[] }).nachrichten.map(
      (n) => n.id,
    );
    expect(ids).toEqual([nachrichtId]);
    const r2 = await bestaetigtSenden(t.app, {
      methode: 'POST',
      ziel: zugestellt,
      roheClaims: systemClaims({ tnt: T, req: { m: 'POST', p: zugestellt, b: LEER } }),
    });
    expect(r2.status).toBe(200);
    const aktionen = await mitTenant(T, (tx) =>
      tx.auditEvent.findMany({ orderBy: { pos: 'asc' }, select: { aktion: true } }),
    );
    expect(aktionen.map((a) => a.aktion)).toEqual([
      'tcms.nachricht.abgerufen',
      'tcms.nachricht.zugestellt',
    ]);
  });
});
