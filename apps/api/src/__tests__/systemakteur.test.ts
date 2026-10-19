// =============================================================================
// Systemakteur über das gesamte Endpunktregister (Stufe 4, ADR 0001 §3.2,
// §3.3), ohne Datenbank, in zwei unabhängigen Schichten:
//
//   1. Routentabelle: Jeder Registereintrag bekommt einen Platzhalter-Handler.
//      Der Systemakteur erreicht genau die drei Nachrichten-Endpunkte (abholen,
//      zugestellt, unzustellbar); jeder andere antwortet 404, ohne Handler und
//      ohne Tenant-Transaktion. Personen erreichen die Nachrichten-Endpunkte
//      nicht.
//   2. Dienstschicht: Die echten Handler des Dienstes (`registriereAlle`)
//      werden direkt mit einem Systemakteur aufgerufen – an der Routentabelle
//      vorbei. Jeder Handler außer den Nachrichten-Endpunkten weist ihn mit
//      NICHT_GEFUNDEN ab, bevor er die Transaktion berührt (`tx` wirft bei
//      jedem Zugriff); Personen weisen die Nachrichten-Handler ebenso ab.
//
// Die Ende-zu-Ende-Prüfung mit PostgreSQL steht in systemakteur.db.test.ts.
// =============================================================================

import {
  DienstFehler,
  ENDPUNKT_LISTE,
  bodySha256,
  type Akteur,
  type AkteurArt,
  type AkteurClaims,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { describe, expect, it } from 'vitest';
import { baueRoutentabelle } from '../app';
import type { Routen } from '../routen';
import { registriereAlle } from '../routen/index';
import { dienstKontext, systemKontext } from '../routen/kontext';
import {
  MANDANT,
  PERSON,
  SCHLUESSEL,
  SYSTEM_ID,
  TENANT,
  TOKEN_ALT,
  aufbau,
  beispielParams,
  beispielPfad,
  bestaetigtSenden,
  claims,
  json,
  mandantClaims,
  systemClaims,
  TEST_CODES,
} from './hilfen';

/** Alle Endpunkte des Systemakteurs (sortiert). */
const NACHRICHTEN = [
  'nachrichtUnzustellbarMelden',
  'nachrichtZugestelltMelden',
  'nachrichtenOffenLesen',
];
const MIT_AKTEUR = ENDPUNKT_LISTE.filter((e) => e.akteur);
/** Gültige Eingabe je Nachrichten-Endpunkt mit Body (sonst 400 vor dem Handler). */
const BEISPIEL_BODY: Readonly<Record<string, unknown>> = {
  nachrichtUnzustellbarMelden: { grund: 'SONSTIGES' },
};
const bodyFuer = (name: string): string | undefined =>
  name in BEISPIEL_BODY ? JSON.stringify(BEISPIEL_BODY[name]) : undefined;

/** Claims je Art mit allen Rechten, die die Art haben kann (gebunden an den Body). */
function claimsFuer(
  art: AkteurArt,
  methode: AkteurClaims['req']['m'],
  p: string,
  body = '',
): AkteurClaims {
  const req = { m: methode, p, b: bodySha256(new TextEncoder().encode(body)) };
  if (art === 'SYSTEM') return systemClaims({ req });
  if (art === 'MANDANT') return mandantClaims(MANDANT, { req });
  return claims({ rol: { adm: true, bt: true }, cli: { id: MANDANT, bt: true, hb: true }, req });
}

describe('Systemakteur: Routentabelle über alle Registereinträge', () => {
  it('erreicht genau die Nachrichten-Endpunkte; überall sonst 404 ohne Handler und Tenant', async () => {
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
    const ergebnisse: Record<string, number> = {};
    for (const e of MIT_AKTEUR) {
      const ziel = beispielPfad(e.pfad);
      const body = bodyFuer(e.name);
      const r = await bestaetigtSenden(t.app, {
        methode: e.methode,
        ziel,
        body,
        roheClaims: claimsFuer('SYSTEM', e.methode, ziel, body),
      });
      ergebnisse[e.name] = r.status;
      if (NACHRICHTEN.includes(e.name)) {
        expect(r.status, e.name).toBe(409);
      } else {
        expect(r.status, e.name).toBe(404);
        expect(await json(r), e.name).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
      }
    }
    expect(Object.keys(ergebnisse)).toHaveLength(ENDPUNKT_LISTE.length - 1);
    expect(erreicht.sort()).toEqual(NACHRICHTEN);
    // Nur die erreichten Handler öffneten eine Transaktion.
    expect(t.tenants).toEqual(NACHRICHTEN.map(() => TENANT));
  });

  it('jede zugelassene Personenart passiert die Akteursprüfung, jede andere erhält 404', async () => {
    const erreicht: string[] = [];
    const t = aufbau({
      register: ENDPUNKT_LISTE,
      routen: (r: Routen<unknown>) => {
        for (const e of ENDPUNKT_LISTE) {
          if (e.name === 'health' || e.name === 'ich') continue;
          r.endpunkt(e, async () => {
            erreicht.push(e.name);
            throw new DienstFehler('KONFLIKT');
          });
        }
      },
    });
    for (const e of MIT_AKTEUR) {
      for (const art of ['KANZLEI', 'MANDANT', 'SYSTEM'] as const) {
        const ziel = beispielPfad(e.pfad);
        const body = bodyFuer(e.name);
        const r = await bestaetigtSenden(t.app, {
          methode: e.methode,
          ziel,
          body,
          roheClaims: claimsFuer(art, e.methode, ziel, body),
        });
        if (e.akteure.includes(art)) {
          // Zugelassen: Handler (409), eingebautes `ich` (200) oder Body fehlt (400).
          expect([200, 400, 409], `${art} ${e.name}`).toContain(r.status);
        } else {
          expect(r.status, `${art} ${e.name}`).toBe(404);
        }
      }
    }
    for (const n of NACHRICHTEN) expect(erreicht.filter((x) => x === n)).toEqual([n]);
  });
});

/** Transaktion, die jeden Zugriff meldet und abweist. */
function wachsameTx(zugriffe: string[]): Tx {
  return new Proxy(
    {},
    {
      get(_ziel, name) {
        zugriffe.push(String(name));
        throw new Error('Datenzugriff');
      },
    },
  ) as Tx;
}

const SYSTEM_AKTEUR: Akteur = {
  art: 'SYSTEM',
  tenantId: TENANT,
  id: SYSTEM_ID,
  name: 'Zustellung kanzleikonsole',
};
const ADMIN: Akteur = {
  art: 'KANZLEI',
  tenantId: TENANT,
  id: PERSON,
  name: 'Admin',
  istAdmin: true,
  istBerufstraeger: true,
  mandant: { id: MANDANT, zustaendigBerufstraeger: true, hauptbearbeitung: true },
};
const KONTAKT: Akteur = {
  art: 'MANDANT',
  tenantId: TENANT,
  id: PERSON,
  name: 'Kontakt',
  mandantId: MANDANT,
};

function dienstTabelle() {
  return baueRoutentabelle<Tx>(
    {
      konfiguration: { dienstTokens: [TOKEN_ALT], akteurSchluessel: SCHLUESSEL, version: '0.1.0' },
      daten: {
        mitTenant: async () => {
          throw new Error('kein Datenzugriff');
        },
        ping: async () => undefined,
      },
      routen: (r) => registriereAlle(r, { codes: TEST_CODES }),
      register: ENDPUNKT_LISTE,
    },
    { schreibe: () => undefined },
  );
}

async function rufe(
  route: ReturnType<ReturnType<typeof dienstTabelle>['eintraege']>[number],
  akteur: Akteur,
) {
  const zugriffe: string[] = [];
  let fehler: unknown = null;
  try {
    await route.handler({
      tx: wachsameTx(zugriffe),
      akteur,
      params: beispielParams(route.pfad),
      body: BEISPIEL_BODY[route.endpunkt?.name ?? ''] ?? {},
      query: {},
      requestId: 'test',
      jetzt: new Date(),
    });
  } catch (e) {
    fehler = e;
  }
  return { zugriffe, fehler };
}

describe('Systemakteur: Dienstschicht (echte Handler an der Routentabelle vorbei)', () => {
  it('jeder Handler außer den Nachrichten weist den Systemakteur ab, bevor er die Transaktion berührt', async () => {
    const routen = dienstTabelle()
      .eintraege()
      .filter((r) => r.akteur);
    expect(routen).toHaveLength(MIT_AKTEUR.length);
    for (const route of routen) {
      const name = route.endpunkt!.name;
      const { zugriffe, fehler } = await rufe(route, SYSTEM_AKTEUR);
      if (NACHRICHTEN.includes(name)) {
        // Zugelassen: die Operation läuft bis zum ersten Datenzugriff.
        expect((fehler as Error).message, name).toBe('Datenzugriff');
        expect(zugriffe.length, name).toBeGreaterThan(0);
        continue;
      }
      expect(fehler, name).toBeInstanceOf(DienstFehler);
      expect((fehler as DienstFehler).code, name).toBe('NICHT_GEFUNDEN');
      expect(zugriffe, name).toEqual([]);
    }
  });

  it('die Nachrichten-Handler weisen jede Person ab (auch Admin/Partner), ohne Datenzugriff', async () => {
    const routen = dienstTabelle()
      .eintraege()
      .filter((r) => NACHRICHTEN.includes(r.endpunkt?.name ?? ''));
    expect(routen).toHaveLength(NACHRICHTEN.length);
    for (const route of routen) {
      for (const person of [ADMIN, KONTAKT]) {
        const { zugriffe, fehler } = await rufe(route, person);
        expect((fehler as DienstFehler).code, `${person.art} ${route.pfad}`).toBe('NICHT_GEFUNDEN');
        expect(zugriffe).toEqual([]);
      }
    }
  });
});

describe('Kontexte der Routen', () => {
  const routenCtx = (akteur: Akteur) => ({
    tx: wachsameTx([]),
    akteur,
    params: {},
    body: undefined,
    query: undefined,
    requestId: 'test',
    jetzt: new Date(),
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'kein Fehler';
    } catch (e) {
      return e instanceof DienstFehler ? e.code : 'anderer Fehler';
    }
  };

  it('dienstKontext nur für Personen, systemKontext nur für den Systemakteur', () => {
    expect(code(() => dienstKontext(routenCtx(SYSTEM_AKTEUR)))).toBe('NICHT_GEFUNDEN');
    expect(code(() => systemKontext(routenCtx(ADMIN)))).toBe('NICHT_GEFUNDEN');
    expect(code(() => systemKontext(routenCtx(KONTAKT)))).toBe('NICHT_GEFUNDEN');
    expect(dienstKontext(routenCtx(ADMIN)).akteur).toEqual(ADMIN);
    expect(dienstKontext(routenCtx(KONTAKT)).akteur).toEqual(KONTAKT);
    expect(systemKontext(routenCtx(SYSTEM_AKTEUR)).akteur).toEqual(SYSTEM_AKTEUR);
  });
});
