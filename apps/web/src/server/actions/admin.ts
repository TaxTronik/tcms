'use server';

import { prisma, pruefeAuditKette } from '@tcms/db';
import type { Ergebnis } from '../ergebnis';
import { brauchtKanzlei } from '../sitzung';

/**
 * Prüft die Audit-Hashkette vollständig (lesend, ohne Änderung; daher kein
 * Audit-Eintrag). Nur Admins/Partner.
 */
export async function pruefeHashkette(_prev: Ergebnis, _fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (!nutzer.istAdmin)
    return { fehler: 'Die Prüfung der Hashkette ist Admins/Partnern vorbehalten.' };
  const r = await pruefeAuditKette(prisma);
  if (r.gueltig) {
    return {
      ok: `Hashkette intakt: ${r.geprueft} Einträge geprüft, jeder Eintrag bindet seinen Vorgänger.`,
    };
  }
  return {
    fehler: `Hashkette gebrochen bei Eintrag #${r.bruchBei ?? '?'}: ${r.grund ?? 'unbekannter Grund'}. Einträge davor sind konsistent.`,
  };
}
