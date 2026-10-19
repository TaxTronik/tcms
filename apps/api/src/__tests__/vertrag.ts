// =============================================================================
// Vertragsprüfung der Antworten in allen API-Tests (gemeinsamer Helfer).
//
// `aufbau()` (hilfen.ts) schaltet sie für jede Test-App ein: Jede Antwort, die
// über `app.fetch` bzw. `app.request` läuft, wird gegen den Vertrag geprüft –
//   - Erfolg (2xx): Umschlag `{ ok: true, daten }` streng, Status gleich
//     `erfolgStatus` und `daten` gegen `antwortSchema` des Registereintrags,
//     aus dem die getroffene Route entstand (dieselbe Routentabelle wie die
//     App, also genau die Route, die geantwortet hat);
//   - Fehler: Umschlag `{ ok: false, fehler }` gegen `FehlerSchema`.
// Eine Verletzung wirft `VertragsVerletzung` im Test (nur Endpunkt, Pfade und
// Codes der zod-Befunde, keine Werte). Freie Testrouten ohne Registereintrag
// (app.test.ts) prüfen nur den Umschlag.
//
// `TCMS_VERTRAG_ABDECKUNG=<datei>` hängt je geprüfter Erfolgsantwort den
// Endpunktnamen an (Abdeckung über alle Testdateien, Auswertung von Hand).
// =============================================================================

import { appendFileSync } from 'node:fs';
import { FehlerSchema, type Endpunkt } from '@tcms/contract';
import { z } from 'zod';
import type { RoutenTabelle } from '../routen';

const ERFOLG = z.object({ ok: z.literal(true), daten: z.unknown() }).strict();
const FEHLER = z.object({ ok: z.literal(false), fehler: FehlerSchema }).strict();

export class VertragsVerletzung extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'VertragsVerletzung';
  }
}

const befunde = (e: z.ZodError) =>
  e.issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join('.') || '(wurzel)'}: ${i.code}`)
    .join('; ');

/**
 * Prüft eine Antwort gegen den Vertrag. `endpunkt` ist der Registereintrag der
 * Route, die geantwortet hat (`undefined` für freie Testrouten).
 */
export function pruefeAntwortGegenVertrag(
  endpunkt: Endpunkt | undefined,
  status: number,
  json: unknown,
  wo: string,
): void {
  if (status >= 200 && status < 300) {
    const umschlag = ERFOLG.safeParse(json);
    if (!umschlag.success) {
      throw new VertragsVerletzung(`${wo}: Erfolgsumschlag ungültig (${befunde(umschlag.error)})`);
    }
    if (!endpunkt) return;
    if (status !== endpunkt.erfolgStatus) {
      throw new VertragsVerletzung(
        `${wo}: Status ${status} statt ${endpunkt.erfolgStatus} (${endpunkt.name})`,
      );
    }
    const daten = endpunkt.antwortSchema.safeParse(umschlag.data.daten);
    if (!daten.success) {
      throw new VertragsVerletzung(
        `${wo}: Antwort verletzt antwortSchema von ${endpunkt.name} (${befunde(daten.error)})`,
      );
    }
    const datei = process.env.TCMS_VERTRAG_ABDECKUNG;
    if (datei) appendFileSync(datei, `${endpunkt.name}\n`);
    return;
  }
  const fehler = FEHLER.safeParse(json);
  if (!fehler.success) {
    throw new VertragsVerletzung(`${wo}: Fehlerumschlag ungültig (${befunde(fehler.error)})`);
  }
}

type Fetch = (anfrage: Request, ...rest: never[]) => Response | Promise<Response>;

/**
 * Hängt die Vertragsprüfung an `app.fetch` (auch `app.request` läuft darüber).
 * `tabelle` ist eine mit denselben Routen gebaute Routentabelle.
 */
export function mitVertragspruefung<A extends { fetch: Fetch }>(
  app: A,
  tabelle: RoutenTabelle<unknown>,
): A {
  const original = app.fetch.bind(app) as (
    anfrage: Request,
    ...rest: unknown[]
  ) => Promise<Response>;
  const geprueft = async (anfrage: Request, ...rest: unknown[]): Promise<Response> => {
    const env = rest[0];
    const antwort = await original(anfrage, ...rest);
    const roh = (env as { incoming?: { url?: unknown; method?: unknown } } | undefined)?.incoming;
    const methode = typeof roh?.method === 'string' ? roh.method : anfrage.method;
    const ziel = typeof roh?.url === 'string' ? roh.url : new URL(anfrage.url).pathname;
    const pfad = ziel.split('?')[0] ?? '';
    const wo = `${methode} ${pfad}`;
    // HEAD-Antworten haben nach HTTP keinen Body (405 an den Dienst, app.test.ts).
    if (methode === 'HEAD') return antwort;
    let json: unknown;
    try {
      json = JSON.parse(await antwort.clone().text());
    } catch {
      throw new VertragsVerletzung(`${wo}: Antwort ist kein JSON`);
    }
    const treffer = pfad.startsWith('/')
      ? tabelle.suche(pfad.slice(1).split('/')).find((t) => t.eintrag.methode === methode)
      : undefined;
    pruefeAntwortGegenVertrag(treffer?.eintrag.endpunkt, antwort.status, json, wo);
    return antwort;
  };
  app.fetch = geprueft as unknown as A['fetch'];
  return app;
}
