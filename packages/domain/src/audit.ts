// =============================================================================
// Manipulationsevidentes Protokoll: SHA-256-Hashkette je Tenant (Kanzlei).
// Jeder Eintrag bindet seinen Vorgänger. Stufe 1 ohne externe Zeitanker
// (RFC 3161); ein Hash bindet Inhalte, er authentifiziert keine Person.
//
// Kettenversion 2 (ADR 0001 §4, TS-10): Der Hash umfasst zusätzlich
// `tenantId`, `actorName` und `programmId` sowie die Kettenversion selbst.
// Eine Kette gehört genau einem Tenant; ein fremder Eintrag bricht sie.
// Nur serverseitig importieren (node:crypto).
// =============================================================================

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/** Aktuelle und einzige gültige Kettenversion (kein Bestandsschutz, ADR §4). */
export const KETTEN_VERSION = 2;

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
  /** Tenant (Kanzlei) in kanonischer Form (UUID, Kleinbuchstaben). */
  tenantId: string;
  at: Date;
  actorId: string | null;
  actorName: string;
  aktion: string;
  objektTyp: string;
  objektId: string;
  programmId: string | null;
  detail: unknown;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash eines Eintrags der Kettenversion 2. */
export function auditHash(prevHash: string, inhalt: AuditInhalt): string {
  const gebunden = {
    v: KETTEN_VERSION,
    tenantId: inhalt.tenantId,
    at: inhalt.at,
    actorId: inhalt.actorId,
    actorName: inhalt.actorName,
    aktion: inhalt.aktion,
    objektTyp: inhalt.objektTyp,
    objektId: inhalt.objektId,
    programmId: inhalt.programmId,
    detail: inhalt.detail,
  };
  return sha256(`${prevHash}|${kanonisch(gebunden)}`);
}

export interface AuditEintrag extends AuditInhalt {
  /**
   * Laufende Position im Tenant (1, 2, 3, …, RT-03). Der globale technische
   * Schlüssel `seq` gehört nicht zur Kette und verlässt den Dienst nie.
   */
  pos: number;
  kettenVersion: number;
  prevHash: string;
  hash: string;
}

/** Stand einer Kette: Hash und Position des zuletzt gültig geprüften Eintrags. */
export interface KettenStand {
  prevHash: string;
  pos: number;
}

/** Anfang jeder Kette (vor dem ersten Eintrag; die Position beginnt bei 1). */
export const KETTEN_ANFANG: KettenStand = Object.freeze({ prevHash: GENESIS_HASH, pos: 0 });

export interface KettenPruefung {
  gueltig: boolean;
  /** Anzahl der in diesem Aufruf gültig geprüften Einträge (bei Bruch: vor dem Bruch). */
  geprueft: number;
  /** Erste Position (`pos`), an der die Kette bricht. */
  bruchBei: number | null;
  grund: string | null;
  /** Stand nach dem letzten gültigen Eintrag: Fortsetzungspunkt für den nächsten Abschnitt. */
  stand: KettenStand;
}

/**
 * Prüft die Kette eines Tenants – vollständig oder fortsetzbar in Abschnitten.
 * `eintraege` sind Einträge dieses Tenants in Schreibreihenfolge (`pos`
 * aufsteigend), die unmittelbar auf `start` folgen (Standard: Kettenanfang).
 * Einzige Implementierung der Kettenregeln: lückenlose Position (RT-03),
 * Kettenversion, Tenant, Vorgänger-Hash, Inhalt.
 */
export function pruefeKette(
  tenantId: string,
  eintraege: readonly AuditEintrag[],
  start: KettenStand = KETTEN_ANFANG,
): KettenPruefung {
  let prev = start.prevHash;
  let letztePos = start.pos;
  let geprueft = 0;
  const stand = () => ({ prevHash: prev, pos: letztePos });
  const bruch = (e: AuditEintrag, grund: string): KettenPruefung => ({
    gueltig: false,
    geprueft,
    bruchBei: e.pos,
    grund,
    stand: stand(),
  });
  for (const e of eintraege) {
    if (!Number.isInteger(e.pos) || e.pos <= letztePos)
      return bruch(e, 'Reihenfolge der Einträge passt nicht');
    // Lückenlos (RT-03): Jede Position folgt unmittelbar auf ihre Vorgängerin.
    if (e.pos !== letztePos + 1) return bruch(e, 'Lücke in den Positionen');
    if (e.kettenVersion !== KETTEN_VERSION) return bruch(e, 'Unbekannte Kettenversion');
    if (e.tenantId !== tenantId) return bruch(e, 'Eintrag gehört zu einem anderen Tenant');
    if (e.prevHash !== prev) return bruch(e, 'Vorgänger-Hash passt nicht');
    if (auditHash(prev, e) !== e.hash) return bruch(e, 'Inhalt wurde verändert');
    prev = e.hash;
    letztePos = e.pos;
    geprueft++;
  }
  return { gueltig: true, geprueft, bruchBei: null, grund: null, stand: stand() };
}
