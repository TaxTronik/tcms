// =============================================================================
// Geordnetes Beenden des Dienstes (Betriebsschnittstelle, Stufe 2): Auf
// SIGTERM nimmt der Server keine neuen Verbindungen mehr an, laufende Anfragen
// dürfen bis zu einer Frist (Standard 20 s) zu Ende laufen, ruhende
// Keep-alive-Verbindungen werden sofort und danach regelmäßig geschlossen.
// Danach räumt der Dienst auf (jti-Aufräumen, Pool) und endet mit 0.
//
// Die Frist gilt für Anfragen und Aufräumen zusammen: Läuft sie ab, bevor
// beides fertig ist (hängende Anfrage oder ein Pool, dessen Verbindung an der
// Datenbank hängt), schließt der Dienst alle Verbindungen, gibt dem Aufräumen
// noch höchstens `aufraeumFristMs` (Standard 2 s) und endet mit 1. Aufgeräumt
// wird genau einmal (ein zweites `pool.end()` würde abgewiesen).
// =============================================================================

import type { Logger } from './log';

/** Frist für laufende Anfragen nach SIGTERM (Schnittstelle: höchstens 20 s). */
export const BEENDEN_FRIST_MS = 20_000;
/** Zeit, die das Aufräumen nach Ablauf der Frist noch bekommt. */
export const AUFRAEUMEN_FRIST_MS = 2_000;

export interface BeendenOptionen {
  server: {
    close(callback?: (fehler?: Error) => void): unknown;
    closeIdleConnections(): void;
    closeAllConnections(): void;
  };
  log: Logger;
  /** Aufräumen nach dem letzten Abschluss (Pool schließen, Timer stoppen); läuft genau einmal. */
  aufraeumen: () => Promise<void>;
  /** Prozessende (Standard `process.exit`; Tests injizieren). */
  ende: (code: number) => void;
  fristMs?: number;
  /** Zeit für das Aufräumen nach Ablauf der Frist. */
  aufraeumFristMs?: number;
  /** Abstand, in dem ruhende Verbindungen geschlossen werden. */
  intervallMs?: number;
}

/** Liefert die Signalbehandlung; jeder weitere Aufruf nach dem ersten wird ignoriert. */
export function geordnetBeenden(opts: BeendenOptionen): (signal: string) => void {
  const fristMs = opts.fristMs ?? BEENDEN_FRIST_MS;
  const aufraeumFristMs = opts.aufraeumFristMs ?? AUFRAEUMEN_FRIST_MS;
  const intervallMs = opts.intervallMs ?? 250;
  let begonnen = false;
  let beendet = false;
  const einmalEnde = (code: number) => {
    if (beendet) return;
    beendet = true;
    opts.ende(code);
  };
  // Genau ein Aufräumen, gleich aus welchem Pfad; Ergebnis ohne Ausnahme.
  let aufraeumen: Promise<'ok' | 'fehler'> | null = null;
  const raeumeAuf = () =>
    (aufraeumen ??= Promise.resolve()
      .then(() => opts.aufraeumen())
      .then(
        () => 'ok' as const,
        (e: unknown) => {
          opts.log.schreibe('error', 'beende_aufraeumen_fehlgeschlagen', {
            fehler: e instanceof Error ? e.name : 'unbekannt',
          });
          return 'fehler' as const;
        },
      ));
  return (signal) => {
    if (begonnen) return;
    begonnen = true;
    let serverGeschlossen = false;
    let erzwungen = false;
    opts.log.schreibe('info', 'beende', { signal, fristMs });
    // Ruhende Keep-alive-Verbindungen halten `close` sonst bis zu ihrem Timeout offen.
    const ruhendeSchliessen = setInterval(() => opts.server.closeIdleConnections(), intervallMs);
    ruhendeSchliessen.unref();
    const frist = setTimeout(() => {
      erzwungen = true;
      clearInterval(ruhendeSchliessen);
      opts.log.schreibe('warn', 'beende_erzwungen', {
        fristMs,
        phase: serverGeschlossen ? 'aufraeumen' : 'anfragen',
      });
      opts.server.closeAllConnections();
      // Das Aufräumen bekommt noch eine kurze Frist; danach endet der Prozess
      // in jedem Fall (ein hängender `pool.end()` hält ihn nicht auf).
      const schluss = setTimeout(() => einmalEnde(1), aufraeumFristMs);
      schluss.unref();
      void raeumeAuf().then(() => {
        clearTimeout(schluss);
        einmalEnde(1);
      });
    }, fristMs);
    frist.unref();
    opts.server.close(() => {
      serverGeschlossen = true;
      clearInterval(ruhendeSchliessen);
      // Die Frist bleibt scharf, bis das Aufräumen fertig ist.
      void raeumeAuf().then((ergebnis) => {
        // Nach Ablauf der Frist entscheidet allein der erzwungene Pfad (Exit 1).
        if (erzwungen) return;
        clearTimeout(frist);
        einmalEnde(ergebnis === 'ok' ? 0 : 1);
      });
    });
    opts.server.closeIdleConnections();
  };
}
