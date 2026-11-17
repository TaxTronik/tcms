// =============================================================================
// CMS-Beschreibung, Freigabe anfordern (Demo-Action, Befund 70): Sitzung und
// Recht vor jedem Datenbankzugriff. Ohne Sitzung leitet die Action um, ein
// Mandantenkontakt bzw. eine Person ohne Bearbeitungsrecht erhält dieselbe
// Antwort wie für eine unbekannte Version – nie „keine gesetzliche Vertretung"
// (das verriete, ob ein Mandant eine GV hat). DB_TESTS=1 wie aktionen.db.test.ts;
// Next-Module (Cookies, Revalidierung, Redirect) sind durch Attrappen ersetzt.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS } from '@tcms/db/demo';

const AKTIV = process.env['DB_TESTS'] === '1';

class Umleitung extends Error {
  constructor(readonly ziel: string) {
    super(`Umleitung nach ${ziel}`);
  }
}
let sitzung = '';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (sitzung ? { value: sitzung } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (ziel: string) => {
    throw new Umleitung(ziel);
  },
  notFound: () => {
    throw new Umleitung('404');
  },
}));

const { erzeugeCookie } = await import('../sitzung-regeln');
const { freigabeAnfordern } = await import('./beschreibung');

const form = (felder: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return fd;
};

describe.skipIf(!AKTIV)('Demo-Action Beschreibung: Freigabe anfordern', () => {
  beforeAll(() => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
  });
  beforeEach(() => {
    sitzung = '';
  });

  // Ein Mandant ohne gesetzliche Vertretung (unbekannte ID): Vor der Korrektur las die
  // Action die Kontaktrollen und antwortete „keine gesetzliche Vertretung".
  const ohneGv = { mandantId: randomUUID(), versionId: 'v-unbekannt' };

  it('ohne Sitzung: Umleitung zur Anmeldung, keine Auskunft über den Mandanten', async () => {
    await expect(freigabeAnfordern(null, form(ohneGv))).rejects.toBeInstanceOf(Umleitung);
  });

  it('Mandantenkontakt: „nicht gefunden" statt Auskunft über gesetzliche Vertretungen', async () => {
    sitzung = erzeugeCookie(DEMO_IDS.jana);
    for (const mandantId of [ohneGv.mandantId, DEMO_IDS.talwind, DEMO_IDS.seestern]) {
      const r = await freigabeAnfordern(null, form({ ...ohneGv, mandantId }));
      expect(r, mandantId).toEqual({ fehler: 'Version nicht gefunden.' });
    }
  });
});
