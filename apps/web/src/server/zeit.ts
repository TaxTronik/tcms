import 'server-only';
import { echteUhr, kalendertag, type Uhr } from '@tcms/service';

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
  const msImTag =
    ((n.getUTCHours() * 60 + n.getUTCMinutes()) * 60 + n.getUTCSeconds()) * 1000 +
    n.getUTCMilliseconds();
  return new Date(demo.getTime() + msImTag);
}

export function istDemo(): boolean {
  return demoTag() !== null;
}

/** Uhr-Port der Demo für den Dienstkontext (`@tcms/service`). */
export const demoUhr: Uhr = {
  jetzt: () => (istDemo() ? jetzt() : echteUhr.jetzt()),
  heute: () => heute().toISOString().slice(0, 10),
};

/** Ende des Kalendertags (UTC) für Stichtagsvergleiche. */
export function tagesende(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 86_400_000 - 1);
}

/**
 * Obergrenze für Audit-Zeitstempel bei Stichtagsauswertungen. Audit-Zeitstempel
 * sind immer echte Zeit, fachliche Zeit folgt der Demo-Uhr: Im aktuellen Stand
 * zählen daher alle Einträge, in historischen Ständen (vor „heute") nur die bis
 * zum Ende des Stichtags. Ohne Demo-Datum ist das dasselbe wie `tagesende`.
 */
export function auditGrenze(stand: Date): Date {
  return stand.getTime() < heute().getTime() ? tagesende(stand) : new Date(8_640_000_000_000_000);
}

/** Liest `?stand=YYYY-MM-DD`; ein Stand ab heute gilt als aktueller Stand. */
export function leseStand(param: string | string[] | undefined): {
  stand: Date;
  historisch: boolean;
} {
  const h = heute();
  const v = Array.isArray(param) ? param[0] : param;
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.getTime() < h.getTime())
      return { stand: d, historisch: true };
  }
  return { stand: h, historisch: false };
}
