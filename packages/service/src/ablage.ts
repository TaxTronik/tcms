// =============================================================================
// Nachweis-Ablage des Dienstes (ADR 0001 §6): Dateien nimmt ausschließlich die
// kanzleikonsole an (Virenscan, Journal, WORM). Das Tax-CMS übernimmt nur den
// Verweis und prüft ihn streng; Dateiinhalte weist es ab.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import type { NachweisAblage, NachweisEingang, NachweisVerweis } from './kontext';

/** Obergrenzen eines Verweises; die Spalte `groesse` ist ein INTEGER. */
export const VERWEIS_GRENZEN = {
  dokumentId: 200,
  dateiname: 255,
  mime: 127,
  groesse: 2_147_483_647,
} as const;

const DOKUMENT_ID = /^[A-Za-z0-9._:-]+$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Steuerzeichen, Pfadtrenner und Unicode-Richtungszeichen (Dateinamen-Spoofing).
const DATEINAME_VERBOTEN = /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/;

/** Prüft einen Verweis; liefert die Feldfehler (leer = gültig). */
export function pruefeVerweis(v: unknown): Record<string, string[]> {
  const f: Record<string, string[]> = {};
  const fehler = (feld: string, text: string) => (f[feld] ??= []).push(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fehler('verweis', 'Objekt erwartet');
    return f;
  }
  const x = v as Record<string, unknown>;
  const erlaubt = new Set(['dokumentId', 'dateiname', 'mime', 'groesse', 'sha256']);
  for (const k of Object.keys(x)) if (!erlaubt.has(k)) fehler(k, 'Unbekanntes Feld');
  const { dokumentId, dateiname, mime, groesse, sha256 } = x;
  if (
    typeof dokumentId !== 'string' ||
    dokumentId.length === 0 ||
    dokumentId.length > VERWEIS_GRENZEN.dokumentId ||
    !DOKUMENT_ID.test(dokumentId)
  )
    fehler('dokumentId', 'Ungültige Dokument-ID');
  if (
    typeof dateiname !== 'string' ||
    dateiname.trim().length === 0 ||
    dateiname.length > VERWEIS_GRENZEN.dateiname ||
    DATEINAME_VERBOTEN.test(dateiname) ||
    dateiname === '.' ||
    dateiname === '..'
  )
    fehler('dateiname', 'Ungültiger Dateiname');
  if (typeof mime !== 'string' || mime.length > VERWEIS_GRENZEN.mime || !MIME.test(mime))
    fehler('mime', 'Ungültiger MIME-Typ');
  if (
    typeof groesse !== 'number' ||
    !Number.isSafeInteger(groesse) ||
    groesse < 0 ||
    groesse > VERWEIS_GRENZEN.groesse
  )
    fehler('groesse', 'Ungültige Größe');
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) fehler('sha256', 'Ungültiger SHA-256');
  return f;
}

/** Ablage des Dienstes: nimmt nur Verweise an. */
export const verweisAblage: NachweisAblage = {
  async annehmen(eingang: NachweisEingang): Promise<NachweisVerweis> {
    if (eingang.art !== 'VERWEIS') {
      throw new DienstFehler(
        'UNGUELTIG',
        'Dateien nimmt die kanzleikonsole an; das Tax-CMS speichert nur den Verweis.',
      );
    }
    const felder = pruefeVerweis(eingang.verweis);
    if (Object.keys(felder).length > 0) {
      throw new DienstFehler('UNGUELTIG', 'Nachweis-Verweis ungültig.', felder);
    }
    const v = eingang.verweis;
    // Nur die bekannten Felder übernehmen (keine durchgereichten Zusatzfelder).
    return {
      dokumentId: v.dokumentId,
      dateiname: v.dateiname,
      mime: v.mime,
      groesse: v.groesse,
      sha256: v.sha256,
    };
  },
};
