import 'server-only';
import type { Geschaeftsprofil } from '@tcms/domain';
import { isoDatum } from '@tcms/domain';
import { ladeProfil } from '@tcms/service';
import type { TcmsKontext } from './kontext';
import { lies } from './risiken-kontrollen-aufruf';

// =============================================================================
// Profil-Tab: Profilstände und Risikoentscheidungen aus @tcms/service (Bereich
// risiken-kontrollen), im Dienstkontext der angemeldeten Person und zum
// Stichtag des Kontexts; hier nur in die Anzeigeform der Demo (Date)
// übertragen.
// =============================================================================

export interface ProfilStandView {
  id: string;
  antworten: Geschaeftsprofil;
  gueltigAb: Date;
  gueltigBis: Date | null;
  erstelltVon: string | null;
  createdAt: Date;
}

export interface RisikoEntscheidungView {
  id: string;
  code: string;
  kern: boolean;
  entscheidung: 'VORGESCHLAGEN' | 'UEBERNOMMEN' | 'ABGELEHNT';
  vorschlagsgrund: string | null;
  ablehnungsgrund: string | null;
  inaktivAb: Date | null;
  neuBewerten: boolean;
  createdAt: Date;
}

/** Profilstände (aufsteigend) und Risikoentscheidungen des Programms zum Stichtag. */
export async function ladeProfilDaten(
  ctx: TcmsKontext,
): Promise<{ staende: ProfilStandView[]; risiken: RisikoEntscheidungView[] }> {
  const mandantId = ctx.mandant.id;
  const p = await lies(mandantId, (c) => ladeProfil(c, { mandantId, stand: isoDatum(ctx.stand) }));
  if (!p) return { staende: [], risiken: [] };
  return {
    staende: p.staende.map((s) => ({
      id: s.id,
      antworten: s.antworten,
      gueltigAb: new Date(s.gueltigAb),
      gueltigBis: s.gueltigBis ? new Date(s.gueltigBis) : null,
      erstelltVon: s.erstelltVon,
      createdAt: new Date(s.createdAt),
    })),
    risiken: p.risiken.map((r) => ({
      ...r,
      inaktivAb: r.inaktivAb ? new Date(r.inaktivAb) : null,
      createdAt: new Date(r.createdAt),
    })),
  };
}
