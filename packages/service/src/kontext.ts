// =============================================================================
// Dienstkontext (ADR 0001 §2): Jede Fachoperation und jeder Lader ist eine
// Funktion `(ctx, eingabe)`. `ctx` bündelt die Transaktion des Tenants, den
// geprüften Akteur, die Uhr und die Ports zur Umgebung. Dienst (apps/api) und
// Demo-Oberfläche (apps/web) unterscheiden sich nur in den Ports.
// =============================================================================

import { DienstFehler, type Akteur } from '@tcms/contract';
import { mitTenant, pruefeTenantId, type TenantOptionen, type Tx } from '@tcms/db';

/**
 * „Heute" und „jetzt" für fachliche Werte (Fälligkeiten, Stichtage,
 * Zeitstempel in Fachobjekten). Audit-Zeitstempel sind davon unabhängig immer
 * die echte Zeit (`schreibeAudit`).
 */
export interface Uhr {
  jetzt(): Date;
  /** Kalendertag als `YYYY-MM-DD`. */
  heute(): string;
}

/** Zeitzone für „heute": Fristen und Stichtage gelten nach deutschem Kalendertag. */
export const ZEITZONE = 'Europe/Berlin';

const tagFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZEITZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Kalendertag (Europe/Berlin) eines Zeitpunkts als `YYYY-MM-DD`. */
export function kalendertag(zeitpunkt: Date): string {
  return tagFormat.format(zeitpunkt);
}

/** Echte Uhr des Dienstes. `TCMS_DEMO_TODAY` wirkt hier nie (ADR 0001 §7). */
export const echteUhr: Uhr = {
  jetzt: () => new Date(),
  heute: () => kalendertag(new Date()),
};

/**
 * Anzeigenamen zu Personen-IDs der kanzleikonsole. Der Dienst löst keine Namen
 * auf (die kanzleikonsole rendert sie); die Demo nutzt eine statische Liste.
 */
export interface PersonenVerzeichnis {
  namen(ids: readonly string[]): Promise<Map<string, string>>;
}

/** Verzeichnis des Dienstes: kennt keine Namen. */
export const keinPersonenVerzeichnis: PersonenVerzeichnis = {
  namen: async () => new Map(),
};

/** Verweis auf einen Nachweis, wie ihn das Tax-CMS speichert (ADR 0001 §6). */
export interface NachweisVerweis {
  dokumentId: string;
  dateiname: string;
  mime: string;
  groesse: number;
  /** SHA-256 des Inhalts, hex, Kleinbuchstaben. */
  sha256: string;
}

export type NachweisEingang =
  | { art: 'VERWEIS'; verweis: NachweisVerweis }
  | { art: 'DATEI'; dateiname: string; mime: string; inhalt: Uint8Array };

/** Nimmt Nachweise an und liefert den zu speichernden Verweis. */
export interface NachweisAblage {
  annehmen(eingang: NachweisEingang): Promise<NachweisVerweis>;
}

export interface DienstKontext {
  tx: Tx;
  akteur: Akteur;
  uhr: Uhr;
  personen: PersonenVerzeichnis;
  ablage: NachweisAblage;
}

export type DienstPorts = Pick<DienstKontext, 'uhr' | 'personen' | 'ablage'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(wert: unknown): string {
  if (typeof wert !== 'string' || !UUID.test(wert)) throw new DienstFehler('NICHT_AUTHENTIFIZIERT');
  return wert.toLowerCase();
}

/**
 * Kanonische, unveränderliche Kopie eines Akteurs: alle IDs als UUID in
 * Kleinbuchstaben. Ohne diese Normalisierung könnte dieselbe Person in zwei
 * Schreibweisen als „zweite Person" gelten (Vier-Augen, AGENTS.md Regel 4).
 * Ungültige IDs: `NICHT_AUTHENTIFIZIERT` ohne Detail.
 */
export function normalisiereAkteur(a: Akteur): Akteur {
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name || name.length > 200) throw new DienstFehler('NICHT_AUTHENTIFIZIERT');
  if (a.art === 'KANZLEI') {
    return Object.freeze({
      art: 'KANZLEI',
      tenantId: pruefeTenantIdOderFehler(a.tenantId),
      id: uuid(a.id),
      name,
      istAdmin: a.istAdmin === true,
      istBerufstraeger: a.istBerufstraeger === true,
      mandant: a.mandant
        ? Object.freeze({
            id: uuid(a.mandant.id),
            zustaendigBerufstraeger: a.mandant.zustaendigBerufstraeger === true,
            hauptbearbeitung: a.mandant.hauptbearbeitung === true,
          })
        : null,
    });
  }
  if (a.art === 'MANDANT') {
    return Object.freeze({
      art: 'MANDANT',
      tenantId: pruefeTenantIdOderFehler(a.tenantId),
      id: uuid(a.id),
      name,
      mandantId: uuid(a.mandantId),
    });
  }
  throw new DienstFehler('NICHT_AUTHENTIFIZIERT');
}

function pruefeTenantIdOderFehler(id: unknown): string {
  try {
    return pruefeTenantId(id);
  } catch {
    throw new DienstFehler('NICHT_AUTHENTIFIZIERT');
  }
}

/**
 * Führt `fn` in genau einer Transaktion im Tenant des Akteurs aus (ADR 0001
 * §4). Der Tenant kommt ausschließlich aus dem Akteur, nie aus der Eingabe.
 */
export async function imDienst<T>(
  akteur: Akteur,
  ports: DienstPorts,
  fn: (ctx: DienstKontext) => Promise<T>,
  opts?: TenantOptionen,
): Promise<T> {
  const a = normalisiereAkteur(akteur);
  return mitTenant(a.tenantId, (tx) => fn({ tx, akteur: a, ...ports }), opts);
}
