// =============================================================================
// Bestätigungscodes für Freigaben (Fachkonzept §10 P4, Aufgabe tcms-programm).
//
//   - 6 Ziffern aus `randomInt` (node:crypto), 7 Tage gültig ab Ausstellung.
//     Frist und Prüfung laufen immer auf echter Zeit, nie auf der Demo-Uhr
//     (AGENTS.md: Sicherheitsfristen sind echte Zeit).
//   - Gespeichert wird nur ein HMAC-SHA-256 mit einem geheimen Schlüssel aus
//     der Umgebung (`TCMS_CODE_SCHLUESSEL`, nie in der Datenbank), gebunden an
//     die Freigabe-ID (Hinweis H5 aus RT4): Wer die Datenbank liest, kann die
//     10^6 möglichen Codes ohne den Schlüssel nicht offline durchprobieren, und
//     ein Hash ist nicht auf eine andere Freigabe übertragbar.
//   - Schlüsselliste wie bei Dienst-Tokens: Der erste Eintrag signiert neue
//     Codes, alle Einträge prüfen. Neben dem Hash steht die Kennung des
//     Schlüssels (`codeSchluesselId`, aus dem Schlüssel abgeleitet, verrät ihn
//     nicht). Ein Code, dessen Schlüssel nicht mehr in der Liste steht, oder
//     ein Hash aus dem früheren Verfahren (SHA-256 ohne Kennung) gilt als
//     abgelaufen: Die Person fordert einen neuen Code an, ohne dass ein
//     Fehlversuch zählt.
//   - Vergleich in konstanter Zeit (`timingSafeEqual` über gleich lange Hashes).
//   - Höchstens MAX_FEHLVERSUCHE Fehlversuche je Freigabe (nicht je Code: ein
//     neuer Code setzt den Zähler nicht zurück); danach gesperrt, bis die
//     Kanzlei die Freigabe neu adressiert.
//   - Höchstens MAX_CODE_ANFORDERUNGEN_JE_STUNDE ausgestellte Codes je
//     Freigabe und Kontakt in einer Stunde (Hinweis H1 aus RT4): Jede
//     Anforderung erzeugt eine Nachricht und einen Audit-Eintrag; ohne Grenze
//     ließe sich der Postausgang fluten. Gezählt werden die Code-Nachrichten
//     (Postausgang, echte Zeit), nie das Audit.
//
// Ablage: `Freigabe.codeHash` (hex) und `Freigabe.codeSchluesselId` des
// aktiven Codes, `Freigabe.codeFehlversuche` der Zähler (CHECK 0–5 in der
// Datenbank). Sie werden nur unter Zeilensperre gelesen und bedingt auf genau
// den gelesenen Zustand geschrieben (TS-05), nie aus dem Audit. Ein anderer
// Hash-Wert oder ein Zähler außerhalb 0–4 bei aktivem Code gilt als gesperrt
// (fail closed).
// =============================================================================

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { FreigabeCodeStatus } from '@tcms/contract';

export const CODE_GUELTIG_TAGE = 7;
export const MAX_FEHLVERSUCHE = 5;
export const MAX_CODE_ANFORDERUNGEN_JE_STUNDE = 5;
export const CODE_ANFORDERUNG_FENSTER_MS = 3_600_000;
const TAG_MS = 86_400_000;
const HASH = /^[0-9a-f]{64}$/;
const SCHLUESSEL_ID = /^[0-9a-f]{16}$/;
/** Mindestlänge eines Schlüssels (Zeichen); dieselbe Regel wie bei Dienst-Tokens. */
export const MIN_CODE_SCHLUESSEL = 32;

/**
 * Schlüsselbund der Bestätigungscodes (aus `TCMS_CODE_SCHLUESSEL`). Hält die
 * Schlüssel nur im Speicher; nach außen gehen nur Kennungen.
 */
export interface CodeSchluessel {
  /** Kennung des Schlüssels für neue Codes (erster Eintrag der Liste). */
  readonly aktuelleId: string;
  /** Steht der Schlüssel mit dieser Kennung (noch) in der Liste? */
  kennt(id: string): boolean;
  /** HMAC-SHA-256 (hex) mit dem Schlüssel `id`; `null`, wenn er nicht (mehr) in der Liste steht. */
  hmac(id: string, nachricht: string): string | null;
}

/** Kennung eines Schlüssels: aus ihm abgeleitet (HMAC), verrät ihn nicht. */
function schluesselId(schluessel: Buffer): string {
  return createHmac('sha256', schluessel)
    .update('tcms|freigabe-code|schluessel-id|v1')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Baut den Schlüsselbund aus der geprüften Liste (Konfiguration des Dienstes
 * bzw. der Demo). Fail closed: leere Liste, zu kurze, doppelte oder
 * kollidierende Einträge → Fehler ohne Werte.
 */
export function erzeugeCodeSchluessel(liste: readonly string[]): CodeSchluessel {
  if (liste.length === 0) throw new Error('[service] Code-Schlüssel: Liste ist leer');
  const je = new Map<string, Buffer>();
  for (const eintrag of liste) {
    if (eintrag.length < MIN_CODE_SCHLUESSEL) {
      throw new Error(
        `[service] Code-Schlüssel: Eintrag kürzer als ${MIN_CODE_SCHLUESSEL} Zeichen`,
      );
    }
    const schluessel = Buffer.from(eintrag, 'utf8');
    const id = schluesselId(schluessel);
    if (je.has(id)) throw new Error('[service] Code-Schlüssel: Einträge doppelt');
    je.set(id, schluessel);
  }
  const aktuelleId = schluesselId(Buffer.from(liste[0]!, 'utf8'));
  return Object.freeze({
    aktuelleId,
    kennt: (id: string) => je.has(id),
    hmac(id: string, nachricht: string): string | null {
      const schluessel = je.get(id);
      return schluessel ? createHmac('sha256', schluessel).update(nachricht).digest('hex') : null;
    },
  });
}

/** Fail closed: ohne Schlüsselbund wird kein Code ausgestellt oder geprüft. */
export function brauchtCodeSchluessel(s: CodeSchluessel | undefined): CodeSchluessel {
  if (!s) throw new Error('[service] Kein Code-Schlüssel konfiguriert');
  return s;
}

export interface CodeZustand {
  fehlversuche: number;
  /** Hash des aktiven Codes oder null. */
  hash: string | null;
  /** Kennung des Schlüssels des aktiven Codes; null = früheres Verfahren (abgelaufen). */
  schluesselId: string | null;
}

/** Gespeicherte Spalten einer Freigabe, aus denen sich der Codezustand ergibt. */
export interface CodeSpalten {
  codeHash: string | null;
  codeSchluesselId: string | null;
  codeFehlversuche: number;
}

const GESPERRT: CodeZustand = Object.freeze({
  fehlversuche: MAX_FEHLVERSUCHE,
  hash: null,
  schluesselId: null,
});

/** Liest den gespeicherten Codezustand; Unbekanntes gilt als gesperrt. */
export function leseCodeZustand(f: CodeSpalten): CodeZustand {
  const n = f.codeFehlversuche;
  // Ausgeschöpfte oder unplausible Zähler: gesperrt, auch mit Hash.
  if (!Number.isInteger(n) || n < 0 || n >= MAX_FEHLVERSUCHE) return { ...GESPERRT };
  if (f.codeHash === null) return { fehlversuche: n, hash: null, schluesselId: null };
  if (!HASH.test(f.codeHash)) return { ...GESPERRT };
  const id = f.codeSchluesselId;
  if (id !== null && !SCHLUESSEL_ID.test(id)) return { ...GESPERRT };
  return { fehlversuche: n, hash: f.codeHash, schluesselId: id };
}

export const istGesperrt = (z: CodeZustand) => z.fehlversuche >= MAX_FEHLVERSUCHE;

/**
 * Der aktive Code ist mit einem bekannten Schlüssel ausgestellt. Sonst (Hash
 * aus dem früheren Verfahren oder Schlüssel nicht mehr in der Liste) gilt er
 * als abgelaufen.
 */
export function codeVerfahrenGueltig(s: CodeSchluessel, z: CodeZustand): boolean {
  return z.hash !== null && z.schluesselId !== null && s.kennt(z.schluesselId);
}

/** Neuer 6-stelliger Code (gleichverteilt, node:crypto). */
export function erzeugeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const nachricht = (freigabeId: string, code: string) =>
  `tcms|freigabe-code|v2|${freigabeId}|${code}`;

/**
 * HMAC-SHA-256 des Codes mit dem aktuellen Schlüssel, gebunden an genau diese
 * Freigabe (hex), dazu die Kennung des Schlüssels – beides zu speichern.
 */
export function codeHash(
  s: CodeSchluessel,
  freigabeId: string,
  code: string,
): { codeHash: string; codeSchluesselId: string } {
  const hash = s.hmac(s.aktuelleId, nachricht(freigabeId, code));
  if (!hash) throw new Error('[service] Code-Schlüssel: aktueller Schlüssel fehlt');
  return { codeHash: hash, codeSchluesselId: s.aktuelleId };
}

/** Vergleich in konstanter Zeit; ein fehlender Hash oder unbekannter Schlüssel passt nie. */
export function codePasst(
  s: CodeSchluessel,
  freigabeId: string,
  code: string,
  z: Pick<CodeZustand, 'hash' | 'schluesselId'>,
): boolean {
  const roh = z.schluesselId ? s.hmac(z.schluesselId, nachricht(freigabeId, code)) : null;
  // Ohne bekannten Schlüssel trotzdem einen HMAC rechnen und gleich lang vergleichen.
  const ist = Buffer.from(roh ?? s.hmac(s.aktuelleId, nachricht(freigabeId, code))!, 'hex');
  const soll = Buffer.from(z.hash ?? '', 'hex');
  if (roh === null || soll.length !== ist.length) {
    timingSafeEqual(ist, ist);
    return false;
  }
  return timingSafeEqual(ist, soll);
}

/** Ablauf eines jetzt ausgestellten Codes (echte Zeit). */
export function codeAblaufAb(jetzt: Date): Date {
  return new Date(jetzt.getTime() + CODE_GUELTIG_TAGE * TAG_MS);
}

/**
 * Status für Anzeigen (nie Code oder Hash). Ein Code des früheren Verfahrens
 * oder mit einem nicht mehr bekannten Schlüssel gilt als abgelaufen; ohne
 * Schlüsselbund (nur Anzeige) zählt allein, ob eine Kennung gespeichert ist.
 */
export function codeStatus(
  f: CodeSpalten & { codeAblauf: Date | null },
  jetzt: Date,
  s?: CodeSchluessel,
): FreigabeCodeStatus {
  const z = leseCodeZustand(f);
  if (istGesperrt(z)) return 'GESPERRT';
  if (!z.hash || !f.codeAblauf) return 'KEIN';
  const verfahren = s ? codeVerfahrenGueltig(s, z) : z.schluesselId !== null;
  if (!verfahren) return 'ABGELAUFEN';
  return f.codeAblauf.getTime() < jetzt.getTime() ? 'ABGELAUFEN' : 'AKTIV';
}
