// =============================================================================
// Rechte (Fachkonzept Abschnitt 13). Serverseitig in jeder Action geprüft,
// nie nur durch Ausblenden. Reine Funktionen, damit sie testbar bleiben.
// =============================================================================

import type { Nutzer } from './sitzung';

export interface MandantZustaendigkeit {
  id: string;
  berufstraegerId: string;
  bearbeitungId: string;
}

export function istBerufstraeger(n: Pick<Nutzer, 'art' | 'kanzleiRolle'>): boolean {
  return n.art === 'KANZLEI' && n.kanzleiRolle === 'BERUFSTRAEGER';
}

/** Bearbeiten: Admin/Partner, zugeordnete Berufsträger und Hauptbearbeitung. */
export function kannBearbeiten(n: Nutzer, m: MandantZustaendigkeit): boolean {
  if (n.art !== 'KANZLEI') return false;
  return n.istAdmin || n.id === m.berufstraegerId || n.id === m.bearbeitungId;
}

/** §-153-Würdigung: nur Berufsträger:innen mit Zuständigkeit oder Admin-Berufsträger. */
export function kannWuerdigen(n: Nutzer, m: MandantZustaendigkeit): boolean {
  return istBerufstraeger(n) && (n.istAdmin || n.id === m.berufstraegerId);
}

export interface KontrollZustaendigkeit {
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  partei: 'KANZLEI' | 'MANDANT';
}

export function kannDurchfuehren(n: Nutzer, k: KontrollZustaendigkeit, mandantId: string): boolean {
  const zugewiesen = n.id === k.durchfuehrendId || n.id === k.vertretungId;
  if (k.partei === 'MANDANT') return zugewiesen && n.art === 'MANDANT' && n.mandantId === mandantId;
  return zugewiesen && n.art === 'KANZLEI';
}

/**
 * Gegenzeichnen, zweistufig modelliert. Nie durch die durchführende Person.
 * - Mandant (Bestätigung): nur wenn die Kontrolle eine Gegenzeichnung beim
 *   Mandanten vorsieht; zweite Person desselben Mandanten.
 * - Kanzlei (Abschluss): zugewiesene Gegenzeichnung oder zuständige:r
 *   Berufsträger:in; bei Mandanten-Gegenzeichnung erst nach der Bestätigung.
 */
export function kannGegenzeichnen(
  n: Nutzer,
  k: KontrollZustaendigkeit,
  m: MandantZustaendigkeit,
  durchgefuehrtVon: string | null,
  mandantBestaetigt = false,
): { erlaubt: boolean; grund: string | null } {
  if (durchgefuehrtVon && n.id === durchgefuehrtVon) {
    return { erlaubt: false, grund: 'Gegenzeichnung muss durch eine andere Person erfolgen' };
  }
  if (n.art === 'MANDANT') {
    if (!k.gegenzeichnungMandant)
      return { erlaubt: false, grund: 'Gegenzeichnung erfolgt durch die Kanzlei' };
    const ok = n.mandantId === m.id;
    return {
      erlaubt: ok,
      grund: ok ? null : 'Bestätigung durch eine zweite Person beim Mandanten',
    };
  }
  if (k.gegenzeichnungMandant && !mandantBestaetigt) {
    return {
      erlaubt: false,
      grund: 'Bestätigung durch eine zweite Person beim Mandanten steht aus',
    };
  }
  const ok = n.id === k.gegenzeichnerId || (istBerufstraeger(n) && kannBearbeiten(n, m));
  return {
    erlaubt: ok,
    grund: ok ? null : 'Nur die zugewiesene Gegenzeichnung oder zuständige Berufsträger:innen',
  };
}

/** Vier-Augen: Freigebende Person ≠ beantragende Person. */
export function zweitePerson(n: Nutzer, beantragtVon: string | null | undefined): boolean {
  return !!beantragtVon && n.id !== beantragtVon;
}

export function istGesetzlicherVertreter(n: Nutzer): boolean {
  return n.art === 'MANDANT' && n.mandantRolle === 'GESETZLICHER_VERTRETER';
}
