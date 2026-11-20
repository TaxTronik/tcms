import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Kalender from '../app/staff/clients/[id]/tcms/kalender/page';

vi.mock('@/components/tcms/kopf', () => ({ TcmsKopf: () => null }));
vi.mock('@/server/seite', () => ({
  ladeStaffSeite: async () => ({
    ctx: {
      programm: { wirksamAb: new Date('2026-08-01T00:00:00Z'), wirksamBis: null },
      stand: new Date('2026-10-01T00:00:00Z'),
      kontrollen: [],
      durchfuehrungen: [],
    },
    basis: '/staff/clients/demo/tcms',
    mitStand: (href: string) => href,
  }),
}));

describe('Startmonat des Kontrollkalenders', () => {
  async function seite(ab: string) {
    const view = await Kalender({
      params: Promise.resolve({ id: 'demo' }),
      searchParams: Promise.resolve({ ab }),
    });
    return renderToStaticMarkup(view);
  }

  it.each(['2026-00', '2026-13', 'kein-monat'])(
    'verwendet bei %s den Wirksamkeitsbeginn und bereinigt die Filterlinks',
    async (ab) => {
      const html = await seite(ab);
      expect(html).toContain('Aug 2026 – Jul 2027');
      expect(html).not.toContain(ab);
    },
  );

  it('zeigt zwölf Monate ab dem explizit gewählten Dezember', async () => {
    const html = await seite('2025-12');
    expect(html).toContain('Dez 2025 – Nov 2026');
    expect(html).toContain('ab=2024-12');
    expect(html).toContain('ab=2026-12');
  });
});
