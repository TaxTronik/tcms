// =============================================================================
// Tax-CMS-Kontext gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app, mit
// Demo-Seed): Rechte (TS-03), Mandanten- und Tenant-Trennung ohne
// Existenz-Orakel, Eingabeprüfung, Stichtag und Maskierung vertraulicher
// Feststellungen im Service.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DienstFehler, type Akteur, type KontextEingabe } from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { verweisAblage } from '../ablage';
import { imDienst, type PersonenVerzeichnis, type Uhr } from '../kontext';
import { ladeKontext, VERTRAULICH_MASKE, type TcmsKontext } from './tcms-kontext';

const AKTIV = process.env['DB_TESTS'] === '1';

const UHR: Uhr = { jetzt: () => new Date('2026-10-16T10:00:00Z'), heute: () => '2026-10-16' };
const angefragt: string[][] = [];
const PERSONEN: PersonenVerzeichnis = {
  namen: async (ids) => {
    angefragt.push([...ids]);
    return new Map(ids.map((id) => [id, `Person ${id.slice(-4)}`]));
  },
};
const PORTS = { uhr: UHR, personen: PERSONEN, ablage: verweisAblage };

const kanzlei = (
  id: string,
  mandantId: string | null,
  p: { tenantId?: string; admin?: boolean; bt?: boolean; zustaendig?: boolean; hb?: boolean } = {},
): Akteur => ({
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
});
const kontakt = (id: string, mandantId: string): Akteur => ({
  art: 'MANDANT',
  tenantId: DEMO_TENANT_ID,
  id,
  name: 'Kontakt',
  mandantId,
});

const lade = (a: Akteur, eingabe: unknown): Promise<TcmsKontext> =>
  imDienst(a, PORTS, (ctx) => ladeKontext(ctx, eingabe as KontextEingabe));

async function fehlerVon(p: Promise<unknown>): Promise<DienstFehler> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DienstFehler) return e;
    throw e;
  }
  throw new Error('Kein Fehler, obwohl einer erwartet war');
}

const anna = kanzlei(DEMO_IDS.anna, DEMO_IDS.talwind, { admin: true, bt: true, zustaendig: true });
// Thomas: Berufsträger der Kanzlei mit Zugriff auf Talwind, aber dort weder zuständig noch Admin.
const thomas = kanzlei(DEMO_IDS.thomas, DEMO_IDS.talwind, { bt: true });

describe.skipIf(!AKTIV)('Tax-CMS-Kontext gegen PostgreSQL', () => {
  let vertraulichId = '';
  let vertraulichTitel = '';

  beforeAll(async () => {
    // Eine Talwind-Feststellung, an der Thomas nicht beteiligt ist, vertraulich setzen.
    await mitTenant(DEMO_TENANT_ID, async (tx) => {
      const kandidaten = await tx.feststellung.findMany({
        where: { programm: { mandantId: DEMO_IDS.talwind }, vertraulich: false },
        include: { massnahmen: { select: { verantwortlich: true } } },
        orderBy: { nummer: 'asc' },
      });
      const f = kandidaten.find(
        (x) =>
          ![
            x.erfasstVon,
            x.p153EntschiedenVon,
            x.verwerfenBeantragtVon,
            ...x.massnahmen.map((m) => m.verantwortlich),
          ].includes(DEMO_IDS.thomas),
      );
      if (!f) throw new Error('Seed ohne passende Feststellung');
      vertraulichId = f.id;
      vertraulichTitel = f.titel;
      await tx.feststellung.update({ where: { id: f.id }, data: { vertraulich: true } });
    });
  });

  afterAll(async () => {
    if (vertraulichId) {
      await mitTenant(DEMO_TENANT_ID, (tx) =>
        tx.feststellung.update({ where: { id: vertraulichId }, data: { vertraulich: false } }),
      );
    }
  });

  it('lädt den Kontext für eine Kanzleiperson mit Bezug (aktueller Stand)', async () => {
    angefragt.length = 0;
    const k = await lade(anna, { mandantId: DEMO_IDS.talwind });
    expect(k.mandant).toEqual({
      id: DEMO_IDS.talwind,
      name: 'Talwind Outdoor GmbH',
      rechtsform: 'KapG',
      datevNr: '4711',
    });
    expect(k.programm).not.toBeNull();
    expect(k.risiken.length).toBeGreaterThan(0);
    expect(k.kontrollen.length).toBeGreaterThan(0);
    expect(k.historisch).toBe(false);
    expect(k.stand.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(k.heute.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    // Rollen der Mandantenseite aus MandantKontaktRolle, keine Zuständigkeit der Kanzlei.
    expect(k.kontaktRollen).toContainEqual(
      expect.objectContaining({ kontaktId: DEMO_IDS.jana, rolle: 'GESETZLICHER_VERTRETER' }),
    );
    expect(k.mandant).not.toHaveProperty('berufstraegerId');
    // Namen nur über den Port, in einem Aufruf.
    expect(angefragt).toHaveLength(1);
    expect(k.namen.get(DEMO_IDS.jana)).toBe(`Person ${DEMO_IDS.jana.slice(-4)}`);
  });

  it('Stichtag: vor heute historisch, ab heute aktueller Stand', async () => {
    const alt = await lade(anna, { mandantId: DEMO_IDS.talwind, stand: '2026-03-31' });
    expect(alt.historisch).toBe(true);
    expect(alt.stand.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    const zukunft = await lade(anna, { mandantId: DEMO_IDS.talwind, stand: '2027-01-01' });
    expect(zukunft.historisch).toBe(false);
    expect(zukunft.stand.toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });

  it('Mandantenkontakt mit aktiver Rolle liest den eigenen Mandanten', async () => {
    const k = await lade(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), {
      mandantId: DEMO_IDS.talwind,
    });
    expect(k.mandant.id).toBe(DEMO_IDS.talwind);
  });

  it('TS-03: ohne bestätigten Bezug kein Lesen – auch nicht als Admin', async () => {
    const ohne = kanzlei(DEMO_IDS.anna, null, { admin: true, bt: true });
    expect((await fehlerVon(lade(ohne, { mandantId: DEMO_IDS.talwind }))).code).toBe(
      'NICHT_GEFUNDEN',
    );
    // Bezug auf einen anderen Mandanten desselben Tenants.
    const anderer = kanzlei(DEMO_IDS.anna, DEMO_IDS.seestern, { admin: true, bt: true });
    expect((await fehlerVon(lade(anderer, { mandantId: DEMO_IDS.talwind }))).code).toBe(
      'NICHT_GEFUNDEN',
    );
  });

  it('TS-03: Mandantenkontakt nur beim eigenen Mandanten und nur mit aktiver Rolle', async () => {
    // Jana (Talwind) fragt Seestern an.
    const fremd = await fehlerVon(
      lade(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), { mandantId: DEMO_IDS.seestern }),
    );
    expect(fremd.code).toBe('NICHT_GEFUNDEN');
    // Bestätigter Kontakt von Talwind ohne Rolle in MandantKontaktRolle.
    const ohneRolle = await fehlerVon(
      lade(kontakt(randomUUID(), DEMO_IDS.talwind), { mandantId: DEMO_IDS.talwind }),
    );
    expect(ohneRolle.code).toBe('NICHT_GEFUNDEN');
  });

  it('fremder Tenant und unbekannte ID: dieselbe Antwort (kein Existenz-Orakel)', async () => {
    // Bezug stimmt, aber der Akteur gehört zu einem anderen Tenant: RLS verbirgt Talwind.
    const fremderTenant = kanzlei(randomUUID(), DEMO_IDS.talwind, {
      tenantId: randomUUID(),
      admin: true,
      bt: true,
      zustaendig: true,
    });
    const a = await fehlerVon(lade(fremderTenant, { mandantId: DEMO_IDS.talwind }));
    const unbekannt = randomUUID();
    const b = await fehlerVon(
      lade(kanzlei(DEMO_IDS.anna, unbekannt, { admin: true }), { mandantId: unbekannt }),
    );
    const c = await fehlerVon(
      lade(kanzlei(DEMO_IDS.anna, null, { admin: true }), { mandantId: DEMO_IDS.talwind }),
    );
    for (const f of [a, b, c]) {
      expect(f.code).toBe('NICHT_GEFUNDEN');
      expect(f.message).toBe('NICHT_GEFUNDEN');
      expect(f.felder).toBeUndefined();
    }
  });

  it('ungültige Eingaben: UNGUELTIG mit Feldern', async () => {
    for (const eingabe of [
      { mandantId: 'kein-uuid' },
      { mandantId: DEMO_IDS.talwind, stand: '2026-02-30' },
      { mandantId: DEMO_IDS.talwind, stand: '16.10.2026' },
      { mandantId: DEMO_IDS.talwind, historisch: true },
      { mandantId: DEMO_IDS.talwind, tenantId: randomUUID() },
      null,
    ]) {
      const f = await fehlerVon(lade(anna, eingabe));
      expect(f.code).toBe('UNGUELTIG');
      expect(Object.keys(f.felder ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('vertrauliche Feststellung: für Nicht-Beteiligte maskiert, für Admin sichtbar', async () => {
    const offen = (await lade(anna, { mandantId: DEMO_IDS.talwind })).feststellungen.find(
      (f) => f.id === vertraulichId,
    );
    expect(offen?.titel).toBe(vertraulichTitel);
    expect(offen?.vertraulich).toBe(true);

    const maskiert = (await lade(thomas, { mandantId: DEMO_IDS.talwind })).feststellungen.find(
      (f) => f.id === vertraulichId,
    );
    expect(maskiert).toMatchObject({
      vertraulich: true,
      titel: VERTRAULICH_MASKE.titel,
      sachverhalt: '',
      quelleText: 'vertraulich',
      risikoCodes: [],
    });

    // Mandantenkontakte sind nie Beteiligte im Sinne von `kannVertraulichLesen`.
    const portal = (
      await lade(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), { mandantId: DEMO_IDS.talwind })
    ).feststellungen.find((f) => f.id === vertraulichId);
    expect(portal?.titel).toBe(VERTRAULICH_MASKE.titel);
  });
});
