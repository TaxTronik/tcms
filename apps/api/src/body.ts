// =============================================================================
// Roher Body mit hartem Limit (ADR 0001, Abschnitt 7: höchstens 256 KiB).
//
// Zwei Grenzen: `Content-Length` wird vor dem ersten Lesen geprüft, die
// gestreamte Länge bei jedem Stück. Wer eine kleine Länge angibt und mehr
// schickt, wird beim Überschreiten abgebrochen; der Rest wird nicht gelesen.
// =============================================================================

import { DienstFehler } from '@tcms/contract';

const DEZIMAL = /^(?:0|[1-9][0-9]{0,15})$/;

export async function leseBodyRoh(anfrage: Request, maxBytes: number): Promise<Uint8Array> {
  const angegeben = anfrage.headers.get('content-length');
  let laengeAngegeben: number | null = null;
  if (angegeben !== null) {
    // Mehrere Header verbindet `Headers.get` mit ", " – das ist dann ungültig.
    if (!DEZIMAL.test(angegeben)) throw new DienstFehler('UNGUELTIG');
    laengeAngegeben = Number(angegeben);
    if (laengeAngegeben > maxBytes) throw new DienstFehler('ZU_GROSS');
  }
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
