// =============================================================================
// Routen des Bereichs „durchfuehrung" (Welle 2): Kontrolldurchführung der
// Kanzlei (S8) und Kontrollaufgaben im Portal (P2, `portal: true`).
//
// Keine Logik in den Routen (ADR 0001 §2): Pfadparameter und Body/Query
// (Contract-Schemas, strikt) gehen unverändert an `@tcms/service`; Rechte,
// Mandantenzugehörigkeit der Objekte und Statusübergänge prüft der Service.
// Die Mandantenbindung (`cli.id == :mandantId`, Portal-Kennzeichen) erzwingt
// die Routentabelle vor dem Lesen des Bodys (ADR 0001 §3.3).
// Schreibende Routen nehmen keine Query an (kein Stichtag, TS-07).
// =============================================================================

import {
  DurchfuehrungBegruendungBodySchema,
  DurchfuehrungSpeichernBodySchema,
  DurchfuehrungStandQuerySchema,
  EntfallenAblehnenBodySchema,
  GegenzeichnenBodySchema,
  NachweisAnhaengenBodySchema,
} from '@tcms/contract';
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

/** Kontrolldurchführung der Kanzlei. */
const D = '/v1/mandanten/:mandantId/durchfuehrungen/:durchfuehrungId';
/** Kontrollaufgaben im Portal. */
const P = '/v1/mandanten/:mandantId/portal/aufgaben';

type Params = { params: Readonly<Record<string, string>> };
const mandant = (c: Params) => ({ mandantId: c.params['mandantId'] ?? '' });
const ziel = (c: Params) => ({
  ...mandant(c),
  durchfuehrungId: c.params['durchfuehrungId'] ?? '',
});
const nachweis = (c: Params) => ({ nachweisId: c.params['nachweisId'] ?? '' });

export function registriereDurchfuehrung(r: Routen<Tx>): void {
  // ---------------------------------------------------------------- Kanzlei
  r.route({
    methode: 'GET',
    pfad: D,
    query: DurchfuehrungStandQuerySchema,
    handler: async (c) => ladeDurchfuehrung(dienstKontext(c), { ...ziel(c), ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/beginnen`,
    handler: async (c) => beginneDurchfuehrung(dienstKontext(c), ziel(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/speichern`,
    body: DurchfuehrungSpeichernBodySchema,
    handler: async (c) => speichereDurchfuehrung(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/einreichen`,
    handler: async (c) => reicheDurchfuehrungEin(dienstKontext(c), ziel(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/nachweise`,
    body: NachweisAnhaengenBodySchema,
    status: 201,
    handler: async (c) => haengeNachweisAn(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/nachweise/:nachweisId/entfernen`,
    handler: async (c) => entferneNachweis(dienstKontext(c), { ...ziel(c), ...nachweis(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/zurueckweisen`,
    body: DurchfuehrungBegruendungBodySchema,
    handler: async (c) => weiseDurchfuehrungZurueck(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/gegenzeichnen`,
    body: GegenzeichnenBodySchema,
    handler: async (c) => gegenzeichneDurchfuehrung(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/entfallen/beantragen`,
    body: DurchfuehrungBegruendungBodySchema,
    handler: async (c) => beantrageEntfallen(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/entfallen/freigeben`,
    handler: async (c) => gibEntfallenFrei(dienstKontext(c), ziel(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/entfallen/ablehnen`,
    body: EntfallenAblehnenBodySchema,
    handler: async (c) => lehneEntfallenAb(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${D}/nachtrag`,
    body: DurchfuehrungBegruendungBodySchema,
    status: 201,
    handler: async (c) => legeNachtragAn(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/nachweise/:nachweisId',
    handler: async (c) => ladeNachweis(dienstKontext(c), { ...mandant(c), ...nachweis(c) }),
  });

  // ----------------------------------------------------------------- Portal
  r.route({
    methode: 'GET',
    pfad: P,
    portal: true,
    handler: async (c) => listeKontrollaufgaben(dienstKontext(c), mandant(c)),
  });
  r.route({
    methode: 'GET',
    pfad: `${P}/:durchfuehrungId`,
    portal: true,
    query: DurchfuehrungStandQuerySchema,
    handler: async (c) => ladeKontrollaufgabe(dienstKontext(c), { ...ziel(c), ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/speichern`,
    portal: true,
    body: DurchfuehrungSpeichernBodySchema,
    handler: async (c) => speichereDurchfuehrung(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/einreichen`,
    portal: true,
    handler: async (c) => reicheDurchfuehrungEin(dienstKontext(c), ziel(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/anlagen`,
    portal: true,
    body: NachweisAnhaengenBodySchema,
    status: 201,
    handler: async (c) => haengeNachweisAn(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/anlagen/:nachweisId/entfernen`,
    portal: true,
    handler: async (c) => entferneNachweis(dienstKontext(c), { ...ziel(c), ...nachweis(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/zurueckgeben`,
    portal: true,
    body: DurchfuehrungBegruendungBodySchema,
    handler: async (c) => weiseDurchfuehrungZurueck(dienstKontext(c), { ...ziel(c), ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/bestaetigen`,
    portal: true,
    handler: async (c) => bestaetigeDurchfuehrung(dienstKontext(c), ziel(c)),
  });
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/portal/anlagen/:nachweisId',
    portal: true,
    handler: async (c) => ladeNachweis(dienstKontext(c), { ...mandant(c), ...nachweis(c) }),
  });
}
