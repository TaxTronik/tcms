import 'server-only';
import type { PersonAkteur } from '@tcms/contract';
import * as R from '@tcms/service';
import { fuerMandant } from './demo';

// =============================================================================
// Anbindung der Rechte an die Demo. Die Regeln stehen ausschließlich in
// @tcms/service (ADR 0001 §5); hier setzt die Demo nur – wie die kanzleikonsole
// mit `cli` – den Mandantenbezug des Akteurs auf den Mandanten des Objekts,
// um das es geht. Für Mandantenkontakte bleibt der Akteur unverändert (ihr
// Mandant steht fest); ihre Rollen kommen aus MandantKontaktRolle.
// =============================================================================

export { istBerufstraeger, kannVerwalten, zweitePerson } from '@tcms/service';

interface MandantRef {
  id: string;
}

/** Akteur mit Bezug auf diesen Mandanten (Kanzlei) bzw. unverändert (Mandantenkontakt). */
export function mitBezug(a: PersonAkteur, mandantId: string): PersonAkteur {
  return a.art === 'KANZLEI' ? fuerMandant(a, mandantId) : a;
}

export function kannBearbeiten(a: PersonAkteur, m: MandantRef): boolean {
  return R.kannBearbeiten(mitBezug(a, m.id), m.id);
}

export function kannWuerdigen(a: PersonAkteur, m: MandantRef): boolean {
  return R.kannWuerdigen(mitBezug(a, m.id), m.id);
}

/** Verwerfen bestätigen: zweite Person, bei möglicher Steuerwirkung mit Würdigungsrecht. */
export function kannVerwerfenBestaetigen(
  a: PersonAkteur,
  m: MandantRef,
  beantragtVon: string | null,
  auswirkung: R.Auswirkung,
): R.Entscheidung {
  return R.kannVerwerfenBestaetigen(mitBezug(a, m.id), m.id, beantragtVon, auswirkung);
}

/** TS-04: „NEIN" beim Anlegen nur mit Würdigungsrecht, sonst „UNKLAR". */
export function auswirkungBeimAnlegen(
  a: PersonAkteur,
  m: MandantRef,
  angegeben: R.Auswirkung,
): R.Auswirkung {
  return R.auswirkungBeimAnlegen(mitBezug(a, m.id), m.id, angegeben);
}

export function kannDurchfuehren(
  a: PersonAkteur,
  k: R.KontrollZustaendigkeit,
  mandantId: string,
  rollen: readonly R.KontaktRolle[] = [],
): boolean {
  return R.kannDurchfuehren(mitBezug(a, mandantId), k, mandantId, rollen);
}

export function kannGegenzeichnen(
  a: PersonAkteur,
  k: R.KontrollZustaendigkeit,
  m: MandantRef,
  durchgefuehrtVon: string | null,
  mandantBestaetigt = false,
  rollen: readonly R.KontaktRolle[] = [],
): R.Entscheidung {
  return R.kannGegenzeichnen(
    mitBezug(a, m.id),
    k,
    m.id,
    durchgefuehrtVon,
    mandantBestaetigt,
    rollen,
  );
}
