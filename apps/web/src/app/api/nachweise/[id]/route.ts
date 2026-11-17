import { DienstFehler } from '@tcms/contract';
import { ladeNachweis } from '@tcms/service';
import { downloadAntwort, downloadMeldung } from '@/server/dateien';
import { imDemoDienst, leseNachweisdatei } from '@/server/durchfuehrung-daten';
import { demoAkteur } from '@/server/sitzung';

// =============================================================================
// Download eines Nachweises (nur Demo; im Dienst laufen Downloads über die
// kanzleikonsole, ADR 0001 §6). Die Rechte prüft der Service (`ladeNachweis`,
// TS-03): Kanzleipersonen mit Bezug zum Mandanten (`kannLesen`), Portal-
// Personen nur für Aufgaben ihrer Seite, die ihnen offenstehen. Der Mandant
// kommt aus der Anfrage (`?mandant=`, wie `cli` der kanzleikonsole); der
// Nachweis muss zu diesem Mandanten gehören. Nicht sichtbar → 404 ohne
// Hinweis auf die Existenz. Vor der Auslieferung prüft die Ablage den
// SHA-256 des Inhalts (TS-09). Kopfzeilen (Sandbox-CSP, nosniff, attachment)
// wie bei Ereignis-Anlagen aus `@/server/dateien`.
// =============================================================================

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const nichtGefunden = () => downloadMeldung(404, 'Nicht gefunden.');
  const mandantId = new URL(req.url).searchParams.get('mandant') ?? '';
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return downloadMeldung(401, 'Nicht angemeldet.');
  const { id } = await params;

  let n;
  try {
    ({ nachweis: n } = await imDemoDienst(akteur, (ctx) =>
      ladeNachweis(ctx, { mandantId, nachweisId: id }),
    ));
  } catch (e) {
    // Fremder oder unbekannter Mandant/Nachweis, ungültige Eingabe: immer 404.
    if (e instanceof DienstFehler) return nichtGefunden();
    throw e;
  }

  let inhalt: Buffer;
  try {
    // Prüft Ablagepfad, SHA-256 des Inhalts und den Hash des Nachweises.
    inhalt = await leseNachweisdatei(n);
  } catch {
    return downloadMeldung(410, 'Datei nicht verfügbar oder Integritätsprüfung fehlgeschlagen.');
  }

  return downloadAntwort(inhalt, n, 'X-Nachweis-SHA256');
}
