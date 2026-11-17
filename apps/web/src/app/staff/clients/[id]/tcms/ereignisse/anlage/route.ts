import { downloadAntwort, downloadMeldung } from '@/server/dateien';
import { akteurFuer } from '@/server/demo';
import { ladeAnlageZumDownload } from '@/server/ereignisse-daten';
import { aktuellePerson } from '@/server/sitzung';

// =============================================================================
// Download einer Ereignis-Anlage (Portal-Meldung) für die Kanzlei – nur Demo;
// im Dienst laufen Downloads über die kanzleikonsole (ADR 0001 §6, TS-09).
// Rechte und Mandantenzuordnung prüft der Service (`ladeEreignisAnlage`: nur
// Verweise aus dem Meldungs-Audit eines Ereignisses dieses Mandanten); die
// Ablage prüft den SHA-256 des Inhalts gegen Ablagepfad und Verweis.
// =============================================================================

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const person = await aktuellePerson();
  if (!person || person.art !== 'KANZLEI') return downloadMeldung(401, 'Nicht angemeldet.');
  const { id } = await params;
  const url = new URL(req.url);
  const ergebnis = await ladeAnlageZumDownload(akteurFuer(person, id), {
    mandantId: id,
    ereignisId: url.searchParams.get('e') ?? '',
    sha256: url.searchParams.get('h') ?? '',
  });
  if (ergebnis === 'UNGUELTIG') return downloadMeldung(400, 'Ungültige Anfrage.');
  // Kein Hinweis auf die Existenz fremder Ereignisse oder Dateien.
  if (ergebnis === 'NICHT_GEFUNDEN') return downloadMeldung(404, 'Nicht gefunden.');
  if (ergebnis === 'DEFEKT')
    return downloadMeldung(410, 'Datei nicht verfügbar oder Integritätsprüfung fehlgeschlagen.');
  return downloadAntwort(ergebnis.inhalt, ergebnis.verweis, 'X-Anlage-SHA256');
}
