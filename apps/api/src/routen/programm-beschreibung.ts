// =============================================================================
// Routen des Bereichs „programm-beschreibung" (Welle 2): Einrichtungsassistent,
// CMS-Beschreibung, Freigaben (Kanzlei und Portal), Kommunikation und
// Postausgang. Keine Logik und keine Rechteprüfung hier: Jede Route ruft genau
// eine Funktion aus @tcms/service (ADR 0001 §2); Rechte, Mandantenzugehörigkeit
// der Objekt-IDs und Zustandsübergänge prüft der Service.
//
// Pfade unter /v1/mandanten/:mandantId/… sind an `cli.id` gebunden (routen.ts);
// Portal-Endpunkte (`portal: true`) erreichen Mandantenkontakte. Der Postausgang
// ist tenantweit (/v1/nachrichten, nur Verwaltungsrecht, im Service geprüft).
// =============================================================================

import {
  EinrichtungLesenQuerySchema,
  EntwurfSpeichernBodySchema,
  NachrichtenOffenQuerySchema,
  ProgrammAnlegenBodySchema,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  bestaetigeNachrichtZustellung,
  ladeEinrichtung,
  ladeOffeneNachrichten,
  legeProgrammAn,
  speichereEinrichtungsschritt,
} from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

const M = '/v1/mandanten/:mandantId';

export function registriereProgrammBeschreibung(r: Routen<Tx>): void {
  // ---- Postausgang (tenantweit, Verwaltungsrecht im Service) ----
  r.route({
    methode: 'GET',
    pfad: '/v1/nachrichten/offen',
    query: NachrichtenOffenQuerySchema,
    handler: (c) => ladeOffeneNachrichten(dienstKontext(c), { ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: '/v1/nachrichten/:nachrichtId/zugestellt',
    handler: (c) =>
      bestaetigeNachrichtZustellung(dienstKontext(c), { nachrichtId: c.params.nachrichtId! }),
  });

  // ---- Einrichtungsassistent ----
  r.route({
    methode: 'GET',
    pfad: `${M}/einrichtung`,
    query: EinrichtungLesenQuerySchema,
    handler: (c) =>
      ladeEinrichtung(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/einrichtung/entwurf`,
    body: EntwurfSpeichernBodySchema,
    handler: (c) =>
      speichereEinrichtungsschritt(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.body }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/einrichtung/anlegen`,
    status: 201,
    body: ProgrammAnlegenBodySchema,
    handler: (c) => legeProgrammAn(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.body }),
  });
}
