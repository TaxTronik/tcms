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
// Ablage: `Freigabe.codeHash` ist nur der SHA-256 (hex) des aktiven Codes,
// `Freigabe.codeFehlversuche` der Zähler (CHECK 0–5 in der Datenbank). Beide
// werden nur unter Zeilensperre gelesen und bedingt auf genau den gelesenen
// Zustand geschrieben (TS-05), nie aus dem Audit. Ein anderer Hash-Wert oder
// ein Zähler außerhalb 0–4 bei aktivem Code gilt als gesperrt (fail closed).
// =============================================================================

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FreigabeCodeStatus } from '@tcms/contract';

export const CODE_GUELTIG_TAGE = 7;
export const MAX_FEHLVERSUCHE = 5;
const TAG_MS = 86_400_000;
const HASH = /^[0-9a-f]{64}$/;

export interface CodeZustand {
  fehlversuche: number;
  /** Hash des aktiven Codes oder null. */
  hash: string | null;
}

/** Gespeicherte Spalten einer Freigabe, aus denen sich der Codezustand ergibt. */
export interface CodeSpalten {
  codeHash: string | null;
  codeFehlversuche: number;
}

const GESPERRT: CodeZustand = Object.freeze({ fehlversuche: MAX_FEHLVERSUCHE, hash: null });

/** Liest den gespeicherten Codezustand; Unbekanntes gilt als gesperrt. */
export function leseCodeZustand(f: CodeSpalten): CodeZustand {
  const n = f.codeFehlversuche;
  // Ausgeschöpfte oder unplausible Zähler: gesperrt, auch mit Hash.
  if (!Number.isInteger(n) || n < 0 || n >= MAX_FEHLVERSUCHE) return { ...GESPERRT };
  if (f.codeHash === null) return { fehlversuche: n, hash: null };
  if (!HASH.test(f.codeHash)) return { ...GESPERRT };
  return { fehlversuche: n, hash: f.codeHash };
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
  f: CodeSpalten & { codeAblauf: Date | null },
  jetzt: Date,
): FreigabeCodeStatus {
  const z = leseCodeZustand(f);
  if (istGesperrt(z)) return 'GESPERRT';
  if (!z.hash || !f.codeAblauf) return 'KEIN';
  return f.codeAblauf.getTime() < jetzt.getTime() ? 'ABGELAUFEN' : 'AKTIV';
}
