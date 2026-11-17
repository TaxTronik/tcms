'use server';

import { redirect } from 'next/navigation';
import {
  DienstFehler,
  PORTAL_ANLAGE_MIME,
  PortalMeldungSchema,
  type PortalMeldung,
} from '@tcms/contract';
import {
  EINGABE_UNGUELTIG,
  imDienst,
  meldeEreignis as meldeEreignisDienst,
  NUR_GV_TCB,
} from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import { DEMO_PORTS, demoPersonen, zustaendigkeit } from '../demo';
import type { Ergebnis } from '../ergebnis';
import {
  ANLAGEN_GRENZEN,
  bereiteAnlageVor,
  darfPortalMelden,
  legeAnlageAb,
  type VorbereiteteAnlage,
} from '../ereignisse-daten';
import { eingabe, feld } from '../feststellungen-daten';
import { brauchtPortal } from '../sitzung';

// =============================================================================
// Server Action P3 – Ereignis melden (Portal). Die Demo spielt hier die
// kanzleikonsole: Sie nimmt Dateien nur von meldeberechtigten Personen an
// (Regel aus @tcms/service), prüft die Meldung mit dem Vertragsschema, legt
// die Dateien erst danach ab und übergibt dem Service nur Verweise (ADR 0001
// §6) sowie die Ansprechperson der Kanzlei für die Benachrichtigung. Rechte,
// Typ, Datum und Verweise prüft der Service.
// =============================================================================

const UNGUELTIG =
  'Bitte geben Sie eine Bezeichnung (mindestens 5 Zeichen), eine Beschreibung (mindestens 10 Zeichen) und ein Datum an.';
const ANLAGE_UNGUELTIG =
  'Eine Anlage kann nicht angenommen werden (gleiche Datei doppelt oder Dateiname ungültig). Bitte prüfen Sie die Anlagen.';

/** Meldung zu Feldfehlern des Vertragsschemas (Pfade wie `anlagen.0.dateiname`); Anlagen eigens. */
function feldfehler(pfade: readonly string[]): string {
  return pfade.some((p) => p === 'anlagen' || p.startsWith('anlagen.'))
    ? ANLAGE_UNGUELTIG
    : UNGUELTIG;
}

export async function meldeEreignis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { akteur: n, rollen } = await brauchtPortal();
  if (!darfPortalMelden(n, rollen)) return { fehler: NUR_GV_TCB };
  if (!fd.get('typ')) return { fehler: 'Bitte wählen Sie zuerst die Art des Ereignisses.' };

  const dateien = fd
    .getAll('anlagen')
    .filter(
      (x): x is File =>
        typeof x === 'object' && x !== null && 'arrayBuffer' in x && (x as File).size > 0,
    );
  const g = ANLAGEN_GRENZEN;
  if (dateien.length > g.anzahl) return { fehler: `Bitte höchstens ${g.anzahl} Anlagen beifügen.` };
  for (const d of dateien) {
    if (d.size > g.jeDateiBytes) return { fehler: `Die Datei „${d.name}" ist größer als 10 MB.` };
    if (!PORTAL_ANLAGE_MIME.test(d.type))
      return {
        fehler: `Der Dateityp von „${d.name}" wird nicht unterstützt (PDF, Bild, CSV, Excel, Word).`,
      };
  }
  // Eine Meldung ist eine Anfrage: zusammen höchstens so viel, wie das Body-Limit
  // der Server Actions zulässt (next.config.mjs).
  if (dateien.reduce((s, d) => s + d.size, 0) > g.zusammenBytes)
    return { fehler: 'Bitte fügen Sie zusammen höchstens 20 MB an.' };

  const anlagen: VorbereiteteAnlage[] = [];
  for (const d of dateien)
    anlagen.push(bereiteAnlageVor(Buffer.from(await d.arrayBuffer()), d.name, d.type));
  const bearbeitung = demoPersonen.person(zustaendigkeit(n.mandantId).bearbeitungId);
  const meldung = eingabe<PortalMeldung>({
    mandantId: n.mandantId,
    typ: feld(fd, 'typ'),
    titel: feld(fd, 'titel'),
    beschreibung: feld(fd, 'beschreibung'),
    datum: feld(fd, 'datum'),
    anlagen: anlagen.map((a) => a.verweis),
    zusageAenderungen: fd.get('zusage') === '1',
    benachrichtigen: bearbeitung ? { id: bearbeitung.id, name: bearbeitung.name } : null,
  });

  // Erst prüfen, dann ablegen: Eine abgewiesene Meldung hinterlässt keine Datei.
  const geprueft = PortalMeldungSchema.safeParse(meldung);
  if (!geprueft.success)
    return { fehler: feldfehler(geprueft.error.issues.map((i) => i.path.map(String).join('.'))) };
  // Ablage wie in der kanzleikonsole (inhaltsadressiert); der Service speichert
  // nur den Verweis im Audit-Eintrag der Meldung.
  for (const a of anlagen) await legeAnlageAb(a);

  let nummer: string;
  try {
    const r = await imDienst(n, DEMO_PORTS, (ctx) => meldeEreignisDienst(ctx, meldung), {
      timeoutMs: 30_000,
      maxWaitMs: 10_000,
    });
    nummer = r.nummer;
  } catch (e) {
    if (!(e instanceof DienstFehler)) throw e;
    if (e.code === 'UNGUELTIG' && e.message === EINGABE_UNGUELTIG)
      return { fehler: feldfehler(Object.keys(e.felder ?? {})) };
    return {
      fehler: e.message !== e.code ? e.message : 'Die Meldung konnte nicht gespeichert werden.',
    };
  }
  aktualisiereMandant(n.mandantId);
  redirect(`/portal/tcms/ereignis?gemeldet=${encodeURIComponent(nummer)}`);
}
