// =============================================================================
// Fachliche Änderung mit Protokoll (AGENTS.md Regel 1): `fn` ändert in der
// Transaktion des Dienstkontexts und liefert die Audit-Einträge; beide werden
// zusammen festgeschrieben oder zusammen verworfen. Handelnde Person ist immer
// der Akteur des Kontexts (ID und Anzeigename aus der Akteursbestätigung).
// =============================================================================

import { schreibeAudit, type Tx } from '@tcms/db';
import type { DienstKontext } from './kontext';

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
  ctx: DienstKontext,
  fn: (tx: Tx, zeitpunkt: Date) => Promise<{ wert: T; protokoll: Protokoll | Protokoll[] }>,
): Promise<T> {
  const zeitpunkt = ctx.uhr.jetzt();
  const { wert, protokoll } = await fn(ctx.tx, zeitpunkt);
  const eintraege = Array.isArray(protokoll) ? protokoll : [protokoll];
  if (eintraege.length === 0) {
    throw new Error('[service] Fachliche Änderung ohne Audit-Eintrag (AGENTS.md Regel 1).');
  }
  for (const p of eintraege) {
    await schreibeAudit(ctx.tx, {
      actorId: ctx.akteur.id,
      actorName: ctx.akteur.name,
      aktion: p.aktion,
      objektTyp: p.objektTyp,
      objektId: p.objektId,
      programmId: p.programmId,
      detail: p.detail ?? {},
    });
  }
  return wert;
}
