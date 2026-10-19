import 'server-only';
import type { Akteur } from '@tcms/contract';
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
export function mitBezug(a: Akteur, mandantId: string): Akteur {
  return a.art === 'KANZLEI' ? fuerMandant(a, mandantId) : a;
}

export function kannBearbeiten(a: Akteur, m: MandantRef): boolean {
  return R.kannBearbeiten(mitBezug(a, m.id), m.id);
}

export function kannWuerdigen(a: Akteur, m: MandantRef): boolean {
  return R.kannWuerdigen(mitBezug(a, m.id), m.id);
}

export function kannDurchfuehren(
  a: Akteur,
  k: R.KontrollZustaendigkeit,
  mandantId: string,
  rollen: readonly R.KontaktRolle[] = [],
): boolean {
  return R.kannDurchfuehren(mitBezug(a, mandantId), k, mandantId, rollen);
}

export function kannGegenzeichnen(
  a: Akteur,
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
