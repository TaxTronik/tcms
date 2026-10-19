// =============================================================================
// Nur für Tests des Bereichs „programm-beschreibung": eine eigene Welt je
// Testdatei in einem frischen Tenant (zwei Mandanten mit Kontakten und Rollen),
// Akteure, Uhr und Helfer. Läuft über `mitTenant` als Laufzeitrolle tcms_app
// (RLS aktiv); legt nur Daten im eigenen Tenant an. Einzige Ausnahme ist
// `alsEigentuemerOhneTrigger` für Manipulationstests (Eigentümerrolle).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { DienstFehler, type Akteur } from '@tcms/contract';
import {
  AUDIT_SPERRE,
  erzeugeClient,
  mitTenant,
  tenantSperre,
  type PrismaClient,
  type Tx,
} from '@tcms/db';
import { verweisAblage } from '../../ablage';
import { imDienst, keinPersonenVerzeichnis, type DienstKontext, type Uhr } from '../../kontext';

export const TEST_UHR: Uhr = {
  jetzt: () => new Date('2026-10-19T09:00:00.000Z'),
  heute: () => '2026-10-19',
};
export const TEST_PORTS = {
  uhr: TEST_UHR,
  personen: keinPersonenVerzeichnis,
  ablage: verweisAblage,
};

export interface Welt {
  tenantId: string;
  mandantA: string;
  mandantB: string;
  /** Kanzlei: zuständige:r BT (Admin), Hauptbearbeitung, weitere Person ohne Zuständigkeit. */
  bt: string;
  hb: string;
  dritte: string;
  /** Mandant A: zwei gesetzliche Vertretungen, TCB, Mitarbeit, Kontakt mit inaktiver Rolle. */
  gv: string;
  gv2: string;
  tcb: string;
  ma: string;
  inaktiv: string;
  /** Mandant B: gesetzliche Vertretung. */
  gvB: string;
}

export async function baueWelt(): Promise<Welt> {
  const w: Welt = {
    tenantId: randomUUID(),
    mandantA: randomUUID(),
    mandantB: randomUUID(),
    bt: randomUUID(),
    hb: randomUUID(),
    dritte: randomUUID(),
    gv: randomUUID(),
    gv2: randomUUID(),
    tcb: randomUUID(),
    ma: randomUUID(),
    inaktiv: randomUUID(),
    gvB: randomUUID(),
  };
  await mitTenant(w.tenantId, async (tx) => {
    await tx.mandant.create({
      data: { id: w.mandantA, name: 'Testmandant A GmbH', rechtsform: 'KapG' },
    });
    await tx.mandant.create({
      data: { id: w.mandantB, name: 'Testmandant B GmbH', rechtsform: 'KapG' },
    });
    const rolle = (
      mandantId: string,
      kontaktId: string,
      r: 'GESETZLICHER_VERTRETER' | 'TAX_COMPLIANCE_BEAUFTRAGTER' | 'MITARBEITER',
      aktiv = true,
    ) => tx.mandantKontaktRolle.create({ data: { mandantId, kontaktId, rolle: r, aktiv } });
    await rolle(w.mandantA, w.gv, 'GESETZLICHER_VERTRETER');
    await rolle(w.mandantA, w.gv2, 'GESETZLICHER_VERTRETER');
    await rolle(w.mandantA, w.tcb, 'TAX_COMPLIANCE_BEAUFTRAGTER');
    await rolle(w.mandantA, w.ma, 'MITARBEITER');
    await rolle(w.mandantA, w.inaktiv, 'GESETZLICHER_VERTRETER', false);
    await rolle(w.mandantB, w.gvB, 'GESETZLICHER_VERTRETER');
  });
  return w;
}

/** Weiterer Mandant im Tenant der Welt mit einer gesetzlichen Vertretung. */
export async function neuerMandant(w: Welt): Promise<{ mandantId: string; gv: string }> {
  const mandantId = randomUUID();
  const gv = randomUUID();
  await mitTenant(w.tenantId, async (tx) => {
    await tx.mandant.create({
      data: { id: mandantId, name: 'Weiterer Mandant KG', rechtsform: 'PersG' },
    });
    await tx.mandantKontaktRolle.create({
      data: { mandantId, kontaktId: gv, rolle: 'GESETZLICHER_VERTRETER' },
    });
  });
  return { mandantId, gv };
}

/** Zuständige Berufsträgerin (Admin) für einen beliebigen Mandanten der Welt. */
export const btFuer = (w: Welt, mandantId: string) =>
  kanzlei(w, w.bt, mandantId, { admin: true, bt: true, zustaendig: true });

export interface KanzleiOpt {
  tenantId?: string;
  admin?: boolean;
  bt?: boolean;
  zustaendig?: boolean;
  hb?: boolean;
  name?: string;
}

export function kanzlei(w: Welt, id: string, mandantId: string | null, o: KanzleiOpt = {}): Akteur {
  return {
    art: 'KANZLEI',
    tenantId: o.tenantId ?? w.tenantId,
    id,
    name: o.name ?? 'Kanzleiperson',
    istAdmin: o.admin ?? false,
    istBerufstraeger: o.bt ?? false,
    mandant: mandantId
      ? {
          id: mandantId,
          zustaendigBerufstraeger: o.zustaendig ?? false,
          hauptbearbeitung: o.hb ?? false,
        }
      : null,
  };
}

export function kontakt(w: Welt, id: string, mandantId: string, tenantId = w.tenantId): Akteur {
  return { art: 'MANDANT', tenantId, id, name: 'Kontaktperson', mandantId };
}

/** Zuständige Berufsträgerin (Admin) von Mandant A. */
export const btA = (w: Welt) =>
  kanzlei(w, w.bt, w.mandantA, { admin: true, bt: true, zustaendig: true });
/** Hauptbearbeitung von Mandant A (Bearbeitungsrecht, kein BT). */
export const hbA = (w: Welt) => kanzlei(w, w.hb, w.mandantA, { hb: true });
/** Kanzleiperson mit Bezug zu A, aber ohne Bearbeitungsrecht. */
export const ohneRechtA = (w: Welt) => kanzlei(w, w.dritte, w.mandantA);

export function im<T>(
  a: Akteur,
  fn: (ctx: DienstKontext) => Promise<T>,
  client?: PrismaClient,
): Promise<T> {
  return imDienst(a, TEST_PORTS, fn, client ? { client } : undefined);
}

export async function fehlerVon(p: Promise<unknown>): Promise<DienstFehler> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DienstFehler) return e;
    throw e;
  }
  throw new Error('Kein Fehler, obwohl einer erwartet war');
}

/** Lesender bzw. vorbereitender Zugriff im Tenant der Welt (als tcms_app). */
export function inWelt<T>(w: Welt, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return mitTenant(w.tenantId, fn);
}

/** Zweite Laufzeitverbindung für Gleichzeitigkeitstests (eigener Pool, ebenfalls tcms_app). */
export function zweiteVerbindung(): PrismaClient {
  return erzeugeClient(process.env['DATABASE_URL']);
}

/**
 * Ändert Daten unterhalb des Dienstes, wie es nur mit Eigentümerrechten ginge
 * (Migrationsrolle `tcms_owner`, `DATABASE_OWNER_URL`; nur für
 * Manipulationstests): eine Transaktion im Tenant der Welt, in der der
 * Einfrier-Trigger der Beschreibung abgeschaltet ist (vor dem Festschreiben
 * wieder an). Die Laufzeitrolle kann den Trigger nicht abschalten.
 */
export async function alsEigentuemerOhneTrigger(
  w: Welt,
  sql: string,
  ...werte: unknown[]
): Promise<number> {
  const eigentuemer = erzeugeClient(process.env['DATABASE_OWNER_URL']);
  try {
    return await eigentuemer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${w.tenantId}, true)`;
      await tx.$executeRawUnsafe(
        'ALTER TABLE "BeschreibungVersion" DISABLE TRIGGER "BeschreibungVersion_eingefroren"',
      );
      const n = await tx.$executeRawUnsafe(sql, ...werte);
      await tx.$executeRawUnsafe(
        'ALTER TABLE "BeschreibungVersion" ENABLE TRIGGER "BeschreibungVersion_eingefroren"',
      );
      return n;
    });
  } finally {
    await eigentuemer.$disconnect();
  }
}

/** Audit-Einträge zu einem Objekt (neueste zuletzt). */
export function auditZu(w: Welt, objektId: string) {
  return inWelt(w, (tx) =>
    tx.auditEvent.findMany({ where: { objektId }, orderBy: { pos: 'asc' } }),
  );
}

/**
 * Erzwingt echte Gleichzeitigkeit (TS-05): Eine Testtransaktion hält die
 * Audit-Sperre des Tenants, beide Läufe starten auf getrennten Verbindungen
 * und bleiben vor ihrem Commit hängen (beim Audit bzw. an einer Zeilensperre).
 * Erst wenn alle Läufe warten, wird die Sperre freigegeben. Ohne
 * Schutzmaßnahme lesen beide Läufe so denselben alten Stand.
 */
export async function gleichzeitig<T>(
  w: Welt,
  laeufe: (() => Promise<T>)[],
  zeitlimitMs = 5000,
): Promise<PromiseSettledResult<T>[]> {
  let freigeben!: () => void;
  const ende = new Promise<void>((r) => (freigeben = r));
  let gesperrt!: () => void;
  const bereit = new Promise<void>((r) => (gesperrt = r));
  const halter = mitTenant(
    w.tenantId,
    async (tx) => {
      await tenantSperre(tx, AUDIT_SPERRE);
      gesperrt();
      await ende;
    },
    { timeoutMs: zeitlimitMs + 10_000 },
  );
  await bereit;
  const ergebnisse = Promise.allSettled(laeufe.map((l) => l()));
  const bis = Date.now() + zeitlimitMs;
  while (Date.now() < bis) {
    const [z] = await mitTenant(
      w.tenantId,
      (tx) =>
        tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((z?.n ?? 0) >= laeufe.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  freigeben();
  await halter;
  return ergebnisse;
}

export function nurEinErfolg<T>(e: PromiseSettledResult<T>[]): { wert: T; fehlerCode: string } {
  const ok = e.filter((x): x is PromiseFulfilledResult<T> => x.status === 'fulfilled');
  const nein = e.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
  if (ok.length !== 1 || nein.length !== e.length - 1) {
    throw new Error(
      `Erwartet genau einen Erfolg, erhalten ${ok.length} Erfolge: ${nein.map((x) => String((x.reason as Error)?.message)).join(', ')}`,
    );
  }
  return { wert: ok[0]!.value, fehlerCode: String((nein[0]?.reason as { code?: string })?.code) };
}
