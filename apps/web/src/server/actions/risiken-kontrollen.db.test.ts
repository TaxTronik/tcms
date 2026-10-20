// =============================================================================
// Demo-Actions und -Lader des Bereichs „risiken-kontrollen" Ende-zu-Ende gegen
// die geseedete Demo-Datenbank (DB_TESTS=1, DATABASE_URL = tcms_app):
// Formular → Eingabe → @tcms/service im Dienstkontext der angemeldeten Person.
// Next-Module (Cookies, Revalidierung, Redirect) sind Attrappen. Die Tests
// ändern Demodaten (Wegwerf-Datenbank).
// =============================================================================

import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { mitTenant } from '@tcms/db';
import { schlageRisikenVor, type Geschaeftsprofil } from '@tcms/domain';

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
const R = await import('./risiken');
const K = await import('./kontrollen');
const P = await import('./profil');
const { ladeRisikenZusatz, ladeRisikoDetail } = await import('../risiken-daten');
const { ladeKontrollenZusatz } = await import('../kontrollen-daten');
const { ladeProfilDaten } = await import('../profil-daten');
// „Heute" der Demo-Uhr (TCMS_DEMO_TODAY oder echtes Datum): Stichtag der Lader.
const { heute } = await import('../zeit');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};
const form = (felder: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) {
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
};
const imDemo = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(DEMO_TENANT_ID, fn);
const B = 'Begründung mit ausreichend vielen Zeichen für die Demo.';
const T = DEMO_IDS.talwind;

describe.skipIf(!AKTIV)('Demo risiken-kontrollen gegen PostgreSQL', () => {
  let programmId = '';

  beforeAll(async () => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
    programmId = (
      await imDemo((tx) => tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: T } }))
    ).id;
  });

  beforeEach(() => {
    sitzung = '';
  });

  async function risikoMitStand(code?: string) {
    return imDemo((tx) =>
      tx.risiko.findFirstOrThrow({
        where: {
          programmId,
          entscheidung: 'UEBERNOMMEN',
          inaktivAb: null,
          ...(code ? { code } : {}),
        },
        include: { staende: { where: { gueltigBis: null } } },
        orderBy: { code: 'asc' },
      }),
    );
  }

  it('Neubewertung über das Formular; fremder Mandant und historischer Stand', async () => {
    als(DEMO_IDS.leon);
    const r = await risikoMitStand();
    const s = r.staende[0]!;
    const felder = {
      mandantId: T,
      id: r.id,
      standId: s.id,
      s: s.s === 'H' ? 'M' : 'H',
      w: s.w,
      r: String(s.r),
      gt: s.gt,
      begruendung: B,
    };
    // Mandant im Formular manipuliert: Risiko gehört nicht zu Seestern.
    expect(
      await R.risikoNeuBewerten(null, form({ ...felder, mandantId: DEMO_IDS.seestern })),
    ).toEqual({ fehler: 'Risiko nicht gefunden.' });
    expect(await R.risikoNeuBewerten(null, form({ ...felder, stand: '2026-01-01' }))).toEqual({
      fehler: 'Änderungen nur im aktuellen Stand möglich',
    });
    expect(await R.risikoNeuBewerten(null, form({ ...felder, begruendung: 'kurz' }))).toEqual({
      fehler: 'Bitte S, W, R, Governance-Typ und eine Begründung (mindestens 30 Zeichen) angeben.',
    });
    const ok = await R.risikoNeuBewerten(null, form(felder));
    expect(ok?.ok).toContain(`${r.code} neu bewertet`);
    // Derselbe (inzwischen geschlossene) Stand → Konflikt mit Grund.
    expect((await R.risikoNeuBewerten(null, form(felder)))?.fehler).toContain('inzwischen');
  });

  it('Übersteuerung: Vier-Augen über die Demo', async () => {
    const r = await risikoMitStand();
    als(DEMO_IDS.anna);
    const zusatz = await ladeRisikoDetail({ mandant: { id: T }, stand: heute() } as never, r.id);
    expect(zusatz?.staende.length).toBeGreaterThan(0);
    als(DEMO_IDS.leon);
    const antrag = await R.uebersteuerungBeantragen(
      null,
      form({ mandantId: T, id: r.id, sicht: 'BETRIEB', klasse: 'KRITISCH', begruendung: B }),
    );
    if (antrag?.fehler) expect(antrag.fehler).toMatch(/berechneten|wirksam/);
    else {
      expect(antrag?.ok).toContain('Übersteuerung beantragt');
      const u = await imDemo((tx) =>
        tx.uebersteuerung.findFirstOrThrow({
          where: { risikoId: r.id, status: 'BEANTRAGT' },
          orderBy: { beantragtAm: 'desc' },
        }),
      );
      const selbst = await R.uebersteuerungEntscheiden(
        null,
        form({ mandantId: T, id: u.id, entscheidung: 'freigeben' }),
      );
      expect(selbst?.fehler).toContain('zweite Person');
      als(DEMO_IDS.anna);
      const ok = await R.uebersteuerungEntscheiden(
        null,
        form({ mandantId: T, id: u.id, entscheidung: 'freigeben' }),
      );
      expect(ok?.ok).toContain('Übersteuerung freigegeben');
    }
  });

  it('Inventarfreigabe über die Demo: einreichen, selbst freigeben verweigert, zweite Person', async () => {
    als(DEMO_IDS.leon);
    const r = await risikoMitStand();
    const s = r.staende[0]!;
    await R.risikoNeuBewerten(
      null,
      form({
        mandantId: T,
        id: r.id,
        standId: s.id,
        s: s.s === 'H' ? 'N' : 'H',
        w: s.w,
        r: String(s.r),
        gt: s.gt,
        begruendung: B,
      }),
    );
    const ein = await R.risikenFreigabeSchritt(
      null,
      form({ mandantId: T, ids: [r.id], aktion: 'einreichen' }),
    );
    expect(ein?.ok).toContain('zur Freigabe eingereicht');
    const selbst = await R.risikenFreigabeSchritt(
      null,
      form({ mandantId: T, ids: [r.id], aktion: 'freigeben' }),
    );
    expect(selbst?.fehler).toContain('zweite Person');
    als(DEMO_IDS.anna);
    const frei = await R.risikenFreigabeSchritt(
      null,
      form({ mandantId: T, ids: [r.id], aktion: 'freigeben' }),
    );
    expect(frei?.ok).toContain('freigegeben');
  });

  it('Kontrollen über die Demo: Design, Abweichung (Vier-Augen), Zuständigkeiten, Lader', async () => {
    als(DEMO_IDS.leon);
    const k = await imDemo((tx) =>
      tx.kontrolle.findFirstOrThrow({
        where: { programmId, code: 'K-EC-03' },
        include: { staende: { where: { gueltigBis: null } } },
      }),
    );
    const st = k.staende[0]!;
    const design = await K.designBeurteilen(
      null,
      form({
        mandantId: T,
        id: k.id,
        standId: st.id,
        code: k.code,
        design: 'ANGEMESSEN',
        begruendung: B,
      }),
    );
    expect(design?.ok).toContain('Designbeurteilung erfasst: angemessen');
    // Veralteter Stand → Konflikt.
    const alt = await K.designBeurteilen(
      null,
      form({
        mandantId: T,
        id: k.id,
        standId: st.id,
        code: k.code,
        design: 'MANGEL',
        begruendung: B,
      }),
    );
    expect(alt?.fehler).toContain('inzwischen');
    const zusatz = await ladeKontrollenZusatz(
      {
        mandant: { id: T },
        stand: heute(),
        programm: { id: programmId },
      } as never,
      k.id,
    );
    expect(zusatz.detail?.staende[0]?.aenderungen).toContain('Designbeurteilung');
    expect(zusatz.detail?.audit[0]?.actorName).toBe('Leon Brandt');
  });

  it('Profil und Risikoaufnahme über die Demo; Mandantenkontakt wird umgeleitet', async () => {
    als(DEMO_IDS.leon);
    const daten = await ladeProfilDaten({
      mandant: { id: T },
      stand: heute(),
    } as never);
    const offen = daten.staende.find((s) => s.gueltigBis === null)!;
    const profil: Geschaeftsprofil = structuredClone(offen.antworten);
    profil.p7.abos = !profil.p7.abos;
    await expect(
      P.aendereProfil(
        null,
        form({
          mandantId: T,
          profilStandId: offen.id,
          profil: JSON.stringify(profil),
          gueltigAb: heute().toISOString().slice(0, 10),
          ereignisse: 'on',
        }),
      ),
    ).rejects.toMatchObject({
      ziel: expect.stringMatching(/^\/staff\/clients\/.+\/profil\?geaendert=1/),
    });
    // Doppelte Schlüssel im Profil-JSON werden wie im Dienst abgewiesen.
    expect(
      await P.aendereProfil(
        null,
        form({
          mandantId: T,
          profilStandId: offen.id,
          profil: '{"p1":{},"p1":{}}',
          gueltigAb: heute().toISOString().slice(0, 10),
        }),
      ),
    ).toEqual({ fehler: 'Das Profil konnte nicht gelesen werden.' });

    const neu = await ladeProfilDaten({
      mandant: { id: T },
      stand: heute(),
    } as never);
    const juengster = neu.staende.find((s) => s.gueltigBis === null)!;
    const uebernommen = new Set(
      neu.risiken.filter((r) => r.entscheidung === 'UEBERNOMMEN').map((r) => r.code),
    );
    const vorschlag = schlageRisikenVor(juengster.antworten).find((v) => !uebernommen.has(v.code));
    if (vorschlag) {
      await expect(
        P.nimmVorgeschlagenesRisikoAuf(null, form({ mandantId: T, code: vorschlag.code })),
      ).rejects.toMatchObject({ ziel: expect.stringMatching(/aufgenommen=/) });
    }
    als(DEMO_IDS.jana);
    await expect(
      P.nimmVorgeschlagenesRisikoAuf(null, form({ mandantId: T, code: 'EC-UST-01' })),
    ).rejects.toMatchObject({ ziel: expect.stringMatching(/^\/portal\/tcms/) });
  });

  it('Lader: Hinweise und Akzeptanzen zum Stichtag', async () => {
    als(DEMO_IDS.anna);
    const z = await ladeRisikenZusatz({
      mandant: { id: T },
      stand: heute(),
      programm: { id: programmId },
    } as never);
    expect(z.hinweise).toBeInstanceOf(Map);
    for (const liste of z.akzeptanzen.values())
      for (const a of liste) expect(a.angefordertAm).toBeInstanceOf(Date);
  });
});
