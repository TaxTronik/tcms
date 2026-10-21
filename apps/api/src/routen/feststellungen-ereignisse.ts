// =============================================================================
// Routen des Bereichs „feststellungen-ereignisse" (Welle 2): Feststellungen
// und Maßnahmen, Ereigniseingang, Portal-Meldung, Länder-Monitor. Jede Route
// ruft genau eine Funktion aus @tcms/service; Rechte prüft ausschließlich der
// Service (ADR 0001 §2). Methode, Muster und Schemas stehen im
// Endpunktregister (`ENDPUNKTE`). Die Mandantenbindung (`cli.id == :mandantId`)
// erzwingt die Prüfkette vorher (ADR 0001 §3.3).
//
// Eingabe = Body + Pfadparameter. Pfadparameter werden NACH dem Body
// eingesetzt: Selbst ein Body-Schema, das versehentlich `mandantId` oder eine
// Objekt-ID zuließe, könnte den Pfad nicht überschreiben.
// =============================================================================

import { ENDPUNKTE } from '@tcms/contract';
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
  fuegeLandHinzu,
  ladeEreignis,
  ladeEreignisAnlage,
  ladeEreignisAnlagenJeDokument,
  ladeEreignisse,
  ladeFeststellung,
  ladeFeststellungen,
  ladeLaender,
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
  speichereLandStaende,
  verwerfeFolge,
} from '@tcms/service';
import type { Routen, RoutenKontext } from '../routen';
import { dienstKontext } from './kontext';

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
  r.endpunkt(ENDPUNKTE.feststellungenLesen, (c) =>
    ladeFeststellungen(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.feststellungLesen, (c) =>
    ladeFeststellung(dienstKontext(c), { ...c.query, ...fst(c) }),
  );

  // ------------------------------------------------------------ S10 Schreiben
  r.endpunkt(ENDPUNKTE.feststellungErfassen, (c) =>
    erfasseFeststellung(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.feststellungWeiterschalten, (c) =>
    schalteFeststellungWeiter(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.p153Entscheiden, (c) =>
    entscheideP153(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.wuerdigungAktualisieren, (c) =>
    aktualisiereWuerdigung(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.erklaerungHinzufuegen, (c) =>
    fuegeErklaerungHinzu(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.massnahmeAnlegen, (c) =>
    legeMassnahmeAn(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.nachkontrolleAnlegen, (c) =>
    legeNachkontrolleAn(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.feststellungVerwerfenBeantragen, (c) =>
    beantrageFeststellungVerwerfen(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.feststellungVerwerfenBestaetigen, (c) =>
    bestaetigeFeststellungVerwerfen(dienstKontext(c), fst(c)),
  );
  r.endpunkt(ENDPUNKTE.feststellungVerwerfenAblehnen, (c) =>
    lehneFeststellungVerwerfenAb(dienstKontext(c), fst(c)),
  );
  r.endpunkt(ENDPUNKTE.feststellungVertraulichSetzen, (c) =>
    setzeVertraulich(dienstKontext(c), { ...c.body, ...fst(c) }),
  );
  r.endpunkt(ENDPUNKTE.massnahmeErledigen, (c) =>
    erledigeMassnahme(dienstKontext(c), {
      ...c.body,
      ...mandant(c),
      massnahmeId: p(c, 'massnahmeId'),
    }),
  );

  // ---------------------------------------------------------------- S11 Lesen
  r.endpunkt(ENDPUNKTE.ereignisseLesen, (c) =>
    ladeEreignisse(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.ereignisLesen, (c) =>
    ladeEreignis(dienstKontext(c), { ...c.query, ...erg(c) }),
  );
  r.endpunkt(ENDPUNKTE.ereignisAnlageLesen, (c) =>
    ladeEreignisAnlage(dienstKontext(c), { ...erg(c), sha256: p(c, 'sha256') }),
  );
  // Abgleich der kanzleikonsole (tcms-s11): Pfadparameter nach der Query.
  r.endpunkt(ENDPUNKTE.ereignisAnlagenJeDokumentLesen, (c) =>
    ladeEreignisAnlagenJeDokument(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );

  // ------------------------------------------------------------ S11 Schreiben
  r.endpunkt(ENDPUNKTE.ereignisErfassen, (c) =>
    erfasseEreignis(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.ereignisInPruefungNehmen, (c) =>
    nehmeEreignisInPruefung(dienstKontext(c), erg(c)),
  );
  r.endpunkt(ENDPUNKTE.folgeHinzufuegen, (c) =>
    fuegeFolgeHinzu(dienstKontext(c), { ...c.body, ...erg(c) }),
  );
  r.endpunkt(ENDPUNKTE.folgenAnlegen, (c) =>
    legeFolgenAn(dienstKontext(c), { ...c.body, ...erg(c) }),
  );
  r.endpunkt(ENDPUNKTE.folgeErledigen, (c) => erledigeFolge(dienstKontext(c), folge(c)));
  r.endpunkt(ENDPUNKTE.folgeVerwerfen, (c) =>
    verwerfeFolge(dienstKontext(c), { ...c.body, ...folge(c) }),
  );
  r.endpunkt(ENDPUNKTE.ereignisAbschliessen, (c) => schliesseEreignisAb(dienstKontext(c), erg(c)));
  r.endpunkt(ENDPUNKTE.ereignisVerwerfenBeantragen, (c) =>
    beantrageEreignisVerwerfen(dienstKontext(c), { ...c.body, ...erg(c) }),
  );
  r.endpunkt(ENDPUNKTE.ereignisVerwerfenBestaetigen, (c) =>
    bestaetigeEreignisVerwerfen(dienstKontext(c), erg(c)),
  );
  r.endpunkt(ENDPUNKTE.ereignisVerwerfenAblehnen, (c) =>
    lehneEreignisVerwerfenAb(dienstKontext(c), erg(c)),
  );

  // ------------------------------------------------------------------ P3 Portal
  r.endpunkt(ENDPUNKTE.portalMeldungenLesen, (c) =>
    ladePortalMeldungen(dienstKontext(c), mandant(c)),
  );
  r.endpunkt(ENDPUNKTE.portalMeldungErfassen, (c) =>
    meldeEreignis(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );

  // ---------------------------------------------------------- S12 Länder-Monitor
  r.endpunkt(ENDPUNKTE.laenderLesen, (c) =>
    ladeLaender(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.landHinzufuegen, (c) =>
    fuegeLandHinzu(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.landStaendeSpeichern, (c) =>
    speichereLandStaende(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
}
