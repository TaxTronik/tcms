import { DienstFehler } from '@tcms/contract';
import { ladeNachweis } from '@tcms/service';
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
// SHA-256 des Inhalts (TS-09).
// =============================================================================

export const dynamic = 'force-dynamic';

function dispositionsname(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const AKTIVE_TYPEN =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const kopf = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const nichtGefunden = () => new Response('Nicht gefunden.', { status: 404, headers: kopf });
  const mandantId = new URL(req.url).searchParams.get('mandant') ?? '';
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return new Response('Nicht angemeldet.', { status: 401, headers: kopf });
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
    return new Response('Datei nicht verfügbar oder Integritätsprüfung fehlgeschlagen.', {
      status: 410,
      headers: kopf,
    });
  }

  return new Response(new Uint8Array(inhalt), {
    status: 200,
    headers: {
      ...kopf,
      'Content-Type': AKTIVE_TYPEN.test(n.mime)
        ? 'application/octet-stream'
        : n.mime || 'application/octet-stream',
      'Content-Length': String(inhalt.length),
      'Content-Disposition': dispositionsname(n.dateiname),
      'X-Nachweis-SHA256': n.sha256,
    },
  });
}
