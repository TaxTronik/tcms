import { NextResponse, type NextRequest } from 'next/server';
import { kannLesen } from '@tcms/service';
import { akteurFuer, db } from '@/server/demo';
import { ladeAnlage, leseAnlage } from '@/server/ereignisse-daten';
import { aktuellePerson } from '@/server/sitzung';

// Download einer Ereignis-Anlage (Portal-Meldung) für die Kanzlei (nur Demo).
// Prüft Sitzung, Bezug zum Mandanten (kannLesen), Mandantenzuordnung, dass die
// Datei zum Meldungs-Audit gehört, und den SHA-256 des Inhalts (TS-09).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const person = await aktuellePerson();
  if (!person || person.art !== 'KANZLEI')
    return new NextResponse('Nicht angemeldet', { status: 401 });
  const { id } = await params;
  if (!kannLesen(akteurFuer(person, id), id))
    return new NextResponse('Nicht gefunden', { status: 404 });
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const h = req.nextUrl.searchParams.get('h') ?? '';
  if (!/^[0-9a-f]{64}$/.test(h)) return new NextResponse('Ungültige Anfrage', { status: 400 });
  const ereignis = await db.ereignis.findUnique({
    where: { id: e },
    include: { programm: { select: { mandantId: true } } },
  });
  if (!ereignis || ereignis.programm.mandantId !== id)
    return new NextResponse('Nicht gefunden', { status: 404 });
  const a = await ladeAnlage(ereignis.id, h);
  if (!a || !a.speicherpfad) return new NextResponse('Nicht gefunden', { status: 404 });
  let inhalt: Buffer;
  try {
    inhalt = await leseAnlage(a.speicherpfad, a.anlage.sha256);
  } catch {
    return new NextResponse('Nicht verfügbar', { status: 410 });
  }
  return new NextResponse(new Uint8Array(inhalt), {
    headers: {
      'Content-Type': a.anlage.mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.anlage.dateiname)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
