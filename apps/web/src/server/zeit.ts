import 'server-only';

/**
 * Fiktives „Heute" für Demo-Daten (TCMS_DEMO_TODAY=YYYY-MM-DD). Ohne Variable
 * gilt das echte Datum. Zeitstempel neuer Handlungen liegen auf diesem Tag,
 * damit Stichtagsauswertungen konsistent bleiben.
 */
function demoTag(): Date | null {
  const v = process.env['TCMS_DEMO_TODAY'];
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T00:00:00Z`);
}

export function heute(): Date {
  const demo = demoTag();
  if (demo) return demo;
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
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

/** Ende des Kalendertags (UTC) für Stichtagsvergleiche. */
export function tagesende(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 86_400_000 - 1);
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
