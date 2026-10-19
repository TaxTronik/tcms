// Labels und reine Helfer für die Kontrollmatrix (S6). Ohne I/O.

import type { BetriebsStand } from '@tcms/domain';

export const BETRIEB_LABEL: Record<BetriebsStand, string> = {
  OK: 'letzte fällige Durchführung ohne Befund, gegengezeichnet',
  MIT_BEFUND: 'letzte fällige Durchführung mit Befund',
  UEBERFAELLIG: 'Durchführung überfällig',
  KEINE: 'noch keine fällige Durchführung',
};

export const BETRIEB_KURZ: Record<BetriebsStand, string> = {
  OK: 'ohne Befund',
  MIT_BEFUND: 'mit Befund',
  UEBERFAELLIG: 'überfällig',
  KEINE: 'keine Durchführung',
};

export const BETRIEB_BADGE: Record<BetriebsStand, string> = {
  OK: 'badge-green',
  MIT_BEFUND: 'badge-yellow',
  UEBERFAELLIG: 'badge-red',
  KEINE: 'badge-gray',
};

export const KONTROLL_AUDIT_LABEL: Record<string, string> = {
  'tcms.kontrolle.design': 'Designbeurteilung erfasst',
  'tcms.kontrolle.abweichung_beantragt': 'Frequenzabweichung beantragt',
  'tcms.kontrolle.abweichung_freigegeben': 'Frequenzabweichung freigegeben (Vier-Augen)',
  'tcms.kontrolle.abweichung_abgelehnt': 'Frequenzabweichung abgelehnt',
  'tcms.kontrolle.abweichung_aufgehoben': 'Frequenzabweichung aufgehoben',
  'tcms.kontrolle.frequenz_geaendert': 'Frequenz geändert (Ableitung)',
  'tcms.kontrolle.neu_geplant': 'Künftige Durchführungen neu geplant',
  'tcms.kontrolle.zustaendigkeit': 'Zuständigkeiten geändert',
};

/** Erste Zeile einer Audit-Detailangabe für die Historie. */
export function auditKurztext(detail: Record<string, unknown>): string {
  const teile: string[] = [];
  const v = detail['vorher'];
  const n = detail['nachher'];
  if (typeof v === 'string' && typeof n === 'string') teile.push(`${v} → ${n}`);
  if (Array.isArray(detail['angelegt']) || Array.isArray(detail['entfernt'])) {
    const a = (detail['angelegt'] as unknown[] | undefined)?.length ?? 0;
    const e = (detail['entfernt'] as unknown[] | undefined)?.length ?? 0;
    teile.push(`${a} angelegt, ${e} entfernt`);
  }
  if (typeof detail['beantragt'] === 'string') teile.push(`beantragt: ${detail['beantragt']}`);
  if (typeof detail['begruendung'] === 'string' && detail['begruendung'])
    teile.push(`„${detail['begruendung']}"`);
  if (typeof detail['anlass'] === 'string') teile.push(detail['anlass']);
  return teile.join(' · ');
}
