// Registriert alle Fachrouten des Dienstes (Welle 2). Jeder Bereich hat eine
// eigene Datei; hier wird nur verdrahtet.
import type { Tx } from '@tcms/db';
import type { CodeSchluessel } from '@tcms/service';
import type { Routen } from '../routen';
import { registriereDurchfuehrung } from './durchfuehrung';
import { registriereFeststellungenEreignisse } from './feststellungen-ereignisse';
import { registriereLesepfade } from './lesepfade';
import { registriereProgrammBeschreibung } from './programm-beschreibung';
import { registriereRisikenKontrollen } from './risiken-kontrollen';

/** Umgebung der Fachrouten aus der Konfiguration des Dienstes. */
export interface RoutenUmgebung {
  /** Schlüsselbund der Bestätigungscodes (`TCMS_CODE_SCHLUESSEL`, Pflicht). */
  codes: CodeSchluessel;
}

export function registriereAlle(r: Routen<Tx>, u: RoutenUmgebung): void {
  registriereLesepfade(r);
  registriereDurchfuehrung(r);
  registriereRisikenKontrollen(r);
  registriereFeststellungenEreignisse(r);
  registriereProgrammBeschreibung(r, u.codes);
}
