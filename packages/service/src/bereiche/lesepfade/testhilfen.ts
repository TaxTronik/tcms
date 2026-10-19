// Testhilfen des Bereichs „lesepfade" (nur von Tests importiert): Akteure,
// Ports mit fester Uhr und Fehlererwartung.

import { DienstFehler, type Akteur } from '@tcms/contract';
import { DEMO_TENANT_ID } from '@tcms/db/demo';
import { verweisAblage } from '../../ablage';
import { imDienst, keinPersonenVerzeichnis, type DienstKontext, type Uhr } from '../../kontext';

export const UHR: Uhr = {
  jetzt: () => new Date('2026-10-16T10:00:00Z'),
  heute: () => '2026-10-16',
};
export const PORTS = { uhr: UHR, personen: keinPersonenVerzeichnis, ablage: verweisAblage };

export type KanzleiAkteur = Extract<Akteur, { art: 'KANZLEI' }>;

export function kanzlei(
  id: string,
  mandantId: string | null,
  p: { tenantId?: string; admin?: boolean; bt?: boolean; zustaendig?: boolean; hb?: boolean } = {},
): KanzleiAkteur {
  return {
    art: 'KANZLEI',
    tenantId: p.tenantId ?? DEMO_TENANT_ID,
    id,
    name: 'Kanzleiperson',
    istAdmin: p.admin ?? false,
    istBerufstraeger: p.bt ?? false,
    mandant: mandantId
      ? {
          id: mandantId,
          zustaendigBerufstraeger: p.zustaendig ?? false,
          hauptbearbeitung: p.hb ?? false,
        }
      : null,
  };
}

export function kontakt(id: string, mandantId: string, tenantId = DEMO_TENANT_ID): Akteur {
  return { art: 'MANDANT', tenantId, id, name: 'Kontakt', mandantId };
}

/** Führt `fn` im Dienstkontext des Akteurs aus (eine Transaktion im Tenant). */
export function im<T>(a: Akteur, fn: (ctx: DienstKontext) => Promise<T>): Promise<T> {
  return imDienst(a, PORTS, fn, { timeoutMs: 60_000 });
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
