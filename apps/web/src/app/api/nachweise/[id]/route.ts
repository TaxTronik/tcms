import { kannLesen } from '@tcms/service';
import { akteurFuer, handelnde, lies } from '@/server/demo';
import {
  darfPortalLesen,
  ladeNachweisFuerDownload,
  leseNachweisdatei,
} from '@/server/durchfuehrung-daten';
import { aktuellePerson } from '@/server/sitzung';
import { ladeKontaktRollen } from '@tcms/service';

// =============================================================================
// Download eines Nachweises (nur Demo; im Dienst laufen Downloads über die
// kanzleikonsole, ADR 0001 §6). Zugriff: Kanzleipersonen mit Bezug zum
// Mandanten (kannLesen) sowie Portal-Personen desselben Mandanten mit aktiver
// Rolle und Leserecht auf die Kontrollaufgabe (Partei Mandant). Vor der
// Auslieferung prüft die Ablage den SHA-256 gegen Ablagepfad und Nachweis (TS-09).
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
  const person = await aktuellePerson();
  const kopf = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!person) return new Response('Nicht angemeldet.', { status: 401, headers: kopf });
  const { id } = await params;
  const n = await ladeNachweisFuerDownload(id);
  if (!n) return new Response('Nicht gefunden.', { status: 404, headers: kopf });

  const ks = n.durchfuehrung.kontrolleStand;
  const mandantId = n.durchfuehrung.kontrolle.programm.mandantId;
  const akteur = akteurFuer(person, mandantId);
  const rollen = await lies((tx) => ladeKontaktRollen(tx, akteur));
  const erlaubt =
    akteur.art === 'KANZLEI'
      ? kannLesen(akteur, mandantId)
      : darfPortalLesen(handelnde(akteur, rollen), {
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
