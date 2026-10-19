import 'server-only';
import { prisma } from '@tcms/db';
import { tagesende } from './zeit';

// =============================================================================
// S13 Kommunikation: Freigaben und Kenntnisnahmen des Programms zum Stichtag.
// Status zum Stichtag: eine später erledigte Anforderung gilt am Stichtag als offen.
// =============================================================================

export interface FreigabeZeile {
  id: string;
  art: 'ZIELE' | 'BESCHREIBUNG' | 'RISIKOAKZEPTANZ' | 'AUFKLAERUNG' | 'KENNTNISNAHME';
  titel: string;
  empfaengerId: string;
  angefordertVon: string;
  angefordertAm: Date;
  status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT';
  erledigtAm: Date | null;
  anmerkung: string | null;
  codeAblauf: Date | null;
}

export async function ladeFreigaben(programmId: string, stand: Date): Promise<FreigabeZeile[]> {
  const ende = tagesende(stand);
  const roh = await prisma.freigabe.findMany({
    where: { programmId, angefordertAm: { lte: ende } },
    orderBy: { angefordertAm: 'desc' },
    select: {
      id: true,
      art: true,
      titel: true,
      empfaengerId: true,
      angefordertVon: true,
      angefordertAm: true,
      status: true,
      erledigtAm: true,
      anmerkung: true,
      codeAblauf: true,
    },
  });
  return roh.map((f) => {
    const spaeter = f.erledigtAm != null && f.erledigtAm.getTime() > ende.getTime();
    return {
      ...f,
      status: spaeter ? 'OFFEN' : f.status,
      erledigtAm: spaeter ? null : f.erledigtAm,
    };
  });
}
