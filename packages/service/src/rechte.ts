// =============================================================================
// Rechte (ADR 0001 §5, Fachkonzept Abschnitt 13). Reine Funktionen über den
// geprüften Akteur; serverseitig in jeder Operation geprüft, nie nur durch
// Ausblenden (AGENTS.md Regel 4).
//
// Grundsätze:
//   - Kanzleipersonen handeln nur für den Mandanten, den die kanzleikonsole in
//     der Akteursbestätigung bestätigt (`cli`); ohne `cli` oder bei einem
//     anderen Mandanten gibt es kein Recht, auch nicht für Admins (TS-03).
//     Einzige Ausnahme: Die Kanzleileitung liest vertrauliche Inhalte auch ohne
//     Bezug (`liestAlleVertraulichen`, tcms-s12); einen Mandantenpfad öffnet
//     das nicht (`kannLesen`), Schreibrechte gibt es daraus keine.
//   - Mandantenkontakte brauchen eine aktive Rolle beim eigenen Mandanten
//     (MandantKontaktRolle); ohne aktive Rolle kein Zugriff.
//   - IDs werden ohne Rücksicht auf Groß-/Kleinschreibung verglichen, damit
//     dieselbe Person nie als „zweite Person" durchgeht.
// =============================================================================

import type { Akteur, MandantBezug, VerweigerungGrund } from '@tcms/contract';
import type { MandantRolle } from '@tcms/domain';

/** Rollen der Mandantenseite; eine Quelle in `@tcms/domain` (`MANDANT_ROLLEN`). */
export type { MandantRolle };

/** Rolle eines Mandantenkontakts (Zeile aus MandantKontaktRolle). */
export interface KontaktRolle {
  mandantId: string;
  kontaktId: string;
  rolle: MandantRolle;
  aktiv: boolean;
}

export interface KontrollZustaendigkeit {
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  partei: 'KANZLEI' | 'MANDANT';
}

/**
 * Entscheidung einer Rechtefunktion: bei Ablehnung mit Meldung (`grund`) und
 * maschinenlesbarem Grund (`verweigerung`, wird zu `fehler.grund` des 403).
 */
export type Entscheidung =
  | { erlaubt: true; grund: null; verweigerung: null }
  | { erlaubt: false; grund: string; verweigerung: VerweigerungGrund };

const ERLAUBT: Entscheidung = Object.freeze({ erlaubt: true, grund: null, verweigerung: null });
const abgelehnt = (verweigerung: VerweigerungGrund, grund: string): Entscheidung => ({
  erlaubt: false,
  grund,
  verweigerung,
});

/** Gleiche ID (UUID-Vergleich ohne Groß-/Kleinschreibung); leere Werte sind nie gleich. */
export function gleicheId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Bestätigter Bezug einer Kanzleiperson zu genau diesem Mandanten, sonst null. */
export function mandantBezug(a: Akteur, mandantId: string): MandantBezug | null {
  if (a.art !== 'KANZLEI' || !a.mandant) return null;
  return gleicheId(a.mandant.id, mandantId) ? a.mandant : null;
}

/** Aktive Rollen eines Mandantenkontakts beim angegebenen (eigenen) Mandanten. */
export function aktiveRollen(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
): Set<MandantRolle> {
  const out = new Set<MandantRolle>();
  if (a.art !== 'MANDANT' || !gleicheId(a.mandantId, mandantId)) return out;
  for (const r of rollen) {
    if (r.aktiv && gleicheId(r.kontaktId, a.id) && gleicheId(r.mandantId, mandantId)) {
      out.add(r.rolle);
    }
  }
  return out;
}

export function istBerufstraeger(a: Akteur): boolean {
  return a.art === 'KANZLEI' && a.istBerufstraeger;
}

/** Kanzleiweite Verwaltung (z. B. Prüfung der Audit-Kette): Admin/Partner. */
export function kannVerwalten(a: Akteur): boolean {
  return a.art === 'KANZLEI' && a.istAdmin;
}

/**
 * Lesen eines Mandanten: Kanzleiperson mit bestätigtem Bezug zu diesem
 * Mandanten; Mandantenkontakt mit aktiver Rolle beim eigenen Mandanten.
 */
export function kannLesen(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[] = [],
): boolean {
  if (a.art === 'KANZLEI') return mandantBezug(a, mandantId) !== null;
  return aktiveRollen(a, mandantId, rollen).size > 0;
}

/**
 * Portal-Übersicht (P1) lesen: gesetzliche Vertretung und Tax-Compliance-
 * Beauftragte. Mitarbeitende sehen nur ihnen zugewiesene Aufgaben.
 */
export function kannPortalLesen(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
): boolean {
  const r = aktiveRollen(a, mandantId, rollen);
  return r.has('GESETZLICHER_VERTRETER') || r.has('TAX_COMPLIANCE_BEAUFTRAGTER');
}

/**
 * Eine Portal-Meldung (im Portal gemeldetes Ereignis) sehen: gesetzliche
 * Vertretung und Tax-Compliance-Beauftragte alle Meldungen des Mandanten
 * (`kannPortalLesen`), alle anderen nur selbst gemeldete. Eine Regel für die
 * Portal-Übersicht (P1) und die Meldungsliste (P3), RT4-T-04 – vertrauliche
 * Meldungen der Geschäftsführung erreichen Mitarbeitende so auf keinem Weg.
 */
export function siehtPortalMeldung(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
  gemeldetVon: string | null,
): boolean {
  return kannPortalLesen(a, mandantId, rollen) || gleicheId(gemeldetVon, a.id);
}

export function istGesetzlicherVertreter(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
): boolean {
  return aktiveRollen(a, mandantId, rollen).has('GESETZLICHER_VERTRETER');
}

/** Bearbeiten: Kanzleiperson mit Bezug und (Admin, zuständige:r BT oder Hauptbearbeitung). */
export function kannBearbeiten(a: Akteur, mandantId: string): boolean {
  const bezug = mandantBezug(a, mandantId);
  if (!bezug || a.art !== 'KANZLEI') return false;
  return a.istAdmin || bezug.zustaendigBerufstraeger || bezug.hauptbearbeitung;
}

/** §-153-Würdigung (TS-04): Berufsträger:in mit Bezug und (Admin oder zuständig). */
export function kannWuerdigen(a: Akteur, mandantId: string): boolean {
  const bezug = mandantBezug(a, mandantId);
  if (!bezug || a.art !== 'KANZLEI' || !a.istBerufstraeger) return false;
  return a.istAdmin || bezug.zustaendigBerufstraeger;
}

export type Auswirkung = 'JA' | 'NEIN' | 'UNKLAR';

/**
 * Steuerliche Auswirkung beim Anlegen einer Feststellung (TS-04): „NEIN" schließt
 * den §-153-Pfad aus und ist damit eine Würdigungsentscheidung. Ohne
 * `kannWuerdigen` wird die Feststellung als „UNKLAR" (zu würdigen) angelegt.
 */
export function auswirkungBeimAnlegen(
  a: Akteur,
  mandantId: string,
  angegeben: Auswirkung,
): Auswirkung {
  return angegeben === 'NEIN' && !kannWuerdigen(a, mandantId) ? 'UNKLAR' : angegeben;
}

/**
 * Beteiligte Personen einer Feststellung (Fachkonzept §13): erfassend,
 * §-153-würdigend, Verwerfen beantragend und für eine Maßnahme verantwortlich.
 * Einzige Quelle für alle Lader (Feststellungen, Kontext, Durchführung,
 * Audit), die Operationen und die Rechte (tcms-s11, tcms-s12).
 */
export function beteiligteVon(f: {
  erfasstVon: string;
  p153EntschiedenVon: string | null;
  verwerfenBeantragtVon: string | null;
  massnahmen: readonly { verantwortlich: string }[];
}): string[] {
  return [
    f.erfasstVon,
    f.p153EntschiedenVon,
    f.verwerfenBeantragtVon,
    ...f.massnahmen.map((m) => m.verantwortlich),
  ].filter((x): x is string => !!x);
}

/**
 * Kanzleileitung (Produktentscheidung Rey Koxha, 21.10.2026, tcms-s12):
 * Kanzleiperson mit Verwaltungsrecht (`kannVerwalten`, `rol.adm` – in der
 * kanzleikonsole ADMIN und PARTNER) liest alle vertraulichen Inhalte auf allen
 * Lesepfaden (Feststellungen samt Maßnahmen, Begründungen und
 * §-153-Entscheidungen; Kontext, Länder-Monitor, Kennzahlen, Durchführung,
 * Arbeitskorb, Audit mit Namen, Details und Hashes), unabhängig von
 * Beteiligung und Mandantenbezug (`cli`). Einzige Quelle dieser Regel; sie gibt
 * nur Leserecht auf Inhalte: Ob ein Mandantenpfad überhaupt erreichbar ist,
 * entscheidet weiter `kannLesen` (mit `cli`), und Schreibrechte
 * (`kannBearbeiten`, `kannWuerdigen`, …) entstehen daraus nie.
 */
export function liestAlleVertraulichen(a: Akteur): boolean {
  return kannVerwalten(a);
}

/**
 * Vertrauliche Feststellungen (Fachkonzept §13): die Kanzleileitung immer
 * (`liestAlleVertraulichen`, tcms-s12); alle anderen nur als Beteiligte –
 * zuständige:r Berufsträger:in, Hauptbearbeitung und die beteiligten Personen
 * (`beteiligteVon`: erfassend, würdigend, Verwerfen beantragend,
 * verantwortlich), jeweils mit Bezug zum Mandanten. Ohne Bezug (`cli`) sieht
 * außer der Kanzleileitung niemand Inhalte, auch keine persönlich Beteiligten:
 * Ob die Person den Mandanten noch betreut, weiß nur die kanzleikonsole (fail
 * closed). Einzige Regel für alle Lesepfade und die Prüfung der
 * Schreiboperationen (`VERTRAULICH`).
 */
export function kannVertraulichLesen(
  a: Akteur,
  mandantId: string,
  beteiligte: readonly string[],
): boolean {
  if (liestAlleVertraulichen(a)) return true;
  const bezug = mandantBezug(a, mandantId);
  if (!bezug || a.art !== 'KANZLEI') return false;
  return (
    bezug.zustaendigBerufstraeger ||
    bezug.hauptbearbeitung ||
    beteiligte.some((id) => gleicheId(id, a.id))
  );
}

/** Durchführen: zugewiesene Person (oder Vertretung) auf der richtigen Seite. */
export function kannDurchfuehren(
  a: Akteur,
  k: KontrollZustaendigkeit,
  mandantId: string,
  rollen: readonly KontaktRolle[] = [],
): boolean {
  const zugewiesen = gleicheId(a.id, k.durchfuehrendId) || gleicheId(a.id, k.vertretungId);
  if (!zugewiesen) return false;
  if (k.partei === 'MANDANT') {
    return a.art === 'MANDANT' && aktiveRollen(a, mandantId, rollen).size > 0;
  }
  return a.art === 'KANZLEI' && mandantBezug(a, mandantId) !== null;
}

/**
 * Gegenzeichnen, zweistufig modelliert. Nie durch die durchführende Person.
 * - Mandant (Bestätigung): nur wenn die Kontrolle eine Gegenzeichnung beim
 *   Mandanten vorsieht; zweite Person desselben Mandanten mit aktiver Rolle.
 * - Kanzlei (Abschluss): zugewiesene Gegenzeichnung oder zuständige:r
 *   Berufsträger:in mit Bearbeitungsrecht; bei Mandanten-Gegenzeichnung erst
 *   nach der Bestätigung.
 */
export function kannGegenzeichnen(
  a: Akteur,
  k: KontrollZustaendigkeit,
  mandantId: string,
  durchgefuehrtVon: string | null,
  mandantBestaetigt = false,
  rollen: readonly KontaktRolle[] = [],
): Entscheidung {
  if (gleicheId(a.id, durchgefuehrtVon)) {
    return abgelehnt('VIER_AUGEN', 'Gegenzeichnung muss durch eine andere Person erfolgen');
  }
  if (a.art === 'MANDANT') {
    if (!k.gegenzeichnungMandant)
      return abgelehnt('PARTEI', 'Gegenzeichnung erfolgt durch die Kanzlei');
    return aktiveRollen(a, mandantId, rollen).size > 0
      ? ERLAUBT
      : abgelehnt('PORTAL_ROLLE', 'Bestätigung durch eine zweite Person beim Mandanten');
  }
  if (!mandantBezug(a, mandantId)) {
    return abgelehnt('GEGENZEICHNEN', 'Kein Zugriff auf diesen Mandanten');
  }
  if (k.gegenzeichnungMandant && !mandantBestaetigt) {
    return abgelehnt(
      'GEGENZEICHNEN',
      'Bestätigung durch eine zweite Person beim Mandanten steht aus',
    );
  }
  const ok =
    gleicheId(a.id, k.gegenzeichnerId) || (istBerufstraeger(a) && kannBearbeiten(a, mandantId));
  return ok
    ? ERLAUBT
    : abgelehnt(
        'GEGENZEICHNEN',
        'Nur die zugewiesene Gegenzeichnung oder zuständige Berufsträger:innen',
      );
}

/** Vier-Augen: entscheidende Person ≠ beantragende Person (und beantragt muss gesetzt sein). */
export function zweitePerson(a: Akteur, beantragtVon: string | null | undefined): boolean {
  return !!beantragtVon && !gleicheId(a.id, beantragtVon);
}

/**
 * Verwerfen einer Feststellung bestätigen (AGENTS.md Regeln 4 und 5, TS-04):
 * immer eine zweite Person. Ist eine steuerliche Auswirkung nicht
 * ausgeschlossen (Auswirkung nicht „NEIN"), beendet das Verwerfen den
 * §-153-Pfad und ist damit eine Würdigungsentscheidung: zusätzlich
 * `kannWuerdigen` (Entscheidung des Produktverantwortlichen). Das
 * Bearbeitungsrecht prüft der Aufrufer.
 */
export function kannVerwerfenBestaetigen(
  a: Akteur,
  mandantId: string,
  beantragtVon: string | null | undefined,
  auswirkung: Auswirkung,
): Entscheidung {
  if (!zweitePerson(a, beantragtVon)) {
    return abgelehnt('VIER_AUGEN', 'Die Bestätigung muss durch eine zweite Person erfolgen.');
  }
  if (auswirkung !== 'NEIN' && !kannWuerdigen(a, mandantId)) {
    return abgelehnt(
      'WUERDIGEN',
      'Bei möglicher steuerlicher Auswirkung bestätigt nur die zuständige Berufsträgerin bzw. der zuständige Berufsträger das Verwerfen (§ 153).',
    );
  }
  return ERLAUBT;
}
