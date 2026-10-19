// =============================================================================
// Demo-Actions Ende-zu-Ende gegen PostgreSQL (DB_TESTS=1): Sitzung → Akteur →
// Rechte aus @tcms/service → mitAudit im Tenant (RLS, Laufzeitrolle tcms_app).
// Erwartet eine geseedete Datenbank (DATABASE_URL = tcms_app). Die Tests legen
// ihre Freigaben und Feststellungen selbst an und stellen geänderte
// Kontaktrollen wieder her: zwei Läufe hintereinander sind grün.
// Next-Module (Cookies, Revalidierung, Redirect) sind durch Attrappen ersetzt.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { mitTenant, pruefeAuditKette } from '@tcms/db';

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
const { codeAnfordern, kenntnisnehmen } = await import('./freigaben');
const { entscheideP153, erfasseFeststellung } = await import('./feststellungen');
const { brauchtPortal } = await import('../sitzung');

const als = (personId: string) => {
  sitzung = erzeugeCookie(personId);
};
const form = (felder: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return fd;
};
const imDemo = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(DEMO_TENANT_ID, fn);

describe.skipIf(!AKTIV)('Demo-Actions gegen PostgreSQL', () => {
  let beschreibungsFreigabe: string;
  let kenntnisnahme: string;
  let p153Feststellung: string;
  /** Kennung dieses Laufs (eindeutige Titel und Nummern). */
  const lauf = randomBytes(4).toString('hex');

  beforeAll(async () => {
    process.env['SESSION_SECRET'] ??= randomBytes(32).toString('hex');
    // Eigene Fixtures je Lauf (an Jana bzw. Murat adressiert, offene §-153-Würdigung).
    const programm = await imDemo((tx) =>
      tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: DEMO_IDS.talwind } }),
    );
    const [f1, f2, f] = await imDemo(async (tx) => [
      await tx.freigabe.create({
        data: {
          programmId: programm.id,
          art: 'ZIELE',
          refId: `test-${lauf}`,
          titel: `Compliance-Ziele (Test ${lauf})`,
          angefordertVon: DEMO_IDS.anna,
          empfaengerId: DEMO_IDS.jana,
        },
      }),
      await tx.freigabe.create({
        data: {
          programmId: programm.id,
          art: 'KENNTNISNAHME',
          refId: `test-${lauf}`,
          titel: `Steuerrichtlinie (Test ${lauf})`,
          inhalt: 'Testinhalt',
          angefordertVon: DEMO_IDS.anna,
          empfaengerId: DEMO_IDS.murat,
        },
      }),
      await tx.feststellung.create({
        data: {
          programmId: programm.id,
          nummer: `F-TEST-${lauf}`,
          titel: 'Lieferschwelle überschritten (Test)',
          sachverhalt: 'Fernverkäufe nach Tschechien über der Lieferschwelle, OSS-Meldung prüfen.',
          quelle: 'HINWEIS',
          quelleText: 'Test',
          klasse: 'STEUERLICHER_FEHLER',
          schwere: 'MITTEL',
          auswirkung: 'JA',
          status: 'IN_WUERDIGUNG',
          erfasstVon: DEMO_IDS.leon,
        },
      }),
    ]);
    beschreibungsFreigabe = f1.id;
    kenntnisnahme = f2.id;
    p153Feststellung = f.id;
    // Zweite gesetzliche Vertretung bei Talwind (Murat), um TS-06 zu prüfen.
    await imDemo((tx) =>
      tx.mandantKontaktRolle.upsert({
        where: {
          tenantId_mandantId_kontaktId_rolle: {
            tenantId: DEMO_TENANT_ID,
            mandantId: DEMO_IDS.talwind,
            kontaktId: DEMO_IDS.murat,
            rolle: 'GESETZLICHER_VERTRETER',
          },
        },
        create: {
          mandantId: DEMO_IDS.talwind,
          kontaktId: DEMO_IDS.murat,
          rolle: 'GESETZLICHER_VERTRETER',
        },
        update: { aktiv: true },
      }),
    );
  });

  afterAll(async () => {
    // Eigene Fixtures und erfasste Feststellungen samt Wiedervorlagen entfernen (das Audit bleibt).
    await imDemo(async (tx) => {
      const ids = (
        await tx.feststellung.findMany({
          where: {
            OR: [
              { id: p153Feststellung },
              {
                titel: {
                  in: [`Rundung OSS (Bearbeitung ${lauf})`, `Rundung OSS (Berufsträgerin ${lauf})`],
                },
              },
            ],
          },
          select: { id: true },
        })
      ).map((f) => f.id);
      await tx.massnahme.deleteMany({ where: { feststellungId: { in: ids } } });
      await tx.betroffeneErklaerung.deleteMany({ where: { feststellungId: { in: ids } } });
      await tx.feststellungRisiko.deleteMany({ where: { feststellungId: { in: ids } } });
      await tx.feststellung.deleteMany({ where: { id: { in: ids } } });
      await tx.freigabe.deleteMany({
        where: { id: { in: [beschreibungsFreigabe, kenntnisnahme] } },
      });
    });
    // Murats zusätzliche Rolle wieder abgeben (Seed-Zustand).
    await imDemo((tx) =>
      tx.mandantKontaktRolle.updateMany({
        where: {
          mandantId: DEMO_IDS.talwind,
          kontaktId: DEMO_IDS.murat,
          rolle: 'GESETZLICHER_VERTRETER',
        },
        data: { aktiv: false },
      }),
    );
  });

  beforeEach(() => {
    sitzung = '';
  });

  it('TS-06: eine fremd adressierte Freigabe kann keine andere GV an sich ziehen', async () => {
    als(DEMO_IDS.murat);
    const r = await codeAnfordern(null, form({ freigabeId: beschreibungsFreigabe }));
    expect(r).toEqual({ fehler: 'Diese Freigabe ist an eine andere Person gerichtet.' });
    const f = await imDemo((tx) =>
      tx.freigabe.findUniqueOrThrow({ where: { id: beschreibungsFreigabe } }),
    );
    expect(f.empfaengerId).toBe(DEMO_IDS.jana);
    expect(f.codeHash).toBeNull();
  });

  it('die adressierte GV erhält einen Code (Audit mit Akteur, Kette intakt)', async () => {
    als(DEMO_IDS.jana);
    const r = await codeAnfordern(null, form({ freigabeId: beschreibungsFreigabe }));
    expect(r).toMatchObject({ ok: expect.stringContaining('Bestätigungscode') });
    const [letzter, kette] = await imDemo(async (tx) => [
      await tx.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } }),
      await pruefeAuditKette(tx),
    ]);
    expect(letzter).toMatchObject({
      tenantId: DEMO_TENANT_ID,
      actorId: DEMO_IDS.jana,
      actorName: 'Jana Weller',
      aktion: 'tcms.freigabe.code_angefordert',
    });
    expect(kette.gueltig).toBe(true);
  });

  it('Kenntnisnahme nur durch die adressierte Person', async () => {
    als(DEMO_IDS.jana);
    expect(await kenntnisnehmen(null, form({ freigabeId: kenntnisnahme, gelesen: 'on' }))).toEqual({
      fehler: 'Diese Kenntnisnahme ist an eine andere Person gerichtet.',
    });
  });

  it('§-153: Berufsträger ohne Zuständigkeit und Bearbeitung abgewiesen, zuständige BT entscheidet', async () => {
    const eingabe = form({
      mandantId: DEMO_IDS.talwind,
      id: p153Feststellung,
      bisher: '',
      entscheidung: 'WEITERE_KLAERUNG',
      begruendung: 'Sachverhalt mit dem Mandanten klären, Unterlagen zur Lieferschwelle anfordern.',
      frist: '2026-12-31',
    });
    als(DEMO_IDS.thomas);
    expect(await entscheideP153(null, eingabe)).toEqual({
      fehler: 'Dieser Schritt ist Berufsträger:innen vorbehalten.',
    });
    als(DEMO_IDS.leon);
    expect(await entscheideP153(null, eingabe)).toEqual({
      fehler: 'Dieser Schritt ist Berufsträger:innen vorbehalten.',
    });
    als(DEMO_IDS.anna);
    expect(await entscheideP153(null, eingabe)).toMatchObject({ ok: expect.any(String) });
    const f = await imDemo((tx) =>
      tx.feststellung.findUniqueOrThrow({ where: { id: p153Feststellung } }),
    );
    expect(f.p153EntschiedenVon).toBe(DEMO_IDS.anna);
  });

  it('TS-04: „keine Auswirkung" setzt nur eine Berufsträgerin; sonst „unklar"', async () => {
    const eingabe = (titel: string) =>
      form({
        mandantId: DEMO_IDS.talwind,
        titel,
        sachverhalt: 'Rundungsdifferenz in der OSS-Meldung, Betrag unter Toleranz.',
        quelle: 'STICHPROBE',
        quelleText: 'Stichprobe Oktober',
        klasse: 'HINWEIS',
        schwere: 'GERING',
        auswirkung: 'NEIN',
      });
    als(DEMO_IDS.leon);
    expect(
      await erfasseFeststellung(null, eingabe(`Rundung OSS (Bearbeitung ${lauf})`)),
    ).toMatchObject({
      ok: expect.stringContaining('unklar'),
    });
    als(DEMO_IDS.anna);
    await erfasseFeststellung(null, eingabe(`Rundung OSS (Berufsträgerin ${lauf})`));
    const [leon, anna] = await imDemo(async (tx) => [
      await tx.feststellung.findFirstOrThrow({
        where: { titel: `Rundung OSS (Bearbeitung ${lauf})` },
      }),
      await tx.feststellung.findFirstOrThrow({
        where: { titel: `Rundung OSS (Berufsträgerin ${lauf})` },
      }),
    ]);
    expect(leon.auswirkung).toBe('UNKLAR');
    expect(anna.auswirkung).toBe('NEIN');
  });

  it('Mandantenkontakt mit deaktivierter Rolle kommt nicht ins Portal', async () => {
    const aktiv = await imDemo((tx) =>
      tx.mandantKontaktRolle.findMany({
        where: { kontaktId: DEMO_IDS.sabine, aktiv: true },
        select: { id: true },
      }),
    );
    await imDemo((tx) =>
      tx.mandantKontaktRolle.updateMany({
        where: { kontaktId: DEMO_IDS.sabine },
        data: { aktiv: false },
      }),
    );
    try {
      als(DEMO_IDS.sabine);
      await expect(brauchtPortal()).rejects.toMatchObject({ ziel: '/anmelden?fehler=rolle' });
      als(DEMO_IDS.murat);
      await expect(brauchtPortal()).resolves.toMatchObject({ akteur: { id: DEMO_IDS.murat } });
    } finally {
      // Seed-Zustand wiederherstellen (vorher aktive Rollen).
      await imDemo((tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { id: { in: aktiv.map((r) => r.id) } },
          data: { aktiv: true },
        }),
      );
    }
  });

  it('ohne Sitzung: Umleitung zur Anmeldung, keine Änderung', async () => {
    await expect(
      codeAnfordern(null, form({ freigabeId: beschreibungsFreigabe })),
    ).rejects.toMatchObject({ ziel: '/anmelden' });
  });
});
