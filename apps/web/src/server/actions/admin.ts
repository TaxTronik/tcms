'use server';

import { DienstFehler } from '@tcms/contract';
import { imDienst, pruefeAudit } from '@tcms/service';
import { DEMO_PORTS } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { brauchtKanzlei } from '../sitzung';

/** Höchstzahl Fortsetzungen einer abgebrochenen Prüfung (je Aufruf ein Zeitbudget). */
const MAX_FORTSETZUNGEN = 50;

/**
 * Prüft die Audit-Hashkette des Tenants über @tcms/service (`pruefeAudit`,
 * seitenweise mit Zeitbudget; lesend, daher kein Audit-Eintrag). Das Recht
 * (Admins/Partner) prüft der Service.
 */
export async function pruefeHashkette(_prev: Ergebnis, _fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  let ab: number | undefined;
  let geprueft = 0;
  try {
    for (let i = 0; i < MAX_FORTSETZUNGEN; i++) {
      const r = await imDienst(nutzer, DEMO_PORTS, (ctx) =>
        pruefeAudit(ctx, ab === undefined ? {} : { ab }),
      );
      geprueft += r.geprueft;
      if (r.status === 'INTAKT') {
        return {
          ok: `Hashkette intakt: ${geprueft} Einträge geprüft, jeder Eintrag bindet seinen Vorgänger.`,
        };
      }
      if (r.status === 'GEBROCHEN') {
        return {
          fehler: `Hashkette gebrochen bei Eintrag #${r.bruchBei ?? '?'}: ${r.grund ?? 'unbekannter Grund'}. Einträge davor sind konsistent.`,
        };
      }
      ab = r.weiterAb ?? undefined;
    }
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_BERECHTIGT') {
      return { fehler: 'Die Prüfung der Hashkette ist Admins/Partnern vorbehalten.' };
    }
    throw e;
  }
  return {
    fehler: `Prüfung nach ${geprueft} Einträgen nicht abgeschlossen. Bitte erneut starten.`,
  };
}
