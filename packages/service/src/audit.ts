// =============================================================================
// Fachliche Änderung mit Protokoll (AGENTS.md Regel 1): `fn` ändert in der
// Transaktion des Dienstkontexts und liefert die Audit-Einträge; beide werden
// zusammen festgeschrieben oder zusammen verworfen. Handelnde Person ist immer
// der Akteur des Kontexts (ID und Anzeigename aus der Akteursbestätigung).
//
// Systemakteure (Stufe 4) sind im Audit erkennbar: `actorName` beginnt mit
// `System: ` und `detail.systemakteur` ist `true`. Den Namen wählt die
// kanzleikonsole (auch für Personen); die Kennzeichnung im Detail setzt nur
// dieser Code und keine Operation (reservierter Schlüssel), beide liegen im
// Hash der Kette (Kettenversion 2).
// =============================================================================

import type { Akteur } from '@tcms/contract';
import { schreibeAuditFolge, type Tx } from '@tcms/db';
import type { Uhr } from './kontext';

/** Was `mitAudit` vom Kontext braucht: `DienstKontext` oder `SystemKontext`. */
export interface AuditKontext {
  tx: Tx;
  akteur: Akteur;
  uhr: Uhr;
}

/** Anfang von `actorName` bei Systemakteuren. */
export const AUDIT_SYSTEM_PRAEFIX = 'System: ';
/** Höchstlänge von `actorName` (Vertrag `AuditListeAntwortSchema`). */
const MAX_ACTOR_NAME = 200;
/** Reservierter Detail-Schlüssel der Kennzeichnung. */
const SYSTEM_SCHLUESSEL = 'systemakteur';

export interface Protokoll {
  aktion: string;
  objektTyp: string;
  objektId: string;
  programmId: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Führt `fn` im Kontext aus und protokolliert die zurückgegebenen Einträge.
 * `zeitpunkt` ist die fachliche Zeit der Uhr (Demo: Demo-Tag); der Zeitstempel
 * des Audit-Eintrags ist unabhängig davon die echte Zeit.
 * Eine Änderung ohne Protokoll wird abgewiesen (die Transaktion rollt zurück).
 */
export async function mitAudit<T>(
  ctx: AuditKontext,
  fn: (tx: Tx, zeitpunkt: Date) => Promise<{ wert: T; protokoll: Protokoll | Protokoll[] }>,
): Promise<T> {
  const zeitpunkt = ctx.uhr.jetzt();
  const { wert, protokoll } = await fn(ctx.tx, zeitpunkt);
  const eintraege = Array.isArray(protokoll) ? protokoll : [protokoll];
  if (eintraege.length === 0) {
    throw new Error('[service] Fachliche Änderung ohne Audit-Eintrag (AGENTS.md Regel 1).');
  }
  const system = ctx.akteur.art === 'SYSTEM';
  const actorName = system
    ? `${AUDIT_SYSTEM_PRAEFIX}${ctx.akteur.name}`.slice(0, MAX_ACTOR_NAME)
    : ctx.akteur.name;
  const eingaben = eintraege.map((p) => {
    const detail = p.detail ?? {};
    if (Object.hasOwn(detail, SYSTEM_SCHLUESSEL)) {
      throw new Error(`[service] Detail-Schlüssel ${SYSTEM_SCHLUESSEL} ist reserviert.`);
    }
    return {
      actorId: ctx.akteur.id,
      actorName,
      aktion: p.aktion,
      objektTyp: p.objektTyp,
      objektId: p.objektId,
      programmId: p.programmId,
      detail: system ? { ...detail, [SYSTEM_SCHLUESSEL]: true } : detail,
    };
  });
  // Eine Sperre, ein INSERT: dieselbe Kette wie Eintrag für Eintrag.
  await schreibeAuditFolge(ctx.tx, eingaben);
  return wert;
}
