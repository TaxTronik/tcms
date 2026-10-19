// =============================================================================
// Fachoperationen und Lader des Bereichs „programm-beschreibung" (Welle 2):
// Einrichtungsassistent, CMS-Beschreibung, Freigaben (Kanzlei und Portal),
// Kommunikation und Postausgang. Umsetzung im Ordner `programm-beschreibung/`;
// hier nur die öffentliche Schnittstelle (Namen bereichseindeutig, weil
// `src/index.ts` alle Bereiche re-exportiert).
// =============================================================================

export {
  ladeEinrichtung,
  legeProgrammAn,
  speichereEinrichtungsschritt,
} from './programm-beschreibung/einrichtung';
export {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  leseNachrichtAdresse,
  nachrichtAdresse,
} from './programm-beschreibung/nachrichten';
export {
  appetitAusZielen,
  AufbauFehler,
  aufbauRollen,
  berechnePlan,
  nimmRisikoAuf,
  pruefeKontrollZustaendigkeiten,
  standardKontrollZustaendigkeit,
  type AufbauAufnahmeErgebnis,
  type AufbauPerson,
  type AufbauPlan,
  type AufbauPlanKontrolle,
  type AufbauPlanRisiko,
  type AufbauRollen,
  type AufbauUmfeld,
  type AufbauZustaendigkeit,
} from './programm-beschreibung/aufbau';
export {
  leseEinrichtungsProfil,
  leseEntwurf,
  mindestEnde,
  neuerEntwurf,
  pruefeEinrichtungsProfil,
  pruefeSchritt1,
  pruefeSchritt2,
  pruefeSchritt3,
  pruefeSchritt4,
  risikoEntscheidung,
  standardZeitraum,
} from './programm-beschreibung/entwurf';
