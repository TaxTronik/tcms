// =============================================================================
// Rechte je Handlung der Kontrolldurchführung (bisher apps/web/src/server/
// durchfuehrung-daten.ts: rechteFuer). Reine Funktion über einen Lagestand,
// der in Operationen unter Zeilensperre gelesen wird (TS-05); dieselbe
// Funktion liefert die Flags für die Oberfläche (gesperrte Bedienelemente
// zeigen den Grund, AGENTS.md Regel 4).
//
// Jede Ablehnung trägt ihre Art:
//   - STATUS: Der Zustand erlaubt den Übergang nicht (Statusmodell, auch nach
//     einer gleichzeitigen Änderung) → `KONFLIKT` (409).
//   - RECHT: Die Person darf den Schritt nicht (Rolle, Vier-Augen) →
//     `NICHT_BERECHTIGT` (403) mit fachlichem Grund und maschinenlesbarem
//     Verweigerungsgrund (`verweigerung`, VERWEIGERUNG_GRUENDE im Vertrag).
// Sichtbarkeit (fremder Mandant, Portal ohne Zuweisung) wird vorher geprüft
// und ergibt `NICHT_GEFUNDEN`.
// =============================================================================

import type { Akteur, VerweigerungGrund } from '@tcms/contract';
import {
  addTage,
  fmtDatum,
  OFFENE_GESPEICHERTE_STATUS,
  type AnzeigeStatus,
  type DurchfuehrungStatus,
} from '@tcms/domain';
import {
  gleicheId,
  kannBearbeiten,
  kannDurchfuehren,
  kannGegenzeichnen,
  kannPortalLesen,
  kannWuerdigen,
  zweitePerson,
  aktiveRollen,
  type KontaktRolle,
  type KontrollZustaendigkeit,
} from '../../rechte';

export const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
export const KEIN_RECHT = 'Dieser Schritt ist zuständigen Personen vorbehalten.';
const VIER_AUGEN = 'Gegenzeichnung muss durch eine andere Person erfolgen (Vier-Augen-Prinzip)';

/** Bearbeitbare gespeicherte Status (Schritte, Werte, Nachweise). */
export const BEARBEITBAR: readonly DurchfuehrungStatus[] = ['IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'];
/** Offene gespeicherte Status (Statusmodell @tcms/domain). */
export const OFFEN: readonly DurchfuehrungStatus[] = OFFENE_GESPEICHERTE_STATUS;
export const ABGESCHLOSSEN: readonly DurchfuehrungStatus[] = ['OHNE_BEFUND', 'MIT_BEFUND'];

/**
 * Recht je Handlung. `art` (nur intern; nicht in den Flags): STATUS → 409,
 * RECHT → 403 mit `verweigerung` als `fehler.grund`.
 */
export type Recht =
  | { erlaubt: true; grund: null; art: null; verweigerung: null }
  | { erlaubt: false; grund: string; art: 'STATUS'; verweigerung: null }
  | { erlaubt: false; grund: string; art: 'RECHT'; verweigerung: VerweigerungGrund };

export type HandlungsRechte = Record<
  | 'beginnen'
  | 'bearbeiten'
  | 'gegenzeichnen'
  | 'mandantBestaetigen'
  | 'zurueckweisen'
  | 'entfallenBeantragen'
  | 'entfallenFreigeben'
  | 'entfallenAblehnen'
  | 'nachtrag',
  Recht
>;

/** Alles, was die Rechte einer Durchführung bestimmt (unter Sperre gelesen). */
export interface RechteLage {
  akteur: Akteur;
  rollen: readonly KontaktRolle[];
  mandantId: string;
  historisch: boolean;
  status: DurchfuehrungStatus;
  /** Status zum aktuellen Tag (heute laut Uhr). */
  anzeige: AnzeigeStatus;
  periodeBis: Date;
  zustaendigkeit: KontrollZustaendigkeit;
  durchgefuehrtVon: string | null;
  mandantBestaetigtVon: string | null;
  entfallenBegruendung: string | null;
  entfallenVon: string | null;
  /** Personen, die an der Durchführung mitgewirkt haben (Vier-Augen). */
  beteiligte: readonly string[];
  /** Anzeigenamen für Gründe (im Dienst leer). */
  name?: (id: string | null) => string | null;
}

const ja: Recht = Object.freeze({ erlaubt: true, grund: null, art: null, verweigerung: null });
const status = (grund: string): Recht => ({
  erlaubt: false,
  grund,
  art: 'STATUS',
  verweigerung: null,
});
const recht = (verweigerung: VerweigerungGrund, grund: string): Recht => ({
  erlaubt: false,
  grund,
  art: 'RECHT',
  verweigerung,
});

function statusGrund(s: DurchfuehrungStatus): string {
  switch (s) {
    case 'ZUR_GEGENZEICHNUNG':
      return 'Einreichung liegt vor — keine Änderung mehr möglich';
    case 'OHNE_BEFUND':
    case 'MIT_BEFUND':
      return 'Abgeschlossen — unveränderlich; Korrekturen entstehen als Nachtrag';
    case 'ENTFALLEN':
      return 'Entfallen — keine Änderung möglich';
    case 'GEPLANT':
      return 'Durchführung noch nicht begonnen';
    default:
      return 'In diesem Status nicht möglich';
  }
}

/**
 * Portal-Sichtbarkeit einer Kontrollaufgabe (P2): Mandantenkontakt mit aktiver
 * Rolle beim eigenen Mandanten, Kontrolle der Partei Mandant, und entweder
 * GV/TCB oder der Aufgabe zugewiesen (Durchführung, Vertretung,
 * Gegenzeichnung). Kanzleipersonen: nie (sie lesen über die Kanzlei-Sicht).
 */
export function darfPortalLesen(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
  k: Pick<
    KontrollZustaendigkeit,
    'partei' | 'durchfuehrendId' | 'vertretungId' | 'gegenzeichnerId'
  >,
): boolean {
  if (a.art !== 'MANDANT' || !gleicheId(a.mandantId, mandantId)) return false;
  if (k.partei !== 'MANDANT') return false;
  if (aktiveRollen(a, mandantId, rollen).size === 0) return false;
  if (kannPortalLesen(a, mandantId, rollen)) return true;
  return [k.durchfuehrendId, k.vertretungId, k.gegenzeichnerId].some((id) => gleicheId(a.id, id));
}

/** Anzeigestatus, in denen eine Durchführung der Partei Mandant als offene Aufgabe gilt. */
export const AUFGABE_OFFEN: ReadonlySet<AnzeigeStatus> = new Set<AnzeigeStatus>([
  'FAELLIG',
  'UEBERFAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZURUECKGEWIESEN',
]);
/** Geplante Durchführungen werden so viele Tage vor der Fälligkeit zur Aufgabe. */
export const AUFGABE_VORLAUF_TAGE = 30;

/** Was eine Durchführung zur offenen Mandantenaufgabe macht (Stand heute). */
export interface AufgabenStand {
  anzeige: AnzeigeStatus;
  faelligAm: Date;
  periodeBis: Date;
  durchgefuehrtVon: string | null;
  mandantBestaetigtVon: string | null;
}

export interface PortalAufgabe {
  art: 'DURCHFUEHREN' | 'BESTAETIGEN';
  /** Der Person zugewiesen (Vertrag: „eigene“), nicht „darf handeln“ – das prüft die Operation. */
  eigene: boolean;
}

/**
 * Offene Mandantenaufgabe einer Durchführung für einen Mandantenkontakt – eine
 * Regel für die Portal-Übersicht (P1) und die Aufgabenliste (P2), null, wenn
 * es keine ist oder die Person sie nicht sehen darf (`darfPortalLesen`):
 *   - DURCHFUEHREN: fällig, überfällig, in Arbeit oder zurückgewiesen, oder
 *     geplant mit Fälligkeit und Periodenende innerhalb von
 *     `AUFGABE_VORLAUF_TAGE`; eigene für durchführende Person und Vertretung.
 *   - BESTAETIGEN: zur Gegenzeichnung mit Bestätigung beim Mandanten, solange
 *     niemand bestätigt hat (`mandantBestaetigtVon`, Status bleibt bis zum
 *     Abschluss der Kanzlei); eigene für Gegenzeichnung oder Vertretung, nie
 *     für die einreichende Person.
 */
export function portalAufgabe(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
  k: KontrollZustaendigkeit,
  d: AufgabenStand,
  heute: Date,
): PortalAufgabe | null {
  if (!darfPortalLesen(a, mandantId, rollen, k)) return null;
  const horizont = addTage(heute, AUFGABE_VORLAUF_TAGE).getTime();
  const bald =
    d.anzeige === 'GEPLANT' &&
    d.faelligAm.getTime() <= horizont &&
    d.periodeBis.getTime() < horizont;
  if (AUFGABE_OFFEN.has(d.anzeige) || bald) {
    return {
      art: 'DURCHFUEHREN',
      eigene: gleicheId(a.id, k.durchfuehrendId) || gleicheId(a.id, k.vertretungId),
    };
  }
  if (d.anzeige === 'ZUR_GEGENZEICHNUNG' && k.gegenzeichnungMandant && !d.mandantBestaetigtVon) {
    return {
      art: 'BESTAETIGEN',
      eigene:
        (gleicheId(a.id, k.gegenzeichnerId) || gleicheId(a.id, k.vertretungId)) &&
        !gleicheId(a.id, d.durchgefuehrtVon),
    };
  }
  return null;
}

/** Reihenfolge der Mandantenaufgaben: überfällig, zurückgewiesen, Bestätigungen, Rest. */
export function aufgabenRang(x: { anzeige: AnzeigeStatus; art: PortalAufgabe['art'] }): number {
  if (x.anzeige === 'UEBERFAELLIG') return 0;
  if (x.anzeige === 'ZURUECKGEWIESEN') return 1;
  return x.art === 'BESTAETIGEN' ? 2 : 3;
}

/** Ablehnung von `kannDurchfuehren`: andere Seite (PARTEI) oder nicht zugewiesen. */
function durchfuehrenVerweigert(l: RechteLage): Recht {
  const a = l.akteur;
  if (l.zustaendigkeit.partei === 'MANDANT' && a.art === 'KANZLEI')
    return recht('PARTEI', 'Diese Kontrolle führt der Mandant im Portal durch');
  if (l.zustaendigkeit.partei === 'KANZLEI' && a.art === 'MANDANT')
    return recht('PARTEI', 'Diese Kontrolle führt die Kanzlei durch');
  const d = l.name?.(l.zustaendigkeit.durchfuehrendId) ?? null;
  const v = l.name?.(l.zustaendigkeit.vertretungId) ?? null;
  return recht(
    a.art === 'MANDANT' ? 'PORTAL_ZUGEORDNET' : 'DURCHFUEHREN',
    d && v
      ? `Durchführung durch ${d} oder Vertretung ${v}`
      : 'Durchführung durch die zugewiesene Person oder ihre Vertretung',
  );
}

/** Rechte des Akteurs je Handlung. Im historischen Stand ist alles gesperrt (AGENTS.md Regel 6). */
export function durchfuehrungsRechte(l: RechteLage): HandlungsRechte {
  const a = l.akteur;
  const s = l.status;
  const k = l.zustaendigkeit;
  const darfDurchfuehren = kannDurchfuehren(a, k, l.mandantId, l.rollen);
  const beteiligt = l.beteiligte.some((id) => gleicheId(id, a.id));
  const gzm = k.gegenzeichnungMandant;
  const offen = OFFEN.includes(s);
  // Offener Entfallen-Antrag: nur an einer nicht abgeschlossenen Durchführung
  // (Reste an abgeschlossenen aus der Zeit vor dieser Regel zählen nicht).
  const hatAntrag = s !== 'ENTFALLEN' && !ABGESCHLOSSEN.includes(s) && !!l.entfallenBegruendung;
  // Solange über das Entfallen nicht entschieden ist, wird nicht durchgeführt
  // (sonst überlebte der Antrag Einreichen und Gegenzeichnung). Die
  // Antragsbegründung ist ein Kanzlei-Vorgang; das Portal nennt sie nicht.
  const antragSperrt = (): Recht =>
    status(
      a.art === 'MANDANT'
        ? 'Die Kanzlei prüft diese Aufgabe; Bearbeitung derzeit nicht möglich'
        : 'Entfallen beantragt — zuerst über den Antrag entscheiden',
    );

  const beginnen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (s !== 'GEPLANT')
      return status(BEARBEITBAR.includes(s) ? 'Bereits begonnen' : statusGrund(s));
    if (l.anzeige === 'GEPLANT')
      return status(`Periode endet am ${fmtDatum(l.periodeBis)} — Beginn danach möglich`);
    if (!darfDurchfuehren) return durchfuehrenVerweigert(l);
    if (hatAntrag) return antragSperrt();
    return ja;
  })();

  const bearbeiten = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (s === 'GEPLANT') return beginnen;
    if (!BEARBEITBAR.includes(s)) return status(statusGrund(s));
    if (!darfDurchfuehren) return durchfuehrenVerweigert(l);
    if (hatAntrag) return antragSperrt();
    return ja;
  })();

  // Kanzlei-Gegenzeichnung (bei Mandanten-Gegenzeichnung: Abschluss nach der Bestätigung).
  const kanzleiPruefer = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (s !== 'ZUR_GEGENZEICHNUNG')
      return status(
        ABGESCHLOSSEN.includes(s)
          ? 'Bereits gegengezeichnet'
          : 'Nur für eingereichte Durchführungen',
      );
    if (a.art !== 'KANZLEI') return recht('PARTEI', 'Abschluss durch die Kanzlei');
    if (beteiligt) return recht('VIER_AUGEN', VIER_AUGEN);
    const g = kannGegenzeichnen(a, k, l.mandantId, l.durchgefuehrtVon, true, l.rollen);
    return g.erlaubt ? ja : recht(g.verweigerung, g.grund);
  })();

  const gegenzeichnen = ((): Recht => {
    if (!kanzleiPruefer.erlaubt) return kanzleiPruefer;
    if (gzm && !l.mandantBestaetigtVon)
      return status('Bestätigung durch eine zweite Person beim Mandanten steht aus');
    // Nur Altbestand (Einreichen ist bei offenem Antrag gesperrt): zuerst
    // zurückweisen, dann über den Antrag entscheiden – nie mit offenem Antrag abschließen.
    if (hatAntrag)
      return status('Entfallen beantragt — zuerst zurückweisen und über den Antrag entscheiden');
    return ja;
  })();

  const mandantBestaetigen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (!gzm) return status('Für diese Kontrolle ist keine Bestätigung beim Mandanten vorgesehen');
    if (s !== 'ZUR_GEGENZEICHNUNG') return status('Nur für übermittelte Aufgaben');
    if (l.mandantBestaetigtVon) {
      const n = l.name?.(l.mandantBestaetigtVon) ?? null;
      return status(n ? `Bereits bestätigt durch ${n}` : 'Bereits bestätigt');
    }
    if (a.art !== 'MANDANT' || !darfPortalLesen(a, l.mandantId, l.rollen, k))
      return recht(
        a.art !== 'MANDANT' ? 'PARTEI' : 'PORTAL_ROLLE',
        'Bestätigung durch eine zweite Person beim Mandanten',
      );
    if (beteiligt)
      return recht(
        'VIER_AUGEN',
        'Die Bestätigung erfolgt durch eine zweite Person, nicht durch die durchführende',
      );
    const g = kannGegenzeichnen(a, k, l.mandantId, l.durchgefuehrtVon, false, l.rollen);
    return g.erlaubt ? ja : recht(g.verweigerung, g.grund);
  })();

  const zurueckweisen = a.art === 'KANZLEI' ? kanzleiPruefer : mandantBestaetigen;

  const entfallenBeantragen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (a.art !== 'KANZLEI') return recht('PARTEI', KEIN_RECHT);
    if (!offen)
      return status(
        s === 'ZUR_GEGENZEICHNUNG' ? 'Eingereicht — zuerst zurückweisen' : statusGrund(s),
      );
    if (hatAntrag) return status('Ein Antrag liegt bereits vor');
    if (!darfDurchfuehren && !kannBearbeiten(a, l.mandantId))
      return recht('BEARBEITEN', KEIN_RECHT);
    return ja;
  })();

  const antragOffen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    // Kanzlei-Vorgang: Für Mandantenkontakte unabhängig davon, ob ein Antrag
    // offen ist (die Kennzeichen verraten ihn nicht).
    if (a.art !== 'KANZLEI') return recht('PARTEI', KEIN_RECHT);
    if (!hatAntrag) return status('Kein Antrag offen');
    if (!offen)
      return status(
        s === 'ZUR_GEGENZEICHNUNG' ? 'Eingereicht — zuerst zurückweisen' : statusGrund(s),
      );
    return ja;
  })();

  // Freigabe: Berufsträger:in mit Würdigungsrecht und nie die antragstellende Person.
  const entfallenFreigeben = ((): Recht => {
    if (!antragOffen.erlaubt) return antragOffen;
    if (!kannWuerdigen(a, l.mandantId))
      return recht(
        'WUERDIGEN',
        'Freigabe durch die zuständige Berufsträgerin bzw. den zuständigen Berufsträger',
      );
    // Vier-Augen fail-closed: ohne gespeicherte antragstellende Person keine Freigabe.
    if (!zweitePerson(a, l.entfallenVon))
      return recht('VIER_AUGEN', 'Freigabe durch eine zweite Person');
    return ja;
  })();

  // Ablehnen wie Freigeben; die antragstellende Person darf zurückziehen.
  const entfallenAblehnen = ((): Recht => {
    if (!antragOffen.erlaubt) return antragOffen;
    if (a.art === 'KANZLEI' && gleicheId(a.id, l.entfallenVon)) return ja;
    return entfallenFreigeben;
  })();

  const nachtrag = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (a.art !== 'KANZLEI') return recht('PARTEI', KEIN_RECHT);
    if (!ABGESCHLOSSEN.includes(s))
      return status('Nachträge nur zu abgeschlossenen Durchführungen');
    if (!darfDurchfuehren && !kannBearbeiten(a, l.mandantId))
      return recht('BEARBEITEN', KEIN_RECHT);
    return ja;
  })();

  return {
    beginnen,
    bearbeiten,
    gegenzeichnen,
    mandantBestaetigen,
    zurueckweisen,
    entfallenBeantragen,
    entfallenFreigeben,
    entfallenAblehnen,
    nachtrag,
  };
}

/** Flag einer Handlung für die Oberfläche (Vertrag `DurchfuehrungRechtSchema`). */
export interface RechtFlag {
  erlaubt: boolean;
  grund: string | null;
  /** Verweigerungsgrund des `403` der Operation; `null` bei Erlaubnis oder Zustand (`409`). */
  verweigerung: VerweigerungGrund | null;
}

/**
 * Flags für die Oberfläche (ohne interne Art). `verweigerung` ist genau der
 * Grund, mit dem die Operation (`verlange`) dieselbe Ablehnung als `403`
 * meldet – eine Quelle für Kennzeichen und Schreibrecht.
 */
export function rechteFlags(r: HandlungsRechte): Record<keyof HandlungsRechte, RechtFlag> {
  const out = {} as Record<keyof HandlungsRechte, RechtFlag>;
  for (const [k, v] of Object.entries(r) as [keyof HandlungsRechte, Recht][]) {
    out[k] = { erlaubt: v.erlaubt, grund: v.grund, verweigerung: v.verweigerung };
  }
  return out;
}
