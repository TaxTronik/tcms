// =============================================================================
// Zustellstatus der Nachrichten zu Freigaben (Stufe 4) für die Lesepfade der
// Kanzlei: Freigabenhistorie (Kommunikation), CMS-Beschreibung und
// Risikoakzeptanzen zeigen je Freigabe, ob die jüngste Nachricht an den
// aktuellen Empfänger noch offen, zugestellt, unzustellbar (mit Grund) oder
// verworfen ist – damit die Kanzlei bei „unzustellbar" neu adressieren kann.
// Eine Regel für alle Bereiche (AGENTS.md: gemeinsamer Kern).
//
// Zuordnung (fail closed, keine Inhalte):
//   - nur Nachrichten des Mandanten der Anfrage (Spalte `mandantId`; RLS trennt
//     nur Tenants), mit einem Freigabe-Zweck und der Freigabe-ID in den
//     Vorlagendaten, die zu einer Freigabe dieses Programms gehört;
//   - nur an den aktuellen Empfänger der Freigabe (nach einer Neuadressierung
//     zählen Nachrichten an die frühere Person nicht mehr);
//   - jüngste zuerst (`createdAt`, dann `id`).
// Gelesen werden nur Status-Spalten und die Vorlagendaten (ohne Code, der nur
// in `code` steht); ausgegeben werden nur Zweck, Status, Zeitpunkte und Grund.
// =============================================================================

import {
  FREIGABE_NACHRICHT_ZWECKE,
  NachrichtDatenFreigabeAngefordertSchema,
  type FreigabeZustellung,
  type NachrichtUnzustellbarGrund,
  type NachrichtZweck,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';

// Typprüfung: Die Freigabe-Zwecke sind Zwecke des Postausgangs.
type Teilmenge<A, B> = [A] extends [B] ? true : false;
const _zweckePassen: Teilmenge<(typeof FREIGABE_NACHRICHT_ZWECKE)[number], NachrichtZweck> = true;
void _zweckePassen;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status-Spalten einer Nachricht (ohne Text und Code). */
export interface ZustellZeile {
  zweck: (typeof FREIGABE_NACHRICHT_ZWECKE)[number];
  createdAt: Date;
  zugestelltAm: Date | null;
  unzustellbarAm: Date | null;
  unzustellbarGrund: NachrichtUnzustellbarGrund | null;
  verworfenAm: Date | null;
}

/**
 * Zustellstatus einer Nachricht. Eine Meldung der kanzleikonsole (zugestellt
 * bzw. unzustellbar) geht dem Verwerfen vor: Sie hatte die Nachricht vor dem
 * Verwerfen abgeholt – das erzwingen Dienst und CHECK über `abgerufenAm`
 * (H2); eine nie ausgelieferte, verworfene Nachricht bleibt VERWORFEN.
 * Unzustellbar ohne Grund verletzt den CHECK der Datenbank und ist ein Fehler
 * (fail closed).
 */
export function zustellungVon(z: ZustellZeile): FreigabeZustellung {
  const kopf = { zweck: z.zweck, erstelltAm: z.createdAt.toISOString() };
  if (z.zugestelltAm) return { ...kopf, status: 'ZUGESTELLT', am: z.zugestelltAm.toISOString() };
  if (z.unzustellbarAm) {
    if (!z.unzustellbarGrund) throw new Error('[service] Unzustellbare Nachricht ohne Grund');
    return {
      ...kopf,
      status: 'UNZUSTELLBAR',
      am: z.unzustellbarAm.toISOString(),
      grund: z.unzustellbarGrund,
    };
  }
  if (z.verworfenAm) return { ...kopf, status: 'VERWORFEN', am: z.verworfenAm.toISOString() };
  return { ...kopf, status: 'OFFEN' };
}

function istFreigabeZweck(z: string): z is ZustellZeile['zweck'] {
  return (FREIGABE_NACHRICHT_ZWECKE as readonly string[]).includes(z);
}

function freigabeIdAus(daten: Prisma.JsonValue): string | null {
  if (!daten || typeof daten !== 'object' || Array.isArray(daten)) return null;
  const r = NachrichtDatenFreigabeAngefordertSchema.shape.freigabeId.safeParse(daten['freigabeId']);
  return r.success ? r.data : null;
}

/**
 * Zustellstatus je Freigabe (Schlüssel: Freigabe-ID) der jüngsten Nachricht
 * an ihren aktuellen Empfänger. Freigaben ohne solche Nachricht fehlen in der
 * Ergebniskarte. `freigaben` müssen zum Programm des Mandanten `mandantId`
 * gehören (die Aufrufer lesen sie über das Programm des Mandanten).
 *
 * Im historischen Stand leer: Der Zustellstatus ist ein betrieblicher Zustand
 * wie der Code-Status und wird nicht zum Stichtag rekonstruiert (der Empfänger
 * einer Freigabe kann sich seitdem geändert haben).
 */
export async function zustellungenDerFreigaben(
  tx: Tx,
  mandantId: string,
  freigaben: readonly { id: string; empfaengerId: string }[],
  stand: { historisch: boolean },
): Promise<ReadonlyMap<string, FreigabeZustellung>> {
  const out = new Map<string, FreigabeZustellung>();
  if (stand.historisch) return out;
  const empfaenger = new Map(freigaben.map((f) => [f.id, f.empfaengerId.toLowerCase()]));
  // Nachrichten adressieren nur UUIDs (legeNachrichtAn); andere Empfänger haben keine.
  const ids = [...new Set(empfaenger.values())].filter((id) => UUID.test(id));
  if (ids.length === 0 || !UUID.test(mandantId)) return out;
  const zeilen = await tx.nachricht.findMany({
    where: {
      mandantId: mandantId.toLowerCase(),
      zweck: { in: [...FREIGABE_NACHRICHT_ZWECKE] },
      empfaengerId: { in: ids },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      daten: true,
      empfaengerId: true,
      zweck: true,
      createdAt: true,
      zugestelltAm: true,
      unzustellbarAm: true,
      unzustellbarGrund: true,
      verworfenAm: true,
    },
  });
  for (const z of zeilen) {
    if (!istFreigabeZweck(z.zweck)) continue;
    const freigabeId = freigabeIdAus(z.daten);
    if (!freigabeId || out.has(freigabeId)) continue;
    if (empfaenger.get(freigabeId) !== z.empfaengerId.toLowerCase()) continue;
    out.set(freigabeId, zustellungVon({ ...z, zweck: z.zweck }));
  }
  return out;
}
