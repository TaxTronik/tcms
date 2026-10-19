// =============================================================================
// Reine Zeit-Helfer für Stichtage (bisher apps/web/src/server/zeit.ts). „Heute"
// kommt immer von außen (Uhr des Dienstkontexts bzw. Demo-Uhr), nie aus
// `new Date()` hier (ADR 0001 §7: TCMS_DEMO_TODAY wirkt nur in der Demo).
// Stichtage sind Kalendertage als Date auf UTC-Mitternacht.
// =============================================================================

import type { Uhr } from '../kontext';

const TAG = /^\d{4}-\d{2}-\d{2}$/;
const TAG_MS = 86_400_000;

/** Kalendertag `YYYY-MM-DD` als Date (UTC-Mitternacht). */
export function tagAlsDatum(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** „Heute" der Uhr als Date (UTC-Mitternacht des Kalendertags). */
export function heuteDatum(uhr: Uhr): Date {
  return tagAlsDatum(uhr.heute());
}

/** Ende des Kalendertags (UTC) für Stichtagsvergleiche. */
export function tagesende(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + TAG_MS - 1);
}

/**
 * Obergrenze für Audit-Zeitstempel bei Stichtagsauswertungen. Audit-Zeitstempel
 * sind immer echte Zeit, fachliche Zeit folgt der Uhr: Im aktuellen Stand
 * zählen daher alle Einträge, in historischen Ständen (vor „heute") nur die bis
 * zum Ende des Stichtags. Mit echter Uhr ist das dasselbe wie `tagesende`.
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
  const v = typeof param === 'string' ? param : param?.[0];
  if (v && TAG.test(v)) {
    const d = tagAlsDatum(v);
    if (!Number.isNaN(d.getTime()) && d.getTime() < heute.getTime())
      return { stand: d, historisch: true };
  }
  return { stand: heute, historisch: false };
}
