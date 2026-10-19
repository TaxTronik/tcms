// =============================================================================
// Daten der lebenden Bausteine der CMS-Beschreibung (Vertrag: BausteinSatzSchema
// in @tcms/contract). Die Struktur ist bewusst JSON-flach (Datumswerte als
// ISO-Strings, Personen als Namen und ID), damit derselbe Inhalt live aus dem
// Kontext gerendert und als Snapshot eingefroren werden kann.
// =============================================================================

import type { Abschnitt, BausteinArt, Design, GovernanceTyp, Klasse } from '@tcms/domain';

export interface TeilbereichDaten {
  name: string;
  abgrenzung: string;
  einschluesse: string[];
  ausschluesse: string[];
  zielLaender: string[];
  kanaele: string[];
}

export interface ZieleDaten {
  appetit: Klasse;
  ziele: {
    text: string;
    wesentlichkeitEur: number;
    risikoappetit: Klasse;
    freigabe: 'ENTWURF' | 'AUSSTEHEND' | 'FREIGEGEBEN';
    freigegebenAm: string | null;
    freigegebenVon: string | null;
    /** ID der freigebenden Person (für die kanzleikonsole; fehlt in älteren Snapshots). */
    freigegebenVonId?: string | null;
  }[];
}

export interface RisikoinventarDaten {
  appetit: Klasse;
  /** Netto-Sicht, die für den Appetit maßgeblich ist. */
  sicht: 'DESIGN' | 'BETRIEB';
  risiken: {
    code: string;
    titel: string;
    gt: GovernanceTyp;
    brutto: Klasse;
    netto: Klasse;
    ueberAppetit: boolean;
    kontrollen: number;
  }[];
}

export interface KontrollmatrixDaten {
  kontrollen: {
    code: string;
    titel: string;
    art: 'P' | 'D' | 'K';
    frequenz: string;
    partei: 'KANZLEI' | 'MANDANT';
    schluessel: boolean;
    design: Design;
    designVon: string | null;
    designVonId?: string | null;
    designAm: string | null;
    risikoCodes: string[];
  }[];
}

export interface VerantwortungDaten {
  rollen: { rolle: string; name: string; personId?: string | null }[];
  kontrollen: {
    code: string;
    titel: string;
    partei: 'KANZLEI' | 'MANDANT';
    durchfuehrend: string;
    vertretung: string;
    gegenzeichnung: string;
    durchfuehrendId?: string | null;
    vertretungId?: string | null;
    gegenzeichnungId?: string | null;
  }[];
}

export interface LaenderDaten {
  stand: string | null;
  summeLfd: number;
  summeVorjahr: number;
  schwelle: string;
  laender: {
    land: string;
    name: string;
    fernverkaeufeLfdEur: number;
    lagerSeit: string | null;
    oss: boolean;
    lokaleUstNr: boolean;
    registrierung: 'VOLLSTAENDIG' | 'FEHLT' | 'PRUEFEN';
  }[];
}

export interface FeststellungenDaten {
  feststellungen: {
    nummer: string;
    titel: string;
    schwere: Klasse;
    status: string;
    massnahmenOffen: number;
  }[];
}

export interface BausteinSatz {
  TEILBEREICH: TeilbereichDaten | null;
  ZIELE: ZieleDaten;
  RISIKOINVENTAR: RisikoinventarDaten;
  KONTROLLMATRIX: KontrollmatrixDaten;
  VERANTWORTUNG: VerantwortungDaten;
  LAENDER: LaenderDaten;
  FESTSTELLUNGEN: FeststellungenDaten;
}

/** Eingefrorener Inhalt einer Beschreibungsversion. */
export interface Snapshot {
  nummer: string;
  mandant: string;
  eingefroren: true;
  /** Datenstand der lebenden Bausteine (YYYY-MM-DD). */
  stand?: string;
  erzeugtAm?: string;
  abschnitte: Abschnitt[];
  /** Fehlt bei älteren Snapshots (nur Gliederung eingefroren). */
  bausteine?: Partial<BausteinSatz>;
}

export type BausteinQuelle =
  | { modus: 'live'; stand: string; satz: BausteinSatz }
  | { modus: 'snapshot'; stand: string | null; satz: Partial<BausteinSatz> | null };

export type { BausteinArt };
