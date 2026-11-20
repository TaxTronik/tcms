import 'server-only';
import { StandSchema } from '@tcms/contract';
import { kalendertagVon, tagesbeginn, ZEITZONE } from '@tcms/domain';
import {
  auditGrenze as auditGrenzeAm,
  echteUhr,
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
  const tag = StandSchema.safeParse(process.env['TCMS_DEMO_TODAY']);
  return tag.success ? new Date(`${tag.data}T00:00:00Z`) : null;
}

export function heute(): Date {
  return demoTag() ?? kalendertagVon(new Date());
}

const uhrzeitFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZEITZONE,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
});

export function jetzt(): Date {
  const demo = demoTag();
  const n = new Date();
  if (!demo || demo.getTime() === kalendertagVon(n).getTime()) return n;
  const uhrzeit = uhrzeitFormat.format(n);
  const msImTag = Date.parse(`1970-01-01T${uhrzeit}Z`);
  const abBeginn = new Date(tagesbeginn(demo).getTime() + msImTag);
  if (uhrzeitFormat.format(abBeginn) === uhrzeit) return abBeginn;
  // Nach einer Zeitumstellung gilt der Versatz am Tagesende. Eine fehlende
  // Uhrzeit im Frühjahr liegt um die Lücke später, eine doppelte im Herbst
  // beim ersten Vorkommen (bereits oben getroffen).
  const abEnde = new Date(tagesende(demo).getTime() + 1 - 86_400_000 + msImTag);
  return uhrzeitFormat.format(abEnde) === uhrzeit ? abEnde : abBeginn;
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
