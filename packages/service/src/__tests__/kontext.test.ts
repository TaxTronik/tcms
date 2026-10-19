import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DienstFehler, type Akteur } from '@tcms/contract';

// schreibeAudit/mitTenant brauchen eine Datenbank; hier wird nur geprüft, was
// der Service-Kern an sie übergibt (Ende-zu-Ende: dienst.db.test.ts).
const aufrufe: { schreibeAudit: unknown[][]; mitTenant: unknown[][] } = {
  schreibeAudit: [],
  mitTenant: [],
};
vi.mock('@tcms/db', async (original) => {
  const echt = await original<typeof import('@tcms/db')>();
  return {
    ...echt,
    schreibeAudit: vi.fn(async (...a: unknown[]) => {
      aufrufe.schreibeAudit.push(a);
    }),
    mitTenant: vi.fn(async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      aufrufe.mitTenant.push([tenantId]);
      return fn({ fake: true });
    }),
  };
});

const { echteUhr, imDienst, kalendertag, normalisiereAkteur } = await import('../kontext');
const { mitAudit } = await import('../audit');
const { pruefeVerweis, verweisAblage } = await import('../ablage');
const { keinPersonenVerzeichnis } = await import('../kontext');

const AKTEUR: Akteur = {
  art: 'KANZLEI',
  tenantId: '11111111-1111-4111-8111-111111111111',
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  name: 'StB Dr. Anna Roth',
  istAdmin: true,
  istBerufstraeger: true,
  mandant: {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    zustaendigBerufstraeger: true,
    hauptbearbeitung: false,
  },
};
const PORTS = {
  uhr: { jetzt: () => new Date('2026-10-16T10:00:00Z'), heute: () => '2026-10-16' },
  personen: keinPersonenVerzeichnis,
  ablage: verweisAblage,
};

beforeEach(() => {
  aufrufe.schreibeAudit = [];
  aufrufe.mitTenant = [];
});

describe('Uhr', () => {
  it('heute ist der Kalendertag in Europe/Berlin', () => {
    expect(kalendertag(new Date('2026-10-18T22:30:00Z'))).toBe('2026-10-19'); // MESZ
    expect(kalendertag(new Date('2026-12-31T22:59:59Z'))).toBe('2026-12-31'); // MEZ
    expect(kalendertag(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01');
    expect(echteUhr.heute()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('die echte Uhr ignoriert TCMS_DEMO_TODAY', () => {
    const vorher = process.env['TCMS_DEMO_TODAY'];
    process.env['TCMS_DEMO_TODAY'] = '2001-01-01';
    try {
      expect(echteUhr.heute()).not.toBe('2001-01-01');
      expect(echteUhr.jetzt().getUTCFullYear()).toBeGreaterThan(2001);
    } finally {
      if (vorher === undefined) delete process.env['TCMS_DEMO_TODAY'];
      else process.env['TCMS_DEMO_TODAY'] = vorher;
    }
  });
});

describe('normalisiereAkteur', () => {
  it('schreibt alle IDs klein und friert das Objekt ein', () => {
    const gross = {
      ...AKTEUR,
      tenantId: AKTEUR.tenantId.toUpperCase(),
      id: AKTEUR.id.toUpperCase(),
    } as Akteur;
    const n = normalisiereAkteur(gross);
    expect(n.tenantId).toBe(AKTEUR.tenantId);
    expect(n.id).toBe(AKTEUR.id);
    expect(Object.isFrozen(n)).toBe(true);
  });

  it.each([
    ['Tenant keine UUID', { ...AKTEUR, tenantId: 'kanzlei-1' }],
    ['Tenant Nil-UUID', { ...AKTEUR, tenantId: '00000000-0000-0000-0000-000000000000' }],
    ['Person keine UUID', { ...AKTEUR, id: 'x' }],
    ['Mandant keine UUID', { ...AKTEUR, mandant: { ...AKTEUR.mandant!, id: "x' OR 1=1" } }],
    ['Name leer', { ...AKTEUR, name: '  ' }],
    ['Name zu lang', { ...AKTEUR, name: 'x'.repeat(201) }],
    ['unbekannte Art', { ...AKTEUR, art: 'SYSTEM' }],
  ])('weist ab: %s', (_n, a) => {
    expect(() => normalisiereAkteur(a as Akteur)).toThrow(DienstFehler);
  });

  it('Rollenflags nur bei true gesetzt (kein truthy-Durchrutschen)', () => {
    const n = normalisiereAkteur({ ...AKTEUR, istAdmin: 'ja' as unknown as boolean });
    expect(n.art === 'KANZLEI' && n.istAdmin).toBe(false);
  });
});

describe('imDienst', () => {
  it('bindet die Transaktion an den Tenant des Akteurs und übergibt den normalisierten Akteur', async () => {
    const gross = { ...AKTEUR, tenantId: AKTEUR.tenantId.toUpperCase() } as Akteur;
    const ctx = await imDienst(gross, PORTS, async (c) => c);
    expect(aufrufe.mitTenant).toEqual([[AKTEUR.tenantId]]);
    expect(ctx.akteur.tenantId).toBe(AKTEUR.tenantId);
    expect(ctx.tx).toEqual({ fake: true });
  });

  it('öffnet bei ungültigem Akteur keine Transaktion', async () => {
    await expect(
      imDienst({ ...AKTEUR, tenantId: 'x' }, PORTS, async () => 1),
    ).rejects.toBeInstanceOf(DienstFehler);
    expect(aufrufe.mitTenant).toEqual([]);
  });
});

describe('mitAudit', () => {
  const ctx = () => ({ tx: { fake: true } as never, akteur: normalisiereAkteur(AKTEUR), ...PORTS });

  it('protokolliert mit dem Akteur des Kontexts und der Uhrzeit der Uhr', async () => {
    let zeit: Date | null = null;
    const wert = await mitAudit(ctx(), async (_tx, zeitpunkt) => {
      zeit = zeitpunkt;
      return {
        wert: 42,
        protokoll: [
          { aktion: 'tcms.test.a', objektTyp: 'X', objektId: '1', programmId: 'p' },
          {
            aktion: 'tcms.test.b',
            objektTyp: 'X',
            objektId: '2',
            programmId: null,
            detail: { k: 1 },
          },
        ],
      };
    });
    expect(wert).toBe(42);
    expect(zeit).toEqual(new Date('2026-10-16T10:00:00Z'));
    expect(aufrufe.schreibeAudit).toHaveLength(2);
    expect(aufrufe.schreibeAudit[0]![1]).toEqual({
      actorId: AKTEUR.id,
      actorName: AKTEUR.name,
      aktion: 'tcms.test.a',
      objektTyp: 'X',
      objektId: '1',
      programmId: 'p',
      detail: {},
    });
    // Kein Zeitstempel und kein Tenant aus der Operation: beide setzt @tcms/db.
    expect(aufrufe.schreibeAudit[1]![1]).not.toHaveProperty('at');
    expect(aufrufe.schreibeAudit[1]![1]).not.toHaveProperty('tenantId');
  });

  it('eine Operation kann den Akteur im Protokoll nicht überschreiben', async () => {
    await mitAudit(ctx(), async () => ({
      wert: null,
      protokoll: {
        aktion: 'tcms.test.c',
        objektTyp: 'X',
        objektId: '3',
        programmId: null,
        actorId: 'fremd',
        actorName: 'Fremd',
      } as never,
    }));
    expect(aufrufe.schreibeAudit[0]![1]).toMatchObject({
      actorId: AKTEUR.id,
      actorName: AKTEUR.name,
    });
  });

  it('weist eine Änderung ohne Protokoll ab', async () => {
    await expect(mitAudit(ctx(), async () => ({ wert: 1, protokoll: [] }))).rejects.toThrow(
      /ohne Audit-Eintrag/,
    );
    expect(aufrufe.schreibeAudit).toEqual([]);
  });
});

describe('Nachweis-Ablage des Dienstes', () => {
  const gut = {
    dokumentId: 'dok_2026-10-16.abc:1',
    dateiname: 'Abstimmung Oktober.csv',
    mime: 'text/csv',
    groesse: 1234,
    sha256: 'a'.repeat(64),
  };

  it('übernimmt einen gültigen Verweis (ohne Zusatzfelder)', async () => {
    expect(await verweisAblage.annehmen({ art: 'VERWEIS', verweis: gut })).toEqual(gut);
  });

  it('weist Dateiinhalte ab', async () => {
    await expect(
      verweisAblage.annehmen({
        art: 'DATEI',
        dateiname: 'x.csv',
        mime: 'text/csv',
        inhalt: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: 'UNGUELTIG' });
  });

  const rlo = String.fromCharCode(0x202e);
  it.each([
    ['dokumentId leer', { dokumentId: '' }],
    ['dokumentId mit Pfad', { dokumentId: '../x' }],
    ['dokumentId zu lang', { dokumentId: 'a'.repeat(201) }],
    ['Dateiname mit Schrägstrich', { dateiname: 'a/b.csv' }],
    ['Dateiname mit Backslash', { dateiname: 'a\\b.csv' }],
    ['Dateiname mit Steuerzeichen', { dateiname: 'a\nb.csv' }],
    ['Dateiname mit Richtungszeichen', { dateiname: `rechnung${rlo}vsc.exe` }],
    ['Dateiname ..', { dateiname: '..' }],
    ['Dateiname zu lang', { dateiname: `${'a'.repeat(252)}.csv` }],
    ['MIME ungültig', { mime: 'text' }],
    ['MIME mit Parameter', { mime: 'text/html; charset=utf-8' }],
    ['Größe negativ', { groesse: -1 }],
    ['Größe gebrochen', { groesse: 1.5 }],
    ['Größe zu groß', { groesse: 2 ** 31 }],
    ['Größe als Text', { groesse: '12' }],
    ['SHA-256 zu kurz', { sha256: 'a'.repeat(63) }],
    ['SHA-256 Großbuchstaben', { sha256: 'A'.repeat(64) }],
    ['Zusatzfeld', { pfad: '/etc/passwd' }],
  ])('weist ab: %s', async (_n, aenderung) => {
    const verweis = { ...gut, ...aenderung } as never;
    expect(Object.keys(pruefeVerweis(verweis)).length).toBeGreaterThan(0);
    await expect(verweisAblage.annehmen({ art: 'VERWEIS', verweis })).rejects.toMatchObject({
      code: 'UNGUELTIG',
    });
  });

  it('weist Nicht-Objekte ab', () => {
    for (const v of [null, 'x', 1, []]) expect(pruefeVerweis(v)).toHaveProperty('verweis');
  });
});
