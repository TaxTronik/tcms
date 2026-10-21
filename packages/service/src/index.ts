// =============================================================================
// @tcms/service – Kern der Fachoperationen (ADR 0001 §2). Dienst (apps/api)
// und Demo-Oberfläche (apps/web) rufen ausschließlich diese Funktionen; beide
// enthalten keine Fachregeln.
// =============================================================================

export {
  echteUhr,
  imDienst,
  imSystemdienst,
  kalendertag,
  keinPersonenVerzeichnis,
  normalisiereAkteur,
  personAkteur,
  systemAkteur,
  ZEITZONE,
  type DienstKontext,
  type DienstPorts,
  type NachweisAblage,
  type NachweisEingang,
  type NachweisVerweis,
  type PersonenVerzeichnis,
  type SystemKontext,
  type SystemPorts,
  type Uhr,
} from './kontext';
export {
  brauchtCodeSchluessel,
  erzeugeCodeSchluessel,
  MIN_CODE_SCHLUESSEL,
  type CodeSchluessel,
} from './bereiche/programm-beschreibung/code';
export { pruefeVerweis, verweisAblage, VERWEIS_GRENZEN } from './ablage';
export { AUDIT_SYSTEM_PRAEFIX, mitAudit, type AuditKontext, type Protokoll } from './audit';
export { ladeKontaktRollen } from './rollen';
export {
  aktiveRollen,
  auswirkungBeimAnlegen,
  beteiligteVon,
  gleicheId,
  istBerufstraeger,
  istGesetzlicherVertreter,
  kannBearbeiten,
  kannDurchfuehren,
  kannGegenzeichnen,
  kannLesen,
  kannPortalLesen,
  kannVertraulichLesen,
  kannVerwalten,
  kannVerwerfenBestaetigen,
  kannWuerdigen,
  mandantBezug,
  zweitePerson,
  type Auswirkung,
  type Entscheidung,
  type KontaktRolle,
  type KontrollZustaendigkeit,
  type MandantRolle,
} from './rechte';
export * from './bereiche/durchfuehrung';
export * from './bereiche/risiken-kontrollen';
export * from './bereiche/feststellungen-ereignisse';
export * from './bereiche/programm-beschreibung';
export * from './bereiche/lesepfade';
