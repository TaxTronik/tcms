import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@tcms/db';
import { ladeAnlage, leseAnlage } from '@/server/ereignisse-daten';
import { aktuellerNutzer } from '@/server/sitzung';

// Download einer Ereignis-Anlage (Portal-Meldung) für die Kanzlei.
// Prüft Sitzung, Mandantenzuordnung und dass die Datei zum Meldungs-Audit gehört.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const nutzer = await aktuellerNutzer();
  if (!nutzer || nutzer.art !== 'KANZLEI')
    return new NextResponse('Nicht angemeldet', { status: 401 });
  const { id } = await params;
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const h = req.nextUrl.searchParams.get('h') ?? '';
  if (!/^[0-9a-f]{64}$/.test(h)) return new NextResponse('Ungültige Anfrage', { status: 400 });
  const ereignis = await prisma.ereignis.findUnique({
    where: { id: e },
    include: { programm: { select: { mandantId: true } } },
  });
  if (!ereignis || ereignis.programm.mandantId !== id)
    return new NextResponse('Nicht gefunden', { status: 404 });
  const a = await ladeAnlage(ereignis.id, h);
  if (!a || !a.speicherpfad) return new NextResponse('Nicht gefunden', { status: 404 });
  const inhalt = await leseAnlage(a.speicherpfad);
  return new NextResponse(new Uint8Array(inhalt), {
    headers: {
      'Content-Type': a.anlage.mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.anlage.dateiname)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
