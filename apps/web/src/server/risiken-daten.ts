import 'server-only';
import { isoDatum } from '@tcms/domain';
import { ladeRisiken, ladeRisiko } from '@tcms/service';
import type { TcmsKontext } from './kontext';
import { lies } from './risiken-kontrollen-aufruf';

// =============================================================================
// Zusatzdaten für Risikoinventar (S4) und Risikodetail (S5) aus @tcms/service
// (Bereich risiken-kontrollen): Hinweise „neu bewerten", Risikoakzeptanzen,
// Stand-Historie und Audit-Spur – stichtagsbezogen, im Dienstkontext der
// angemeldeten Person (Rechte prüft der Service). Hier wird nur die
// JSON-Antwort in die Anzeigeform der Demo (Date) übertragen.
// =============================================================================

export interface NeuBewertenHinweis {
  quelle: 'EREIGNIS' | 'PROFIL' | 'MARKIERT';
  text: string;
  ereignisId?: string;
}

export interface AkzeptanzView {
  id: string;
  refId: string;
  status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT';
  titel: string;
  inhalt: string | null;
  angefordertVon: string;
  angefordertAm: Date;
  empfaengerId: string;
  anmerkung: string | null;
  erledigtAm: Date | null;
}

export interface RisikoStandView {
  id: string;
  s: 'N' | 'M' | 'H';
  w: 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';
  r: 1 | 2 | 3;
  gt: 'FP' | 'FF' | 'IN';
  modell: string;
  gueltigAb: Date;
  gueltigBis: Date | null;
  erstelltVon: string | null;
}

export interface AuditZeile {
  seq: number;
  at: Date;
  actorName: string;
  aktion: string;
  detail: Record<string, unknown>;
}

export interface RisikoDetail {
  staende: RisikoStandView[];
  audit: AuditZeile[];
  aktivAb: Date;
  herkunft: 'KATALOG' | 'BERATER';
}

const datum = (iso: string) => new Date(iso);
const datumOder = (iso: string | null) => (iso ? new Date(iso) : null);

/** Hinweise und Akzeptanzen je Risiko-ID zum Stichtag des Kontexts (ein Service-Aufruf). */
export async function ladeRisikenZusatz(ctx: TcmsKontext): Promise<{
  hinweise: Map<string, NeuBewertenHinweis[]>;
  akzeptanzen: Map<string, AkzeptanzView[]>;
}> {
  const hinweise = new Map<string, NeuBewertenHinweis[]>();
  const akzeptanzen = new Map<string, AkzeptanzView[]>();
  if (!ctx.programm) return { hinweise, akzeptanzen };
  const mandantId = ctx.mandant.id;
  const l = await lies(mandantId, (c) => ladeRisiken(c, { mandantId, stand: isoDatum(ctx.stand) }));
  for (const r of l?.risiken ?? []) {
    if (r.hinweise.length)
      hinweise.set(
        r.id,
        r.hinweise.map((h) => ({
          quelle: h.quelle,
          text: h.text,
          ...(h.ereignisId ? { ereignisId: h.ereignisId } : {}),
        })),
      );
    if (r.akzeptanzen.length)
      akzeptanzen.set(
        r.id,
        r.akzeptanzen.map((a) => ({
          ...a,
          refId: r.id,
          angefordertAm: datum(a.angefordertAm),
          erledigtAm: datumOder(a.erledigtAm),
        })),
      );
  }
  return { hinweise, akzeptanzen };
}

/** Stand-Historie und Audit-Spur eines Risikos zum Stichtag des Kontexts. */
export async function ladeRisikoDetail(
  ctx: TcmsKontext,
  risikoId: string,
): Promise<RisikoDetail | null> {
  const mandantId = ctx.mandant.id;
  const d = await lies(mandantId, (c) =>
    ladeRisiko(c, { mandantId, risikoId, stand: isoDatum(ctx.stand) }),
  );
  if (!d) return null;
  return {
    staende: d.staende.map((s) => ({
      id: s.id,
      s: s.s,
      w: s.w,
      r: s.r,
      gt: s.gt,
      modell: s.modell,
      gueltigAb: datum(s.gueltigAb),
      gueltigBis: datumOder(s.gueltigBis),
      erstelltVon: s.erstelltVon,
    })),
    audit: d.audit.map((a) => ({
      seq: a.seq,
      at: datum(a.at),
      actorName: (a.actorId && d.namen[a.actorId]) || '—',
      aktion: a.aktion,
      detail: a.detail,
    })),
    aktivAb: datum(d.aktivAb),
    herkunft: d.risiko.herkunft,
  };
}
