// =============================================================================
// Fachoperationen und Lader des Bereichs „lesepfade" (Welle 2) sowie der
// gemeinsame Kern aller Bereiche (`../kern`): Tax-CMS-Kontext, Nummernkreise,
// Stichtag-Helfer. Export über diese Datei, weil `src/index.ts` nur die
// Bereichsdateien re-exportiert.
// =============================================================================

export {
  ladeKontext,
  VERTRAULICH_MASKE,
  type BeschreibungView,
  type DurchfuehrungView,
  type EreignisView,
  type FeststellungView,
  type KennzahlDef,
  type KontaktRolleView,
  type KontrolleView,
  type LandView,
  type RisikoView,
  type Schritt,
  type TcmsKontext,
} from '../kern/tcms-kontext';
export {
  naechsteEreignisnummer,
  naechsteEreignisnummern,
  naechsteFeststellungsnummer,
  naechsteWiedervorlageNr,
} from '../kern/nummern';
export { auditGrenze, heuteDatum, leseStand, tagAlsDatum, tagesende } from '../kern/zeit';
export { kontextAlsAntwort, kontextRechte, leseKontext } from './lesepfade/kontext';
