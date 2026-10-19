// =============================================================================
// Demo-Lader des Bereichs „lesepfade" Ende-zu-Ende gegen PostgreSQL
// (DB_TESTS=1, geseedete Wegwerf-DB): Sitzung → Demo-Akteur → Service.
// Portfolio, Arbeitskorb, Staff-Seite (TS-03), Portal-Start und Audit-Prüfung.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

const { erzeugeCookie } = await import('./sitzung-regeln');
const { brauchtKanzlei, brauchtPortal } = await import('./sitzung');
const { ladePortfolio } = await import('./portfolio-daten');
const { ladeArbeitskorb } = await import('./arbeitskorb-daten');
const { ladePortalStart } = await import('./portal-daten');
const { ladeStaffSeite } = await import('./seite');
const { ladeKontext } = await import('./kontext');
const { pruefeHashkette } = await import('./actions/admin');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};

describe.skipIf(!AKTIV)('Demo-Lader lesepfade gegen PostgreSQL', () => {
  beforeAll(() => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
  });

  it('Portfolio und Arbeitskorb über den Service, mit Namen aus dem Verzeichnis', async () => {
    als(DEMO_IDS.anna);
    const nutzer = await brauchtKanzlei();
    const p = await ladePortfolio(nutzer);
    expect(p.zeilen).toHaveLength(5);
    const talwind = p.zeilen.find((z) => z.mandant.id === DEMO_IDS.talwind)!;
    expect(talwind).toMatchObject({
      berufstraeger: 'StB Dr. Anna Roth',
      bearbeitung: 'Leon Brandt',
      darfBearbeiten: true,
      hatProgramm: true,
    });
    expect(talwind.naechsterTermin?.datum).toBeInstanceOf(Date);
    const k = await ladeArbeitskorb(nutzer);
    expect(k.heute).toBeInstanceOf(Date);
    expect(k.mandantenZustaendig).toBeGreaterThan(0);
  });

  it('Staff-Seite: unbekannter Mandant 404 (TS-03), bekannter mit Rechten aus dem Service', async () => {
    als(DEMO_IDS.thomas);
    await expect(ladeStaffSeite(randomUUID(), {})).rejects.toMatchObject({ ziel: '404' });
    const s = await ladeStaffSeite(DEMO_IDS.talwind, { stand: '2026-03-31' });
    expect(s.ctx.historisch).toBe(true);
    expect(s.darfBearbeiten).toBe(false);
    const aktuell = await ladeStaffSeite(DEMO_IDS.seestern, {});
    expect(aktuell.darfWuerdigen).toBe(true); // zuständiger BT für Seestern
  });

  it('Kontext-Hülle: Mandantenkontakt sieht keinen fremden Mandanten', async () => {
    als(DEMO_IDS.jana);
    expect(await ladeKontext(DEMO_IDS.seestern, '2026-10-16', false)).toBeNull();
    expect((await ladeKontext(DEMO_IDS.talwind, '2026-10-16', false))?.mandant.id).toBe(
      DEMO_IDS.talwind,
    );
  });

  it('Portal-Start über den Service mit Kanzleiteam aus dem Verzeichnis', async () => {
    als(DEMO_IDS.jana);
    const { akteur } = await brauchtPortal();
    const start = await ladePortalStart(akteur);
    expect(start.rechte.portalLesen).toBe(true);
    expect(start.team.map((t) => t.person.name)).toEqual(['StB Dr. Anna Roth', 'Leon Brandt']);
    expect(start.aufgaben.every((a) => a.d.faelligAm instanceof Date)).toBe(true);
  });

  it('Hashkette prüfen: Admin ok, sonst Hinweis ohne Prüfung', async () => {
    als(DEMO_IDS.anna);
    expect((await pruefeHashkette(null, new FormData()))?.ok).toMatch(/^Hashkette intakt/);
    als(DEMO_IDS.leon);
    expect((await pruefeHashkette(null, new FormData()))?.fehler).toMatch(/Admins\/Partnern/);
  });
});
