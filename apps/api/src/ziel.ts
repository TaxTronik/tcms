// =============================================================================
// Rohe Anfrage: Methode und Request-Target, wie sie auf der Leitung ankamen.
//
// `@hono/node-server` baut `request.url` mit dem WHATWG-URL-Parser: `..`/`.`
// (auch als `%2e`) werden aufgelöst, `\` wird zu `/`, absolute Targets
// (`GET http://host/…`) werden übernommen. Routing und Akteursbindung dürfen
// sich darauf nicht stützen: Eine signierte Bestätigung für einen Pfad könnte
// sonst eine andere Route treffen. Der Dienst arbeitet deshalb nur auf dem
// rohen Target (`incoming.url`) und weist jedes nicht kanonische Target mit 404
// ab, bevor der Body gelesen wird.
// =============================================================================

import { AnfrageBindungSchema } from '@tcms/contract';

/** Feste Segmente: nur unreservierte Zeichen ohne Punkt und ohne Prozentkodierung. */
const PFAD = /^(?:\/[A-Za-z0-9_~-]+)+$/;
/** Query: RFC 3986 `query`, Prozentkodierung nur vollständig. */
const QUERY = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})+$/;
const MAX_ZIEL = AnfrageBindungSchema.shape.p.maxLength ?? 2048;

export interface RoheAnfrage {
  /** Methode wie vom HTTP-Parser geliefert. */
  methode: string;
  /** Request-Target wie empfangen (Pfad und Query). */
  ziel: string;
}

/**
 * Liest Methode und Target aus den Node-Bindings (`c.env.incoming`). Fehlen
 * sie, gibt es keine rohe Anfrage: `null` (der Aufrufer weist ab).
 */
export function roheAnfrage(env: unknown): RoheAnfrage | null {
  const incoming = (env as { incoming?: { url?: unknown; method?: unknown } } | undefined)
    ?.incoming;
  if (typeof incoming?.url !== 'string' || typeof incoming.method !== 'string') return null;
  return { methode: incoming.method, ziel: incoming.url };
}

export interface KanonischesZiel {
  /** Pfadsegmente ohne führenden Schrägstrich. */
  segmente: string[];
  /** Query ohne `?`, `null` ohne Query. */
  query: string | null;
}

/**
 * Prüft das rohe Target. Kanonisch heißt: beginnt mit `/`, nur Segmente aus
 * `[A-Za-z0-9_~-]` (also keine leeren Segmente, kein `.`/`..`, kein `%`, kein
 * `\`, kein abschließender Schrägstrich), höchstens eine nicht leere Query mit
 * RFC-3986-Zeichen, insgesamt höchstens 2048 Zeichen (Grenze von `req.p`), und
 * der URL-Parser des Adapters kommt zu exakt demselben Pfad samt Query.
 */
export function pruefeZiel(ziel: string, requestUrl: string): KanonischesZiel | null {
  if (ziel.length === 0 || ziel.length > MAX_ZIEL) return null;
  const frage = ziel.indexOf('?');
  const pfad = frage === -1 ? ziel : ziel.slice(0, frage);
  const query = frage === -1 ? null : ziel.slice(frage + 1);
  if (!PFAD.test(pfad)) return null;
  if (query !== null && !QUERY.test(query)) return null;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (`${url.pathname}${url.search}` !== ziel) return null;
  return { segmente: pfad.slice(1).split('/'), query };
}
