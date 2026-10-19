// Routentabelle des Dienstes gegen das Endpunktregister (eine Quelle der
// Wahrheit): Jede Route hat genau einen Registereintrag und umgekehrt
// (Methode, Muster, Portal, Akteur, Schemas, Status). Der Dienst (dienst.ts,
// wie server.ts) bricht den Aufbau bei jeder Abweichung ab.

import { ENDPUNKT_LISTE, ENDPUNKTE, type Endpunkt } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { describe, expect, it } from 'vitest';
import { baueRoutentabelle, type AppDeps } from '../app';
import { erzeugeDienst } from '../dienst';
import { SpeicherJti } from '../jti';
import { pruefeGegenRegister, type Routen } from '../routen';
import { registriereAlle } from '../routen/index';
import { aufbau, bestaetigtSenden, json, MANDANT, SCHLUESSEL, TOKEN_ALT } from './hilfen';

const stumm = { schreibe: () => undefined };
const deps: Omit<AppDeps<Tx>, 'routen' | 'register'> = {
  konfiguration: { dienstTokens: [TOKEN_ALT], akteurSchluessel: SCHLUESSEL, version: '0.1.0' },
  uhr: { jetzt: () => new Date() },
  jti: new SpeicherJti(),
  daten: {
    mitTenant: async () => {
      throw new Error('kein Datenzugriff im Registertest');
    },
    ping: async () => undefined,
  },
  log: stumm,
};

const tabelle = (routen: (r: Routen<Tx>) => void, register?: readonly Endpunkt[]) =>
  baueRoutentabelle<Tx>({ ...deps, routen, register }, stumm);

/** Wie `registriereAlle`, aber ohne den genannten Eintrag. */
const ohne =
  (name: string) =>
  (r: Routen<Tx>): void =>
    registriereAlle({
      endpunkt: (e, h) => {
        if (e.name !== name) r.endpunkt(e, h);
      },
      route: (d) => r.route(d),
    });

describe('Routentabelle und Endpunktregister', () => {
  it('stimmen genau überein (Methode, Muster, Akteursarten, Akteur, Status, Schemas)', () => {
    const eintraege = tabelle(registriereAlle, ENDPUNKT_LISTE).eintraege();
    const schluessel = (m: string, p: string, akteure: readonly string[]) =>
      `${m} ${p} akteure=${akteure.join('+')}`;
    expect(eintraege.map((r) => schluessel(r.methode, r.pfad, r.akteure)).sort()).toEqual(
      ENDPUNKT_LISTE.map((e) => schluessel(e.methode, e.pfad, e.akteure)).sort(),
    );
    for (const r of eintraege) {
      const e = r.endpunkt!;
      expect(e, `${r.methode} ${r.pfad}`).toBeDefined();
      expect(r.akteur).toBe(e.akteur);
      expect(r.status).toBe(e.erfolgStatus);
      expect(r.mandantGebunden).toBe(e.mandantenbezogen);
      expect(r.body).toBe(e.bodySchema ?? undefined);
      expect(r.query).toBe(e.querySchema ?? undefined);
      expect(r.params).toBe(e.akteur ? e.paramsSchema : undefined);
    }
  });

  it('der Dienst baut die App mit allen Routen und dem Abgleich auf', () => {
    expect(() => erzeugeDienst(deps)).not.toThrow();
  });

  it('bricht ab, wenn ein Registereintrag keine Route hat', () => {
    expect(() => erzeugeDienst(deps, ohne('kontextLesen'))).toThrow(
      /kontextLesen hat 0 Routen statt genau einer/,
    );
  });

  it('bricht ab, wenn eine Route keinen Registereintrag hat', () => {
    const ohneEintrag = ENDPUNKT_LISTE.filter((e) => e.name !== 'risikoLesen');
    expect(() => tabelle(registriereAlle, ohneEintrag)).toThrow(
      /Route ohne Registereintrag: GET \/v1\/mandanten\/:mandantId\/risiken\/:risikoId/,
    );
  });

  it('bricht ab bei einer freien Route (nicht aus dem Register)', () => {
    const mitFreier = (r: Routen<Tx>) => {
      registriereAlle(r);
      r.route({ methode: 'GET', pfad: '/v1/frei', handler: async () => ({}) });
    };
    expect(() => erzeugeDienst(deps, mitFreier)).toThrow(
      /Route ohne Registereintrag: GET \/v1\/frei/,
    );
  });

  it('bricht ab, wenn eine Route einen abweichenden Eintrag gleichen Namens nutzt', () => {
    // z. B. versehentlich als Portal-Endpunkt geöffnet
    const kopie = {
      ...ENDPUNKTE.kontakteLesen,
      akteure: ['KANZLEI', 'MANDANT'],
      portal: true,
    } as const;
    const abweichend = (r: Routen<Tx>) =>
      registriereAlle({
        endpunkt: (e, h) => r.endpunkt(e.name === 'kontakteLesen' ? kopie : e, h),
        route: (d) => r.route(d),
      });
    expect(() => erzeugeDienst(deps, abweichend)).toThrow(
      /verweist auf fremden Eintrag kontakteLesen/,
    );
  });

  it('bricht ab, wenn die Akteursarten einer Route vom Register abweichen', () => {
    const eintraege = tabelle(registriereAlle, ENDPUNKT_LISTE).eintraege();
    for (const [name, akteure] of [
      ['kontakteLesen', ['KANZLEI', 'MANDANT']],
      ['nachrichtenOffenLesen', ['SYSTEM', 'KANZLEI']],
      ['portalFreigabenLesen', ['KANZLEI', 'MANDANT']],
      ['auditLesen', ['SYSTEM']],
    ] as const) {
      const geaendert = eintraege.map((r) => (r.endpunkt?.name === name ? { ...r, akteure } : r));
      expect(() => pruefeGegenRegister(geaendert, ENDPUNKT_LISTE), name).toThrow(
        new RegExp(`weicht von ${name} ab`),
      );
    }
  });

  it('prüft Pfadparameter mit dem Schema aus dem Register, bevor der Handler läuft', async () => {
    let aufrufe = 0;
    const t = aufbau({
      routen: (r) =>
        r.endpunkt(ENDPUNKTE.risikoLesen, async () => {
          aufrufe++;
          throw new Error('Handler darf nicht laufen');
        }),
    });
    // 65 Zeichen: kanonisches Segment, aber länger als die Objekt-ID erlaubt.
    const ziel = `/v1/mandanten/${MANDANT}/risiken/${'a'.repeat(65)}`;
    const r = await bestaetigtSenden(t.app, { ziel });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ ok: false, fehler: { code: 'UNGUELTIG' } });
    expect(aufrufe).toBe(0);
    expect(t.tenants).toEqual([]);
  });
});
