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
  AbschnittSpeichernBodySchema,
  BeschreibungFreigabeAnfordernBodySchema,
  BeschreibungLesenQuerySchema,
  EinrichtungLesenQuerySchema,
  EntwurfSpeichernBodySchema,
  FreigabeNeuadressierungBodySchema,
  NachrichtenOffenQuerySchema,
  PortalFreigebenBodySchema,
  PortalKenntnisnahmeBodySchema,
  ProgrammAnlegenBodySchema,
  ReviewZurueckweisenBodySchema,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  adressiereFreigabeNeu,
  bestaetigeKenntnisnahme,
  bestaetigeNachrichtZustellung,
  erteileFreigabe,
  fordereBeschreibungsfreigabeAn,
  fordereFreigabeCodeAn,
  gibBeschreibungZurReview,
  ladeBeschreibung,
  ladeEinrichtung,
  ladeOffeneNachrichten,
  ladePortalFreigaben,
  legeBeschreibungsversionAn,
  legeProgrammAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
  speichereEinrichtungsschritt,
  weiseBeschreibungsreviewZurueck,
} from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

const M = '/v1/mandanten/:mandantId';
const VERSION = `${M}/beschreibung/versionen/:versionId`;
const PORTAL = `${M}/portal/freigaben/:freigabeId`;

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

  // ---- CMS-Beschreibung ----
  r.route({
    methode: 'GET',
    pfad: `${M}/beschreibung`,
    query: BeschreibungLesenQuerySchema,
    handler: (c) =>
      ladeBeschreibung(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/beschreibung/versionen`,
    status: 201,
    handler: (c) =>
      legeBeschreibungsversionAn(dienstKontext(c), { mandantId: c.params.mandantId! }),
  });
  r.route({
    methode: 'POST',
    pfad: `${VERSION}/abschnitte`,
    body: AbschnittSpeichernBodySchema,
    handler: (c) =>
      speichereBeschreibungsabschnitt(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        versionId: c.params.versionId!,
        ...c.body,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${VERSION}/review`,
    handler: (c) =>
      gibBeschreibungZurReview(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        versionId: c.params.versionId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${VERSION}/review/abschliessen`,
    handler: (c) =>
      schliesseBeschreibungsreviewAb(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        versionId: c.params.versionId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${VERSION}/review/zurueckweisen`,
    body: ReviewZurueckweisenBodySchema,
    handler: (c) =>
      weiseBeschreibungsreviewZurueck(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        versionId: c.params.versionId!,
        ...c.body,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${VERSION}/freigabe`,
    status: 201,
    body: BeschreibungFreigabeAnfordernBodySchema,
    handler: (c) =>
      fordereBeschreibungsfreigabeAn(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        versionId: c.params.versionId!,
        ...c.body,
      }),
  });

  // ---- Freigaben: Neuadressierung (Kanzlei) ----
  r.route({
    methode: 'POST',
    pfad: `${M}/freigaben/:freigabeId/neuadressierung`,
    body: FreigabeNeuadressierungBodySchema,
    handler: (c) =>
      adressiereFreigabeNeu(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        freigabeId: c.params.freigabeId!,
        ...c.body,
      }),
  });

  // ---- Portal ----
  r.route({
    methode: 'GET',
    pfad: `${M}/portal/freigaben`,
    portal: true,
    handler: (c) => ladePortalFreigaben(dienstKontext(c), { mandantId: c.params.mandantId! }),
  });
  r.route({
    methode: 'POST',
    pfad: `${PORTAL}/code`,
    portal: true,
    handler: (c) =>
      fordereFreigabeCodeAn(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        freigabeId: c.params.freigabeId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${PORTAL}/freigeben`,
    portal: true,
    body: PortalFreigebenBodySchema,
    handler: (c) =>
      erteileFreigabe(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        freigabeId: c.params.freigabeId!,
        ...c.body,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${PORTAL}/kenntnisnahme`,
    portal: true,
    body: PortalKenntnisnahmeBodySchema,
    handler: (c) =>
      bestaetigeKenntnisnahme(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        freigabeId: c.params.freigabeId!,
        ...c.body,
      }),
  });
}
