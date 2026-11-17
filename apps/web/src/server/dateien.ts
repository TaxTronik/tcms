import 'server-only';
import { gueltigerNachweisDateiname, UNZULAESSIGE_ZEICHEN } from '@tcms/contract';

// =============================================================================
// Dateien der Demo (Stellvertreterin der kanzleikonsole, ADR 0001 §6): eine
// Bereinigung für Dateinamen und MIME-Typen beim Annehmen (Nachweise und
// Anlagen von Portal-Meldungen) und eine Antwort für beide Download-Routen.
// Reine Funktionen ohne Next-Abhängigkeit (Tests: dateien.test.ts).
// =============================================================================

// Dieselben unzulässigen Zeichen wie der Vertrag (Steuer-, Richtungs-, Nullbreiten-,
// Füllzeichen), dazu Anführungszeichen; Pfadanteile entfernt `split` unten.
const UNZULAESSIG = new RegExp(UNZULAESSIGE_ZEICHEN, 'gu');
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Dateiname, wie ihn der Vertrag annimmt (`gueltigerNachweisDateiname`, dieselbe
 * Regel wie `AnlageVerweisSchema`): nur der letzte Pfadanteil, ohne unzulässige
 * Zeichen und Anführungszeichen, höchstens 180 Zeichen (nach Code Points, kein
 * geteiltes Surrogatpaar). Bleibt nichts Gültiges übrig: `ersatz`.
 */
export function dateinameBereinigt(name: string, ersatz: string): string {
  const basis = name.split(/[\\/]/).pop() ?? '';
  const ohne = basis.replace(UNZULAESSIG, '').replace(/"/g, '').trim();
  const sauber = Array.from(ohne).slice(0, 180).join('').trim();
  return sauber && gueltigerNachweisDateiname(sauber) ? sauber : ersatz;
}

/** MIME-Typ in Kleinbuchstaben, wenn syntaktisch gültig; sonst `application/octet-stream`. */
export function mimeBereinigt(typ: string): string {
  const t = typ.toLowerCase();
  return t.length <= 127 && MIME.test(t) ? t : 'application/octet-stream';
}

/** Typen, die ein Browser ausführen bzw. rendern würde: nur als Download ausliefern. */
const AKTIVE_TYPEN =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)$/;

/** Content-Type der Auslieferung: aktive, leere oder ungültige Typen als `application/octet-stream`. */
export function auslieferungsTyp(mime: string): string {
  const t = mimeBereinigt(mime.split(';')[0]!.trim());
  return AKTIVE_TYPEN.test(t) ? 'application/octet-stream' : t;
}

/** Content-Disposition: immer `attachment`, ASCII-Ersatzname plus RFC 5987. */
export function dispositionsname(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Kopfzeilen jeder Antwort der Download-Routen: nicht zwischenspeichern, kein
 * MIME-Sniffing und eine Sandbox-CSP – selbst wenn ein Browser den Inhalt
 * anzeigt, laufen darin weder Skripte noch Formulare, und er lädt nichts nach.
 */
export const DOWNLOAD_KOPF = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;

/** Text-Antwort einer Download-Route (Fehlerfälle). */
export function downloadMeldung(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { ...DOWNLOAD_KOPF, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Erfolgsantwort einer Download-Route; `hashKopf` nennt den SHA-256 des Inhalts. */
export function downloadAntwort(
  inhalt: Buffer,
  datei: { dateiname: string; mime: string; sha256: string },
  hashKopf: 'X-Nachweis-SHA256' | 'X-Anlage-SHA256',
): Response {
  return new Response(new Uint8Array(inhalt), {
    status: 200,
    headers: {
      ...DOWNLOAD_KOPF,
      'Content-Type': auslieferungsTyp(datei.mime),
      'Content-Length': String(inhalt.length),
      'Content-Disposition': dispositionsname(datei.dateiname),
      [hashKopf]: datei.sha256,
    },
  });
}
