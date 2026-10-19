// =============================================================================
// Geordnetes Beenden des Dienstes (Betriebsschnittstelle, Stufe 2): Auf
// SIGTERM nimmt der Server keine neuen Verbindungen mehr an, laufende Anfragen
// dürfen bis zu einer Frist (Standard 20 s) zu Ende laufen, ruhende
// Keep-alive-Verbindungen werden sofort und danach regelmäßig geschlossen.
// Danach räumt der Dienst auf (jti-Aufräumen, Pool) und endet mit 0; wird die
// Frist überschritten, schließt er alle Verbindungen und endet mit 1.
// =============================================================================

import type { Logger } from './log';

/** Frist für laufende Anfragen nach SIGTERM (Schnittstelle: höchstens 20 s). */
export const BEENDEN_FRIST_MS = 20_000;

export interface BeendenOptionen {
  server: {
    close(callback?: (fehler?: Error) => void): unknown;
    closeIdleConnections(): void;
    closeAllConnections(): void;
  };
  log: Logger;
  /** Aufräumen nach dem letzten Abschluss (Pool schließen, Timer stoppen). */
  aufraeumen: () => Promise<void>;
  /** Prozessende (Standard `process.exit`; Tests injizieren). */
  ende: (code: number) => void;
  fristMs?: number;
  /** Abstand, in dem ruhende Verbindungen geschlossen werden. */
  intervallMs?: number;
}

/** Liefert die Signalbehandlung; jeder weitere Aufruf nach dem ersten wird ignoriert. */
export function geordnetBeenden(opts: BeendenOptionen): (signal: string) => void {
  const fristMs = opts.fristMs ?? BEENDEN_FRIST_MS;
  const intervallMs = opts.intervallMs ?? 250;
  let begonnen = false;
  let beendet = false;
  const einmalEnde = (code: number) => {
    if (beendet) return;
    beendet = true;
    opts.ende(code);
  };
  return (signal) => {
    if (begonnen) return;
    begonnen = true;
    opts.log.schreibe('info', 'beende', { signal, fristMs });
    // Ruhende Keep-alive-Verbindungen halten `close` sonst bis zu ihrem Timeout offen.
    const ruhendeSchliessen = setInterval(() => opts.server.closeIdleConnections(), intervallMs);
    ruhendeSchliessen.unref();
    const frist = setTimeout(() => {
      clearInterval(ruhendeSchliessen);
      opts.log.schreibe('warn', 'beende_erzwungen', { fristMs });
      opts.server.closeAllConnections();
      void opts.aufraeumen().finally(() => einmalEnde(1));
    }, fristMs);
    frist.unref();
    opts.server.close(() => {
      clearInterval(ruhendeSchliessen);
      clearTimeout(frist);
      void opts.aufraeumen().then(
        () => einmalEnde(0),
        (e: unknown) => {
          opts.log.schreibe('error', 'beende_aufraeumen_fehlgeschlagen', {
            fehler: e instanceof Error ? e.name : 'unbekannt',
          });
          einmalEnde(1);
        },
      );
    });
    opts.server.closeIdleConnections();
  };
}
