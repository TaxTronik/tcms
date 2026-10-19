// =============================================================================
// Postausgang (Nachricht): Der Dienst versendet keine E-Mails. Er legt
// Nachrichten ab, die kanzleikonsole holt sie ab und stellt sie mit eigenen
// Vorlagen zu (Stufe 4). Empfänger werden ausschließlich über die Personen-ID
// adressiert (TS-06), nie über Namen oder Adressen; Zweck, Mandant,
// Empfängerart und die Vorlagendaten (`daten`) stehen strukturiert in der
// Zeile, `betreff`/`text` bleiben als Rückfall.
//
// Sparsamkeit: Ein Bestätigungscode steht im Klartext nur in `code` (und im
// Rückfalltext), nie in `daten`, und nur bis zum Abschluss: „Zugestellt"
// setzt `zugestelltAm`, „unzustellbar" (die kanzleikonsole konnte nicht
// zustellen) setzt `unzustellbarAm` mit Grund; beide leeren `code` und `text`
// und schließen sich aus (409, CHECK). Der Vorgang steht im Audit (ohne Text
// und Code). Gilt der Code nicht mehr (Freigabe erledigt, Code abgelaufen,
// ersetzt, gesperrt oder neu adressiert), liefert der nächste Abruf die
// Nachricht nicht mehr aus und leert sie (`verworfenAm`).
//
// Abholen und Melden ausschließlich durch den Systemakteur der kanzleikonsole
// (`SystemKontext`, Stufe 4): Der Zustell-Worker ist keine Person, und keine
// Person – auch kein Admin – liest den Postausgang über den Dienst.
// Tenantweit über RLS. Codes erscheinen in keiner anderen Antwort und in
// keinem Audit-Detail.
// =============================================================================

import {
  DienstFehler,
  NACHRICHT_EMPFAENGER,
  NACHRICHT_ZWECKE,
  NachrichtDatenEreignisGemeldetSchema,
  NachrichtDatenFreigabeAngefordertSchema,
  NachrichtDatenFreigabeCodeSchema,
  NachrichtDatenFreigabeNeuAdressiertSchema,
  NachrichtenOffenEingabeSchema,
  NachrichtUnzustellbarEingabeSchema,
  NachrichtZugestelltEingabeSchema,
  OffeneNachrichtSchema,
  type NachrichtEmpfaengerArt,
  type NachrichtenOffenEingabe,
  type NachrichtUnzustellbarEingabe,
  type NachrichtUnzustellbarErgebnis,
  type NachrichtUnzustellbarGrund,
  type NachrichtZugestelltEingabe,
  type NachrichtZugestelltErgebnis,
  type NachrichtZweck,
  type OffeneNachricht,
} from '@tcms/contract';
import type { Freigabe, Prisma, Tx } from '@tcms/db';
import type { z } from 'zod';
import { mitAudit, type Protokoll } from '../../audit';
import type { SystemKontext } from '../../kontext';
import { gleicheId } from '../../rechte';
import {
  brauchtCodeSchluessel,
  codePasst,
  codeVerfahrenGueltig,
  istGesperrt,
  leseCodeZustand,
  type CodeSchluessel,
} from './code';
import { pruefeEingabe } from './gemeinsam';

// Typprüfung: Die Datenbank-Enums sind genau die Listen des Vertrags.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _zweckePassen: Gleich<Prisma.NachrichtCreateInput['zweck'], NachrichtZweck> = true;
const _artenPassen: Gleich<Prisma.NachrichtCreateInput['empfaengerArt'], NachrichtEmpfaengerArt> =
  true;
const _gruendePassen: Gleich<
  NonNullable<Prisma.NachrichtCreateInput['unzustellbarGrund']>,
  NachrichtUnzustellbarGrund
> = true;
void _zweckePassen;
void _artenPassen;
void _gruendePassen;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STANDARD_NACHRICHTEN_LIMIT = 50;

/** Schema der Vorlagendaten je Zweck (aus dem Vertrag). */
const DATEN_SCHEMA: { readonly [Z in NachrichtZweck]: z.ZodType } = {
  FREIGABE_ANGEFORDERT: NachrichtDatenFreigabeAngefordertSchema,
  FREIGABE_CODE: NachrichtDatenFreigabeCodeSchema,
  FREIGABE_NEU_ADRESSIERT: NachrichtDatenFreigabeNeuAdressiertSchema,
  EREIGNIS_GEMELDET: NachrichtDatenEreignisGemeldetSchema,
};

/** Zweck und Vorlagendaten einer neuen Nachricht (bei FREIGABE_CODE mit Code). */
export type NachrichtInhalt = {
  [Z in NachrichtZweck]: { zweck: Z; daten: Extract<OffeneNachricht, { zweck: Z }>['daten'] };
}[NachrichtZweck];

export type NeueNachricht = NachrichtInhalt & {
  /** Mandant, zu dem die Nachricht gehört (Anker im Tenant). */
  mandantId: string;
  empfaengerId: string;
  /** Rückfalltext für Zustellwege ohne Vorlage. */
  betreff: string;
  text: string;
  /** Fachliche Zeit der Anlage (Uhr der Operation); sonst Datenbankzeit. */
  erstelltAm?: Date;
};

/**
 * Legt eine Nachricht im Postausgang ab (in der Transaktion der fachlichen
 * Änderung). Empfänger und Mandant nur als ID, die Empfängerart folgt aus dem
 * Zweck (`NACHRICHT_EMPFAENGER`), die Vorlagendaten werden gegen den Vertrag
 * geprüft. Ein Verstoß ist ein Programmierfehler (fail closed, Meldung ohne
 * Werte). Der Code landet nur in der Spalte `code`, nie in `daten`.
 */
export async function legeNachrichtAn(tx: Tx, n: NeueNachricht): Promise<string> {
  if (!UUID.test(n.empfaengerId)) throw new Error('[service] Empfänger ohne gültige ID');
  if (!UUID.test(n.mandantId)) throw new Error('[service] Nachricht ohne gültigen Mandanten');
  if (!(NACHRICHT_ZWECKE as readonly string[]).includes(n.zweck)) {
    throw new Error('[service] Unbekannter Nachrichtenzweck');
  }
  const geprueft = DATEN_SCHEMA[n.zweck].safeParse(n.daten);
  if (!geprueft.success) throw new Error('[service] Vorlagendaten verletzen den Vertrag');
  const { code, ...ohneCode } = geprueft.data as Record<string, unknown> & { code?: string };
  const z = await tx.nachricht.create({
    data: {
      mandantId: n.mandantId.toLowerCase(),
      empfaengerId: n.empfaengerId.toLowerCase(),
      empfaengerArt: NACHRICHT_EMPFAENGER[n.zweck],
      zweck: n.zweck,
      betreff: n.betreff,
      text: n.text,
      daten: ohneCode as Prisma.InputJsonValue,
      code: n.zweck === 'FREIGABE_CODE' ? (code ?? null) : null,
      ...(n.erstelltAm ? { createdAt: n.erstelltAm } : {}),
    },
    select: { id: true },
  });
  return z.id;
}

/**
 * Gespeicherte Zeile → offene Nachricht des Vertrags; `null`, wenn sie den
 * Vertrag nicht (mehr) erfüllt – etwa ein Titel aus der Zeit vor RT4-T-03 mit
 * Zeilenumbruch oder Richtungszeichen. Solche Nachrichten werden nicht
 * ausgeliefert, sondern verworfen (fail closed je Nachricht).
 */
function alsOffeneNachricht(z: {
  id: string;
  mandantId: string;
  empfaengerId: string;
  empfaengerArt: string;
  zweck: string;
  betreff: string;
  text: string;
  daten: Prisma.JsonValue;
  code: string | null;
  createdAt: Date;
}): OffeneNachricht | null {
  const daten =
    z.zweck === 'FREIGABE_CODE' && z.daten && typeof z.daten === 'object' && !Array.isArray(z.daten)
      ? { ...z.daten, code: z.code }
      : z.daten;
  const n = OffeneNachrichtSchema.safeParse({
    id: z.id,
    mandantId: z.mandantId,
    empfaengerId: z.empfaengerId,
    empfaengerArt: z.empfaengerArt,
    zweck: z.zweck,
    betreff: z.betreff,
    text: z.text,
    erstelltAm: z.createdAt.toISOString(),
    daten,
  });
  return n.success ? n.data : null;
}

/**
 * Nur der Systemakteur (dritte Schicht nach Routentabelle und `systemKontext`):
 * Personen erhalten `NICHT_GEFUNDEN` wie ein unbekannter Pfad, auch wenn ein
 * Aufrufer einen `DienstKontext` unterschiebt. Vor jedem Datenzugriff.
 */
function brauchtSystem(ctx: SystemKontext): void {
  const a = (ctx as { akteur?: { art?: unknown } } | null)?.akteur;
  if (a?.art !== 'SYSTEM') throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Grund, aus dem eine Nachricht nicht mehr ausgeliefert wird (nur IDs und Codes
 * im Audit): Code-Nachrichten, deren Code nicht mehr gilt, und Nachrichten,
 * deren gespeicherte Vorlagendaten den Vertrag verletzen (`DATEN_UNGUELTIG`).
 */
export type VerwerfGrund =
  | 'FREIGABE_NICHT_OFFEN'
  | 'CODE_ABGELAUFEN'
  | 'CODE_UNGUELTIG'
  | 'DATEN_UNGUELTIG';

/**
 * Prüft, ob der Code einer offenen Code-Nachricht noch der aktive Code ihrer
 * Freigabe ist: Freigabe vorhanden, im Mandanten der Nachricht, offen, an
 * denselben Empfänger, nicht gesperrt, Code nicht abgelaufen (echte Zeit,
 * Sicherheitsfrist) und der Hash passt (ein neu angeforderter Code oder eine
 * Neuadressierung ersetzt ihn). Sonst der Grund zum Verwerfen.
 */
function grundZumVerwerfen(
  n: { mandantId: string; empfaengerId: string; daten: Prisma.JsonValue; code: string | null },
  f:
    | (Pick<
        Freigabe,
        | 'id'
        | 'status'
        | 'empfaengerId'
        | 'codeHash'
        | 'codeSchluesselId'
        | 'codeAblauf'
        | 'codeFehlversuche'
      > & { programm: { mandantId: string } })
    | undefined,
  jetzt: Date,
  schluessel: CodeSchluessel,
): VerwerfGrund | null {
  if (!f || f.status !== 'OFFEN' || f.programm.mandantId !== n.mandantId) {
    return 'FREIGABE_NICHT_OFFEN';
  }
  const z = leseCodeZustand(f);
  // H5: früheres Verfahren oder Schlüssel nicht mehr konfiguriert → abgelaufen.
  if (!istGesperrt(z) && z.hash !== null && !codeVerfahrenGueltig(schluessel, z)) {
    return 'CODE_ABGELAUFEN';
  }
  // Ist es noch der aktive Code dieses Empfängers? (ersetzt, neu adressiert, gesperrt)
  if (
    n.code === null ||
    istGesperrt(z) ||
    !gleicheId(f.empfaengerId, n.empfaengerId) ||
    !codePasst(schluessel, f.id, n.code, z)
  ) {
    return 'CODE_UNGUELTIG';
  }
  if (!f.codeAblauf || f.codeAblauf.getTime() <= jetzt.getTime()) return 'CODE_ABGELAUFEN';
  return null;
}

/** Höchstzahl offener Code-Nachrichten, die ein Abruf zusätzlich prüft (begrenzt die Arbeit). */
export const MAX_CODE_PRUEFUNG_JE_ABRUF = 1000;

type CodeZeile = {
  id: string;
  mandantId: string;
  empfaengerId: string;
  daten: Prisma.JsonValue;
  code: string | null;
};

/**
 * Code-Nachrichten unter `zeilen`, deren Code nicht mehr gilt
 * (`grundZumVerwerfen`); unlesbare Vorlagendaten gelten als veraltet (fail
 * closed, nie ausgeliefert).
 */
async function veralteteCodes(
  tx: Tx,
  zeilen: readonly CodeZeile[],
  jetzt: Date,
  schluessel: CodeSchluessel,
): Promise<{ id: string; empfaengerId: string; grund: VerwerfGrund }[]> {
  if (zeilen.length === 0) return [];
  const freigabeIdVon = (daten: Prisma.JsonValue): string | null => {
    const r = NachrichtDatenFreigabeAngefordertSchema.shape.freigabeId.safeParse(
      daten && typeof daten === 'object' && !Array.isArray(daten) ? daten['freigabeId'] : null,
    );
    return r.success ? r.data : null;
  };
  const ids = [...new Set(zeilen.map((n) => freigabeIdVon(n.daten)).filter((x) => x !== null))];
  const freigaben = new Map(
    (
      await tx.freigabe.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          empfaengerId: true,
          codeHash: true,
          codeSchluesselId: true,
          codeAblauf: true,
          codeFehlversuche: true,
          programm: { select: { mandantId: true } },
        },
        orderBy: { id: 'asc' },
      })
    ).map((f) => [f.id, f]),
  );
  const veraltet: { id: string; empfaengerId: string; grund: VerwerfGrund }[] = [];
  for (const n of zeilen) {
    const freigabeId = freigabeIdVon(n.daten);
    const grund = grundZumVerwerfen(
      n,
      freigabeId ? freigaben.get(freigabeId) : undefined,
      jetzt,
      schluessel,
    );
    if (grund) veraltet.push({ id: n.id, empfaengerId: n.empfaengerId, grund });
  }
  return veraltet;
}

/**
 * Offene Nachrichten des Tenants (älteste zuerst) zur Zustellung durch die
 * kanzleikonsole. Ausgeliefert wird nur, was geprüft ist: Zuerst werden die
 * ältesten `MAX_CODE_PRUEFUNG_JE_ABRUF` offenen Code-Nachrichten gegen ihre
 * Freigabe geprüft. Gilt der Code nicht mehr (Freigabe erledigt, Code
 * abgelaufen, ersetzt, gesperrt, neu adressiert oder Freigabe eines anderen
 * Mandanten), wird die Nachricht verworfen – `verworfenAm` gesetzt, `code` und
 * `text` geleert, je Nachricht ein Audit-Eintrag mit Grund (ohne Code). Erst
 * danach werden die Kandidaten gelesen; Code-Kandidaten außerhalb dieser
 * Prüfung (nur bei sehr vielen offenen Codes) werden ebenso geprüft und
 * gegebenenfalls nicht ausgeliefert (die Antwort enthält dann weniger als
 * `limit`). Kandidaten, deren gespeicherte Vorlagendaten den Vertrag
 * verletzen (etwa ein Titel mit Zeilenumbruch aus der Zeit vor RT4-T-03),
 * werden ebenso verworfen (`DATEN_UNGUELTIG`), statt den Abruf zu blockieren.
 * Der Abruf wird protokolliert (IDs, kein Text).
 */
export async function ladeOffeneNachrichten(
  ctx: SystemKontext,
  eingabe: NachrichtenOffenEingabe,
): Promise<{ nachrichten: OffeneNachricht[] }> {
  brauchtSystem(ctx);
  const e = pruefeEingabe(NachrichtenOffenEingabeSchema, eingabe);
  const schluessel = brauchtCodeSchluessel(ctx.codes);
  const limit = e.limit ?? STANDARD_NACHRICHTEN_LIMIT;
  // Codefristen laufen auf echter Zeit, nie auf einer fachlichen Uhr (AGENTS.md).
  const jetzt = new Date();
  // Offen: weder zugestellt noch unzustellbar gemeldet noch verworfen.
  const offen = { zugestelltAm: null, unzustellbarAm: null, verworfenAm: null };
  const reihenfolge = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
  const protokoll: Protokoll[] = [];
  const geprueft = new Set<string>();
  const ausgeschlossen = new Set<string>();
  /** Verwirft eine offene Nachricht (bedingt, mit Audit; leert Code und Text). */
  async function verwirf(v: {
    id: string;
    empfaengerId: string;
    zweck: NachrichtZweck;
    grund: VerwerfGrund;
  }): Promise<void> {
    ausgeschlossen.add(v.id);
    // Bedingt: Eine gleichzeitige Zustellung oder ein anderer Abruf verwirft nicht doppelt.
    const r = await ctx.tx.nachricht.updateMany({
      where: { id: v.id, ...offen },
      data: { verworfenAm: jetzt, code: null, text: '' },
    });
    if (r.count !== 1) return;
    protokoll.push({
      aktion: 'tcms.nachricht.verworfen',
      objektTyp: 'Nachricht',
      objektId: v.id,
      programmId: null,
      detail: { zweck: v.zweck, empfaengerId: v.empfaengerId, grund: v.grund },
    });
  }
  /** Prüft Code-Nachrichten und verwirft die veralteten. */
  async function pruefeUndVerwirf(zeilen: readonly CodeZeile[]): Promise<void> {
    for (const z of zeilen) geprueft.add(z.id);
    for (const v of await veralteteCodes(ctx.tx, zeilen, jetzt, schluessel)) {
      await verwirf({ ...v, zweck: 'FREIGABE_CODE' });
    }
  }
  // 1. Die ältesten offenen Code-Nachrichten prüfen und verfallene leeren (Sparsamkeit).
  await pruefeUndVerwirf(
    await ctx.tx.nachricht.findMany({
      where: { ...offen, zweck: 'FREIGABE_CODE' },
      orderBy: reihenfolge,
      take: MAX_CODE_PRUEFUNG_JE_ABRUF,
      select: { id: true, mandantId: true, empfaengerId: true, daten: true, code: true },
    }),
  );
  // 2. Kandidaten erst danach lesen: Verworfene belegen keinen Platz im Limit.
  const kandidaten = await ctx.tx.nachricht.findMany({
    where: offen,
    orderBy: reihenfolge,
    take: limit,
  });
  // 3. Code-Kandidaten außerhalb der Prüfung aus 1. (nur bei sehr vielen offenen Codes) prüfen:
  //    Ausgeliefert wird nur Geprüftes.
  await pruefeUndVerwirf(
    kandidaten.filter((k) => k.zweck === 'FREIGABE_CODE' && !geprueft.has(k.id)),
  );
  // 4. Nur vertragsgemäße Vorlagendaten ausliefern; ältere Zeilen, die den Vertrag
  //    verletzen (RT4-T-03), werden verworfen statt den ganzen Abruf zu blockieren.
  const nachrichten: OffeneNachricht[] = [];
  for (const k of kandidaten) {
    if (ausgeschlossen.has(k.id)) continue;
    const n = alsOffeneNachricht(k);
    if (n) nachrichten.push(n);
    else await verwirf({ ...k, grund: 'DATEN_UNGUELTIG' });
  }
  // 5. Erste Auslieferung festhalten (H2): Nur eine ausgelieferte Nachricht kann die
  //    kanzleikonsole nach einem späteren Verwerfen noch als zugestellt melden.
  if (nachrichten.length > 0) {
    await ctx.tx.nachricht.updateMany({
      where: { id: { in: nachrichten.map((n) => n.id) }, abgerufenAm: null },
      data: { abgerufenAm: jetzt },
    });
  }
  if (nachrichten.length > 0) {
    protokoll.push({
      aktion: 'tcms.nachricht.abgerufen',
      objektTyp: 'Nachricht',
      objektId: nachrichten[0]!.id,
      programmId: null,
      detail: { anzahl: nachrichten.length, ids: nachrichten.map((n) => n.id) },
    });
  }
  if (protokoll.length === 0) return { nachrichten };
  return mitAudit(ctx, async () => ({ wert: { nachrichten }, protokoll }));
}

/** Zustand einer Nachricht unter Zeilensperre (ohne Inhalte: kein Text, kein Code). */
interface NachrichtZustand {
  id: string;
  zweck: NachrichtZweck;
  empfaengerId: string;
  zugestelltAm: Date | null;
  unzustellbarAm: Date | null;
  unzustellbarGrund: NachrichtUnzustellbarGrund | null;
  verworfenAm: Date | null;
  abgerufenAm: Date | null;
}

/**
 * Sperrt eine Nachricht des eigenen Tenants (FOR UPDATE, TS-05) und liest
 * ihren Zustand. Unbekannte IDs und Nachrichten anderer Tenants (RLS:
 * unsichtbar) → `NICHT_GEFUNDEN`; das verrät nichts über andere Tenants, und
 * der Systemakteur sieht die Nachrichten seines Tenants ohnehin. Gleichzeitige
 * Meldungen zu derselben Nachricht laufen so nacheinander und sehen den
 * Zustand der vorherigen (zugestellt bzw. unzustellbar).
 */
async function sperreNachricht(tx: Tx, nachrichtId: string): Promise<NachrichtZustand> {
  const zeilen = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Nachricht" WHERE id = ${nachrichtId} FOR UPDATE`;
  if (zeilen.length !== 1) throw new DienstFehler('NICHT_GEFUNDEN');
  const z = await tx.nachricht.findUnique({
    where: { id: nachrichtId },
    select: {
      id: true,
      zweck: true,
      empfaengerId: true,
      zugestelltAm: true,
      unzustellbarAm: true,
      unzustellbarGrund: true,
      verworfenAm: true,
      abgerufenAm: true,
    },
  });
  if (!z) throw new DienstFehler('NICHT_GEFUNDEN');
  return z;
}

/**
 * Verworfen, bevor ein Abruf sie je ausgeliefert hat (H2): Die kanzleikonsole
 * kann sie weder zugestellt noch als unzustellbar erlebt haben.
 */
const nieAusgeliefert = (z: NachrichtZustand) => z.verworfenAm !== null && z.abgerufenAm === null;
/** Bedingung für Meldungen: nicht verworfen oder vor dem Verwerfen ausgeliefert (wie der CHECK). */
const MELDBAR = { OR: [{ verworfenAm: null }, { abgerufenAm: { not: null } }] };

const BEREITS_UNZUSTELLBAR = 'Die Nachricht ist bereits als unzustellbar gemeldet.';
const BEREITS_ZUGESTELLT = 'Die Nachricht ist bereits als zugestellt gemeldet.';
const NIE_AUSGELIEFERT = 'Die Nachricht wurde verworfen, bevor sie ausgeliefert wurde.';
/** Unter der Zeilensperre nicht erreichbar; fail closed statt eines Doppelstatus. */
const ZUSTAND_GEAENDERT = 'Die Nachricht hat ihren Zustand geändert.';

/**
 * Zustellung bestätigen: `zugestelltAm` wird gesetzt, Text und Code geleert.
 * Idempotent für Nachrichten des eigenen Tenants (eine bereits bestätigte
 * liefert dasselbe Ergebnis ohne zweites Audit). Eine als unzustellbar
 * gemeldete Nachricht → `KONFLIKT` (schließen sich aus), ebenso eine
 * verworfene, die nie ausgeliefert wurde (H2: sie bliebe sonst als ZUGESTELLT
 * sichtbar). Unbekannte IDs und Nachrichten anderer Tenants → `NICHT_GEFUNDEN`.
 */
export async function bestaetigeNachrichtZustellung(
  ctx: SystemKontext,
  eingabe: NachrichtZugestelltEingabe,
): Promise<NachrichtZugestelltErgebnis> {
  brauchtSystem(ctx);
  const e = pruefeEingabe(NachrichtZugestelltEingabeSchema, eingabe);
  const ergebnis: NachrichtZugestelltErgebnis = { nachrichtId: e.nachrichtId, zugestellt: true };
  const zeile = await sperreNachricht(ctx.tx, e.nachrichtId);
  if (zeile.zugestelltAm) return ergebnis;
  if (zeile.unzustellbarAm) throw new DienstFehler('KONFLIKT', BEREITS_UNZUSTELLBAR);
  if (nieAusgeliefert(zeile)) throw new DienstFehler('KONFLIKT', NIE_AUSGELIEFERT);
  // Bedingt auf den gesperrten Zustand (fail closed, zusätzlich zum CHECK der Datenbank).
  const r = await ctx.tx.nachricht.updateMany({
    where: { id: zeile.id, zugestelltAm: null, unzustellbarAm: null, ...MELDBAR },
    data: { zugestelltAm: ctx.uhr.jetzt(), text: '', code: null },
  });
  if (r.count !== 1) throw new DienstFehler('KONFLIKT', ZUSTAND_GEAENDERT);
  return mitAudit(ctx, async () => ({
    wert: ergebnis,
    protokoll: {
      aktion: 'tcms.nachricht.zugestellt',
      objektTyp: 'Nachricht',
      objektId: zeile.id,
      programmId: null,
      detail: { zweck: zeile.zweck, empfaengerId: zeile.empfaengerId },
    },
  }));
}

/**
 * Unzustellbarkeit melden: Die kanzleikonsole konnte die Nachricht nicht
 * zustellen (Empfänger ungültig, kein bestätigter Portalzugang, Frist
 * abgelaufen, Sonstiges) und schließt sie ab. Setzt `unzustellbarAm` und
 * `unzustellbarGrund` und leert Text und Code wie die Zustellung; die
 * Nachricht wird nicht mehr ausgeliefert. Die Kanzlei sieht den Status an der
 * Freigabe und kann neu adressieren.
 *
 * Idempotent mit demselben Grund (kein zweites Audit). Bereits zugestellt oder
 * mit anderem Grund gemeldet → `KONFLIKT` (zugestellt und unzustellbar
 * schließen sich aus; zusätzlich CHECK in der Datenbank), ebenso eine
 * verworfene Nachricht, die nie ausgeliefert wurde (H2). Unbekannte IDs und
 * Nachrichten anderer Tenants → `NICHT_GEFUNDEN`. Das Audit nennt Zweck,
 * Empfänger-ID und Grund, nie Inhalte.
 */
export async function meldeNachrichtUnzustellbar(
  ctx: SystemKontext,
  eingabe: NachrichtUnzustellbarEingabe,
): Promise<NachrichtUnzustellbarErgebnis> {
  brauchtSystem(ctx);
  const e = pruefeEingabe(NachrichtUnzustellbarEingabeSchema, eingabe);
  const ergebnis: NachrichtUnzustellbarErgebnis = {
    nachrichtId: e.nachrichtId,
    unzustellbar: true,
    grund: e.grund,
  };
  const zeile = await sperreNachricht(ctx.tx, e.nachrichtId);
  if (zeile.zugestelltAm) throw new DienstFehler('KONFLIKT', BEREITS_ZUGESTELLT);
  if (zeile.unzustellbarAm) {
    if (zeile.unzustellbarGrund === e.grund) return ergebnis;
    throw new DienstFehler('KONFLIKT', 'Die Nachricht ist bereits mit anderem Grund gemeldet.');
  }
  if (nieAusgeliefert(zeile)) throw new DienstFehler('KONFLIKT', NIE_AUSGELIEFERT);
  // Bedingt auf den gesperrten Zustand (fail closed, zusätzlich zum CHECK der Datenbank).
  const r = await ctx.tx.nachricht.updateMany({
    where: { id: zeile.id, zugestelltAm: null, unzustellbarAm: null, ...MELDBAR },
    data: { unzustellbarAm: ctx.uhr.jetzt(), unzustellbarGrund: e.grund, text: '', code: null },
  });
  if (r.count !== 1) throw new DienstFehler('KONFLIKT', ZUSTAND_GEAENDERT);
  return mitAudit(ctx, async () => ({
    wert: ergebnis,
    protokoll: {
      aktion: 'tcms.nachricht.unzustellbar',
      objektTyp: 'Nachricht',
      objektId: zeile.id,
      programmId: null,
      detail: { zweck: zeile.zweck, empfaengerId: zeile.empfaengerId, grund: e.grund },
    },
  }));
}
