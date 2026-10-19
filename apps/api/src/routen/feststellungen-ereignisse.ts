// =============================================================================
// Routen des Bereichs „feststellungen-ereignisse" (Welle 2): Feststellungen
// und Maßnahmen, Ereigniseingang, Portal-Meldung, Länder-Monitor. Jede Route
// ruft genau eine Funktion aus @tcms/service; Rechte prüft ausschließlich der
// Service (ADR 0001 §2). Die Mandantenbindung (`cli.id == :mandantId`)
// erzwingt die Prüfkette vorher (ADR 0001 §3.3).
//
// Eingabe = Body + Pfadparameter. Pfadparameter werden NACH dem Body
// eingesetzt: Selbst ein Body-Schema, das versehentlich `mandantId` oder eine
// Objekt-ID zuließe, könnte den Pfad nicht überschreiben.
// =============================================================================

import {
  ErklaerungBodySchema,
  EreignisErfassenBodySchema,
  FeststellungErfassenBodySchema,
  FeststellungWeiterBodySchema,
  FolgeHinzufuegenBodySchema,
  FolgenAnlegenBodySchema,
  MassnahmeBodySchema,
  MassnahmeErledigenBodySchema,
  NachkontrolleBodySchema,
  P153BodySchema,
  PortalMeldungBodySchema,
  StandQuerySchema,
  VertraulichBodySchema,
  VerwerfenBeantragenBodySchema,
  WuerdigungBodySchema,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  aktualisiereWuerdigung,
  beantrageEreignisVerwerfen,
  beantrageFeststellungVerwerfen,
  bestaetigeEreignisVerwerfen,
  bestaetigeFeststellungVerwerfen,
  entscheideP153,
  erfasseEreignis,
  erfasseFeststellung,
  erledigeFolge,
  erledigeMassnahme,
  fuegeErklaerungHinzu,
  fuegeFolgeHinzu,
  ladeEreignis,
  ladeEreignisAnlage,
  ladeEreignisse,
  ladeFeststellung,
  ladeFeststellungen,
  ladePortalMeldungen,
  legeFolgenAn,
  legeMassnahmeAn,
  legeNachkontrolleAn,
  lehneEreignisVerwerfenAb,
  lehneFeststellungVerwerfenAb,
  meldeEreignis,
  nehmeEreignisInPruefung,
  schalteFeststellungWeiter,
  schliesseEreignisAb,
  setzeVertraulich,
  verwerfeFolge,
} from '@tcms/service';
import type { Routen, RoutenKontext } from '../routen';
import { dienstKontext } from './kontext';

const M = '/v1/mandanten/:mandantId';
const F = `${M}/feststellungen/:feststellungId`;
const E = `${M}/ereignisse/:ereignisId`;

/** Pfadparameter (immer vorhanden, weil das Muster ihn enthält). */
function p(r: RoutenKontext<Tx, unknown, unknown>, name: string): string {
  const wert = r.params[name];
  if (wert === undefined) throw new Error(`Routen: Parameter ${name} fehlt`);
  return wert;
}

/** Pfadparameter für Feststellungs-, Ereignis- und Folge-Routen. */
const mandant = (r: RoutenKontext<Tx, unknown, unknown>) => ({ mandantId: p(r, 'mandantId') });
const fst = (r: RoutenKontext<Tx, unknown, unknown>) => ({
  mandantId: p(r, 'mandantId'),
  feststellungId: p(r, 'feststellungId'),
});
const erg = (r: RoutenKontext<Tx, unknown, unknown>) => ({
  mandantId: p(r, 'mandantId'),
  ereignisId: p(r, 'ereignisId'),
});
const folge = (r: RoutenKontext<Tx, unknown, unknown>) => ({
  ...erg(r),
  folgeId: p(r, 'folgeId'),
});

export function registriereFeststellungenEreignisse(r: Routen<Tx>): void {
  // ---------------------------------------------------------------- S10 Lesen
  r.route({
    methode: 'GET',
    pfad: `${M}/feststellungen`,
    query: StandQuerySchema,
    handler: (c) => ladeFeststellungen(dienstKontext(c), { ...c.query, ...mandant(c) }),
  });
  r.route({
    methode: 'GET',
    pfad: F,
    query: StandQuerySchema,
    handler: (c) => ladeFeststellung(dienstKontext(c), { ...c.query, ...fst(c) }),
  });

  // ------------------------------------------------------------ S10 Schreiben
  r.route({
    methode: 'POST',
    pfad: `${M}/feststellungen`,
    body: FeststellungErfassenBodySchema,
    status: 201,
    handler: (c) => erfasseFeststellung(dienstKontext(c), { ...c.body, ...mandant(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/weiter`,
    body: FeststellungWeiterBodySchema,
    handler: (c) => schalteFeststellungWeiter(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/p153`,
    body: P153BodySchema,
    handler: (c) => entscheideP153(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/wuerdigung`,
    body: WuerdigungBodySchema,
    handler: (c) => aktualisiereWuerdigung(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/erklaerungen`,
    body: ErklaerungBodySchema,
    status: 201,
    handler: (c) => fuegeErklaerungHinzu(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/massnahmen`,
    body: MassnahmeBodySchema,
    status: 201,
    handler: (c) => legeMassnahmeAn(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/nachkontrolle`,
    body: NachkontrolleBodySchema,
    status: 201,
    handler: (c) => legeNachkontrolleAn(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/verwerfen/beantragen`,
    body: VerwerfenBeantragenBodySchema,
    handler: (c) => beantrageFeststellungVerwerfen(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/verwerfen/bestaetigen`,
    handler: (c) => bestaetigeFeststellungVerwerfen(dienstKontext(c), fst(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/verwerfen/ablehnen`,
    handler: (c) => lehneFeststellungVerwerfenAb(dienstKontext(c), fst(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${F}/vertraulich`,
    body: VertraulichBodySchema,
    handler: (c) => setzeVertraulich(dienstKontext(c), { ...c.body, ...fst(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/massnahmen/:massnahmeId/erledigen`,
    body: MassnahmeErledigenBodySchema,
    handler: (c) =>
      erledigeMassnahme(dienstKontext(c), {
        ...c.body,
        ...mandant(c),
        massnahmeId: p(c, 'massnahmeId'),
      }),
  });

  // ---------------------------------------------------------------- S11 Lesen
  r.route({
    methode: 'GET',
    pfad: `${M}/ereignisse`,
    query: StandQuerySchema,
    handler: (c) => ladeEreignisse(dienstKontext(c), { ...c.query, ...mandant(c) }),
  });
  r.route({
    methode: 'GET',
    pfad: E,
    query: StandQuerySchema,
    handler: (c) => ladeEreignis(dienstKontext(c), { ...c.query, ...erg(c) }),
  });
  r.route({
    methode: 'GET',
    pfad: `${E}/anlagen/:sha256`,
    handler: (c) => ladeEreignisAnlage(dienstKontext(c), { ...erg(c), sha256: p(c, 'sha256') }),
  });

  // ------------------------------------------------------------ S11 Schreiben
  r.route({
    methode: 'POST',
    pfad: `${M}/ereignisse`,
    body: EreignisErfassenBodySchema,
    status: 201,
    handler: (c) => erfasseEreignis(dienstKontext(c), { ...c.body, ...mandant(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/in-pruefung`,
    handler: (c) => nehmeEreignisInPruefung(dienstKontext(c), erg(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/folgen`,
    body: FolgeHinzufuegenBodySchema,
    status: 201,
    handler: (c) => fuegeFolgeHinzu(dienstKontext(c), { ...c.body, ...erg(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/folgen/anlegen`,
    body: FolgenAnlegenBodySchema,
    handler: (c) => legeFolgenAn(dienstKontext(c), { ...c.body, ...erg(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/folgen/:folgeId/erledigen`,
    handler: (c) => erledigeFolge(dienstKontext(c), folge(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/folgen/:folgeId/verwerfen`,
    body: VerwerfenBeantragenBodySchema,
    handler: (c) => verwerfeFolge(dienstKontext(c), { ...c.body, ...folge(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/abschliessen`,
    handler: (c) => schliesseEreignisAb(dienstKontext(c), erg(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/verwerfen/beantragen`,
    body: VerwerfenBeantragenBodySchema,
    handler: (c) => beantrageEreignisVerwerfen(dienstKontext(c), { ...c.body, ...erg(c) }),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/verwerfen/bestaetigen`,
    handler: (c) => bestaetigeEreignisVerwerfen(dienstKontext(c), erg(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${E}/verwerfen/ablehnen`,
    handler: (c) => lehneEreignisVerwerfenAb(dienstKontext(c), erg(c)),
  });

  // ------------------------------------------------------------------ P3 Portal
  r.route({
    methode: 'GET',
    pfad: `${M}/portal/ereignisse`,
    portal: true,
    handler: (c) => ladePortalMeldungen(dienstKontext(c), mandant(c)),
  });
  r.route({
    methode: 'POST',
    pfad: `${M}/portal/ereignisse`,
    portal: true,
    body: PortalMeldungBodySchema,
    status: 201,
    handler: (c) => meldeEreignis(dienstKontext(c), { ...c.body, ...mandant(c) }),
  });
}
