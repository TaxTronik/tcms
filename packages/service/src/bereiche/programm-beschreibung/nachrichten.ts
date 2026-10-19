// =============================================================================
// Postausgang (Nachricht): Der Dienst versendet keine E-Mails. Er legt
// Nachrichten ab, die kanzleikonsole holt sie ab und stellt sie mit eigenen
// Vorlagen zu (Stufe 4). Empfänger werden ausschließlich über die Personen-ID
// adressiert (TS-06), nie über Namen oder Adressen; Zweck, Mandant,
// Empfängerart und die Vorlagendaten (`daten`) stehen strukturiert in der
// Zeile, `betreff`/`text` bleiben als Rückfall.
//
// Sparsamkeit: Ein Bestätigungscode steht im Klartext nur in `code` (und im
// Rückfalltext), nie in `daten`. „Zugestellt" setzt `zugestelltAm` und leert
// `code` und `text`; der Vorgang steht im Audit (ohne Text und Code).
//
// Abholen und Bestätigen ausschließlich durch den Systemakteur der
// kanzleikonsole (`SystemKontext`, Stufe 4): Der Zustell-Worker ist keine
// Person, und keine Person – auch kein Admin – liest den Postausgang über den
// Dienst. Tenantweit über RLS. Codes erscheinen in keiner anderen Antwort und
// in keinem Audit-Detail.
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
  NachrichtZugestelltEingabeSchema,
  OffeneNachrichtSchema,
  type NachrichtEmpfaengerArt,
  type NachrichtenOffenEingabe,
  type NachrichtZugestelltEingabe,
  type NachrichtZugestelltErgebnis,
  type NachrichtZweck,
  type OffeneNachricht,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import type { z } from 'zod';
import { mitAudit } from '../../audit';
import type { SystemKontext } from '../../kontext';
import { pruefeEingabe } from './gemeinsam';

// Typprüfung: Die Datenbank-Enums sind genau die Listen des Vertrags.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _zweckePassen: Gleich<Prisma.NachrichtCreateInput['zweck'], NachrichtZweck> = true;
const _artenPassen: Gleich<Prisma.NachrichtCreateInput['empfaengerArt'], NachrichtEmpfaengerArt> =
  true;
void _zweckePassen;
void _artenPassen;

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

/** Gespeicherte Zeile → offene Nachricht des Vertrags; Abweichung = Fehler (fail closed). */
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
}): OffeneNachricht {
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
  if (!n.success) throw new Error('[service] Gespeicherte Nachricht verletzt den Vertrag');
  return n.data;
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
 * Offene Nachrichten des Tenants (älteste zuerst) zur Zustellung durch die
 * kanzleikonsole. Der Abruf wird protokolliert (IDs, kein Text): Nachrichten
 * können Bestätigungscodes enthalten.
 */
export async function ladeOffeneNachrichten(
  ctx: SystemKontext,
  eingabe: NachrichtenOffenEingabe,
): Promise<{ nachrichten: OffeneNachricht[] }> {
  brauchtSystem(ctx);
  const e = pruefeEingabe(NachrichtenOffenEingabeSchema, eingabe);
  const limit = e.limit ?? STANDARD_NACHRICHTEN_LIMIT;
  const zeilen = await ctx.tx.nachricht.findMany({
    where: { zugestelltAm: null, verworfenAm: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const nachrichten = zeilen.map(alsOffeneNachricht);
  if (nachrichten.length === 0) return { nachrichten };
  return mitAudit(ctx, async () => ({
    wert: { nachrichten },
    protokoll: {
      aktion: 'tcms.nachricht.abgerufen',
      objektTyp: 'Nachricht',
      objektId: nachrichten[0]!.id,
      programmId: null,
      detail: { anzahl: nachrichten.length, ids: nachrichten.map((n) => n.id) },
    },
  }));
}

/**
 * Zustellung bestätigen: `zugestelltAm` wird gesetzt und der Text geleert.
 * Idempotent für Nachrichten des eigenen Tenants (eine bereits bestätigte
 * liefert dasselbe Ergebnis ohne zweites Audit). Unbekannte IDs und
 * Nachrichten anderer Tenants (RLS: unsichtbar) → `NICHT_GEFUNDEN`; das
 * verrät nichts über andere Tenants, und der Systemakteur sieht die Nachrichten
 * seines Tenants ohnehin.
 */
export async function bestaetigeNachrichtZustellung(
  ctx: SystemKontext,
  eingabe: NachrichtZugestelltEingabe,
): Promise<NachrichtZugestelltErgebnis> {
  brauchtSystem(ctx);
  const e = pruefeEingabe(NachrichtZugestelltEingabeSchema, eingabe);
  const ergebnis: NachrichtZugestelltErgebnis = { nachrichtId: e.nachrichtId, zugestellt: true };
  const vorhanden = await ctx.tx.nachricht.findFirst({
    where: { id: e.nachrichtId },
    select: { id: true, zugestelltAm: true, zweck: true, empfaengerId: true },
  });
  if (!vorhanden) throw new DienstFehler('NICHT_GEFUNDEN');
  if (vorhanden.zugestelltAm) return ergebnis;
  const zeile = vorhanden;
  // Bedingt: Bei gleichzeitiger Bestätigung setzt genau eine Anfrage die Zustellung,
  // die andere findet unter der Zeilensperre keine offene Zeile mehr.
  const r = await ctx.tx.nachricht.updateMany({
    where: { id: zeile.id, zugestelltAm: null },
    data: { zugestelltAm: ctx.uhr.jetzt(), text: '', code: null },
  });
  if (r.count !== 1) return ergebnis;
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
