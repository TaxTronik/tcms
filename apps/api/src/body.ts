// =============================================================================
// Roher Body mit hartem Limit (ADR 0001, Abschnitt 7: höchstens 256 KiB).
//
// Zwei Grenzen: `Content-Length` wird vorab geprüft (`pruefeContentLength`,
// noch vor dem Dienst-Token, ohne ein Body-Byte zu lesen), die gestreamte
// Länge beim Lesen bei jedem Stück. Wer eine kleine Länge angibt und mehr
// schickt, wird beim Überschreiten abgebrochen; der Rest wird nicht gelesen.
// =============================================================================

import { DienstFehler } from '@tcms/contract';

const DEZIMAL = /^(?:0|[1-9][0-9]{0,15})$/;

/** Prüft nur den Header `Content-Length`; liefert die angegebene Länge oder `null`. */
export function pruefeContentLength(anfrage: Request, maxBytes: number): number | null {
  const angegeben = anfrage.headers.get('content-length');
  if (angegeben === null) return null;
  // Mehrere Header verbindet `Headers.get` mit ", " – das ist dann ungültig.
  if (!DEZIMAL.test(angegeben)) throw new DienstFehler('UNGUELTIG');
  const laenge = Number(angegeben);
  if (laenge > maxBytes) throw new DienstFehler('ZU_GROSS');
  return laenge;
}

/** Kündigt die Anfrage nach HTTP-Framing einen Body an? Nur Header, liest nichts. */
export function kuendigtBodyAn(anfrage: Request): boolean {
  const laenge = anfrage.headers.get('content-length');
  return anfrage.headers.has('transfer-encoding') || (laenge !== null && laenge !== '0');
}

export async function leseBodyRoh(anfrage: Request, maxBytes: number): Promise<Uint8Array> {
  const laengeAngegeben = pruefeContentLength(anfrage, maxBytes);
  if (anfrage.body === null) {
    if (laengeAngegeben !== null && laengeAngegeben !== 0) throw new DienstFehler('UNGUELTIG');
    return new Uint8Array(0);
  }
  const leser = anfrage.body.getReader();
  const teile: Uint8Array[] = [];
  let gelesen = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    gelesen += value.byteLength;
    if (gelesen > maxBytes) {
      // Nicht weiterlesen: Strom abbrechen, Fehler beim Abbrechen ignorieren.
      await leser.cancel().catch(() => undefined);
      throw new DienstFehler('ZU_GROSS');
    }
    teile.push(value);
  }
  if (laengeAngegeben !== null && gelesen !== laengeAngegeben) throw new DienstFehler('UNGUELTIG');
  const body = new Uint8Array(gelesen);
  let pos = 0;
  for (const teil of teile) {
    body.set(teil, pos);
    pos += teil.byteLength;
  }
  return body;
}
