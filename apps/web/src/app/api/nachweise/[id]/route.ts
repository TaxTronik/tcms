import { createHash } from 'node:crypto';
import {
  darfPortalLesen,
  ladeNachweisFuerDownload,
  leseNachweisdatei,
} from '@/server/durchfuehrung-daten';
import { aktuellerNutzer } from '@/server/sitzung';

// =============================================================================
// Download eines Nachweises. Zugriff: Kanzlei-Personen sowie Portal-Personen
// desselben Mandanten mit Leserecht auf die Kontrollaufgabe (Partei Mandant).
// Vor der Auslieferung wird der SHA-256 gegen den gespeicherten Hash geprüft.
// =============================================================================

export const dynamic = 'force-dynamic';

function dispositionsname(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const AKTIVE_TYPEN =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const nutzer = await aktuellerNutzer();
  const kopf = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!nutzer) return new Response('Nicht angemeldet.', { status: 401, headers: kopf });
  const { id } = await params;
  const n = await ladeNachweisFuerDownload(id);
  if (!n) return new Response('Nicht gefunden.', { status: 404, headers: kopf });

  const ks = n.durchfuehrung.kontrolleStand;
  const mandantId = n.durchfuehrung.kontrolle.programm.mandantId;
  const erlaubt =
    nutzer.art === 'KANZLEI' ||
    darfPortalLesen(nutzer, {
      mandantId,
      kontrolle: {
        partei: ks.partei,
        durchfuehrendId: ks.durchfuehrendId,
        vertretungId: ks.vertretungId,
        gegenzeichnerId: ks.gegenzeichnerId,
      },
    });
  // Kein Hinweis auf die Existenz fremder Dateien.
  if (!erlaubt) return new Response('Nicht gefunden.', { status: 404, headers: kopf });

  let inhalt: Buffer;
  try {
    inhalt = await leseNachweisdatei(n.speicherpfad);
  } catch {
    return new Response('Datei nicht in der Ablage gefunden.', { status: 410, headers: kopf });
  }
  const ist = createHash('sha256').update(inhalt).digest('hex');
  if (ist !== n.sha256) {
    return new Response(
      'Integritätsprüfung fehlgeschlagen: Der Inhalt weicht vom gespeicherten Hash ab.',
      { status: 409, headers: kopf },
    );
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
