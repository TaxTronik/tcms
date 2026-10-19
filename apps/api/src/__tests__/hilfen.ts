// Gemeinsame Testhilfen: App mit injizierten Abhängigkeiten, Anfragen über
// `app.request(...)` ohne Netz. Die rohe Anfrage (`incoming.url`/`method`)
// wird wie von @hono/node-server als Binding übergeben; die Request-URL baut
// der WHATWG-Parser (normalisiert), genau wie im Adapter.

import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { AKTEUR_HEADER, bodySha256, signiereAkteur, type AkteurClaims } from '@tcms/contract';
import { baueRoutentabelle, erzeugeApp, type AppDeps, type Datenzugriff } from '../app';
import { SpeicherJti, type JtiSpeicher } from '../jti';
import type { LogWert } from '../log';
import type { Routen } from '../routen';
import { mitVertragspruefung } from './vertrag';

export const JETZT = new Date('2026-10-19T10:00:00.000Z');
export const JETZT_S = JETZT.getTime() / 1000;
export const TENANT = '11111111-1111-4111-8111-111111111111';
export const PERSON = '22222222-2222-4222-8222-222222222222';
export const MANDANT = '3c3c3c3c-3333-4333-8333-33333333abcd';
export const MANDANT_FREMD = '44444444-4444-4444-8444-444444444444';
export const NAME = 'StB Dr. Anna Roth';

// Je Lauf frisch erzeugt; keine echten Werte.
export const TOKEN_ALT = randomBytes(32).toString('base64url');
export const TOKEN_NEU = randomBytes(32).toString('base64url');
export const SCHLUESSEL_A = generateKeyPairSync('ed25519');
export const SCHLUESSEL_B = generateKeyPairSync('ed25519');
export const SCHLUESSEL: ReadonlyMap<string, KeyObject> = new Map([
  ['kk-a', SCHLUESSEL_A.publicKey],
  ['kk-b', SCHLUESSEL_B.publicKey],
]);

let jtiZaehler = 0;
export const neueJti = () => `${randomBytes(16).toString('base64url')}${jtiZaehler++}`;

export interface Aufbau {
  app: ReturnType<typeof erzeugeApp>;
  log: Record<string, LogWert>[];
  logRoh: string[];
  tenants: string[];
  jti: JtiSpeicher;
  jtiAufrufe: string[];
  pings: number[];
}

export function aufbau(
  over: Partial<AppDeps> & { routen?: (r: Routen<unknown>) => void } = {},
): Aufbau {
  const log: Record<string, LogWert>[] = [];
  const logRoh: string[] = [];
  const tenants: string[] = [];
  const jtiAufrufe: string[] = [];
  const pings: number[] = [];
  const speicher = over.jti ?? new SpeicherJti();
  const jti: JtiSpeicher = {
    einmalig: (j, exp) => {
      jtiAufrufe.push(j);
      return speicher.einmalig(j, exp);
    },
  };
  const daten: Datenzugriff = over.daten ?? {
    mitTenant: async (tenantId, fn) => {
      tenants.push(tenantId);
      return fn({ tenantId });
    },
    ping: async () => {
      pings.push(1);
    },
  };
  const deps: AppDeps = {
    konfiguration: {
      dienstTokens: [TOKEN_ALT, TOKEN_NEU],
      akteurSchluessel: SCHLUESSEL,
      version: '0.1.0',
    },
    uhr: { jetzt: () => JETZT },
    log: {
      schreibe(stufe, ereignis, felder = {}) {
        const zeile = { stufe, ereignis, ...felder };
        logRoh.push(JSON.stringify(zeile));
        log.push(zeile);
      },
    },
    ...over,
    jti,
    daten,
  };
  const app = erzeugeApp(deps);
  // Jede Antwort dieser App gegen den Vertrag prüfen (Endpunktregister, vertrag.ts);
  // die Prüftabelle entsteht aus denselben Routen wie die App.
  mitVertragspruefung(app, baueRoutentabelle(deps, { schreibe: () => undefined }));
  return { app, log, logRoh, tenants, jti, jtiAufrufe, pings };
}

export function claims(over: Partial<AkteurClaims> = {}): AkteurClaims {
  return {
    iss: 'kanzleikonsole',
    aud: 'tcms',
    iat: JETZT_S - 5,
    exp: JETZT_S + 55,
    jti: neueJti(),
    tnt: TENANT,
    sub: PERSON,
    knd: 'KANZLEI',
    nam: NAME,
    rol: { adm: false, bt: true },
    cli: { id: MANDANT, bt: true, hb: false },
    req: { m: 'GET', p: '/v1/ich', b: bodySha256(new Uint8Array()) },
    ...over,
  };
}

export function mandantClaims(mandantId = MANDANT, over: Partial<AkteurClaims> = {}): AkteurClaims {
  const c = claims({ knd: 'MANDANT', cli: { id: mandantId, bt: false, hb: false }, ...over });
  delete c.rol;
  return c;
}

/** Feste ID des Systemakteurs (Dienstnutzer der kanzleikonsole je Tenant) in Tests. */
export const SYSTEM_ID = '55555555-5555-4555-8555-555555555555';

/** Claims eines Systemakteurs: ohne `rol` und `cli` (ADR 0001 §3.2). */
export function systemClaims(over: Partial<AkteurClaims> = {}): AkteurClaims {
  const c = claims({ knd: 'SYSTEM', sub: SYSTEM_ID, nam: 'Zustellung kanzleikonsole', ...over });
  delete c.rol;
  delete c.cli;
  return c;
}

/**
 * Konkreter, kanonischer Pfad zu einem Registermuster mit gültigen
 * Beispielwerten je Parameter (Mandant: `mandantId`).
 */
export function beispielPfad(muster: string, mandantId = MANDANT): string {
  return muster
    .split('/')
    .map((s) => {
      if (!s.startsWith(':')) return s;
      const name = s.slice(1);
      if (name === 'mandantId') return mandantId;
      if (name === 'sha256') return 'a'.repeat(64);
      return 'ckz0a1b2c3d4e5f6g7h8i9j0';
    })
    .join('/');
}

/** Pfadparameter zu einem Muster wie `beispielPfad`. */
export function beispielParams(muster: string, mandantId = MANDANT): Record<string, string> {
  const werte = beispielPfad(muster, mandantId).split('/');
  const params: Record<string, string> = Object.create(null);
  muster.split('/').forEach((s, i) => {
    if (s.startsWith(':')) params[s.slice(1)] = werte[i]!;
  });
  return params;
}

export interface Senden {
  methode?: string;
  /** Pfad mit Query, wie der Client ihn schickt (roh). */
  ziel: string;
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  /** ohne `incoming`-Binding (fremder Adapter) */
  ohneRoh?: boolean;
}

export function senden(app: Aufbau['app'], s: Senden): Promise<Response> {
  const methode = s.methode ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method: methode, headers: s.headers };
  if (s.body !== undefined) {
    init.body = s.body as RequestInit['body'];
    if (s.body instanceof ReadableStream) init.duplex = 'half';
  }
  const url = s.ziel.startsWith('/') ? `http://tcms.intern${s.ziel}` : s.ziel;
  const env = s.ohneRoh ? undefined : { incoming: { url: s.ziel, method: methode } };
  return Promise.resolve(app.request(url, init, env));
}

export interface Bestaetigt {
  methode?: string;
  ziel: string;
  body?: string;
  claims?: Partial<AkteurClaims>;
  /** fertige Claims (überschreibt `claims`) */
  roheClaims?: AkteurClaims;
  token?: string;
  headers?: Record<string, string>;
  kid?: string;
  privateKey?: KeyObject;
}

/** Signiert die Bestätigung für genau diese Anfrage und liefert Header und Token. */
export function bestaetigung(b: Bestaetigt): { headers: Record<string, string>; akteur: string } {
  const methode = (b.methode ?? 'GET') as AkteurClaims['req']['m'];
  const body = new TextEncoder().encode(b.body ?? '');
  // Absolutes Target: signiert ist nur der Pfad (so wie ein Aufrufer ihn bindet).
  const p = b.ziel.startsWith('/') ? b.ziel : new URL(b.ziel).pathname;
  const c = b.roheClaims ?? claims({ req: { m: methode, p, b: bodySha256(body) }, ...b.claims });
  const akteur = signiereAkteur(c, {
    kid: b.kid ?? 'kk-a',
    privateKey: b.privateKey ?? SCHLUESSEL_A.privateKey,
  });
  const headers: Record<string, string> = {
    authorization: `Bearer ${b.token ?? TOKEN_ALT}`,
    [AKTEUR_HEADER]: akteur,
  };
  if (b.body !== undefined) headers['content-type'] = 'application/json';
  return { headers: { ...headers, ...b.headers }, akteur };
}

export function bestaetigtSenden(app: Aufbau['app'], b: Bestaetigt): Promise<Response> {
  const { headers } = bestaetigung(b);
  return senden(app, { methode: b.methode, ziel: b.ziel, body: b.body, headers });
}

/** Strom, der zählt, wie viele Stücke gelesen wurden. */
export function zaehlStrom(stuecke: number, groesse: number) {
  const zaehler = { gelesen: 0, abgebrochen: false };
  const strom = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (zaehler.gelesen >= stuecke) {
          controller.close();
          return;
        }
        zaehler.gelesen++;
        controller.enqueue(new Uint8Array(groesse).fill(0x61));
      },
      cancel() {
        zaehler.abgebrochen = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { strom, zaehler };
}

export const json = async (r: Response) => JSON.parse(await r.text()) as Record<string, unknown>;
