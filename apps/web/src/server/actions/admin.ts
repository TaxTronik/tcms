'use server';

import { pruefeAuditKette } from '@tcms/db';
import { kannVerwalten } from '@tcms/service';
import { lies } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { brauchtKanzlei } from '../sitzung';

/**
 * Prüft die Audit-Hashkette vollständig (lesend, ohne Änderung; daher kein
 * Audit-Eintrag). Nur Admins/Partner.
 */
export async function pruefeHashkette(_prev: Ergebnis, _fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (!kannVerwalten(nutzer))
    return { fehler: 'Die Prüfung der Hashkette ist Admins/Partnern vorbehalten.' };
  // Kette des Tenants (ADR 0001 §4): nur Einträge dieser Kanzlei, im Tenant-Kontext.
  const r = await lies((tx) => pruefeAuditKette(tx));
  if (r.gueltig) {
    return {
      ok: `Hashkette intakt: ${r.geprueft} Einträge geprüft, jeder Eintrag bindet seinen Vorgänger.`,
    };
  }
  return {
    fehler: `Hashkette gebrochen bei Eintrag #${r.bruchBei ?? '?'}: ${r.grund ?? 'unbekannter Grund'}. Einträge davor sind konsistent.`,
  };
}
