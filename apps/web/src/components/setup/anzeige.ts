// =============================================================================
// Einrichtungsassistent: Anzeige-Bausteine für Client-Komponenten (Schritte,
// Dauertext) und Typen des Entwurfs aus dem Vertrag. Ohne Fachregeln und ohne
// Serverabhängigkeiten; Prüfungen und Startwerte liegen in @tcms/service.
// =============================================================================

import { addTage } from '@tcms/domain';

export type { EntwurfKontrolle, EntwurfRisiko, EntwurfZiel, SetupEntwurf } from '@tcms/contract';

export type ErklaerungsTurnus = 'MONATLICH' | 'QUARTALSWEISE' | 'JAEHRLICH';
export type Appetit = 'GERING' | 'MITTEL' | 'HOCH';

export const SCHRITTE = [
  { nr: 1, titel: 'Teilbereich', sub: 'Paketvorlage, Abgrenzung und Zeiträume' },
  { nr: 2, titel: 'Geschäftsprofil', sub: 'P1–P12' },
  { nr: 3, titel: 'Compliance-Ziele', sub: 'Wesentlichkeit und Risikoappetit' },
  { nr: 4, titel: 'Risikovorschlag', sub: 'übernehmen oder begründet ablehnen' },
  { nr: 5, titel: 'Kontrollvorschlag', sub: 'Zuständigkeiten und Frequenzen' },
] as const;

function tag(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dauer eines Zeitraums als Text, z. B. „6 Monate" oder „rund 5,5 Monate". */
export function dauerText(abIso: string, bisIso: string): string | null {
  const ab = tag(abIso);
  const bis = tag(bisIso);
  if (!ab || !bis || bis.getTime() < ab.getTime()) return null;
  const nach = addTage(bis, 1);
  const volle =
    (nach.getUTCFullYear() - ab.getUTCFullYear()) * 12 + nach.getUTCMonth() - ab.getUTCMonth();
  if (nach.getUTCDate() === ab.getUTCDate()) return `${volle} ${volle === 1 ? 'Monat' : 'Monate'}`;
  const tage = Math.round((nach.getTime() - ab.getTime()) / 86_400_000);
  return `rund ${(tage / 30.44).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Monate`;
}
