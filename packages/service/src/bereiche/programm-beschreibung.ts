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
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  ladeBeschreibung,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
  weiseBeschreibungsreviewZurueck,
} from './programm-beschreibung/beschreibung';
export {
  adressiereFreigabeNeu,
  bestaetigeKenntnisnahme,
  erteileFreigabe,
  fordereFreigabeCodeAn,
  FREIGABE_CODE_ARTEN,
  freigabeBrauchtCode,
  ladePortalFreigaben,
} from './programm-beschreibung/freigaben';
export { ladeFreigabenHistorie } from './programm-beschreibung/kommunikation';
export {
  bestaetigeNachrichtZustellung,
  ladeOffeneNachrichten,
  legeNachrichtAn,
  leseNachrichtAdresse,
  nachrichtAdresse,
} from './programm-beschreibung/nachrichten';
export {
  CODE_GUELTIG_TAGE as FREIGABE_CODE_GUELTIG_TAGE,
  MAX_FEHLVERSUCHE as FREIGABE_MAX_FEHLVERSUCHE,
} from './programm-beschreibung/code';
export {
  appetitAusZielen,
  aufbauRollen,
  berechnePlan,
  pruefeKontrollZustaendigkeiten,
  standardKontrollZustaendigkeit,
  type AufbauPerson,
  type AufbauPlan,
  type AufbauPlanKontrolle,
  type AufbauPlanRisiko,
  type AufbauRollen,
  type AufbauUmfeld,
  type AufbauZustaendigkeit,
} from './programm-beschreibung/aufbau';
export {
  leseEntwurf,
  mindestEnde,
  neuerEntwurf,
  pruefeSchritt1,
  pruefeSchritt2,
  pruefeSchritt3,
  pruefeSchritt4,
  risikoEntscheidung,
  standardZeitraum,
} from './programm-beschreibung/entwurf';
export {
  baueBausteine,
  baueSnapshot,
  beschreibungStatusZum,
  geruestAbschnitte,
  normalisiereAbschnitte,
  pruefeSnapshot,
  snapshotHash,
  type BausteinOptionen,
  type BeschreibungStatusWert,
} from './programm-beschreibung/bausteine';
