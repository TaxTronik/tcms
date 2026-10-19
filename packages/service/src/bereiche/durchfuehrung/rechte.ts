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
//     `NICHT_BERECHTIGT` (403) mit fachlichem Grund.
// Sichtbarkeit (fremder Mandant, Portal ohne Zuweisung) wird vorher geprüft
// und ergibt `NICHT_GEFUNDEN`.
// =============================================================================

import type { Akteur } from '@tcms/contract';
import {
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

export interface Recht {
  erlaubt: boolean;
  grund: string | null;
  /** Art der Ablehnung (nur intern; nicht in Antworten). */
  art: 'STATUS' | 'RECHT' | null;
}

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

const ja: Recht = { erlaubt: true, grund: null, art: null };
const status = (grund: string): Recht => ({ erlaubt: false, grund, art: 'STATUS' });
const recht = (grund: string): Recht => ({ erlaubt: false, grund, art: 'RECHT' });

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

function durchfuehrenGrund(l: RechteLage): string {
  const a = l.akteur;
  if (l.zustaendigkeit.partei === 'MANDANT' && a.art === 'KANZLEI')
    return 'Diese Kontrolle führt der Mandant im Portal durch';
  if (l.zustaendigkeit.partei === 'KANZLEI' && a.art === 'MANDANT')
    return 'Diese Kontrolle führt die Kanzlei durch';
  const d = l.name?.(l.zustaendigkeit.durchfuehrendId) ?? null;
  const v = l.name?.(l.zustaendigkeit.vertretungId) ?? null;
  return d && v
    ? `Durchführung durch ${d} oder Vertretung ${v}`
    : 'Durchführung durch die zugewiesene Person oder ihre Vertretung';
}

/** Rechte des Akteurs je Handlung. Im historischen Stand ist alles gesperrt (AGENTS.md Regel 6). */
export function durchfuehrungsRechte(l: RechteLage): HandlungsRechte {
  const a = l.akteur;
  const s = l.status;
  const k = l.zustaendigkeit;
  const darfDurchfuehren = kannDurchfuehren(a, k, l.mandantId, l.rollen);
  const beteiligt = l.beteiligte.some((id) => gleicheId(id, a.id));
  const gzm = k.gegenzeichnungMandant;

  const beginnen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (s !== 'GEPLANT')
      return status(BEARBEITBAR.includes(s) ? 'Bereits begonnen' : statusGrund(s));
    if (l.anzeige === 'GEPLANT')
      return status(`Periode endet am ${fmtDatum(l.periodeBis)} — Beginn danach möglich`);
    if (!darfDurchfuehren) return recht(durchfuehrenGrund(l));
    return ja;
  })();

  const bearbeiten = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (s === 'GEPLANT') return beginnen;
    if (!BEARBEITBAR.includes(s)) return status(statusGrund(s));
    if (!darfDurchfuehren) return recht(durchfuehrenGrund(l));
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
    if (a.art !== 'KANZLEI') return recht('Abschluss durch die Kanzlei');
    if (beteiligt) return recht(VIER_AUGEN);
    const g = kannGegenzeichnen(a, k, l.mandantId, l.durchgefuehrtVon, true, l.rollen);
    return g.erlaubt ? ja : recht(g.grund ?? KEIN_RECHT);
  })();

  const gegenzeichnen = ((): Recht => {
    if (!kanzleiPruefer.erlaubt) return kanzleiPruefer;
    if (gzm && !l.mandantBestaetigtVon)
      return status('Bestätigung durch eine zweite Person beim Mandanten steht aus');
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
      return recht('Bestätigung durch eine zweite Person beim Mandanten');
    if (beteiligt)
      return recht(
        'Die Bestätigung erfolgt durch eine zweite Person, nicht durch die durchführende',
      );
    const g = kannGegenzeichnen(a, k, l.mandantId, l.durchgefuehrtVon, false, l.rollen);
    return g.erlaubt ? ja : recht(g.grund ?? KEIN_RECHT);
  })();

  const zurueckweisen = a.art === 'KANZLEI' ? kanzleiPruefer : mandantBestaetigen;

  const offen = OFFEN.includes(s);
  const hatAntrag = s !== 'ENTFALLEN' && !!l.entfallenBegruendung;

  const entfallenBeantragen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
    if (a.art !== 'KANZLEI') return recht(KEIN_RECHT);
    if (!offen)
      return status(
        s === 'ZUR_GEGENZEICHNUNG' ? 'Eingereicht — zuerst zurückweisen' : statusGrund(s),
      );
    if (hatAntrag) return status('Ein Antrag liegt bereits vor');
    if (!darfDurchfuehren && !kannBearbeiten(a, l.mandantId)) return recht(KEIN_RECHT);
    return ja;
  })();

  const antragOffen = ((): Recht => {
    if (l.historisch) return status(NUR_AKTUELL);
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
        'Freigabe durch die zuständige Berufsträgerin bzw. den zuständigen Berufsträger',
      );
    if (gleicheId(a.id, l.entfallenVon)) return recht('Freigabe durch eine zweite Person');
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
    if (a.art !== 'KANZLEI') return recht(KEIN_RECHT);
    if (!ABGESCHLOSSEN.includes(s))
      return status('Nachträge nur zu abgeschlossenen Durchführungen');
    if (!darfDurchfuehren && !kannBearbeiten(a, l.mandantId)) return recht(KEIN_RECHT);
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

/** Flags für die Oberfläche (ohne interne Art). */
export function rechteFlags(
  r: HandlungsRechte,
): Record<keyof HandlungsRechte, { erlaubt: boolean; grund: string | null }> {
  const out = {} as Record<keyof HandlungsRechte, { erlaubt: boolean; grund: string | null }>;
  for (const [k, v] of Object.entries(r) as [keyof HandlungsRechte, Recht][]) {
    out[k] = { erlaubt: v.erlaubt, grund: v.grund };
  }
  return out;
}
