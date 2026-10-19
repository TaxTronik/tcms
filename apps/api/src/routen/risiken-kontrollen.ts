// =============================================================================
// Routen des Bereichs „risiken-kontrollen" (Welle 2): Risikoinventar,
// Kontrollmatrix, Geschäftsprofil. Jede Route ruft genau eine Funktion aus
// @tcms/service (ADR 0001 §2); Rechte, Zustände und Sperren prüft nur der
// Service. Alle Pfade liegen unter `/v1/mandanten/:mandantId/…` (Bindung an
// `cli.id`, nur Kanzleipersonen – keine Portal-Endpunkte). Methode, Muster und
// Schemas stehen im Endpunktregister (`ENDPUNKTE`). Schreibende Routen nehmen
// keinen Stichtag an (TS-07): Ohne Query-Schema weist der Dienst jede Query
// mit 400 ab. Pfadparameter werden zuletzt eingesetzt.
// =============================================================================

import { ENDPUNKTE } from '@tcms/contract';
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

type Params = { params: Readonly<Record<string, string>> };
const mandant = (c: Params) => ({ mandantId: c.params.mandantId! });
const risiko = (c: Params) => ({ ...mandant(c), risikoId: c.params.risikoId! });
const kontrolle = (c: Params) => ({ ...mandant(c), kontrolleId: c.params.kontrolleId! });

export function registriereRisikenKontrollen(r: Routen<Tx>): void {
  // --- Risiken ---------------------------------------------------------------
  r.endpunkt(ENDPUNKTE.risikenLesen, (c) =>
    ladeRisiken(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikoLesen, (c) =>
    ladeRisiko(dienstKontext(c), { ...c.query, ...risiko(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikoNeuBewerten, (c) =>
    risikoNeuBewerten(dienstKontext(c), { ...c.body, ...risiko(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikoBewertungBestaetigen, (c) =>
    risikoBewertungBestaetigen(dienstKontext(c), { ...c.body, ...risiko(c) }),
  );
  r.endpunkt(ENDPUNKTE.uebersteuerungBeantragen, (c) =>
    uebersteuerungBeantragen(dienstKontext(c), { ...c.body, ...risiko(c) }),
  );
  r.endpunkt(ENDPUNKTE.uebersteuerungEntscheiden, (c) =>
    uebersteuerungEntscheiden(dienstKontext(c), {
      ...c.body,
      ...mandant(c),
      uebersteuerungId: c.params.uebersteuerungId!,
    }),
  );
  r.endpunkt(ENDPUNKTE.risikenFreigabeEinreichen, (c) =>
    risikenZurFreigabe(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikenFreigeben, (c) =>
    risikenFreigeben(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikoZurueckweisen, (c) =>
    risikoZurueckweisen(dienstKontext(c), { ...c.body, ...risiko(c) }),
  );
  r.endpunkt(ENDPUNKTE.risikoakzeptanzAnfordern, (c) =>
    risikoakzeptanzAnfordern(dienstKontext(c), { ...c.body, ...risiko(c) }),
  );

  // --- Kontrollen ------------------------------------------------------------
  r.endpunkt(ENDPUNKTE.kontrollenLesen, (c) =>
    ladeKontrollen(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.kontrolleLesen, (c) =>
    ladeKontrolle(dienstKontext(c), { ...c.query, ...kontrolle(c) }),
  );
  r.endpunkt(ENDPUNKTE.kontrolleDesignBeurteilen, (c) =>
    designBeurteilen(dienstKontext(c), { ...c.body, ...kontrolle(c) }),
  );
  r.endpunkt(ENDPUNKTE.frequenzAbweichungBeantragen, (c) =>
    frequenzAbweichungBeantragen(dienstKontext(c), { ...c.body, ...kontrolle(c) }),
  );
  r.endpunkt(ENDPUNKTE.frequenzAbweichungEntscheiden, (c) =>
    frequenzAbweichungEntscheiden(dienstKontext(c), { ...c.body, ...kontrolle(c) }),
  );
  r.endpunkt(ENDPUNKTE.frequenzAbweichungAufheben, (c) =>
    frequenzAbweichungAufheben(dienstKontext(c), { ...c.body, ...kontrolle(c) }),
  );
  r.endpunkt(ENDPUNKTE.verantwortlicheAendern, (c) =>
    verantwortlicheAendern(dienstKontext(c), { ...c.body, ...kontrolle(c) }),
  );

  // --- Geschäftsprofil ------------------------------------------------------
  r.endpunkt(ENDPUNKTE.profilLesen, (c) =>
    ladeProfil(dienstKontext(c), { ...c.query, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.profilAendern, (c) =>
    profilAendern(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
  r.endpunkt(ENDPUNKTE.profilRisikoAufnehmen, (c) =>
    vorgeschlagenesRisikoAufnehmen(dienstKontext(c), { ...c.body, ...mandant(c) }),
  );
}
