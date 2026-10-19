// =============================================================================
// Lagestand einer Durchführung: Sichtbarkeit, Zeilensperre, Beteiligte und
// Rechte – gemeinsam für Lesen und Operationen.
//
// Reihenfolge in jeder Operation (TS-03, TS-05):
//   1. Eingabe strikt prüfen (Contract-Schema).
//   2. Leserecht auf den Mandanten der Anfrage (`kannLesen`), sonst
//      NICHT_GEFUNDEN – bevor irgendein Objekt gelesen wird.
//   3. Zeile `SELECT … FOR UPDATE` sperren, nur wenn sie zum Programm dieses
//      Mandanten gehört (RLS trennt nur Tenants, nicht Mandanten). Fremde,
//      unbekannte und Objekte anderer Mandanten: dieselbe Antwort.
//   4. Erst danach den Stand lesen (READ COMMITTED: jede Anweisung sieht den
//      Stand nach der Sperre), Portal-Sichtbarkeit prüfen, Beteiligte aus
//      Durchführung, Nachweisen und Audit ermitteln, Rechte berechnen.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import { statusAm } from '@tcms/domain';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannLesen, type KontaktRolle, type KontrollZustaendigkeit } from '../../rechte';
import { ladeKontaktRollen } from '../../rollen';
import {
  darfPortalLesen,
  durchfuehrungsRechte,
  KEIN_RECHT,
  type HandlungsRechte,
  type Recht,
  type RechteLage,
} from './rechte';

/**
 * Audit-Aktionen, deren Akteur an der Durchführung mitgewirkt hat (Vier-Augen,
 * AGENTS.md Regel 4). Aus dem Audit, damit auch entfernte Nachweise zählen.
 */
export const DURCHFUEHRUNGS_AKTIONEN: readonly string[] = [
  'tcms.durchfuehrung.begonnen',
  'tcms.durchfuehrung.gespeichert',
  'tcms.durchfuehrung.nachweis_hochgeladen',
  'tcms.durchfuehrung.nachweis_entfernt',
  'tcms.durchfuehrung.eingereicht',
];

export const LAGE_INCLUDE = {
  kontrolleStand: true,
  kontrolle: {
    select: {
      id: true,
      code: true,
      programmId: true,
      programm: { select: { mandantId: true } },
    },
  },
  nachweise: { orderBy: [{ hochgeladenAm: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.DurchfuehrungInclude;

export type DurchfuehrungRoh = Prisma.DurchfuehrungGetPayload<{ include: typeof LAGE_INCLUDE }>;

export interface Lage {
  d: DurchfuehrungRoh;
  mandantId: string;
  programmId: string;
  rollen: KontaktRolle[];
  zustaendigkeit: KontrollZustaendigkeit;
  beteiligte: string[];
  heute: Date;
  /** Grundlage der Rechte (aktueller Stand, ohne Namen). */
  rechteLage: RechteLage;
  rechte: HandlungsRechte;
}

interface Pruefbar<T> {
  safeParse(v: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

/** Prüft die Eingabe mit dem Contract-Schema; Feldfehler als `UNGUELTIG`. */
export function pruefeEingabe<T>(schema: Pruefbar<T>, eingabe: unknown): T {
  const p = schema.safeParse(eingabe);
  if (p.success) return p.data;
  const felder: Record<string, string[]> = {};
  for (const i of p.error.issues) {
    (felder[i.path.map(String).join('.') || 'eingabe'] ??= []).push(i.message);
  }
  throw new DienstFehler('UNGUELTIG', 'Eingabe ungültig.', felder);
}

/** Ablehnung eines Rechts als Fehler: Zustand → KONFLIKT, Person → NICHT_BERECHTIGT. */
export function verlange(r: Recht): void {
  if (r.erlaubt) return;
  throw new DienstFehler(
    r.art === 'STATUS' ? 'KONFLIKT' : 'NICHT_BERECHTIGT',
    r.grund ?? KEIN_RECHT,
  );
}

/** Leserecht auf den Mandanten der Anfrage (TS-03); liefert die Kontaktrollen des Akteurs. */
export async function pruefeLeserecht(
  ctx: DienstKontext,
  mandantId: string,
): Promise<KontaktRolle[]> {
  const rollen = await ladeKontaktRollen(ctx.tx, ctx.akteur);
  if (!kannLesen(ctx.akteur, mandantId, rollen)) throw new DienstFehler('NICHT_GEFUNDEN');
  return rollen;
}

/**
 * Sperrt die Durchführung (TS-05), aber nur, wenn sie zum Programm des
 * Mandanten gehört. Parametrisiert; RLS begrenzt zusätzlich auf den Tenant.
 */
export async function sperreDurchfuehrung(
  tx: Tx,
  durchfuehrungId: string,
  mandantId: string,
): Promise<void> {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT d.id
      FROM "Durchfuehrung" d
      JOIN "Kontrolle" k ON k.tenant_id = d.tenant_id AND k.id = d."kontrolleId"
      JOIN "TcmsProgramm" p ON p.tenant_id = k.tenant_id AND p.id = k."programmId"
     WHERE d.id = ${durchfuehrungId} AND p."mandantId" = ${mandantId}::uuid
       FOR UPDATE OF d`;
  if (zeilen.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Personen, die an der Durchführung mitgewirkt haben: durchführende Person,
 * hochladende Personen und Akteure der Durchführungs-Aktionen im Audit (auch
 * für inzwischen entfernte Nachweise). IDs kanonisch klein.
 */
export async function ladeBeteiligte(
  tx: Tx,
  d: Pick<DurchfuehrungRoh, 'id' | 'durchgefuehrtVon' | 'nachweise'>,
): Promise<string[]> {
  const ids = new Set<string>();
  const merke = (id: string | null | undefined) => {
    if (id) ids.add(id.toLowerCase());
  };
  merke(d.durchgefuehrtVon);
  for (const n of d.nachweise) merke(n.hochgeladenVon);
  // Zwei Zweige als UNION, damit je ein Index greift: (tenant_id, objektTyp, objektId)
  // und – vorgeschlagen – (tenant_id, (detail->>'durchfuehrungId')).
  const aktionen = [...DURCHFUEHRUNGS_AKTIONEN];
  const audit = await tx.$queryRaw<{ actorId: string | null }[]>`
    SELECT "actorId" FROM "AuditEvent"
     WHERE aktion = ANY(${aktionen}::text[])
       AND "objektTyp" = 'Durchfuehrung' AND "objektId" = ${d.id}
    UNION
    SELECT "actorId" FROM "AuditEvent"
     WHERE aktion = ANY(${aktionen}::text[])
       AND detail->>'durchfuehrungId' = ${d.id}`;
  for (const e of audit) merke(e.actorId);
  return [...ids].sort();
}

export function zustaendigkeitVon(d: DurchfuehrungRoh): KontrollZustaendigkeit {
  const ks = d.kontrolleStand;
  return {
    durchfuehrendId: ks.durchfuehrendId,
    vertretungId: ks.vertretungId,
    gegenzeichnerId: ks.gegenzeichnerId,
    gegenzeichnungMandant: ks.gegenzeichnungMandant,
    partei: ks.partei,
  };
}

/**
 * Lädt den Lagestand einer Durchführung im Mandanten der Anfrage. Mit
 * `sperren` unter Zeilensperre (Operationen). Nicht sichtbar → NICHT_GEFUNDEN.
 */
export async function ladeLage(
  ctx: DienstKontext,
  ziel: { mandantId: string; durchfuehrungId: string },
  opts: { sperren: boolean },
): Promise<Lage> {
  const rollen = await pruefeLeserecht(ctx, ziel.mandantId);
  if (opts.sperren) await sperreDurchfuehrung(ctx.tx, ziel.durchfuehrungId, ziel.mandantId);
  const d = await ctx.tx.durchfuehrung.findFirst({
    where: { id: ziel.durchfuehrungId, kontrolle: { programm: { mandantId: ziel.mandantId } } },
    include: LAGE_INCLUDE,
  });
  if (!d) throw new DienstFehler('NICHT_GEFUNDEN');
  const zustaendigkeit = zustaendigkeitVon(d);
  // Mandantenkontakte sehen nur Aufgaben ihrer Seite, die ihnen offenstehen (P2).
  if (
    ctx.akteur.art === 'MANDANT' &&
    !darfPortalLesen(ctx.akteur, ziel.mandantId, rollen, zustaendigkeit)
  ) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
  const beteiligte = await ladeBeteiligte(ctx.tx, d);
  const heute = heuteDatum(ctx.uhr);
  const rechteLage: RechteLage = {
    akteur: ctx.akteur,
    rollen,
    mandantId: ziel.mandantId,
    historisch: false,
    status: d.status,
    anzeige: statusAm(d, heute),
    periodeBis: d.periodeBis,
    zustaendigkeit,
    durchgefuehrtVon: d.durchgefuehrtVon,
    mandantBestaetigtVon: d.mandantBestaetigtVon,
    entfallenBegruendung: d.entfallenBegruendung,
    entfallenVon: d.entfallenVon,
    beteiligte,
  };
  return {
    d,
    mandantId: ziel.mandantId,
    programmId: d.kontrolle.programmId,
    rollen,
    zustaendigkeit,
    beteiligte,
    heute,
    rechteLage,
    rechte: durchfuehrungsRechte(rechteLage),
  };
}
