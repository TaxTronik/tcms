import 'server-only';
import { fmtDatum, katalogRisiko, PROFIL_FRAGEN, type Geschaeftsprofil } from '@tcms/domain';
import { profilFragenAus } from '@/components/risiken/labels';
import { db } from './demo';
import type { RisikoView, TcmsKontext } from './kontext';
import { auditGrenze, tagesende } from './zeit';

// =============================================================================
// Zusatzdaten für Risikoinventar (S4) und Risikodetail (S5): Hinweise
// „neu bewerten", Risikoakzeptanzen, Stand-Historie und Audit-Spur. Alles
// stichtagsbezogen; der Kontext selbst kommt aus `ladeKontext`.
// =============================================================================

export interface NeuBewertenHinweis {
  quelle: 'EREIGNIS' | 'PROFIL' | 'MARKIERT';
  text: string;
  ereignisId?: string;
}

interface ProfilAenderung {
  am: Date;
  fragen: string[];
}

/** Welche Profilfragen haben sich zwischen aufeinanderfolgenden Profilständen geändert? */
async function profilAenderungen(programmId: string, ende: Date): Promise<ProfilAenderung[]> {
  const staende = await db.profilStand.findMany({
    where: { programmId, gueltigAb: { lte: ende } },
    orderBy: { gueltigAb: 'asc' },
    select: { gueltigAb: true, antworten: true },
  });
  const out: ProfilAenderung[] = [];
  for (let i = 1; i < staende.length; i++) {
    const vorher = staende[i - 1]!.antworten as unknown as Partial<Geschaeftsprofil>;
    const nachher = staende[i]!.antworten as unknown as Partial<Geschaeftsprofil>;
    const fragen = PROFIL_FRAGEN.map((f) => f.key as string).filter(
      (k) =>
        JSON.stringify((vorher as Record<string, unknown>)[k] ?? null) !==
        JSON.stringify((nachher as Record<string, unknown>)[k] ?? null),
    );
    if (fragen.length) out.push({ am: staende[i]!.gueltigAb, fragen });
  }
  return out;
}

/**
 * Deterministische Hinweise „neu bewerten" je Risiko-ID (AGENTS.md Regel 7:
 * jeder Hinweis nennt seinen Grund):
 * - Markierung aus der Ereignis-Triage (`neuBewerten`, nur aktueller Stand),
 * - offene Ereignisfolge „Risiko neu bewerten", gemeldet nach der letzten Bewertung,
 * - Änderung einer Profilfrage, auf die sich die Anwendbarkeit stützt, nach der letzten Bewertung.
 */
export async function ladeNeuBewertenHinweise(
  ctx: TcmsKontext,
): Promise<Map<string, NeuBewertenHinweis[]>> {
  const out = new Map<string, NeuBewertenHinweis[]>();
  if (!ctx.programm) return out;
  const ende = tagesende(ctx.stand);
  const aenderungen = await profilAenderungen(ctx.programm.id, ende);
  const frageNr = new Map(PROFIL_FRAGEN.map((f) => [f.key as string, f.nr]));
  const add = (id: string, h: NeuBewertenHinweis) => out.set(id, [...(out.get(id) ?? []), h]);

  for (const r of ctx.risiken) {
    if (r.neuBewerten && !ctx.historisch)
      add(r.id, { quelle: 'MARKIERT', text: 'aus der Ereignis-Triage zur Neubewertung markiert' });
    for (const e of ctx.ereignisse) {
      if (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN') continue;
      if (e.gemeldetAm.getTime() <= r.gueltigAb.getTime()) continue;
      const folge = e.folgen.find(
        (f) =>
          f.art === 'RISIKO_NEU_BEWERTEN' &&
          f.ziel === r.code &&
          (f.status === 'VORGESCHLAGEN' || f.status === 'ANGELEGT'),
      );
      if (folge) {
        add(r.id, {
          quelle: 'EREIGNIS',
          ereignisId: e.id,
          text: `Ereignis ${e.nummer} (${e.typ}) vom ${fmtDatum(e.gemeldetAm)}${folge.status === 'VORGESCHLAGEN' ? ' – Triage offen' : ''}`,
        });
      }
    }
    const fragen = profilFragenAus(katalogRisiko(r.code)?.anwendbarWenn);
    for (const a of aenderungen) {
      if (a.am.getTime() <= r.gueltigAb.getTime()) continue;
      const betroffen = a.fragen.filter((f) => fragen.includes(f));
      if (betroffen.length) {
        add(r.id, {
          quelle: 'PROFIL',
          text: `Profiländerung ${betroffen.map((f) => frageNr.get(f) ?? f.toUpperCase()).join(', ')} am ${fmtDatum(a.am)} (letzte Bewertung ${fmtDatum(r.gueltigAb)})`,
        });
      }
    }
  }
  return out;
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

/** Risikoakzeptanzen (Freigabe-Art RISIKOAKZEPTANZ) bis zum Stichtag, jüngste zuerst. */
export async function ladeAkzeptanzen(ctx: TcmsKontext): Promise<Map<string, AkzeptanzView[]>> {
  const out = new Map<string, AkzeptanzView[]>();
  if (!ctx.programm) return out;
  const ende = tagesende(ctx.stand);
  const liste = await db.freigabe.findMany({
    where: { programmId: ctx.programm.id, art: 'RISIKOAKZEPTANZ', angefordertAm: { lte: ende } },
    orderBy: { angefordertAm: 'desc' },
  });
  for (const f of liste) {
    // Zum Stichtag noch nicht entschiedene Akzeptanzen gelten als offen.
    const status = f.erledigtAm && f.erledigtAm.getTime() > ende.getTime() ? 'OFFEN' : f.status;
    out.set(f.refId, [
      ...(out.get(f.refId) ?? []),
      {
        id: f.id,
        refId: f.refId,
        status,
        titel: f.titel,
        inhalt: f.inhalt,
        angefordertVon: f.angefordertVon,
        angefordertAm: f.angefordertAm,
        empfaengerId: f.empfaengerId,
        anmerkung: status === 'OFFEN' ? null : f.anmerkung,
        erledigtAm: status === 'OFFEN' ? null : f.erledigtAm,
      },
    ]);
  }
  return out;
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

/** Stand-Historie und Audit-Spur eines Risikos zum Stichtag. */
export async function ladeRisikoDetail(
  risiko: Pick<RisikoView, 'id'>,
  stand: Date,
): Promise<RisikoDetail | null> {
  const ende = tagesende(stand);
  const r = await db.risiko.findUnique({
    where: { id: risiko.id },
    include: { staende: { where: { gueltigAb: { lte: ende } }, orderBy: { gueltigAb: 'desc' } } },
  });
  if (!r) return null;
  const audit = await db.auditEvent.findMany({
    // Audit-Zeitstempel sind echte Zeit (auditGrenze, zeit.ts).
    where: { objektTyp: 'Risiko', objektId: r.id, at: { lte: auditGrenze(stand) } },
    orderBy: { seq: 'desc' },
    take: 40,
  });
  return {
    staende: r.staende.map((s) => ({
      id: s.id,
      s: s.s,
      w: s.w,
      r: s.r as 1 | 2 | 3,
      gt: s.gt,
      modell: s.modell,
      gueltigAb: s.gueltigAb,
      // Zum Stichtag war ein später geschlossener Stand noch offen.
      gueltigBis: s.gueltigBis && s.gueltigBis.getTime() <= ende.getTime() ? s.gueltigBis : null,
      erstelltVon: s.erstelltVon,
    })),
    audit: audit.map((a) => ({
      seq: a.seq,
      at: a.at,
      actorName: a.actorName,
      aktion: a.aktion,
      detail: (a.detail ?? {}) as Record<string, unknown>,
    })),
    aktivAb: r.aktivAb,
    herkunft: r.herkunft,
  };
}
