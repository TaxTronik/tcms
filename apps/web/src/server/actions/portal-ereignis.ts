'use server';

import { redirect } from 'next/navigation';
import {
  DienstFehler,
  PORTAL_ANLAGE_MIME,
  PORTAL_MAX_ANLAGE_BYTES,
  PORTAL_MAX_ANLAGEN,
} from '@tcms/contract';
import {
  EINGABE_UNGUELTIG,
  imDienst,
  meldeEreignis as meldeEreignisDienst,
  NUR_GV_TCB,
  type NachweisVerweis,
} from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import { DEMO_PORTS, demoPersonen, zustaendigkeit } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { darfPortalMelden, legeAnlageAb } from '../ereignisse-daten';
import { eingabe, feld } from '../feststellungen-daten';
import { brauchtPortal } from '../sitzung';

// =============================================================================
// Server Action P3 – Ereignis melden (Portal). Die Demo spielt hier die
// kanzleikonsole: Sie nimmt Dateien nur von meldeberechtigten Personen an
// (Regel aus @tcms/service), legt sie ab und übergibt dem Service nur
// Verweise (ADR 0001 §6) sowie die Ansprechperson der Kanzlei für die
// Benachrichtigung. Rechte, Typ, Datum und Verweise prüft der Service.
// =============================================================================

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
  if (dateien.length > PORTAL_MAX_ANLAGEN)
    return { fehler: `Bitte höchstens ${PORTAL_MAX_ANLAGEN} Anlagen beifügen.` };
  for (const d of dateien) {
    if (d.size > PORTAL_MAX_ANLAGE_BYTES)
      return { fehler: `Die Datei „${d.name}" ist größer als 10 MB.` };
    if (!PORTAL_ANLAGE_MIME.test(d.type))
      return {
        fehler: `Der Dateityp von „${d.name}" wird nicht unterstützt (PDF, Bild, CSV, Excel, Word).`,
      };
  }
  // Dateien über den Ablage-Port der Demo ablegen (inhaltsadressiert); der Service
  // speichert nur den Verweis im Audit-Eintrag der Meldung.
  const anlagen: NachweisVerweis[] = [];
  for (const d of dateien) {
    anlagen.push(
      await legeAnlageAb(Buffer.from(await d.arrayBuffer()), d.name.slice(0, 200), d.type),
    );
  }
  const bearbeitung = demoPersonen.person(zustaendigkeit(n.mandantId).bearbeitungId);

  let nummer: string;
  try {
    const r = await imDienst(
      n,
      DEMO_PORTS,
      (ctx) =>
        meldeEreignisDienst(
          ctx,
          eingabe({
            mandantId: n.mandantId,
            typ: feld(fd, 'typ'),
            titel: feld(fd, 'titel'),
            beschreibung: feld(fd, 'beschreibung'),
            datum: feld(fd, 'datum'),
            anlagen,
            zusageAenderungen: fd.get('zusage') === '1',
            benachrichtigen: bearbeitung ? { id: bearbeitung.id, name: bearbeitung.name } : null,
          }),
        ),
      { timeoutMs: 30_000, maxWaitMs: 10_000 },
    );
    nummer = r.nummer;
  } catch (e) {
    if (!(e instanceof DienstFehler)) throw e;
    if (e.code === 'UNGUELTIG' && e.message === EINGABE_UNGUELTIG)
      return {
        fehler:
          'Bitte geben Sie eine Bezeichnung (mindestens 5 Zeichen), eine Beschreibung (mindestens 10 Zeichen) und ein Datum an.',
      };
    return {
      fehler: e.message !== e.code ? e.message : 'Die Meldung konnte nicht gespeichert werden.',
    };
  }
  aktualisiereMandant(n.mandantId);
  redirect(`/portal/tcms/ereignis?gemeldet=${encodeURIComponent(nummer)}`);
}
