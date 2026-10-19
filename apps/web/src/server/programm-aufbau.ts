import 'server-only';
import type { PersonKurz } from './kontext';

// =============================================================================
// Aufbau eines Tax-CMS-Programms – die Regeln liegen in @tcms/service
// (bereiche/programm-beschreibung/aufbau.ts). Diese Datei hält nur die
// bisherigen Namen für Seiten und Actions der Demo; das Umfeld der Demo trägt
// zusätzlich Anzeigedaten aus dem Demo-Verzeichnis.
// =============================================================================

export {
  appetitAusZielen as appetitAus,
  aufbauRollen as rollen,
  berechnePlan,
  pruefeKontrollZustaendigkeiten as pruefeKontrollen,
  standardKontrollZustaendigkeit as standardZustaendigkeit,
  type AufbauPlan as Plan,
  type AufbauPlanKontrolle as PlanKontrolle,
  type AufbauPlanRisiko as PlanRisiko,
  type AufbauRollen as Rollen,
  type AufbauZustaendigkeit as Zustaendigkeit,
} from '@tcms/service';

/** Umfeld der Demo (strukturgleich zu `AufbauUmfeld` aus @tcms/service, mit Namen). */
export interface Umfeld {
  mandant: { id: string; name: string; berufstraegerId: string; bearbeitungId: string };
  kanzlei: PersonKurz[];
  mandantPersonen: PersonKurz[];
  heute: Date;
}
