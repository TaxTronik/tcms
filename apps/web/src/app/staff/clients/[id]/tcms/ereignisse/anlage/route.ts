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

const KOPF = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** Typen, die ein Browser ausführen bzw. rendern würde: nur als Download ausliefern. */
const AKTIVE_TYPEN =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)$/i;

function dispositionsname(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const person = await aktuellePerson();
  if (!person || person.art !== 'KANZLEI')
    return new Response('Nicht angemeldet.', { status: 401, headers: KOPF });
  const { id } = await params;
  const url = new URL(req.url);
  const ergebnis = await ladeAnlageZumDownload(akteurFuer(person, id), {
    mandantId: id,
    ereignisId: url.searchParams.get('e') ?? '',
    sha256: url.searchParams.get('h') ?? '',
  });
  if (ergebnis === 'UNGUELTIG')
    return new Response('Ungültige Anfrage.', { status: 400, headers: KOPF });
  // Kein Hinweis auf die Existenz fremder Ereignisse oder Dateien.
  if (ergebnis === 'NICHT_GEFUNDEN')
    return new Response('Nicht gefunden.', { status: 404, headers: KOPF });
  if (ergebnis === 'DEFEKT')
    return new Response('Datei nicht verfügbar oder Integritätsprüfung fehlgeschlagen.', {
      status: 410,
      headers: KOPF,
    });
  const { verweis, inhalt } = ergebnis;
  return new Response(new Uint8Array(inhalt), {
    status: 200,
    headers: {
      ...KOPF,
      'Content-Type': AKTIVE_TYPEN.test(verweis.mime) ? 'application/octet-stream' : verweis.mime,
      'Content-Length': String(inhalt.length),
      'Content-Disposition': dispositionsname(verweis.dateiname),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Anlage-SHA256': verweis.sha256,
    },
  });
}
