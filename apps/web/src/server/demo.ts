import 'server-only';
import type { Akteur } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import {
  DEMO_MANDANTEN,
  DEMO_PERSONEN,
  DEMO_TENANT_ID,
  demoMandant,
  demoPerson,
  type DemoPerson,
} from '@tcms/db/demo';
import { leseDatei, speichereDatei } from '@tcms/db/demo-ablage';
import {
  normalisiereAkteur,
  type DienstPorts,
  type KontaktRolle,
  type MandantRolle,
  type NachweisAblage,
  type NachweisVerweis,
  type PersonenVerzeichnis,
} from '@tcms/service';
import { demoUhr } from './zeit';

// =============================================================================
// Demo-Oberfläche als Stellvertreterin der kanzleikonsole (ADR 0001 §2): Sie
// kennt Personen, Zuständigkeiten und den Tenant aus dem statischen
// Demo-Verzeichnis und bildet daraus den Akteur, den im Zielbild die
// signierte Akteursbestätigung liefert. Fachregeln liegen in @tcms/service.
// =============================================================================

export type KanzleiAkteur = Extract<Akteur, { art: 'KANZLEI' }>;
export type MandantAkteur = Extract<Akteur, { art: 'MANDANT' }>;

/**
 * Handelnde Person einer Demo-Aktion: Akteur plus (nur für Mandantenkontakte)
 * die aktiven Rollen aus MandantKontaktRolle, die Kanzlei und Portal in den
 * gemeinsamen Durchführungs-Handlungen brauchen.
 */
export type Handelnde = Akteur & { rollen: readonly KontaktRolle[] };

export function handelnde(a: Akteur, rollen: readonly KontaktRolle[] = []): Handelnde {
  return { ...a, rollen: a.art === 'MANDANT' ? rollen : [] };
}

export { DEMO_TENANT_ID, demoPerson, type DemoPerson };

/**
 * Akteur einer Demo-Person. Für Kanzleipersonen mit `mandantId` setzt die Demo
 * den Mandantenbezug (`cli`) wie die kanzleikonsole: Zuständigkeit (BT,
 * Hauptbearbeitung) aus dem Verzeichnis; alle Kanzleipersonen der Demo haben
 * Zugriff auf alle Demo-Mandanten (Verhalten des Prototyps). Unbekannte
 * Mandanten erhalten keinen Bezug (kein Recht).
 */
export function akteurFuer(p: DemoPerson, mandantId: string | null): Akteur {
  if (p.art === 'MANDANT') {
    if (!p.mandantId) throw new Error('[demo] Mandantenkontakt ohne Mandant');
    return normalisiereAkteur({
      art: 'MANDANT',
      tenantId: DEMO_TENANT_ID,
      id: p.id,
      name: p.name,
      mandantId: p.mandantId,
    });
  }
  const m = demoMandant(mandantId);
  return normalisiereAkteur({
    art: 'KANZLEI',
    tenantId: DEMO_TENANT_ID,
    id: p.id,
    name: p.name,
    istAdmin: p.istAdmin,
    istBerufstraeger: p.istBerufstraeger,
    mandant: m
      ? {
          id: m.id,
          zustaendigBerufstraeger: m.berufstraegerId === p.id,
          hauptbearbeitung: m.bearbeitungId === p.id,
        }
      : null,
  });
}

/** Derselbe Kanzlei-Akteur mit Bezug auf den angegebenen Mandanten. */
export function fuerMandant(a: KanzleiAkteur, mandantId: string): KanzleiAkteur {
  const p = demoPerson(a.id);
  if (!p || p.art !== 'KANZLEI') throw new Error('[demo] Unbekannte Kanzleiperson');
  return akteurFuer(p, mandantId) as KanzleiAkteur;
}

/**
 * Mandanten, auf die eine Kanzleiperson Zugriff hat (im Zielbild liefert die
 * kanzleikonsole diese Liste, ADR 0001 §3.3). In der Demo: alle Demo-Mandanten.
 */
export function zugaenglicheMandanten(a: Akteur): string[] {
  return a.art === 'KANZLEI' ? DEMO_MANDANTEN.map((m) => m.id) : [a.mandantId];
}

/** Zuständigkeit eines Demo-Mandanten (Anzeige; Rechte laufen über den Akteur). */
export function zustaendigkeit(mandantId: string): {
  berufstraegerId: string | null;
  bearbeitungId: string | null;
} {
  const m = demoMandant(mandantId);
  return { berufstraegerId: m?.berufstraegerId ?? null, bearbeitungId: m?.bearbeitungId ?? null };
}

export interface PersonImMandat {
  id: string;
  name: string;
  art: 'KANZLEI' | 'MANDANT';
  /** Aktive Rollen beim Mandanten (nur Mandantenkontakte, aus MandantKontaktRolle). */
  rollen: MandantRolle[];
}

/**
 * Person, die für diesen Mandanten eingesetzt werden darf: Kanzleiperson der
 * Demo oder Mandantenkontakt mit aktiver Rolle bei genau diesem Mandanten
 * (ADR 0001 §5). Sonst null. Ersetzt die frühere Abfrage der Tabelle Person.
 */
export async function personImMandat(
  id: string | null | undefined,
  mandantId: string,
): Promise<PersonImMandat | null> {
  const p = demoPerson(id);
  if (!p) return null;
  if (p.art === 'KANZLEI') return { id: p.id, name: p.name, art: 'KANZLEI', rollen: [] };
  const rollen = await lies((tx) =>
    tx.mandantKontaktRolle.findMany({
      where: { mandantId, kontaktId: p.id, aktiv: true },
      select: { rolle: true },
    }),
  );
  if (rollen.length === 0) return null;
  return { id: p.id, name: p.name, art: 'MANDANT', rollen: rollen.map((r) => r.rolle) };
}

/** Mandantenkontakte mit aktiver Rolle beim Mandanten, nach Name sortiert. */
export async function kontakteMitRolle(
  mandantId: string,
  rolle?: MandantRolle,
): Promise<{ id: string; name: string; rolle: MandantRolle }[]> {
  const zeilen = await lies((tx) =>
    tx.mandantKontaktRolle.findMany({
      where: { mandantId, aktiv: true, ...(rolle ? { rolle } : {}) },
      select: { kontaktId: true, rolle: true },
    }),
  );
  return zeilen
    .map((z) => ({ id: z.kontaktId, name: demoPerson(z.kontaktId)?.name ?? '', rolle: z.rolle }))
    .filter((z) => z.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** Statisches Personenverzeichnis der Demo (im Zielbild: kanzleikonsole). */
export const demoPersonen: PersonenVerzeichnis & {
  alle(): readonly DemoPerson[];
  person(id: string | null | undefined): DemoPerson | null;
} = {
  async namen(ids) {
    const out = new Map<string, string>();
    for (const id of ids) {
      const p = demoPerson(id);
      if (p) out.set(id, p.name);
    }
    return out;
  },
  alle: () => DEMO_PERSONEN,
  person: (id) => demoPerson(id),
};

/** Lokale Dateiablage der Demo (bisheriges storage.ts); der Dienst nimmt nur Verweise an. */
export const demoAblage: NachweisAblage & {
  lese(verweis: Pick<NachweisVerweis, 'dokumentId' | 'sha256'>): Promise<Buffer>;
} = {
  async annehmen(eingang) {
    if (eingang.art !== 'DATEI') throw new Error('[demo] Die Demo nimmt nur Dateien an.');
    const g = await speichereDatei(Buffer.from(eingang.inhalt));
    return {
      dokumentId: g.speicherpfad,
      dateiname: eingang.dateiname,
      mime: eingang.mime,
      groesse: g.groesse,
      sha256: g.sha256,
    };
  },
  lese: (v) => leseDatei(v.dokumentId, v.sha256),
};

export const DEMO_PORTS: DienstPorts = {
  uhr: demoUhr,
  personen: demoPersonen,
  ablage: demoAblage,
};

/**
 * Lesender Zugriff der Demo im Demo-Tenant (eine Transaktion je Aufruf). Die
 * Demo kennt nur diesen Tenant; Schreibzugriffe laufen über `mitAudit`
 * (aktion.ts) im Tenant des Akteurs.
 */
export function lies<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return mitTenant(DEMO_TENANT_ID, fn);
}

const LESEND = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Lesezugriff der Demo-Lader wie früher über `prisma.<modell>.<methode>(…)`:
 * Jeder Aufruf läuft in `lies` (eigene Transaktion im Demo-Tenant, RLS).
 * Schreibende Methoden und Rohzugriffe (`$…`) sind gesperrt – Änderungen nur
 * über `mitAudit` (AGENTS.md Regel 1).
 */
export const db: Tx = new Proxy({} as Tx, {
  get(_ziel, modell) {
    if (typeof modell !== 'string' || modell.startsWith('$') || modell === 'then') {
      throw new Error(`[demo] db.${String(modell)} ist nicht erlaubt.`);
    }
    return new Proxy(
      {},
      {
        get(_z, methode) {
          if (typeof methode !== 'string' || !LESEND.has(methode)) {
            throw new Error(
              `[demo] db.${modell}.${String(methode)}: Änderungen nur über mitAudit.`,
            );
          }
          return (...args: unknown[]) =>
            lies((tx) => {
              const delegat = (tx as unknown as Record<string, Record<string, unknown>>)[modell];
              const f = delegat?.[methode];
              if (typeof f !== 'function') throw new Error(`[demo] Unbekanntes Modell ${modell}.`);
              return (f as (...a: unknown[]) => Promise<unknown>).apply(delegat, args);
            });
        },
      },
    );
  },
});
