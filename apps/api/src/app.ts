// =============================================================================
// HTTP-Dienst des Tax-CMS (ADR 0001, Abschnitte 3 und 7).
//
// Reihenfolge je Anfrage (ADR 0001 §3.2):
//   1. Request-ID
//   2. Methode und Pfad bekannt (rohes, kanonisches Target) – sonst 404/405
//   3. Content-Length vorab gegen MAX_BODY_BYTES – sonst 413, ohne zu lesen
//   4. Dienst-Token (konstante Zeit, jeder Listeneintrag) – vor dem ersten
//      Body-Byte: Ohne Token lässt sich der Dienst nichts puffern
//   5. Body roh lesen, gestreamtes hartes Limit – sonst 413
//   6. Akteursbestätigung gegen tatsächliche Methode, rohes Target, Body-Hash
//   7. jti einmalig
//   8. Mandantenbindung (ADR §3.3) – sonst 404
//   9. erst jetzt Pfadparameter, Query und JSON lesen und validieren
//  10. Route in genau einer Tenant-Transaktion (`mitTenant`)
// Jeder Authentifizierungsfehler (4, 6, 7) ergibt dieselbe Antwort
// `401 NICHT_AUTHENTIFIZIERT` mit `Connection: close`; der Grund steht nur im
// Log. Jede Antwort, bevor ein angekündigter Body gelesen wurde, schließt die
// Verbindung, damit der Rest nicht gelesen wird.
// =============================================================================

import { performance } from 'node:perf_hooks';
import { randomUUID, type KeyObject } from 'node:crypto';
import {
  AKTEUR_HEADER,
  DienstFehler,
  ENDPUNKTE,
  FEHLER_STATUS,
  MAX_BODY_BYTES,
  akteurAusClaims,
  bodySha256,
  parseJsonStrikt,
  pruefeAkteur,
  type Endpunkt,
  type Fehler,
  type PruefGrund,
} from '@tcms/contract';
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import { kuendigtBodyAn, leseBodyRoh, pruefeContentLength } from './body';
import { erzeugeTokenPruefung } from './dienst-token';
import type { JtiSpeicher } from './jti';
import { jsonLogger, type Logger, type LogWert } from './log';
import {
  MANDANT_PARAM,
  RoutenTabelle,
  bindeMandant,
  pruefeGegenRegister,
  type Methode,
  type Routen,
  type RoutenEintrag,
} from './routen';
import { pruefeZiel, roheAnfrage } from './ziel';

/**
 * Datenzugriff (ADR §4). `mitTenant` ist die einzige Implementierung des
 * Mandantenkontexts aus `@tcms/db`; der Dienst setzt nie selbst
 * `tcms.tenant_id`. `ping` prüft nur die Erreichbarkeit (Health) und braucht
 * keinen Tenant.
 */
export interface Datenzugriff<Tx = unknown> {
  mitTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

export interface AppKonfiguration {
  /** Gültige Dienst-Tokens (Rotation: mehrere gleichzeitig). */
  dienstTokens: readonly string[];
  /** Öffentliche Ed25519-Schlüssel je kid (`parseSchluesselListe`). */
  akteurSchluessel: ReadonlyMap<string, KeyObject>;
  version: string;
  /** Zeitlimit des DB-Pings im Health-Check, Standard 2000 ms. */
  healthZeitlimitMs?: number;
}

export interface AppDeps<Tx = unknown> {
  konfiguration: AppKonfiguration;
  uhr: { jetzt(): Date };
  jti: JtiSpeicher;
  daten: Datenzugriff<Tx>;
  /** Fachliche Routen; jede verlangt Dienst-Token und Akteursbestätigung. */
  routen?: (r: Routen<Tx>) => void;
  /**
   * Endpunktregister, gegen das die Routentabelle beim Aufbau geprüft wird
   * (Dienst: `ENDPUNKT_LISTE`, siehe `dienst.ts`). Abweichung → Start bricht ab.
   */
  register?: readonly Endpunkt[];
  log?: Logger;
}

export type AuthGrund = PruefGrund | 'DIENST_TOKEN' | 'AKTEUR_FEHLT' | 'JTI_WIEDERHOLT';

class AuthFehler extends Error {
  readonly grund: AuthGrund;
  constructor(grund: AuthGrund) {
    super('NICHT_AUTHENTIFIZIERT');
    this.grund = grund;
  }
}

class MethodeNichtErlaubt extends DienstFehler {
  readonly erlaubt: Methode[];
  constructor(erlaubt: Methode[]) {
    super('METHODE_NICHT_ERLAUBT');
    this.erlaubt = erlaubt;
  }
}

const GRUND_HEADER: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
const JSON_TYP = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const MAX_FELDER = 50;
const MAX_MELDUNGEN_JE_FELD = 20;
const MAX_MELDUNG_FELD = 300;
const MAX_MELDUNG = 500;

type Bindings = { incoming?: unknown };

/**
 * Baut die Routentabelle: eingebaute Routen (`health`, `ich`) und Fachrouten
 * aus dem Endpunktregister, mit `register` dagegen geprüft, danach eingefroren.
 */
export function baueRoutentabelle<Tx>(
  deps: Pick<AppDeps<Tx>, 'konfiguration' | 'daten' | 'routen' | 'register'>,
  log: Logger,
): RoutenTabelle<Tx> {
  const zeitlimitMs = deps.konfiguration.healthZeitlimitMs ?? 2000;
  const tabelle = new RoutenTabelle<Tx>();
  tabelle.eintragenOhneAkteur(ENDPUNKTE.health, async () => ({
    version: deps.konfiguration.version,
    datenbank: await pingeDatenbank(deps.daten, zeitlimitMs, log),
  }));
  tabelle.eintragenAusRegister(ENDPUNKTE.ich, async ({ akteur }) => {
    // `ich` liefert nur Personen; Systemakteure lässt schon die Routentabelle nicht zu.
    if (akteur.art === 'SYSTEM') throw new DienstFehler('NICHT_GEFUNDEN');
    return akteur;
  });
  deps.routen?.(tabelle.registrar());
  if (deps.register) pruefeGegenRegister(tabelle.eintraege(), deps.register);
  tabelle.einfrieren();
  return tabelle;
}

export function erzeugeApp<Tx = unknown>(deps: AppDeps<Tx>): Hono<{ Bindings: Bindings }> {
  const log = deps.log ?? jsonLogger();
  const tokenGueltig = erzeugeTokenPruefung(deps.konfiguration.dienstTokens);
  const schluessel = deps.konfiguration.akteurSchluessel;
  if (schluessel.size === 0) throw new Error('Akteursbestätigung: keine Schlüssel konfiguriert');
  const tabelle = baueRoutentabelle(deps, log);

  async function verarbeite(
    c: Context<{ Bindings: Bindings }>,
    requestId: string,
    felder: Record<string, LogWert>,
    zustand: { bodyGelesen: boolean },
  ): Promise<Response> {
    // 2. Methode und Pfad bekannt – ausschließlich auf der rohen Anfrage.
    const roh = roheAnfrage(c.env);
    if (!roh) throw new Error('Rohe Anfrage fehlt: Dienst nur über @hono/node-server betreiben');
    felder.methode = roh.methode.slice(0, 16);
    const ziel = pruefeZiel(roh.ziel, c.req.url);
    if (!ziel) throw new DienstFehler('NICHT_GEFUNDEN');
    const kandidaten = tabelle.suche(ziel.segmente);
    if (kandidaten.length === 0) throw new DienstFehler('NICHT_GEFUNDEN');
    const treffer = kandidaten.find((k) => k.eintrag.methode === roh.methode);
    if (!treffer) throw new MethodeNichtErlaubt(kandidaten.map((k) => k.eintrag.methode));
    const route = treffer.eintrag;
    felder.route = route.pfad;

    // 3. Content-Length vorab: zu groß → 413, ohne ein Body-Byte zu lesen.
    pruefeContentLength(c.req.raw, MAX_BODY_BYTES);

    // 4. Dienst-Token vor dem ersten Body-Byte.
    if (!tokenGueltig(c.req.raw.headers.get('authorization'))) throw new AuthFehler('DIENST_TOKEN');

    // 5. Body roh mit gestreamtem hartem Limit, bevor irgendetwas anderes ihn ansieht.
    const body = await leseBodyRoh(c.req.raw, MAX_BODY_BYTES);
    zustand.bodyGelesen = true;

    if (!route.akteur) {
      if (body.byteLength > 0 || ziel.query !== null) throw new DienstFehler('UNGUELTIG');
      return antwort(route.status, { ok: true, daten: await route.ohneAkteur!() }, requestId);
    }

    // 6. Akteursbestätigung gegen die tatsächlich empfangene Anfrage.
    const token = c.req.raw.headers.get(AKTEUR_HEADER);
    if (token === null) throw new AuthFehler('AKTEUR_FEHLT');
    const geprueft = pruefeAkteur(token, {
      schluessel,
      jetzt: deps.uhr.jetzt(),
      anfrage: { methode: roh.methode, pfad: roh.ziel, bodySha256: bodySha256(body) },
    });
    if (!geprueft.ok) throw new AuthFehler(geprueft.grund);

    // 7. jti einmalig (atomar im Speicher; Fehler des Speichers → 500, nie durchlassen).
    const { claims } = geprueft;
    if (!(await deps.jti.einmalig(claims.jti, new Date(claims.exp * 1000)))) {
      throw new AuthFehler('JTI_WIEDERHOLT');
    }
    const akteur = akteurAusClaims(claims);
    felder.tenantId = akteur.tenantId;
    felder.akteurId = akteur.id;
    felder.akteurArt = akteur.art;

    // 8. Mandantenbindung vor jeder Auswertung der Eingaben (404 statt 400).
    const mandantId = route.mandantGebunden ? (treffer.params[MANDANT_PARAM] ?? '') : null;
    bindeMandant(akteur, mandantId, route.portal);
    if (mandantId !== null) felder.mandantId = mandantId;

    // 9. Erst jetzt Pfadparameter (Schema aus dem Register), Query und JSON.
    route.params?.parse(treffer.params);
    const query = leseQuery(route, ziel.query);
    const eingabe = leseJson(route, body, c.req.raw.headers.get('content-type'));

    // 10. Route in genau einer Tenant-Transaktion.
    const jetzt = deps.uhr.jetzt();
    const daten = await deps.daten.mitTenant(akteur.tenantId, (tx) =>
      route.handler({ tx, akteur, params: treffer.params, body: eingabe, query, requestId, jetzt }),
    );
    return antwort(route.status, { ok: true, daten }, requestId);
  }

  const app = new Hono<{ Bindings: Bindings }>();
  app.all('*', async (c) => {
    // 1. Request-ID: immer selbst erzeugt, nie vom Aufrufer übernommen.
    const requestId = randomUUID();
    const beginn = performance.now();
    const felder: Record<string, LogWert> = { requestId };
    const zustand = { bodyGelesen: false };
    let res: Response;
    try {
      res = await verarbeite(c, requestId, felder, zustand);
    } catch (e) {
      const schliessen = !zustand.bodyGelesen && kuendigtBodyAn(c.req.raw);
      res = fehlerAntwort(e, requestId, felder, schliessen);
    }
    felder.status = res.status;
    felder.dauerMs = Math.round(performance.now() - beginn);
    const stufe = res.status >= 500 ? 'error' : res.status === 401 ? 'warn' : 'info';
    log.schreibe(stufe, 'anfrage', felder);
    return res;
  });
  app.onError((e) => {
    log.schreibe('error', 'unbehandelt', { fehler: e instanceof Error ? e.name : 'unbekannt' });
    return antwort(500, { ok: false, fehler: { code: 'INTERN' } }, 'unbekannt');
  });
  return app;
}

function antwort(
  status: number,
  body: unknown,
  requestId: string,
  zusatz: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(GRUND_HEADER);
  headers.set('x-request-id', requestId);
  for (const [name, wert] of Object.entries(zusatz)) headers.set(name, wert);
  return new Response(JSON.stringify(body), { status, headers });
}

function fehler(
  status: number,
  f: Fehler,
  requestId: string,
  zusatz?: Readonly<Record<string, string>>,
) {
  return antwort(status, { ok: false, fehler: f }, requestId, zusatz);
}

const SCHLIESSEN: Readonly<Record<string, string>> = { connection: 'close' };

/**
 * Übersetzt jeden Fehler in den Umschlag; Details nur ins Log. `schliessen`:
 * Ein angekündigter Body wurde nicht (ganz) gelesen – Verbindung schließen,
 * damit der Rest nicht gelesen wird.
 */
function fehlerAntwort(
  e: unknown,
  requestId: string,
  felder: Record<string, LogWert>,
  schliessen: boolean,
): Response {
  const zusatz = schliessen ? SCHLIESSEN : {};
  if (e instanceof AuthFehler) {
    felder.grund = e.grund;
    // Immer `Connection: close`: sonst verriete der Header, ob das Token
    // (Body ungelesen) oder erst die Bestätigung (Body gelesen) scheiterte.
    return fehler(401, { code: 'NICHT_AUTHENTIFIZIERT' }, requestId, SCHLIESSEN);
  }
  if (e instanceof MethodeNichtErlaubt) {
    return fehler(405, { code: e.code }, requestId, { ...zusatz, allow: e.erlaubt.join(', ') });
  }
  if (e instanceof DienstFehler) {
    const f: Fehler = { code: e.code };
    if (e.message !== e.code) f.meldung = e.message.slice(0, MAX_MELDUNG);
    if (e.felder) f.felder = begrenzeFelder(Object.entries(e.felder));
    felder.fehler = e.code;
    // Nach 413 immer schließen, auch ohne angekündigte Länge (gestreamter Body).
    return fehler(FEHLER_STATUS[e.code], f, requestId, e.code === 'ZU_GROSS' ? SCHLIESSEN : zusatz);
  }
  if (e instanceof ZodError) {
    felder.fehler = 'UNGUELTIG';
    return fehler(400, { code: 'UNGUELTIG', felder: felderAusZod(e) }, requestId, zusatz);
  }
  felder.fehler = 'INTERN';
  felder.ausnahme = e instanceof Error ? e.name : typeof e;
  felder.stack = e instanceof Error && e.stack ? e.stack : null;
  return fehler(500, { code: 'INTERN' }, requestId, zusatz);
}

function felderAusZod(e: ZodError): Record<string, string[]> {
  const felder = new Map<string, string[]>();
  for (const issue of e.issues) {
    const pfad = issue.path.map(String).join('.') || '_';
    const liste = felder.get(pfad) ?? [];
    liste.push(issue.message);
    felder.set(pfad, liste);
  }
  return begrenzeFelder([...felder]);
}

/** Begrenzt `felder` auf die Grenzen von `FehlerSchema`; ohne Prototyp-Fallen. */
function begrenzeFelder(eintraege: [string, string[]][]): Record<string, string[]> {
  return Object.fromEntries(
    eintraege
      .slice(0, MAX_FELDER)
      .map(([pfad, meldungen]) => [
        pfad.slice(0, MAX_MELDUNG_FELD),
        meldungen.slice(0, MAX_MELDUNGEN_JE_FELD).map((m) => m.slice(0, MAX_MELDUNG_FELD)),
      ]),
  );
}

function leseQuery<Tx>(route: RoutenEintrag<Tx>, query: string | null): unknown {
  if (!route.query) {
    if (query !== null) throw new DienstFehler('UNGUELTIG', 'Diese Route nimmt keine Query an.');
    return undefined;
  }
  const werte = new Map<string, string>();
  for (const [name, wert] of new URLSearchParams(query ?? '')) {
    if (werte.has(name) || name === '__proto__') {
      throw new DienstFehler('UNGUELTIG', 'Query-Parameter doppelt oder unzulässig.');
    }
    werte.set(name, wert);
  }
  return route.query.parse(Object.fromEntries(werte));
}

function leseJson<Tx>(route: RoutenEintrag<Tx>, body: Uint8Array, typ: string | null): unknown {
  if (!route.body) {
    if (body.byteLength > 0)
      throw new DienstFehler('UNGUELTIG', 'Diese Route nimmt keinen Body an.');
    return undefined;
  }
  if (typ === null || !JSON_TYP.test(typ)) {
    throw new DienstFehler('UNGUELTIG', 'Content-Type muss application/json sein.');
  }
  const json = parseJsonStrikt(body);
  if (!json.ok) throw new DienstFehler('UNGUELTIG', 'Body ist kein gültiges JSON.');
  return route.body.parse(json.wert);
}

async function pingeDatenbank<Tx>(
  daten: Datenzugriff<Tx>,
  zeitlimitMs: number,
  log: Logger,
): Promise<'ok' | 'fehler'> {
  let timer: NodeJS.Timeout | undefined;
  const zeitlimit = new Promise<'fehler'>((resolve) => {
    timer = setTimeout(() => resolve('fehler'), zeitlimitMs);
  });
  try {
    const ergebnis = await Promise.race([daten.ping().then(() => 'ok' as const), zeitlimit]);
    if (ergebnis !== 'ok') log.schreibe('warn', 'health_db_zeitlimit', { zeitlimitMs });
    return ergebnis;
  } catch (e) {
    log.schreibe('warn', 'health_db_fehler', { fehler: e instanceof Error ? e.name : 'unbekannt' });
    return 'fehler';
  } finally {
    clearTimeout(timer);
  }
}
