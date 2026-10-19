import 'server-only';

// =============================================================================
// Entwurfsstand des Einrichtungsassistenten (TcmsProgramm.setupEntwurf) für
// Serverseiten der Demo. Startwerte und Prüfungen je Schritt liegen in
// @tcms/service (ADR 0001 §2); Client-Komponenten nutzen `./anzeige`.
// =============================================================================

export {
  leseEntwurf,
  mindestEnde,
  neuerEntwurf,
  pruefeSchritt1,
  pruefeSchritt2,
  pruefeSchritt3,
  pruefeSchritt4,
  risikoEntscheidung as entscheidung,
  standardZeitraum,
} from '@tcms/service';
export {
  dauerText,
  SCHRITTE,
  type Appetit,
  type EntwurfKontrolle,
  type EntwurfRisiko,
  type EntwurfZiel,
  type ErklaerungsTurnus,
  type SetupEntwurf,
} from './anzeige';
