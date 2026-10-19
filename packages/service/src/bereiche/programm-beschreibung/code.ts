// =============================================================================
// Bestätigungscodes für Freigaben (Fachkonzept §10 P4, Aufgabe tcms-programm).
//
//   - 6 Ziffern aus `randomInt` (node:crypto), 7 Tage gültig ab Ausstellung.
//     Frist und Prüfung laufen immer auf echter Zeit, nie auf der Demo-Uhr
//     (AGENTS.md: Sicherheitsfristen sind echte Zeit).
//   - Gespeichert wird nur ein SHA-256, gebunden an die Freigabe-ID: Ein Hash
//     ist nicht auf eine andere Freigabe übertragbar.
//   - Vergleich in konstanter Zeit (`timingSafeEqual` über gleich lange Hashes).
//   - Höchstens MAX_FEHLVERSUCHE Fehlversuche je Freigabe (nicht je Code: ein
//     neuer Code setzt den Zähler nicht zurück); danach gesperrt, bis die
//     Kanzlei die Freigabe neu adressiert.
//
// Ablage (Übergang, Schema-Vorschlag im Bericht): Das Schema hat noch keine
// Spalte für den Fehlversuchszähler. Bis dahin trägt `Freigabe.codeHash` den
// Codezustand in einem versionierten Format; der Zähler wird nur unter
// Zeilensperre gelesen und bedingt geschrieben (TS-05), nie aus dem Audit:
//
//   null                   kein Code ausgestellt, keine Fehlversuche
//   "v1:<n>:<64 hex>"      aktiver Code, n Fehlversuche bisher (0 ≤ n < MAX)
//   "v1:<n>:"              kein aktiver Code, n Fehlversuche (n = MAX: gesperrt)
//
// Jeder andere Wert (auch ein roher Hash älterer Demo-Stände) gilt als
// gesperrt (fail closed).
// =============================================================================

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FreigabeCodeStatus } from '@tcms/contract';

export const CODE_GUELTIG_TAGE = 7;
export const MAX_FEHLVERSUCHE = 5;
const TAG_MS = 86_400_000;
const FORMAT = /^v1:([0-5]):([0-9a-f]{64})?$/;

export interface CodeZustand {
  fehlversuche: number;
  /** Hash des aktiven Codes oder null. */
  hash: string | null;
}

const GESPERRT: CodeZustand = Object.freeze({ fehlversuche: MAX_FEHLVERSUCHE, hash: null });

/** Liest den gespeicherten Codezustand; Unbekanntes gilt als gesperrt. */
export function leseCodeZustand(roh: string | null): CodeZustand {
  if (roh === null) return { fehlversuche: 0, hash: null };
  const m = FORMAT.exec(roh);
  if (!m) return { ...GESPERRT };
  const fehlversuche = Number(m[1]);
  // Ein aktiver Code bei ausgeschöpften Versuchen ist ungültig (fail closed).
  if (fehlversuche >= MAX_FEHLVERSUCHE) return { ...GESPERRT };
  return { fehlversuche, hash: m[2] ?? null };
}

export function schreibeCodeZustand(z: CodeZustand): string | null {
  if (z.fehlversuche === 0 && z.hash === null) return null;
  const n = Math.min(MAX_FEHLVERSUCHE, Math.max(0, Math.trunc(z.fehlversuche)));
  return `v1:${n}:${n >= MAX_FEHLVERSUCHE ? '' : (z.hash ?? '')}`;
}

export const istGesperrt = (z: CodeZustand) => z.fehlversuche >= MAX_FEHLVERSUCHE;

/** Neuer 6-stelliger Code (gleichverteilt, node:crypto). */
export function erzeugeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** SHA-256 des Codes, gebunden an genau diese Freigabe (hex, Kleinbuchstaben). */
export function codeHash(freigabeId: string, code: string): string {
  return createHash('sha256').update(`tcms|freigabe-code|v1|${freigabeId}|${code}`).digest('hex');
}

/** Vergleich in konstanter Zeit; ein fehlender Hash passt nie. */
export function codePasst(freigabeId: string, code: string, hash: string | null): boolean {
  const ist = Buffer.from(codeHash(freigabeId, code), 'hex');
  const soll = Buffer.from(hash ?? '', 'hex');
  // Bei ungleicher Länge trotzdem einen Vergleich gleicher Länge ausführen.
  if (soll.length !== ist.length) {
    timingSafeEqual(ist, ist);
    return false;
  }
  return timingSafeEqual(ist, soll);
}

/** Ablauf eines jetzt ausgestellten Codes (echte Zeit). */
export function codeAblaufAb(jetzt: Date): Date {
  return new Date(jetzt.getTime() + CODE_GUELTIG_TAGE * TAG_MS);
}

/** Status für Anzeigen (nie Code oder Hash). */
export function codeStatus(
  roh: string | null,
  ablauf: Date | null,
  jetzt: Date,
): FreigabeCodeStatus {
  const z = leseCodeZustand(roh);
  if (istGesperrt(z)) return 'GESPERRT';
  if (!z.hash || !ablauf) return 'KEIN';
  return ablauf.getTime() < jetzt.getTime() ? 'ABGELAUFEN' : 'AKTIV';
}
