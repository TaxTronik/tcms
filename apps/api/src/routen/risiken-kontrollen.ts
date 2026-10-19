// =============================================================================
// Routen des Bereichs „risiken-kontrollen" (Welle 2): Risikoinventar,
// Kontrollmatrix, Geschäftsprofil. Jede Route ruft genau eine Funktion aus
// @tcms/service (ADR 0001 §2); Rechte, Zustände und Sperren prüft nur der
// Service. Alle Pfade liegen unter `/v1/mandanten/:mandantId/…` (Bindung an
// `cli.id`, nur Kanzleipersonen – keine Portal-Endpunkte). Schreibende Routen
// nehmen keinen Stichtag an (TS-07): Ohne Query-Schema weist der Dienst jede
// Query mit 400 ab.
// =============================================================================

import {
  AbweichungAufhebenBodySchema,
  AbweichungBeantragenBodySchema,
  AbweichungEntscheidenBodySchema,
  DesignBeurteilenBodySchema,
  ProfilAendernBodySchema,
  RisikenFreigabeSchrittBodySchema,
  RisikenKontrollenQuerySchema,
  RisikoakzeptanzAnfordernBodySchema,
  RisikoAufnehmenBodySchema,
  RisikoBestaetigenBodySchema,
  RisikoNeuBewertenBodySchema,
  RisikoZurueckweisenBodySchema,
  UebersteuerungBeantragenBodySchema,
  UebersteuerungEntscheidenBodySchema,
  VerantwortlicheAendernBodySchema,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  designBeurteilen,
  frequenzAbweichungAufheben,
  frequenzAbweichungBeantragen,
  frequenzAbweichungEntscheiden,
  ladeKontrolle,
  ladeKontrollen,
  ladeProfil,
  ladeRisiken,
  ladeRisiko,
  profilAendern,
  risikenFreigeben,
  risikenZurFreigabe,
  risikoakzeptanzAnfordern,
  risikoBewertungBestaetigen,
  risikoNeuBewerten,
  risikoZurueckweisen,
  uebersteuerungBeantragen,
  uebersteuerungEntscheiden,
  verantwortlicheAendern,
  vorgeschlagenesRisikoAufnehmen,
} from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

const M = '/v1/mandanten/:mandantId';

export function registriereRisikenKontrollen(r: Routen<Tx>): void {
  // --- Risiken ---------------------------------------------------------------
  r.route({
    methode: 'GET',
    pfad: `${M}/risiken`,
    query: RisikenKontrollenQuerySchema,
    handler: (c) => ladeRisiken(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.query }),
  });
  r.route({
    methode: 'GET',
    pfad: `${M}/risiken/:risikoId`,
    query: RisikenKontrollenQuerySchema,
    handler: (c) =>
      ladeRisiko(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
        ...c.query,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/neu-bewerten`,
    body: RisikoNeuBewertenBodySchema,
    handler: (c) =>
      risikoNeuBewerten(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/bewertung-bestaetigen`,
    body: RisikoBestaetigenBodySchema,
    handler: (c) =>
      risikoBewertungBestaetigen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/uebersteuerungen`,
    status: 201,
    body: UebersteuerungBeantragenBodySchema,
    handler: (c) =>
      uebersteuerungBeantragen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/uebersteuerungen/:uebersteuerungId/entscheiden`,
    body: UebersteuerungEntscheidenBodySchema,
    handler: (c) =>
      uebersteuerungEntscheiden(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        uebersteuerungId: c.params.uebersteuerungId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken-freigabe/einreichen`,
    body: RisikenFreigabeSchrittBodySchema,
    handler: (c) =>
      risikenZurFreigabe(dienstKontext(c), { ...c.body, mandantId: c.params.mandantId! }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken-freigabe/freigeben`,
    body: RisikenFreigabeSchrittBodySchema,
    handler: (c) =>
      risikenFreigeben(dienstKontext(c), { ...c.body, mandantId: c.params.mandantId! }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/zurueckweisen`,
    body: RisikoZurueckweisenBodySchema,
    handler: (c) =>
      risikoZurueckweisen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/akzeptanz-anfordern`,
    status: 201,
    body: RisikoakzeptanzAnfordernBodySchema,
    handler: (c) =>
      risikoakzeptanzAnfordern(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        risikoId: c.params.risikoId!,
      }),
  });

  // --- Kontrollen ------------------------------------------------------------
  r.route({
    methode: 'GET',
    pfad: `${M}/kontrollen`,
    query: RisikenKontrollenQuerySchema,
    handler: (c) =>
      ladeKontrollen(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.query }),
  });
  r.route({
    methode: 'GET',
    pfad: `${M}/kontrollen/:kontrolleId`,
    query: RisikenKontrollenQuerySchema,
    handler: (c) =>
      ladeKontrolle(dienstKontext(c), {
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
        ...c.query,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/design`,
    body: DesignBeurteilenBodySchema,
    handler: (c) =>
      designBeurteilen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung`,
    body: AbweichungBeantragenBodySchema,
    handler: (c) =>
      frequenzAbweichungBeantragen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung/entscheiden`,
    body: AbweichungEntscheidenBodySchema,
    handler: (c) =>
      frequenzAbweichungEntscheiden(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung/aufheben`,
    body: AbweichungAufhebenBodySchema,
    handler: (c) =>
      frequenzAbweichungAufheben(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
      }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/verantwortliche`,
    body: VerantwortlicheAendernBodySchema,
    handler: (c) =>
      verantwortlicheAendern(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
        kontrolleId: c.params.kontrolleId!,
      }),
  });

  // --- Geschäftsprofil ------------------------------------------------------
  r.route({
    methode: 'GET',
    pfad: `${M}/profil`,
    query: RisikenKontrollenQuerySchema,
    handler: (c) => ladeProfil(dienstKontext(c), { mandantId: c.params.mandantId!, ...c.query }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/profil`,
    body: ProfilAendernBodySchema,
    handler: (c) => profilAendern(dienstKontext(c), { ...c.body, mandantId: c.params.mandantId! }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/profil/risiko-aufnehmen`,
    status: 201,
    body: RisikoAufnehmenBodySchema,
    handler: (c) =>
      vorgeschlagenesRisikoAufnehmen(dienstKontext(c), {
        ...c.body,
        mandantId: c.params.mandantId!,
      }),
  });
}
