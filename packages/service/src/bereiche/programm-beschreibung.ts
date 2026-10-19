// =============================================================================
// Fachoperationen und Lader des Bereichs „programm-beschreibung" (Welle 2):
// Einrichtungsassistent, CMS-Beschreibung, Freigaben (Kanzlei und Portal),
// Kommunikation und Postausgang. Umsetzung im Ordner `programm-beschreibung/`;
// hier nur die öffentliche Schnittstelle (Namen bereichseindeutig, weil
// `src/index.ts` alle Bereiche re-exportiert).
// =============================================================================

export {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  leseNachrichtAdresse,
  nachrichtAdresse,
} from './programm-beschreibung/nachrichten';
