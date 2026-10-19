// =============================================================================
// Routen des Bereichs „durchfuehrung" (Welle 2): Kontrolldurchführung der
// Kanzlei (S8) und Kontrollaufgaben im Portal (P2, `portal: true`).
//
// Keine Logik in den Routen (ADR 0001 §2): Pfadparameter und Body/Query
// (Contract-Schemas, strikt) gehen unverändert an `@tcms/service`; Rechte,
// Mandantenzugehörigkeit der Objekte und Statusübergänge prüft der Service.
// Methode, Muster, Portal-Kennzeichen und Schemas stehen im Endpunktregister
// (`ENDPUNKTE`). Die Mandantenbindung (`cli.id == :mandantId`,
// Portal-Kennzeichen) erzwingt die Routentabelle vor dem Lesen des Bodys
// (ADR 0001 §3.3). Schreibende Routen nehmen keine Query an (kein Stichtag, TS-07).
// =============================================================================

import { ENDPUNKTE } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  beantrageEntfallen,
  beginneDurchfuehrung,
  bestaetigeDurchfuehrung,
  entferneNachweis,
  gegenzeichneDurchfuehrung,
  gibEntfallenFrei,
  haengeNachweisAn,
  ladeDurchfuehrung,
  ladeKontrollaufgabe,
  ladeNachweis,
  legeNachtragAn,
  lehneEntfallenAb,
  listeKontrollaufgaben,
  reicheDurchfuehrungEin,
  speichereDurchfuehrung,
  weiseDurchfuehrungZurueck,
} from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

type Params = { params: Readonly<Record<string, string>> };
const mandant = (c: Params) => ({ mandantId: c.params['mandantId'] ?? '' });
const ziel = (c: Params) => ({
  ...mandant(c),
  durchfuehrungId: c.params['durchfuehrungId'] ?? '',
});
const nachweis = (c: Params) => ({ nachweisId: c.params['nachweisId'] ?? '' });

export function registriereDurchfuehrung(r: Routen<Tx>): void {
  // ---------------------------------------------------------------- Kanzlei
  r.endpunkt(ENDPUNKTE.durchfuehrungLesen, async (c) =>
    ladeDurchfuehrung(dienstKontext(c), { ...c.query, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.durchfuehrungBeginnen, async (c) =>
    beginneDurchfuehrung(dienstKontext(c), ziel(c)),
  );
  r.endpunkt(ENDPUNKTE.durchfuehrungSpeichern, async (c) =>
    speichereDurchfuehrung(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.durchfuehrungEinreichen, async (c) =>
    reicheDurchfuehrungEin(dienstKontext(c), ziel(c)),
  );
  r.endpunkt(ENDPUNKTE.nachweisAnhaengen, async (c) =>
    haengeNachweisAn(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.nachweisEntfernen, async (c) =>
    entferneNachweis(dienstKontext(c), { ...ziel(c), ...nachweis(c) }),
  );
  r.endpunkt(ENDPUNKTE.durchfuehrungZurueckweisen, async (c) =>
    weiseDurchfuehrungZurueck(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.durchfuehrungGegenzeichnen, async (c) =>
    gegenzeichneDurchfuehrung(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.entfallenBeantragen, async (c) =>
    beantrageEntfallen(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.entfallenFreigeben, async (c) =>
    gibEntfallenFrei(dienstKontext(c), ziel(c)),
  );
  r.endpunkt(ENDPUNKTE.entfallenAblehnen, async (c) =>
    lehneEntfallenAb(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.nachtragAnlegen, async (c) =>
    legeNachtragAn(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.nachweisLesen, async (c) =>
    ladeNachweis(dienstKontext(c), { ...mandant(c), ...nachweis(c) }),
  );

  // ----------------------------------------------------------------- Portal
  r.endpunkt(ENDPUNKTE.portalAufgabenLesen, async (c) =>
    listeKontrollaufgaben(dienstKontext(c), mandant(c)),
  );
  r.endpunkt(ENDPUNKTE.portalAufgabeLesen, async (c) =>
    ladeKontrollaufgabe(dienstKontext(c), { ...c.query, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalAufgabeSpeichern, async (c) =>
    speichereDurchfuehrung(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalAufgabeEinreichen, async (c) =>
    reicheDurchfuehrungEin(dienstKontext(c), ziel(c)),
  );
  r.endpunkt(ENDPUNKTE.portalAnlageAnhaengen, async (c) =>
    haengeNachweisAn(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalAnlageEntfernen, async (c) =>
    entferneNachweis(dienstKontext(c), { ...ziel(c), ...nachweis(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalAufgabeZurueckgeben, async (c) =>
    weiseDurchfuehrungZurueck(dienstKontext(c), { ...c.body, ...ziel(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalAufgabeBestaetigen, async (c) =>
    bestaetigeDurchfuehrung(dienstKontext(c), ziel(c)),
  );
  r.endpunkt(ENDPUNKTE.portalAnlageLesen, async (c) =>
    ladeNachweis(dienstKontext(c), { ...mandant(c), ...nachweis(c) }),
  );
}
