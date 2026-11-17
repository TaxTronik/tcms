import 'server-only';
import { tagesbeginn } from '@tcms/domain';
import {
  auditGrenze as auditGrenzeAm,
  echteUhr,
  kalendertag,
  leseStand as leseStandAm,
  tagesende,
  type Uhr,
} from '@tcms/service';

// Reine Stichtag-Helfer liegen in @tcms/service (kern/zeit.ts); hier bleiben die
// Demo-Uhr und Hüllen, die „heute" der Demo-Uhr einsetzen.
export { tagesende };

/**
 * Demo-Uhr: fiktives „Heute" für Demo-Daten (TCMS_DEMO_TODAY=YYYY-MM-DD).
 * Wirkt ausschließlich in der Demo-Oberfläche; der Dienst nutzt immer die
 * echte Uhr (ADR 0001 §7). Ohne Variable gilt das echte Datum (Europe/Berlin).
 * Fachliche Zeitstempel neuer Handlungen liegen auf dem Demo-Tag, damit
 * Stichtagsauswertungen konsistent bleiben; Audit-Zeitstempel sind immer echt.
 */
function demoTag(): Date | null {
  const v = process.env['TCMS_DEMO_TODAY'];
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function heute(): Date {
  const demo = demoTag();
  if (demo) return demo;
  return new Date(`${kalendertag(new Date())}T00:00:00Z`);
}

export function jetzt(): Date {
  const demo = demoTag();
  const n = new Date();
  if (!demo) return n;
  // Berliner Uhrzeit auf den Demo-Tag legen: Der Zeitstempel liegt am Demo-Tag
  // nach deutschem Kalendertag (wie „heute"), auch zwischen 00:00 und 02:00 Uhr.
  const beginn = tagesbeginn(demo).getTime();
  const laenge = tagesende(demo).getTime() + 1 - beginn;
  const msImTag = Math.min(n.getTime() - tagesbeginn(n).getTime(), laenge - 1);
  return new Date(beginn + msImTag);
}

export function istDemo(): boolean {
  return demoTag() !== null;
}

/** Uhr-Port der Demo für den Dienstkontext (`@tcms/service`). */
export const demoUhr: Uhr = {
  jetzt: () => (istDemo() ? jetzt() : echteUhr.jetzt()),
  heute: () => heute().toISOString().slice(0, 10),
};

/**
 * Obergrenze für Audit-Zeitstempel bei Stichtagsauswertungen (siehe
 * `auditGrenze` in @tcms/service) mit „heute" der Demo-Uhr.
 */
export function auditGrenze(stand: Date): Date {
  return auditGrenzeAm(stand, heute());
}

/** Liest `?stand=YYYY-MM-DD`; ein Stand ab heute gilt als aktueller Stand. */
export function leseStand(param: string | string[] | undefined): {
  stand: Date;
  historisch: boolean;
} {
  return leseStandAm(param, heute());
}
