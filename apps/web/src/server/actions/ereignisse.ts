'use server';

import {
  beantrageEreignisVerwerfen as beantrageEreignisVerwerfenDienst,
  bestaetigeEreignisVerwerfen as bestaetigeEreignisVerwerfenDienst,
  erfasseEreignis as erfasseEreignisDienst,
  erledigeFolge as erledigeFolgeDienst,
  fuegeFolgeHinzu as fuegeFolgeHinzuDienst,
  legeFolgenAn as legeFolgenAnDienst,
  lehneEreignisVerwerfenAb as lehneEreignisVerwerfenAbDienst,
  nehmeEreignisInPruefung,
  schliesseEreignisAb as schliesseEreignisAbDienst,
  verwerfeFolge as verwerfeFolgeDienst,
} from '@tcms/service';
import { demoPerson } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { dienstAktion, eingabe, feld, optional } from '../feststellungen-daten';
import { brauchtKanzleiFuer } from '../sitzung';

// =============================================================================
// Server Actions S11 – Ereigniseingang und Triage. Dünne Hüllen um die
// Fachoperationen aus @tcms/service (Rechte, Status, TS-04, Vier-Augen und
// Audit prüft ausschließlich der Service). Ein Ereignis ist erst erledigt,
// wenn jede Folge erledigt oder begründet verworfen ist.
// =============================================================================

const PRUEFEN = 'Bitte die Eingaben prüfen.';

async function kanzlei(fd: FormData) {
  const mandantId = feld(fd, 'mandantId');
  return { mandantId, akteur: await brauchtKanzleiFuer(mandantId) };
}

/** Person aus dem Demo-Verzeichnis als Zuweisung (im Zielbild: kanzleikonsole). */
function zuweisung(
  id: string | undefined,
): { id: string; art: 'KANZLEI' | 'MANDANT' } | null | 'unbekannt' {
  if (!id) return null;
  const p = demoPerson(id);
  return p ? { id: p.id, art: p.art } : 'unbekannt';
}

export async function nehmeInPruefung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) => nehmeEreignisInPruefung(ctx, eingabe({ mandantId, ereignisId: feld(fd, 'id') })),
    () => 'In Prüfung genommen.',
  );
}

export async function legeFolgenAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const ereignisId = feld(fd, 'ereignisId');
  const gewaehlt = fd.getAll('folge').filter((x): x is string => typeof x === 'string' && !!x);
  if (!ereignisId) return { fehler: PRUEFEN };
  if (gewaehlt.length === 0) return { fehler: 'Bitte mindestens eine Folge auswählen.' };
  const folgen: Record<string, unknown>[] = [];
  for (const id of gewaehlt) {
    const zustaendig = zuweisung(optional(fd, `zustaendig_${id}`));
    if (zustaendig === 'unbekannt') return { fehler: 'Zuständigkeit ist nicht zulässig.' };
    const titel = optional(fd, `ftitel_${id}`);
    const klasse = optional(fd, `fklasse_${id}`);
    const schwere = optional(fd, `fschwere_${id}`);
    const auswirkung = optional(fd, `fauswirkung_${id}`);
    const feststellung =
      titel || klasse || schwere || auswirkung
        ? { titel: titel ?? '', klasse, schwere, auswirkung }
        : undefined;
    folgen.push({
      folgeId: id,
      zustaendig,
      frist: optional(fd, `frist_${id}`) ?? null,
      ...(feststellung ? { feststellung } : {}),
    });
  }
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) => legeFolgenAnDienst(ctx, eingabe({ mandantId, ereignisId, folgen })),
    (r) => `${r.folgen.length} ${r.folgen.length === 1 ? 'Folge' : 'Folgen'} angelegt.`,
    {
      ungueltig:
        'Bitte die Angaben der gewählten Folgen prüfen (Feststellung: Titel mind. 5 Zeichen, Klasse, Schwere und Auswirkung).',
      nichtGefunden: 'Eine gewählte Folge gehört nicht zu diesem Ereignis.',
    },
  );
}

export async function fuegeFolgeHinzu(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      fuegeFolgeHinzuDienst(
        ctx,
        eingabe({
          mandantId,
          ereignisId: feld(fd, 'ereignisId'),
          art: feld(fd, 'art'),
          ziel: optional(fd, 'ziel') ?? null,
          text: feld(fd, 'text'),
        }),
      ),
    () => 'Folge vorgeschlagen – jetzt auswählen und anlegen.',
    { ungueltig: 'Bitte Art und Beschreibung (mind. 5 Zeichen) angeben.' },
  );
}

export async function erledigeFolge(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      erledigeFolgeDienst(
        ctx,
        eingabe({ mandantId, ereignisId: feld(fd, 'ereignisId'), folgeId: feld(fd, 'id') }),
      ),
    () => 'Folge erledigt.',
    { nichtGefunden: 'Folge nicht gefunden.' },
  );
}

export async function verwerfeFolge(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      verwerfeFolgeDienst(
        ctx,
        eingabe({
          mandantId,
          ereignisId: feld(fd, 'ereignisId'),
          folgeId: feld(fd, 'id'),
          begruendung: feld(fd, 'begruendung'),
        }),
      ),
    () => 'Folge begründet verworfen.',
    {
      ungueltig: 'Die Begründung muss mindestens 30 Zeichen lang sein.',
      nichtGefunden: 'Folge nicht gefunden.',
    },
  );
}

export async function schliesseEreignisAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) => schliesseEreignisAbDienst(ctx, eingabe({ mandantId, ereignisId: feld(fd, 'id') })),
    (r) => `Ereignis ${r.nummer} erledigt.`,
  );
}

export async function beantrageEreignisVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      beantrageEreignisVerwerfenDienst(
        ctx,
        eingabe({ mandantId, ereignisId: feld(fd, 'id'), begruendung: feld(fd, 'begruendung') }),
      ),
    () => 'Verwerfen beantragt. Eine zweite Person muss bestätigen.',
    { ungueltig: 'Die Begründung muss mindestens 30 Zeichen lang sein.' },
  );
}

export async function bestaetigeEreignisVerwerfen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      bestaetigeEreignisVerwerfenDienst(ctx, eingabe({ mandantId, ereignisId: feld(fd, 'id') })),
    (r) => `Ereignis ${r.nummer} verworfen.`,
  );
}

export async function lehneEreignisVerwerfenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      lehneEreignisVerwerfenAbDienst(ctx, eingabe({ mandantId, ereignisId: feld(fd, 'id') })),
    (r) => (r.zurueckgezogen ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.'),
  );
}

export async function erfasseEreignis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      erfasseEreignisDienst(
        ctx,
        eingabe({
          mandantId,
          typ: feld(fd, 'typ'),
          quelle: feld(fd, 'quelle'),
          titel: feld(fd, 'titel'),
          beschreibung: feld(fd, 'beschreibung'),
          datum: feld(fd, 'datum'),
        }),
      ),
    (r) => `Ereignis ${r.nummer} erfasst – ${r.folgen} Folgen vorgeschlagen.`,
    {
      ungueltig:
        'Bitte Typ, Quelle, Titel (mind. 5 Zeichen), Beschreibung (mind. 10 Zeichen) und Datum angeben.',
    },
  );
}
