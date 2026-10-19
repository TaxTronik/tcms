// =============================================================================
// Routen des Bereichs „programm-beschreibung" (Welle 2): Einrichtungsassistent,
// CMS-Beschreibung, Freigaben (Kanzlei und Portal), Kommunikation und
// Postausgang. Keine Logik und keine Rechteprüfung hier: Jede Route ruft genau
// eine Funktion aus @tcms/service (ADR 0001 §2); Rechte, Mandantenzugehörigkeit
// der Objekt-IDs und Zustandsübergänge prüft der Service. Methode, Muster und
// Schemas stehen im Endpunktregister (`ENDPUNKTE`).
//
// Pfade unter /v1/mandanten/:mandantId/… sind an `cli.id` gebunden (routen.ts);
// Portal-Endpunkte erreichen Mandantenkontakte. Der Postausgang ist tenantweit
// (/v1/nachrichten) und nur für den Systemakteur (Register `NUR_SYSTEM`,
// `systemKontext`, im Service erneut geprüft).
// Pfadparameter werden nach Body und Query eingesetzt (überschreiben sie).
// =============================================================================

import { ENDPUNKTE } from '@tcms/contract';
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
  ladeFreigabenHistorie,
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
import { dienstKontext, systemKontext } from './kontext';

type Params = { params: Readonly<Record<string, string>> };
const mandant = (c: Params) => ({ mandantId: c.params.mandantId! });
const version = (c: Params) => ({ ...mandant(c), versionId: c.params.versionId! });
const freigabe = (c: Params) => ({ ...mandant(c), freigabeId: c.params.freigabeId! });

export function registriereProgrammBeschreibung(r: Routen<Tx>): void {
  // ---- Postausgang (tenantweit, nur Systemakteur) ----
  r.endpunkt(ENDPUNKTE.nachrichtenOffenLesen, (c) =>
    ladeOffeneNachrichten(systemKontext(c), { ...c.query }),
  );
  r.endpunkt(ENDPUNKTE.nachrichtZugestelltMelden, (c) =>
    bestaetigeNachrichtZustellung(systemKontext(c), { nachrichtId: c.params.nachrichtId! }),
  );

  // ---- Einrichtungsassistent ----
  r.endpunkt(ENDPUNKTE.einrichtungLesen, (c) =>
    ladeEinrichtung(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.einrichtungEntwurfSpeichern, (c) =>
    speichereEinrichtungsschritt(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.programmAnlegen, (c) =>
    legeProgrammAn(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );

  // ---- CMS-Beschreibung ----
  r.endpunkt(ENDPUNKTE.beschreibungLesen, (c) =>
    ladeBeschreibung(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.beschreibungsversionAnlegen, (c) =>
    legeBeschreibungsversionAn(dienstKontext(c), mandant(c)),
  );
  r.endpunkt(ENDPUNKTE.beschreibungsabschnittSpeichern, (c) =>
    speichereBeschreibungsabschnitt(dienstKontext(c), { ...c.body, ...version(c) }),
  );
  r.endpunkt(ENDPUNKTE.beschreibungZurReviewGeben, (c) =>
    gibBeschreibungZurReview(dienstKontext(c), version(c)),
  );
  r.endpunkt(ENDPUNKTE.beschreibungsreviewAbschliessen, (c) =>
    schliesseBeschreibungsreviewAb(dienstKontext(c), version(c)),
  );
  r.endpunkt(ENDPUNKTE.beschreibungsreviewZurueckweisen, (c) =>
    weiseBeschreibungsreviewZurueck(dienstKontext(c), { ...c.body, ...version(c) }),
  );
  r.endpunkt(ENDPUNKTE.beschreibungsfreigabeAnfordern, (c) =>
    fordereBeschreibungsfreigabeAn(dienstKontext(c), { ...c.body, ...version(c) }),
  );

  // ---- Freigaben: Neuadressierung (Kanzlei) ----
  r.endpunkt(ENDPUNKTE.freigabeNeuadressieren, (c) =>
    adressiereFreigabeNeu(dienstKontext(c), { ...c.body, ...freigabe(c) }),
  );

  // ---- Portal ----
  r.endpunkt(ENDPUNKTE.portalFreigabenLesen, (c) =>
    ladePortalFreigaben(dienstKontext(c), mandant(c)),
  );
  r.endpunkt(ENDPUNKTE.portalFreigabeCodeAnfordern, (c) =>
    fordereFreigabeCodeAn(dienstKontext(c), freigabe(c)),
  );
  r.endpunkt(ENDPUNKTE.portalFreigabeErteilen, (c) =>
    erteileFreigabe(dienstKontext(c), { ...c.body, ...freigabe(c) }),
  );
  r.endpunkt(ENDPUNKTE.portalKenntnisnahmeBestaetigen, (c) =>
    bestaetigeKenntnisnahme(dienstKontext(c), { ...c.body, ...freigabe(c) }),
  );

  // ---- Kommunikation ----
  r.endpunkt(ENDPUNKTE.freigabenHistorieLesen, (c) =>
    ladeFreigabenHistorie(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
}
