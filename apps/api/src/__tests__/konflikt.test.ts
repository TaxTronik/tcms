// =============================================================================
// Konfliktgrund (`fehler.konflikt`, tcms-s10) im Dienst ohne Datenbank: Ein
// `409` trägt genau die Gründe des Registereintrags – an Endpunkten mit
// `konflikte` immer einen davon, an allen anderen nie einen. Jede Abweichung
// ist `500 INTERN` (fail closed wie ein 403 ohne Grund), damit die
// kanzleikonsole an diesen Endpunkten nie raten muss.
// =============================================================================

import { DienstFehler, ENDPUNKTE, konfliktMitGrund } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { aufbau, bestaetigtSenden, json, MANDANT } from './hilfen';

const FREIGABE = 'ckz0a1b2c3d4e5f6g7h8i9j0';
let wurf: () => never = () => {
  throw new Error('kein Wurf gesetzt');
};
const t = aufbau({
  routen: (r) => {
    r.endpunkt(ENDPUNKTE.portalFreigabeErteilen, async () => wurf());
    r.endpunkt(ENDPUNKTE.kontextLesen, async () => wurf());
  },
});

const erteilen = () =>
  bestaetigtSenden(t.app, {
    methode: 'POST',
    ziel: `/v1/mandanten/${MANDANT}/portal/freigaben/${FREIGABE}/freigeben`,
    body: JSON.stringify({ code: '123456' }),
    claims: { knd: 'MANDANT', rol: undefined, cli: { id: MANDANT, bt: false, hb: false } },
  });
const kontext = () => bestaetigtSenden(t.app, { ziel: `/v1/mandanten/${MANDANT}/kontext` });

describe('409 mit Konfliktgrund nach dem Endpunktregister', () => {
  it('Endpunkt mit konflikte: 409 trägt den Grund (Antwort und Log)', async () => {
    for (const grund of ENDPUNKTE.portalFreigabeErteilen.konflikte) {
      wurf = () => {
        throw konfliktMitGrund(grund, 'Feste Meldung.');
      };
      const r = await erteilen();
      expect(r.status, grund).toBe(409);
      expect(await json(r)).toEqual({
        ok: false,
        fehler: { code: 'KONFLIKT', meldung: 'Feste Meldung.', konflikt: grund },
      });
      expect(t.log.at(-1)).toMatchObject({ fehler: 'KONFLIKT', konflikt: grund });
    }
  });

  it('Endpunkt mit konflikte: 409 ohne Grund oder mit fremdem Grund → 500 INTERN', async () => {
    for (const f of [
      new DienstFehler('KONFLIKT', 'Ohne Grund.'),
      konfliktMitGrund('ZU_VIELE_CODES', 'Grund eines anderen Endpunkts.'),
    ]) {
      wurf = () => {
        throw f;
      };
      const r = await erteilen();
      expect(r.status).toBe(500);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'INTERN' } });
      expect(t.log.at(-1)).toMatchObject({ fehler: 'INTERN', ausnahme: 'KonfliktUndokumentiert' });
    }
  });

  it('andere Fehler dieser Endpunkte bleiben, wie sie sind (404 ohne Grund, kein Orakel)', async () => {
    wurf = () => {
      throw new DienstFehler('NICHT_GEFUNDEN');
    };
    const r = await erteilen();
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
  });

  it('Endpunkt ohne konflikte: 409 ohne Grund; ein Grund → 500 INTERN', async () => {
    expect(ENDPUNKTE.kontextLesen.konflikte).toEqual([]);
    wurf = () => {
      throw new DienstFehler('KONFLIKT', 'Status hat sich geändert.');
    };
    const ohne = await kontext();
    expect(ohne.status).toBe(409);
    expect(await json(ohne)).toEqual({
      ok: false,
      fehler: { code: 'KONFLIKT', meldung: 'Status hat sich geändert.' },
    });
    wurf = () => {
      throw konfliktMitGrund('CODE_FEHLT', 'Nicht dokumentiert.');
    };
    const mit = await kontext();
    expect(mit.status).toBe(500);
    expect(await json(mit)).toEqual({ ok: false, fehler: { code: 'INTERN' } });
  });
});
