// =============================================================================
// Lagestand einer Durchführung: Sichtbarkeit, Zeilensperre, Beteiligte und
// Rechte – gemeinsam für Lesen und Operationen.
//
// Reihenfolge in jeder Operation (TS-03, TS-05):
//   1. Eingabe strikt prüfen (Contract-Schema).
//   2. Leserecht auf den Mandanten der Anfrage (`kannLesen`), sonst
//      NICHT_GEFUNDEN – bevor irgendein Objekt gelesen wird.
//   3. Sperren in der Ordnung Programm → Risiko → Kontrolle → Durchführung
//      (AGENTS.md TS-05), nur Zeilen des Programms dieses Mandanten (RLS trennt
//      nur Tenants, nicht Mandanten). Fremde, unbekannte und Objekte anderer
//      Mandanten: dieselbe Antwort. Programm und Risiken nur, wo die Operation
//      Zeilen mit Fremdschlüssel darauf anlegt (Feststellung der
//      Gegenzeichnung): deren FK-Prüfung (FOR KEY SHARE) nach der Durchführung
//      liefe sonst gegen die Sperre einer Neuplanung (Risiko/Programm → alle
//      Durchführungen der Kontrolle). Die Kontrolle FOR SHARE: Ihr Stand (die
//      Zuständigkeit) bleibt bis zum Commit, wie gelesen, und das Anlegen eines
//      Nachtrags braucht keine weitere Sperre auf sie. Danach die Durchführung
//      FOR UPDATE, dann ggf. eine Sperre der Operation auf Kindzeilen.
//   4. Mandantenkontakte: `halteRollenFest` (Mandantenzeile FOR KEY SHARE) und
//      Rollen neu lesen – eine in der Wartezeit entzogene Rolle zählt nicht
//      mehr, und bis zum Commit wird keine entzogen (wie Freigaben, RT4-T-05).
//   5. Erst danach den Stand lesen (READ COMMITTED: jede Anweisung sieht den
//      Stand nach der Sperre), Portal-Sichtbarkeit prüfen, Beteiligte aus
//      Durchführung, Nachweisen und Audit ermitteln, Rechte berechnen.
//
// Zuständigkeit offener Durchführungen aus dem aktuell gültigen Kontrollstand,
// Inhalt (Schritte, Kennzahlen, Mindestnachweise) aus dem geplanten Stand der
// Durchführung (`kern/zustaendigkeit.ts`, eine Regel für alle Lesepfade).
// =============================================================================

import { DienstFehler, nichtBerechtigt } from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import { statusAm } from '@tcms/domain';
import { kanonisch, sha256 } from '@tcms/domain/audit';
import { heuteDatum } from '../../kern/zeit';
import { zustaendigkeitAus, zustaendigkeitsStand } from '../../kern/zustaendigkeit';
import type { DienstKontext } from '../../kontext';
import { kannLesen, type KontaktRolle, type KontrollZustaendigkeit } from '../../rechte';
import { halteRollenFest, ladeKontaktRollen } from '../../rollen';
import {
  darfPortalLesen,
  durchfuehrungsRechte,
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
      // Für die Zuständigkeit offener Durchführungen (aktuell gültiger Stand).
      staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] },
    },
  },
  // Entfernte Verweise bleiben gespeichert, werden aber nie gelesen.
  nachweise: { where: { entferntAm: null }, orderBy: [{ hochgeladenAm: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.DurchfuehrungInclude;

export type DurchfuehrungRoh = Prisma.DurchfuehrungGetPayload<{ include: typeof LAGE_INCLUDE }>;
export type KontrollStandRoh = DurchfuehrungRoh['kontrolleStand'];

export interface Lage {
  d: DurchfuehrungRoh;
  mandantId: string;
  programmId: string;
  rollen: KontaktRolle[];
  /** Kontrollstand der Zuständigkeit heute (offen: aktuell gültiger, sonst der eigene). */
  zustaendigkeitsStand: KontrollStandRoh;
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

/**
 * Merkmal eines Entfallen-Antrags (SHA-256 über antragstellende Person und
 * Begründung): Die Freigabe gilt nur dem gesehenen Antrag (TS-05). Ohne
 * Antrag `null`.
 */
export function antragMerkmal(d: {
  entfallenVon: string | null;
  entfallenBegruendung: string | null;
}): string | null {
  if (!d.entfallenBegruendung) return null;
  return sha256(
    kanonisch({ von: d.entfallenVon?.toLowerCase() ?? null, begruendung: d.entfallenBegruendung }),
  );
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

/**
 * Ablehnung eines Rechts als Fehler: Zustand → KONFLIKT, Person →
 * NICHT_BERECHTIGT mit dem Verweigerungsgrund der Rechtefunktion.
 */
export function verlange(r: Recht): void {
  if (r.erlaubt) return;
  if (r.art === 'STATUS') throw new DienstFehler('KONFLIKT', r.grund);
  throw nichtBerechtigt(r.verweigerung, r.grund);
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

/** Eltern, die eine Operation vor der Durchführung sperrt (Zeilen mit FK darauf, TS-05). */
export interface ElternSperren {
  /** Programm des Mandanten FOR KEY SHARE (neue Feststellung). */
  programm?: boolean;
  /** Risiken des Programms FOR KEY SHARE, nach ID (Risikobezüge einer neuen Feststellung). */
  risikoIds?: readonly string[];
}

/**
 * Sperrt in der Ordnung Programm → Risiko → Kontrolle → Durchführung (TS-05):
 * die angegebenen Eltern FOR KEY SHARE, die Kontrolle der Durchführung FOR
 * SHARE und die Durchführung FOR UPDATE – nur, wenn sie zum Programm des
 * Mandanten gehört. Parametrisiert; RLS begrenzt zusätzlich auf den Tenant.
 */
export async function sperreDurchfuehrung(
  tx: Tx,
  durchfuehrungId: string,
  mandantId: string,
  eltern: ElternSperren = {},
): Promise<void> {
  if (eltern.programm) {
    await tx.$queryRaw`
      SELECT p.id FROM "TcmsProgramm" p
       WHERE p."mandantId" = ${mandantId}::uuid
         FOR KEY SHARE`;
  }
  const risikoIds = [...new Set(eltern.risikoIds ?? [])].sort();
  if (risikoIds.length > 0) {
    await tx.$queryRaw`
      SELECT r.id
        FROM "Risiko" r
        JOIN "TcmsProgramm" p ON p.tenant_id = r.tenant_id AND p.id = r."programmId"
       WHERE r.id = ANY(${risikoIds}::text[]) AND p."mandantId" = ${mandantId}::uuid
       ORDER BY r.id
         FOR KEY SHARE OF r`;
  }
  const kontrolle = await tx.$queryRaw<{ id: string }[]>`
    SELECT k.id
      FROM "Durchfuehrung" d
      JOIN "Kontrolle" k ON k.tenant_id = d.tenant_id AND k.id = d."kontrolleId"
      JOIN "TcmsProgramm" p ON p.tenant_id = k.tenant_id AND p.id = k."programmId"
     WHERE d.id = ${durchfuehrungId} AND p."mandantId" = ${mandantId}::uuid
       FOR SHARE OF k`;
  if (kontrolle.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
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

/**
 * Kontrollstand der Zuständigkeit zum Stichtag (`kern/zustaendigkeit.ts`):
 * offene Durchführung → aktuell gültiger Stand der Kontrolle, abgeschlossene
 * bzw. entfallene → ihr eigener.
 */
export function zustaendigkeitsStandVon(
  d: DurchfuehrungRoh,
  stichtag: Date,
  heute: Date,
): KontrollStandRoh {
  return zustaendigkeitsStand(d, d.kontrolleStand, d.kontrolle.staende, stichtag, heute);
}

/**
 * Lädt den Lagestand einer Durchführung im Mandanten der Anfrage. Mit
 * `sperren` unter Zeilensperre (Operationen; `eltern` vorher, `danach` – etwa
 * eine Sperre auf Kindzeilen – direkt nach der Durchführung, beides TS-05).
 * Nicht sichtbar → NICHT_GEFUNDEN.
 */
export async function ladeLage(
  ctx: DienstKontext,
  ziel: { mandantId: string; durchfuehrungId: string },
  opts: { sperren: boolean; eltern?: ElternSperren; danach?: (tx: Tx) => Promise<void> },
): Promise<Lage> {
  // 404-Schranke vor jedem Objekt (TS-03).
  let rollen = await pruefeLeserecht(ctx, ziel.mandantId);
  if (opts.sperren) {
    await sperreDurchfuehrung(ctx.tx, ziel.durchfuehrungId, ziel.mandantId, opts.eltern);
    if (opts.danach) await opts.danach(ctx.tx);
    if (ctx.akteur.art === 'MANDANT') {
      // Rollen erst unter `halteRollenFest` gelten lassen (TS-05, RT4-T-05).
      await halteRollenFest(ctx.tx, ziel.mandantId);
      rollen = await pruefeLeserecht(ctx, ziel.mandantId);
    }
  }
  const d = await ctx.tx.durchfuehrung.findFirst({
    where: { id: ziel.durchfuehrungId, kontrolle: { programm: { mandantId: ziel.mandantId } } },
    include: LAGE_INCLUDE,
  });
  if (!d) throw new DienstFehler('NICHT_GEFUNDEN');
  const heute = heuteDatum(ctx.uhr);
  const zustaendigkeitsStand = zustaendigkeitsStandVon(d, heute, heute);
  const zustaendigkeit = zustaendigkeitAus(zustaendigkeitsStand);
  // Mandantenkontakte sehen nur Aufgaben ihrer Seite, die ihnen offenstehen (P2).
  if (
    ctx.akteur.art === 'MANDANT' &&
    !darfPortalLesen(ctx.akteur, ziel.mandantId, rollen, zustaendigkeit)
  ) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
  const beteiligte = await ladeBeteiligte(ctx.tx, d);
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
    zustaendigkeitsStand,
    zustaendigkeit,
    beteiligte,
    heute,
    rechteLage,
    rechte: durchfuehrungsRechte(rechteLage),
  };
}
