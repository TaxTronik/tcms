// =============================================================================
// Portal-Endpunkte nur für Mandantenkontakte (Stufe 5, ADR 0001 §3.3, §7):
// über das gesamte Endpunktregister, ohne Datenbank. Jeder Registereintrag
// bekommt einen Platzhalter-Handler; eine Kanzleiperson mit allen Rechten
// (Admin, Berufsträgerin, `cli` auf genau diesen Mandanten) erhält auf jedem
// Portal-Pfad 404 wie ein unbekannter Pfad – ohne Handler und ohne
// Tenant-Transaktion. Mandantenkontakte erreichen jeden Portal-Endpunkt, beide
// Personenarten weiterhin `/v1/ich`.
// =============================================================================

import {
  DienstFehler,
  ENDPUNKT_LISTE,
  ENDPUNKTE,
  bodySha256,
  type AkteurClaims,
} from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import type { Routen } from '../routen';
import {
  MANDANT,
  TENANT,
  aufbau,
  beispielPfad,
  bestaetigtSenden,
  claims,
  json,
  mandantClaims,
} from './hilfen';

const LEER = bodySha256(new Uint8Array());
const PORTAL = ENDPUNKT_LISTE.filter((e) => e.pfad.startsWith('/v1/mandanten/:mandantId/portal/'));

function kanzleiMitAllenRechten(m: AkteurClaims['req']['m'], p: string): AkteurClaims {
  return claims({
    rol: { adm: true, bt: true },
    cli: { id: MANDANT, bt: true, hb: true },
    req: { m, p, b: LEER },
  });
}

function aufbauMitPlatzhaltern() {
  const erreicht: string[] = [];
  const t = aufbau({
    register: ENDPUNKT_LISTE,
    routen: (r: Routen<unknown>) => {
      for (const e of ENDPUNKT_LISTE) {
        if (e.name === 'health' || e.name === 'ich') continue; // eingebaut
        r.endpunkt(e, async () => {
          erreicht.push(e.name);
          // Fester Fehler statt Daten: beweist nur, dass der Handler lief.
          throw new DienstFehler('KONFLIKT');
        });
      }
    },
  });
  return { ...t, erreicht };
}

describe('Portal-Endpunkte: nur Mandantenkontakte (Register)', () => {
  it('das Register führt Portal-Endpunkte (Plausibilität)', () => {
    expect(PORTAL.length).toBe(16);
    expect(PORTAL.map((e) => e.name)).toContain('portalUebersichtLesen');
    expect(PORTAL.map((e) => e.name)).toContain('portalFreigabeErteilen');
  });

  it('Kanzleiperson mit allen Rechten → 404 auf jedem Portal-Endpunkt, ohne Handler und Tenant', async () => {
    const t = aufbauMitPlatzhaltern();
    for (const e of PORTAL) {
      const ziel = beispielPfad(e.pfad);
      const r = await bestaetigtSenden(t.app, {
        methode: e.methode,
        ziel,
        roheClaims: kanzleiMitAllenRechten(e.methode, ziel),
      });
      expect(r.status, e.name).toBe(404);
      expect(await json(r), e.name).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }
    expect(t.erreicht).toEqual([]);
    expect(t.tenants).toEqual([]);
  });

  it('Mandantenkontakt des Mandanten erreicht jeden Portal-Endpunkt', async () => {
    const t = aufbauMitPlatzhaltern();
    for (const e of PORTAL) {
      const ziel = beispielPfad(e.pfad);
      const r = await bestaetigtSenden(t.app, {
        methode: e.methode,
        ziel,
        roheClaims: mandantClaims(MANDANT, { req: { m: e.methode, p: ziel, b: LEER } }),
      });
      // Handler (409) oder fehlender Body (400): die Akteursprüfung ist passiert.
      expect([400, 409], e.name).toContain(r.status);
    }
    expect(new Set(t.erreicht).size).toBeGreaterThan(0);
    expect(t.tenants.every((x) => x === TENANT)).toBe(true);
  });

  it('/v1/ich bleibt für Kanzleipersonen und Mandantenkontakte', async () => {
    expect(ENDPUNKTE.ich.akteure).toEqual(['KANZLEI', 'MANDANT']);
    const t = aufbauMitPlatzhaltern();
    for (const c of [kanzleiMitAllenRechten('GET', '/v1/ich'), mandantClaims(MANDANT)]) {
      const r = await bestaetigtSenden(t.app, { ziel: '/v1/ich', roheClaims: c });
      expect(r.status, c.knd).toBe(200);
    }
  });
});
