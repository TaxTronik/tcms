// =============================================================================
// Grenzen der HTTP-Verbindungen des Dienstes (langsame Clients, ADR 0001 §8).
//
// Node prüft `headersTimeout` und `requestTimeout` nur im Raster von
// `connectionsCheckingInterval` (Standard 30 s): Ohne kürzeres Raster blieb
// eine Verbindung mit unvollständigen Headern bis zu rund 40 s statt 10 s
// offen, eine mit unvollständigem Body bis zu rund 60 s statt 30 s – vor jeder
// Authentifizierung erreichbar. Das Raster von 1 s hält beide Fristen auf
// höchstens eine Sekunde genau ein. `maxConnections` begrenzt zusätzlich die
// Zahl gleichzeitig offener Verbindungen; weitere nimmt der Server an und
// schließt sie sofort.
// =============================================================================

/** Optionen für `http.createServer` (über `createAdaptorServer`). */
export const SERVER_OPTIONEN = Object.freeze({
  /** Header vollständig nach höchstens 10 s. */
  headersTimeout: 10_000,
  /** Ganze Anfrage (Header und Body) nach höchstens 30 s. */
  requestTimeout: 30_000,
  /** Prüfraster beider Fristen (Node-Standard 30 s). */
  connectionsCheckingInterval: 1_000,
});

/** Höchstzahl gleichzeitig offener Verbindungen (`server.maxConnections`). */
export const MAX_VERBINDUNGEN = 1_024;
