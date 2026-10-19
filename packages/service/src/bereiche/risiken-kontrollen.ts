// =============================================================================
// Fachoperationen und Lader des Bereichs „risiken-kontrollen" (Welle 2):
// Risikoinventar, Kontrollmatrix, Geschäftsprofil. Implementierung im Ordner
// `./risiken-kontrollen/`; diese Datei legt die öffentliche Schnittstelle fest
// (über `src/index.ts` als `@tcms/service` exportiert).
// =============================================================================

export {
  ladeKontrolle,
  ladeKontrollen,
  ladeProfil,
  ladeRisiken,
  ladeRisiko,
} from './risiken-kontrollen/lesen';
export {
  risikenFreigeben,
  risikenZurFreigabe,
  risikoakzeptanzAnfordern,
  risikoBewertungBestaetigen,
  risikoNeuBewerten,
  risikoZurueckweisen,
  uebersteuerungBeantragen,
  uebersteuerungEntscheiden,
} from './risiken-kontrollen/risiken';
export {
  designBeurteilen,
  frequenzAbweichungAufheben,
  frequenzAbweichungBeantragen,
  frequenzAbweichungEntscheiden,
  verantwortlicheAendern,
} from './risiken-kontrollen/kontrollen';
export { profilAendern, vorgeschlagenesRisikoAufnehmen } from './risiken-kontrollen/profil';
/** Antragsteller:in einer offenen Frequenzabweichung aus den Kontrollständen (Vier-Augen). */
export { antragDerAbweichung as antragDerFrequenzAbweichung } from './risiken-kontrollen/planung';
