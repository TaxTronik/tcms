// =============================================================================
// Reine Zeit-Helfer für Stichtage (bisher apps/web/src/server/zeit.ts). „Heute"
// kommt immer von außen (Uhr des Dienstkontexts bzw. Demo-Uhr), nie aus
// `new Date()` hier (ADR 0001 §7: TCMS_DEMO_TODAY wirkt nur in der Demo).
// Stichtage sind Kalendertage (Europe/Berlin) als Date auf UTC-Mitternacht;
// Tagesgrenzen und die Einordnung von Zeitpunkten rechnen nach dem Berliner
// Kalendertag (`@tcms/domain`, kalender.ts).
// =============================================================================

import { StandSchema } from '@tcms/contract';
import { tagesende } from '@tcms/domain';
import type { Uhr } from '../kontext';

export { tagesende };

/** Kalendertag `YYYY-MM-DD` als Date (UTC-Mitternacht). */
export function tagAlsDatum(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Unvollständige Eingaben und unmögliche Tage wie 31. Februar ergeben keinen Kalendertag. */
export function leseKalendertag(iso: string | undefined): Date | null {
  return iso && StandSchema.safeParse(iso).success ? tagAlsDatum(iso) : null;
}

/** „Heute" der Uhr als Date (UTC-Mitternacht des Kalendertags). */
export function heuteDatum(uhr: Uhr): Date {
  return tagAlsDatum(uhr.heute());
}

/**
 * Obergrenze für Audit-Zeitstempel bei Stichtagsauswertungen. Audit-Zeitstempel
 * sind immer echte Zeit, fachliche Zeit folgt der Uhr: Im aktuellen Stand
 * zählen daher alle Einträge, in historischen Ständen (vor „heute") nur die bis
 * zum Ende des Stichtags (Europe/Berlin). Mit echter Uhr ist das dasselbe wie
 * `tagesende`.
 */
export function auditGrenze(stand: Date, heute: Date): Date {
  return stand.getTime() < heute.getTime() ? tagesende(stand) : new Date(8_640_000_000_000_000);
}

/**
 * Liest einen Stichtag (`?stand=YYYY-MM-DD`). Ein Stand ab heute sowie ein
 * fehlender oder ungültiger Wert gelten als aktueller Stand; nur ein Stand vor
 * heute ist historisch (schreibgeschützt, AGENTS.md Regel 6).
 */
export function leseStand(
  param: string | readonly string[] | null | undefined,
  heute: Date,
): { stand: Date; historisch: boolean } {
  const d = leseKalendertag(typeof param === 'string' ? param : param?.[0]);
  if (d && d.getTime() < heute.getTime()) return { stand: d, historisch: true };
  return { stand: heute, historisch: false };
}
