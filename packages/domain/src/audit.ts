// =============================================================================
// Manipulationsevidentes Protokoll: SHA-256-Hashkette über alle Ereignisse.
// Jeder Eintrag bindet seinen Vorgänger. Stufe 1 ohne externe Zeitanker
// (RFC 3161); ein Hash bindet Inhalte, er authentifiziert keine Person.
// Nur serverseitig importieren (node:crypto).
// =============================================================================

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/** Stabile JSON-Serialisierung (Schlüssel sortiert, Daten als ISO-Strings). */
export function kanonisch(wert: unknown): string {
  if (wert === null || wert === undefined) return 'null';
  if (wert instanceof Date) return JSON.stringify(wert.toISOString());
  if (typeof wert === 'bigint') return JSON.stringify(wert.toString());
  if (Array.isArray(wert)) return `[${wert.map(kanonisch).join(',')}]`;
  if (typeof wert === 'object') {
    const eintraege = Object.entries(wert as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${eintraege.map(([k, v]) => `${JSON.stringify(k)}:${kanonisch(v)}`).join(',')}}`;
  }
  return JSON.stringify(wert);
}

export interface AuditInhalt {
  at: Date;
  actorId: string | null;
  aktion: string;
  objektTyp: string;
  objektId: string;
  detail: unknown;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function auditHash(prevHash: string, inhalt: AuditInhalt): string {
  return sha256(`${prevHash}|${kanonisch(inhalt)}`);
}

export interface AuditEintrag extends AuditInhalt {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface KettenPruefung {
  gueltig: boolean;
  geprueft: number;
  /** Erste Position, an der die Kette bricht. */
  bruchBei: number | null;
  grund: string | null;
}

export function pruefeKette(eintraege: readonly AuditEintrag[]): KettenPruefung {
  let prev = GENESIS_HASH;
  for (const e of eintraege) {
    if (e.prevHash !== prev) {
      return {
        gueltig: false,
        geprueft: e.seq,
        bruchBei: e.seq,
        grund: 'Vorgänger-Hash passt nicht',
      };
    }
    const erwartet = auditHash(prev, {
      at: e.at,
      actorId: e.actorId,
      aktion: e.aktion,
      objektTyp: e.objektTyp,
      objektId: e.objektId,
      detail: e.detail,
    });
    if (erwartet !== e.hash) {
      return { gueltig: false, geprueft: e.seq, bruchBei: e.seq, grund: 'Inhalt wurde verändert' };
    }
    prev = e.hash;
  }
  return { gueltig: true, geprueft: eintraege.length, bruchBei: null, grund: null };
}
