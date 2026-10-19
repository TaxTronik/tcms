// Labels und reine Helfer für Risikoinventar (S4) und Risikodetail (S5).
// Ohne I/O, damit Server- und Client-Komponenten sie gleichermaßen nutzen.

import {
  frequenzLabel,
  KLASSE_LABEL,
  MATRIX_ZEILEN,
  matrixFrequenz,
  type GovernanceTyp,
  type Klasse,
  type Turnus,
} from '@tcms/domain';

export type RisikoFreigabe = 'IDENTIFIZIERT' | 'BEWERTET' | 'ZUR_FREIGABE' | 'FREIGEGEBEN';

export const RISIKO_FREIGABE_SCHRITTE: readonly RisikoFreigabe[] = [
  'IDENTIFIZIERT',
  'BEWERTET',
  'ZUR_FREIGABE',
  'FREIGEGEBEN',
];

export const RISIKO_FREIGABE_LABEL: Record<RisikoFreigabe, string> = {
  IDENTIFIZIERT: 'identifiziert',
  BEWERTET: 'bewertet',
  ZUR_FREIGABE: 'zur Freigabe',
  FREIGEGEBEN: 'freigegeben',
};

export const RISIKO_FREIGABE_BADGE: Record<RisikoFreigabe, string> = {
  IDENTIFIZIERT: 'badge-yellow',
  BEWERTET: 'badge-brand',
  ZUR_FREIGABE: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
};

export const SICHT_LABEL: Record<'DESIGN' | 'BETRIEB', string> = {
  DESIGN: 'Netto Design',
  BETRIEB: 'Netto Betrieb',
};

export const UEBERSTEUERUNG_STATUS_LABEL: Record<
  'BEANTRAGT' | 'FREIGEGEBEN' | 'ABGELEHNT' | 'AUFGEHOBEN',
  string
> = {
  BEANTRAGT: 'beantragt',
  FREIGEGEBEN: 'freigegeben',
  ABGELEHNT: 'abgelehnt',
  AUFGEHOBEN: 'aufgehoben',
};

export const UEBERSTEUERUNG_STATUS_BADGE: Record<
  'BEANTRAGT' | 'FREIGEGEBEN' | 'ABGELEHNT' | 'AUFGEHOBEN',
  string
> = {
  BEANTRAGT: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
  ABGELEHNT: 'badge-gray',
  AUFGEHOBEN: 'badge-gray',
};

export const AKZEPTANZ_STATUS_LABEL: Record<'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT', string> = {
  OFFEN: 'Akzeptanz angefordert',
  FREIGEGEBEN: 'Risiko akzeptiert',
  ABGELEHNT: 'Akzeptanz abgelehnt',
};

export const AKZEPTANZ_STATUS_BADGE: Record<'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT', string> = {
  OFFEN: 'badge-purple',
  FREIGEGEBEN: 'badge-green',
  ABGELEHNT: 'badge-red',
};

/** Audit-Aktionen zu Risiken in lesbarer Form (Historie im Drawer). */
export const RISIKO_AUDIT_LABEL: Record<string, string> = {
  'tcms.risiko.neu_bewertet': 'Risiko neu bewertet',
  'tcms.risiko.bewertung_bestaetigt': 'Bewertung bestätigt (unverändert)',
  'tcms.risiko.zur_freigabe': 'Zur Freigabe eingereicht',
  'tcms.risiko.freigegeben': 'Bewertung freigegeben (Vier-Augen)',
  'tcms.risiko.zurueckgewiesen': 'Freigabe zurückgewiesen',
  'tcms.risiko.uebersteuerung_beantragt': 'Übersteuerung beantragt',
  'tcms.risiko.uebersteuerung_freigegeben': 'Übersteuerung freigegeben',
  'tcms.risiko.uebersteuerung_abgelehnt': 'Übersteuerung abgelehnt',
  'tcms.risiko.akzeptanz_angefordert': 'Risikoakzeptanz beim Mandanten angefordert',
  'tcms.risiko.uebernommen': 'Risiko übernommen',
  'tcms.risiko.abgelehnt': 'Vorschlag abgelehnt',
};

/** Profilfragen (P1–P12), auf die sich die Anwendbarkeit eines Katalogrisikos stützt. */
export function profilFragenAus(anwendbarWenn: string | undefined): string[] {
  if (!anwendbarWenn) return [];
  return [...new Set([...anwendbarWenn.matchAll(/P(\d{1,2})/g)].map((m) => `p${m[1]}`))];
}

/** Text der Matrixzelle GT × Bruttoklasse (Fachkonzept Abschnitt 6). */
export function matrixZelle(gt: GovernanceTyp, brutto: Klasse): string {
  const z = MATRIX_ZEILEN.find((m) => m.gt === gt);
  if (!z) return '—';
  return brutto === 'KRITISCH' || brutto === 'HOCH'
    ? z.hoch
    : brutto === 'MITTEL'
      ? z.mittel
      : z.gering;
}

/** „FF · kritisch → monatlich + jede Auslösung" – abgeleitete Mindestfrequenz eines Risikos. */
export function mindestfrequenzText(gt: GovernanceTyp, brutto: Klasse, turnus: Turnus): string {
  const f = matrixFrequenz(gt, brutto, turnus);
  const zelle = matrixZelle(gt, brutto);
  // „jede Periode" hängt vom Erklärungsturnus ab – dann den konkreten Turnus nennen.
  const konkret = zelle.includes('Periode') ? ` (${frequenzLabel(f)})` : '';
  return `${gt} · ${KLASSE_LABEL[brutto]} → ${zelle}${konkret}`;
}

/** „StB Dr. Anna Roth" → „Dr. Roth", „Leon Brandt" → „L. Brandt". */
export function kurzName(name: string | null | undefined): string {
  if (!name) return '—';
  const n = name.replace(/^StB\s+/, '').trim();
  const teile = n.split(/\s+/);
  if (teile.length < 2) return n;
  const nach = teile[teile.length - 1]!;
  if (teile[0] === 'Dr.') return `Dr. ${nach}`;
  return `${teile[0]!.charAt(0)}. ${nach}`;
}
