'use server';

import { aktualisiereMandant, KEIN_RECHT, mitAudit } from '../aktion';
import {
  Abbruch,
  ausHistorischemStand,
  darfPortalLesen,
  fuehreAus,
  kernEntfernen,
  kernHochladen,
  kernSpeichern,
  kernZurueckweisen,
  ladeFuerAktion,
  rechteFuer,
  text,
} from '../durchfuehrung-daten';
import type { Ergebnis } from '../ergebnis';
import { brauchtPortal } from '../sitzung';

// =============================================================================
// Server Actions der Kontrollaufgabe im Portal (P2). Akteur ist die
// angemeldete Portal-Person; es gelten dieselben Regeln wie in S8
// (zugewiesene Person führt durch, zweite Person bestätigt, Vier-Augen).
// =============================================================================

const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
const NICHT_GEFUNDEN = 'Diese Aufgabe wurde nicht gefunden.';

/** Prüft vorab, ob die Aufgabe zum Mandanten der Portal-Person gehört. */
async function eigeneAufgabe(
  nutzer: Awaited<ReturnType<typeof brauchtPortal>>,
  id: string,
): Promise<boolean> {
  const d = await ladeFuerAktion(id);
  return !!d && darfPortalLesen(nutzer, d);
}

/** „Entwurf speichern" bzw. „An Kanzlei übermitteln" (absicht=einreichen). */
export async function speichereAufgabe(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  if (!(await eigeneAufgabe(nutzer, text(fd, 'id')))) return { fehler: NICHT_GEFUNDEN };
  return kernSpeichern(nutzer, fd);
}

export async function ladeAnlageHoch(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  if (!(await eigeneAufgabe(nutzer, text(fd, 'id')))) return { fehler: NICHT_GEFUNDEN };
  return kernHochladen(nutzer, fd);
}

export async function entferneAnlage(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  if (!(await eigeneAufgabe(nutzer, text(fd, 'id')))) return { fehler: NICHT_GEFUNDEN };
  return kernEntfernen(nutzer, fd);
}

/** Zweite Person beim Mandanten gibt die Aufgabe mit Begründung zur Überarbeitung zurück. */
export async function gibAufgabeZurueck(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  if (!(await eigeneAufgabe(nutzer, text(fd, 'id')))) return { fehler: NICHT_GEFUNDEN };
  return kernZurueckweisen(nutzer, fd);
}

/**
 * Bestätigung durch eine zweite Person beim Mandanten (Kontrollstand mit
 * gegenzeichnungMandant). Danach schließt die Kanzlei mit der Gegenzeichnung ab.
 */
export async function bestaetigeAufgabe(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d || !darfPortalLesen(nutzer, d)) return { fehler: NICHT_GEFUNDEN };
    const r = rechteFuer(nutzer, d, false).mandantBestaetigen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    await mitAudit(nutzer, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${d.id} FOR UPDATE`;
      const akt = await tx.durchfuehrung.findUnique({
        where: { id: d.id },
        select: { status: true, mandantBestaetigtVon: true },
      });
      if (!akt || akt.status !== 'ZUR_GEGENZEICHNUNG' || akt.mandantBestaetigtVon) {
        throw new Abbruch(
          'Der Status hat sich zwischenzeitlich geändert. Bitte die Seite neu laden.',
        );
      }
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: { mandantBestaetigtVon: nutzer.id },
      });
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.durchfuehrung.mandant_bestaetigt',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: d.programmId,
          detail: {
            kontrolle: d.kontrolle.code,
            periode: d.periodeLabel,
            durchgefuehrtVon: d.durchgefuehrtVon,
          },
        },
      };
    });
    aktualisiereMandant(d.mandantId);
    return { ok: 'Vollständigkeit bestätigt. Die Kanzlei prüft nun und schließt die Aufgabe ab.' };
  });
}
