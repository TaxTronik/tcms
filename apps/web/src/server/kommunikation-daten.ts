import 'server-only';
import { DienstFehler } from '@tcms/contract';
import { imDienst, ladeFreigabenHistorie } from '@tcms/service';
import { DEMO_PORTS } from './demo';
import { demoAkteur } from './sitzung';

// =============================================================================
// S13 Kommunikation: Freigaben und Kenntnisnahmen des Programms zum Stichtag
// über den Service-Lader `ladeFreigabenHistorie` (Status zum Stichtag: eine
// später erledigte Anforderung gilt am Stichtag als offen).
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

export async function ladeFreigaben(mandantId: string, standIso: string): Promise<FreigabeZeile[]> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return [];
  try {
    const h = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeFreigabenHistorie(ctx, { mandantId, stand: standIso }),
    );
    return h.freigaben.map((f) => ({
      ...f,
      angefordertAm: new Date(f.angefordertAm),
      erledigtAm: f.erledigtAm ? new Date(f.erledigtAm) : null,
      codeAblauf: f.codeStatus === 'AKTIV' && f.codeAblauf ? new Date(f.codeAblauf) : null,
    }));
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return [];
    throw e;
  }
}
