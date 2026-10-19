// =============================================================================
// Strukturiertes Log: eine JSON-Zeile je Ereignis auf stdout.
//
// Nur skalare Felder, damit nie versehentlich Objekte (Body, Header, Claims)
// im Log landen. Aufrufer loggen keine Header-Werte, keine Bodys, keine Namen,
// nur IDs, Codes und Routenmuster.
// =============================================================================

export const LOG_STUFEN = ['info', 'warn', 'error'] as const;
export type LogStufe = (typeof LOG_STUFEN)[number];
export type LogWert = string | number | boolean | null;

export interface Logger {
  schreibe(stufe: LogStufe, ereignis: string, felder?: Readonly<Record<string, LogWert>>): void;
}

/** JSON-Zeilen ab `mindestens` (`TCMS_LOG_LEVEL`, Standard `info`). */
export function jsonLogger(
  ausgabe: (zeile: string) => void = (zeile) => {
    process.stdout.write(`${zeile}\n`);
  },
  uhr: () => Date = () => new Date(),
  mindestens: LogStufe = 'info',
): Logger {
  const schwelle = LOG_STUFEN.indexOf(mindestens);
  return {
    schreibe(stufe, ereignis, felder = {}) {
      if (LOG_STUFEN.indexOf(stufe) < schwelle) return;
      // Feste Felder vorn; gleichnamige Aufruferfelder werden verworfen.
      const zeile: Record<string, LogWert> = { zeit: uhr().toISOString(), stufe, ereignis };
      for (const [name, wert] of Object.entries(felder)) {
        if (!(name in zeile)) zeile[name] = wert;
      }
      ausgabe(JSON.stringify(zeile));
    },
  };
}
