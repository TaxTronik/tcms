// =============================================================================
// Postausgang (Nachricht): Der Dienst versendet keine E-Mails. Er legt
// Nachrichten ab, die kanzleikonsole holt sie ab und stellt sie zu (Stufe 4).
// Empfänger werden ausschließlich über IDs adressiert (TS-06), nie über Namen
// oder Adressen.
//
// Ablage (Übergang, Schema-Vorschlag im Bericht): `Nachricht` hat noch keine
// Spalten für Empfänger-ID, Zweck und Zustellung. Bis dahin steht die Adresse
// streng formatiert in `an` (`tcms:<ZWECK>:<empfänger-uuid>`); Zeilen in einem
// anderen Format (Altbestand der Demo, Adressen mit Namen) liefert der Dienst
// nie aus. „Zugestellt" löscht die Nachricht: Sie kann einen Bestätigungscode
// im Klartext enthalten, der nach der Zustellung nicht im Tax-CMS liegen bleiben
// soll; der Vorgang steht im Audit (ohne Text).
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
import type { Tx } from '@tcms/db';
import { mitAudit } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { kannVerwalten } from '../../rechte';
import { pruefeEingabe } from './gemeinsam';

const PRAEFIX = 'tcms:';
const ADRESSE = new RegExp(
  `^tcms:(${NACHRICHT_ZWECKE.join('|')}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STANDARD_NACHRICHTEN_LIMIT = 50;

/** Adresse einer Nachricht im Postausgang (Empfänger-ID kanonisch). */
export function nachrichtAdresse(zweck: NachrichtZweck, empfaengerId: string): string {
  if (!UUID.test(empfaengerId)) throw new Error('[service] Empfänger ohne gültige ID');
  if (!(NACHRICHT_ZWECKE as readonly string[]).includes(zweck)) {
    throw new Error('[service] Unbekannter Nachrichtenzweck');
  }
  return `${PRAEFIX}${zweck}:${empfaengerId.toLowerCase()}`;
}

/** Liest eine Adresse; `null` für alles, was nicht dem Format entspricht. */
export function leseNachrichtAdresse(
  an: string,
): { zweck: NachrichtZweck; empfaengerId: string } | null {
  const m = ADRESSE.exec(an);
  if (!m) return null;
  return { zweck: m[1] as NachrichtZweck, empfaengerId: m[2]! };
}

/** Legt eine Nachricht im Postausgang ab (in der Transaktion der fachlichen Änderung). */
export async function legeNachrichtAn(
  tx: Tx,
  n: { empfaengerId: string; zweck: NachrichtZweck; betreff: string; text: string },
): Promise<string> {
  const z = await tx.nachricht.create({
    data: { an: nachrichtAdresse(n.zweck, n.empfaengerId), betreff: n.betreff, text: n.text },
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
    where: { an: { startsWith: PRAEFIX } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const nachrichten: OffeneNachricht[] = [];
  for (const z of zeilen) {
    const a = leseNachrichtAdresse(z.an);
    if (!a) continue;
    nachrichten.push({
      id: z.id,
      empfaengerId: a.empfaengerId,
      zweck: a.zweck,
      betreff: z.betreff,
      text: z.text,
      erstelltAm: z.createdAt.toISOString(),
    });
  }
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
 * Zustellung bestätigen (idempotent): Die Nachricht wird gelöscht; eine
 * bereits bestätigte oder unbekannte ID ändert nichts und liefert dasselbe
 * Ergebnis (kein Existenz-Orakel, keine Wiederholungsfehler).
 */
export async function bestaetigeNachrichtZustellung(
  ctx: DienstKontext,
  eingabe: NachrichtZugestelltEingabe,
): Promise<NachrichtZugestelltErgebnis> {
  const e = pruefeEingabe(NachrichtZugestelltEingabeSchema, eingabe);
  brauchtVerwaltung(ctx);
  const ergebnis: NachrichtZugestelltErgebnis = { nachrichtId: e.nachrichtId, zugestellt: true };
  const zeile = await ctx.tx.nachricht.findFirst({
    where: { id: e.nachrichtId, an: { startsWith: PRAEFIX } },
    select: { id: true, an: true },
  });
  const adresse = zeile ? leseNachrichtAdresse(zeile.an) : null;
  if (!zeile || !adresse) return ergebnis;
  // Bedingt gelöscht: Bei gleichzeitiger Bestätigung löscht genau eine Anfrage, die
  // andere sieht danach keine Zeile mehr und antwortet ebenfalls „zugestellt".
  const r = await ctx.tx.nachricht.deleteMany({ where: { id: zeile.id, an: zeile.an } });
  if (r.count !== 1) return ergebnis;
  return mitAudit(ctx, async () => ({
    wert: ergebnis,
    protokoll: {
      aktion: 'tcms.nachricht.zugestellt',
      objektTyp: 'Nachricht',
      objektId: zeile.id,
      programmId: null,
      detail: { zweck: adresse.zweck, empfaengerId: adresse.empfaengerId },
    },
  }));
}
