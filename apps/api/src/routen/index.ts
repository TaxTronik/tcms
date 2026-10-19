// Registriert alle Fachrouten des Dienstes (Welle 2). Jeder Bereich hat eine
// eigene Datei; hier wird nur verdrahtet.
import type { Tx } from '@tcms/db';
import type { Routen } from '../routen';
import { registriereDurchfuehrung } from './durchfuehrung';
import { registriereFeststellungenEreignisse } from './feststellungen-ereignisse';
import { registriereLesepfade } from './lesepfade';
import { registriereProgrammBeschreibung } from './programm-beschreibung';
import { registriereRisikenKontrollen } from './risiken-kontrollen';

export function registriereAlle(r: Routen<Tx>): void {
  registriereLesepfade(r);
  registriereDurchfuehrung(r);
  registriereRisikenKontrollen(r);
  registriereFeststellungenEreignisse(r);
  registriereProgrammBeschreibung(r);
}
