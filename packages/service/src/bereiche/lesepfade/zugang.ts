// =============================================================================
// Mandantenübergreifende Lesepfade (ADR 0001 §3.3): Die kanzleikonsole schickt
// die Liste der zugänglichen Mandanten im Body (gebunden über `req.b`). Nur
// diese werden geladen; der Bezug je Mandant ersetzt `cli` der Bestätigung.
// =============================================================================

import { MandantenListeSchema, type Akteur, type MandantenListe } from '@tcms/contract';
import type { KontextZugang } from '../../kern/tcms-kontext';
import { mitListenBezug, nurKanzlei, pruefeEingabe } from './hilfen';

/** Zugänge je Mandant aus der bestätigten Liste (nur Kanzleipersonen). */
export function zugaengeAusListe(akteur: Akteur, eingabe: MandantenListe): KontextZugang[] {
  const person = nurKanzlei(akteur);
  const liste = pruefeEingabe(MandantenListeSchema, eingabe);
  const bt = new Set(liste.bt.map((id) => id.toLowerCase()));
  const hb = new Set(liste.hb.map((id) => id.toLowerCase()));
  return liste.mandantIds.map((roh) => {
    const id = roh.toLowerCase();
    return {
      mandantId: id,
      akteur: mitListenBezug(person, {
        id,
        zustaendigBerufstraeger: bt.has(id),
        hauptbearbeitung: hb.has(id),
      }),
    };
  });
}
