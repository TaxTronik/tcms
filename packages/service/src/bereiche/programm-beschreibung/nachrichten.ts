// =============================================================================
// Postausgang (Nachricht): Der Dienst versendet keine E-Mails. Er legt
// Nachrichten ab, die kanzleikonsole holt sie ab und stellt sie zu (Stufe 4).
// Empfänger werden ausschließlich über die Personen-ID adressiert (TS-06), nie
// über Namen oder Adressen; der Zweck steht als Enum in der Zeile.
//
// „Zugestellt" setzt `zugestelltAm` und leert den Text: Er kann einen
// Bestätigungscode im Klartext enthalten, der nach der Zustellung nicht im
// Tax-CMS liegen bleiben soll; der Vorgang steht im Audit (ohne Text).
//
// Lesen und Bestätigen nur für Kanzleipersonen mit Verwaltungsrecht
// (`kannVerwalten`), tenantweit über RLS. Codes erscheinen in keiner anderen
// Antwort und in keinem Audit-Detail.
// =============================================================================

import {
  DienstFehler,
  NACHRICHT_ZWECKE,
  NachrichtenOffenEingabeSchema,
  NachrichtZugestelltEingabeSchema,
  type NachrichtenOffenEingabe,
  type NachrichtZugestelltEingabe,
  type NachrichtZugestelltErgebnis,
  type NachrichtZweck,
  type OffeneNachricht,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import { mitAudit } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { kannVerwalten } from '../../rechte';
import { pruefeEingabe } from './gemeinsam';

// Typprüfung: Der Datenbank-Enum ist genau die Liste des Vertrags.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _zweckePassen: Gleich<Prisma.NachrichtCreateInput['zweck'], NachrichtZweck> = true;
void _zweckePassen;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STANDARD_NACHRICHTEN_LIMIT = 50;

/**
 * Legt eine Nachricht im Postausgang ab (in der Transaktion der fachlichen
 * Änderung). Empfänger nur als Personen-ID; unbekannter Zweck oder keine UUID
 * ist ein Programmierfehler (fail closed).
 */
export async function legeNachrichtAn(
  tx: Tx,
  n: {
    empfaengerId: string;
    zweck: NachrichtZweck;
    betreff: string;
    text: string;
    /** Fachliche Zeit der Anlage (Uhr der Operation); sonst Datenbankzeit. */
    erstelltAm?: Date;
  },
): Promise<string> {
  if (!UUID.test(n.empfaengerId)) throw new Error('[service] Empfänger ohne gültige ID');
  if (!(NACHRICHT_ZWECKE as readonly string[]).includes(n.zweck)) {
    throw new Error('[service] Unbekannter Nachrichtenzweck');
  }
  const z = await tx.nachricht.create({
    data: {
      empfaengerId: n.empfaengerId.toLowerCase(),
      zweck: n.zweck,
      betreff: n.betreff,
      text: n.text,
      ...(n.erstelltAm ? { createdAt: n.erstelltAm } : {}),
    },
    select: { id: true },
  });
  return z.id;
}

function brauchtVerwaltung(ctx: DienstKontext): void {
  // Ohne Verwaltungsrecht: wie ein unbekannter Pfad (kein Hinweis auf Inhalte).
  if (!kannVerwalten(ctx.akteur)) throw new DienstFehler('NICHT_GEFUNDEN');
}

/**
 * Offene Nachrichten des Tenants (älteste zuerst) zur Zustellung durch die
 * kanzleikonsole. Der Abruf wird protokolliert (IDs, kein Text): Nachrichten
 * können Bestätigungscodes enthalten.
 */
export async function ladeOffeneNachrichten(
  ctx: DienstKontext,
  eingabe: NachrichtenOffenEingabe,
): Promise<{ nachrichten: OffeneNachricht[] }> {
  const e = pruefeEingabe(NachrichtenOffenEingabeSchema, eingabe);
  brauchtVerwaltung(ctx);
  const limit = e.limit ?? STANDARD_NACHRICHTEN_LIMIT;
  const zeilen = await ctx.tx.nachricht.findMany({
    where: { zugestelltAm: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const nachrichten: OffeneNachricht[] = zeilen.map((z) => ({
    id: z.id,
    empfaengerId: z.empfaengerId,
    zweck: z.zweck,
    betreff: z.betreff,
    text: z.text,
    erstelltAm: z.createdAt.toISOString(),
  }));
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
 * Zustellung bestätigen (idempotent): `zugestelltAm` wird gesetzt und der Text
 * geleert; eine bereits bestätigte oder unbekannte ID ändert nichts und
 * liefert dasselbe Ergebnis (kein Existenz-Orakel, keine Wiederholungsfehler).
 */
export async function bestaetigeNachrichtZustellung(
  ctx: DienstKontext,
  eingabe: NachrichtZugestelltEingabe,
): Promise<NachrichtZugestelltErgebnis> {
  const e = pruefeEingabe(NachrichtZugestelltEingabeSchema, eingabe);
  brauchtVerwaltung(ctx);
  const ergebnis: NachrichtZugestelltErgebnis = { nachrichtId: e.nachrichtId, zugestellt: true };
  const zeile = await ctx.tx.nachricht.findFirst({
    where: { id: e.nachrichtId, zugestelltAm: null },
    select: { id: true, zweck: true, empfaengerId: true },
  });
  if (!zeile) return ergebnis;
  // Bedingt: Bei gleichzeitiger Bestätigung setzt genau eine Anfrage die Zustellung,
  // die andere findet unter der Zeilensperre keine offene Zeile mehr.
  const r = await ctx.tx.nachricht.updateMany({
    where: { id: zeile.id, zugestelltAm: null },
    data: { zugestelltAm: ctx.uhr.jetzt(), text: '' },
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
