// =============================================================================
// Dienst-Token (ADR 0001, Abschnitt 3.1).
//
// `Authorization: Bearer <token>`, genau ein Leerzeichen, Schema-Schreibweise
// genau `Bearer` (strenger als RFC 9110, die kanzleikonsole ist der einzige
// Aufrufer). Vergleich in konstanter Zeit gegen jeden Listeneintrag:
// SHA-256 beider Seiten, dann `timingSafeEqual`, ohne vorzeitigen Abbruch.
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';

/** b64token nach RFC 6750; zugleich die erlaubte Zeichenmenge der Konfiguration. */
export const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

const sha256 = (wert: string) => createHash('sha256').update(wert, 'utf8').digest();

/** Liefert eine Prüffunktion für den `Authorization`-Header. */
export function erzeugeTokenPruefung(
  tokens: readonly string[],
): (authorization: string | null) => boolean {
  if (tokens.length === 0) throw new Error('Dienst-Token: Liste ist leer');
  const hashes = tokens.map(sha256);
  return (authorization) => {
    if (typeof authorization !== 'string') return false;
    const treffer = BEARER.exec(authorization);
    if (!treffer) return false;
    const kandidat = sha256(treffer[1]!);
    let gueltig = 0;
    for (const hash of hashes) gueltig |= timingSafeEqual(kandidat, hash) ? 1 : 0;
    return gueltig === 1;
  };
}
