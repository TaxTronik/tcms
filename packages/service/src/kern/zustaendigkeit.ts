// =============================================================================
// Zuständigkeit einer Kontrolle prüfen (gemeinsamer Kern der Bereiche
// programm-beschreibung – Einrichtungsassistent, Version 1 – und
// risiken-kontrollen – Risikoaufnahme, Verantwortliche ändern). Eine Regel für
// alle Wege, damit kein Weg einen Kontrollstand anlegt, den ein anderer abweist
// (Befunde 9/10: Kanzleikontrolle mit Gegenzeichnung beim Mandanten wäre nie
// abschließbar).
//
//   - Durchführende Person und Vertretung gehören zur Partei der Kontrolle:
//     Mandantenseite = Kontakt mit aktiver Rolle bei diesem Mandanten,
//     Kanzleiseite = Kanzleiperson.
//   - Kanzleipersonen sind IDs der kanzleikonsole (ADR 0001 §5). Fail closed:
//     Ein Kontakt dieses Mandanten (aktive oder frühere Rolle) ist nie eine
//     Kanzleiperson. Die Prüfung bleibt auf den Mandanten der Anfrage
//     beschränkt; eine tenantweite Suche verriete, ob eine ID bei einem anderen
//     Mandanten als Kontakt existiert (Existenz-Orakel).
//   - Gegenzeichnung beim Mandanten (`gegenzeichnungMandant`) gibt es nur bei
//     Kontrollen des Mandanten; dann bestätigt die Vertretung (Pflicht). Sonst
//     zeichnet eine Kanzleiperson gegen, nie die durchführende Person;
//     Schlüsselkontrollen brauchen eine Gegenzeichnung.
//
// Die Datenbank hält den Kern zusätzlich fest (CHECK
// `KontrolleStand_gegenzeichnung_mandant_check`: Mandanten-Gegenzeichnung nur bei
// Partei MANDANT).
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { gleicheId } from '../rechte';
import type { VorbelegteZustaendigkeit } from './kontroll-vorlage';

/** Personenkreise eines Mandanten für die Prüfung (IDs klein geschrieben). */
export interface ZustaendigkeitsPools {
  /**
   * Bekannte Kanzleipersonen (ausdrückliche Eingabe der kanzleikonsole); `null`,
   * wenn der Aufrufer keine Liste hat – dann zählt jede ID, die kein Kontakt ist.
   */
  kanzlei: ReadonlySet<string> | null;
  /** Kontakte mit aktiver Rolle bei diesem Mandanten. */
  mandantAktiv: ReadonlySet<string>;
  /** Alle Kontakte dieses Mandanten (aktive und frühere Rollen). */
  kontakte: ReadonlySet<string>;
}

export type ZustaendigkeitsFeld =
  | 'durchfuehrendId'
  | 'vertretungId'
  | 'gegenzeichnerId'
  | 'gegenzeichnungMandant';

export interface ZustaendigkeitsFehler {
  feld: ZustaendigkeitsFeld;
  meldung: string;
}

const klein = (id: string) => id.toLowerCase();

/** Kanzleiperson: kein Kontakt dieses Mandanten und – falls bekannt – in der Liste der Kanzlei. */
export function istKanzleiPerson(id: string, p: ZustaendigkeitsPools): boolean {
  const k = klein(id);
  return !p.kontakte.has(k) && (p.kanzlei === null || p.kanzlei.has(k));
}

/** Mandantenperson: Kontakt mit aktiver Rolle bei diesem Mandanten. */
export function istMandantPerson(id: string, p: ZustaendigkeitsPools): boolean {
  return p.mandantAktiv.has(klein(id));
}

/**
 * Prüft eine Zuständigkeit gegen die Personenkreise des Mandanten (rein). Leere
 * Liste = gültig. Die Reihenfolge der Fehler ist fest (Anzeige).
 */
export function pruefeZustaendigkeit(
  z: VorbelegteZustaendigkeit,
  schluessel: boolean,
  p: ZustaendigkeitsPools,
): ZustaendigkeitsFehler[] {
  const f: ZustaendigkeitsFehler[] = [];
  const kanzleiSeite = z.partei === 'KANZLEI';
  const seite = kanzleiSeite ? 'Kanzlei' : 'Mandant';
  const gehoertZurSeite = (id: string) =>
    kanzleiSeite ? istKanzleiPerson(id, p) : istMandantPerson(id, p);

  if (!z.durchfuehrendId) {
    f.push({ feld: 'durchfuehrendId', meldung: 'durchführende Person zuordnen.' });
  } else if (!gehoertZurSeite(z.durchfuehrendId)) {
    f.push({
      feld: 'durchfuehrendId',
      meldung: `Die durchführende Person gehört nicht (mehr) zur Partei ${seite}.`,
    });
  }
  if (z.vertretungId) {
    if (gleicheId(z.vertretungId, z.durchfuehrendId)) {
      f.push({
        feld: 'vertretungId',
        meldung: 'Vertretung und durchführende Person müssen verschieden sein.',
      });
    } else if (!gehoertZurSeite(z.vertretungId)) {
      f.push({
        feld: 'vertretungId',
        meldung: `Die Vertretung gehört nicht (mehr) zur Partei ${seite}.`,
      });
    }
  }

  if (z.gegenzeichnungMandant) {
    if (kanzleiSeite) {
      f.push({
        feld: 'gegenzeichnungMandant',
        meldung:
          'Eine Gegenzeichnung beim Mandanten gibt es nur bei Kontrollen des Mandanten; bei Kontrollen der Kanzlei zeichnet eine Person der Kanzlei gegen.',
      });
    } else if (!z.vertretungId) {
      f.push({
        feld: 'vertretungId',
        meldung:
          'Bei Gegenzeichnung beim Mandanten bestätigt die Vertretung – Vertretung zuordnen.',
      });
    }
    return f;
  }
  if (!z.gegenzeichnerId) {
    if (schluessel)
      f.push({
        feld: 'gegenzeichnerId',
        meldung: 'Schlüsselkontrolle – Gegenzeichnung ist Pflicht.',
      });
  } else if (gleicheId(z.gegenzeichnerId, z.durchfuehrendId)) {
    f.push({
      feld: 'gegenzeichnerId',
      meldung: 'Die durchführende Person zeichnet nicht selbst gegen.',
    });
  } else if (!istKanzleiPerson(z.gegenzeichnerId, p)) {
    f.push({
      feld: 'gegenzeichnerId',
      meldung: 'Die Gegenzeichnung ist keine (bekannte) Person der Kanzlei.',
    });
  }
  return f;
}

/** Personenkreise des Mandanten aus MandantKontaktRolle (in der Transaktion der Operation). */
export async function ladeZustaendigkeitsPools(
  tx: Tx,
  mandantId: string,
  kanzlei: readonly string[] | null,
): Promise<ZustaendigkeitsPools> {
  const zeilen = await tx.mandantKontaktRolle.findMany({
    where: { mandantId },
    select: { kontaktId: true, aktiv: true },
    orderBy: { id: 'asc' },
  });
  return {
    kanzlei: kanzlei ? new Set(kanzlei.map(klein)) : null,
    mandantAktiv: new Set(zeilen.filter((z) => z.aktiv).map((z) => klein(z.kontaktId))),
    kontakte: new Set(zeilen.map((z) => klein(z.kontaktId))),
  };
}

/**
 * Kanzleipersonen sind IDs der kanzleikonsole; der Dienst kennt sie nicht und
 * prüft nur die UUID-Form (Schema). Zusätzlich fail closed: ein Kontakt
 * dieses Mandanten (aktive oder frühere Rolle) ist keine Kanzleiperson
 * (`UNGUELTIG` mit dem Feld der Eingabe).
 */
export async function pruefeKanzleiPersonen(
  tx: Tx,
  mandantId: string,
  ids: readonly { id: string; feld: string }[],
): Promise<void> {
  if (ids.length === 0) return;
  const pools = await ladeZustaendigkeitsPools(tx, mandantId, null);
  for (const x of ids) {
    if (!istKanzleiPerson(x.id, pools)) {
      const meldung = 'Diese Person ist keine Person der Kanzlei.';
      throw new DienstFehler('UNGUELTIG', meldung, { [x.feld]: [meldung] });
    }
  }
}
