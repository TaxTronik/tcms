// =============================================================================
// Historischer Stichtag gegen PostgreSQL (DB_TESTS=1, eigener Tenant): Kontext,
// Feststellungsliste und Ereignisliste rechnen Maßnahmen, Status, §-153,
// Ereignisse und Folgen gleich zurück (kern/rueckrechnung.ts, Befunde 52/67).
// Uhr der Tests: heute 16.10.2026, Stichtag 15.10.2026, die späteren Schritte am
// 16.10.2026 (heute sichtbar, zum Stichtag nicht); Audit-Einträge der
// Tests tragen die echte Zeit und liegen damit nach dem Stichtag.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FeststellungListenEintrag } from '@tcms/contract';
import { mitTenant, schreibeAudit, type Tx } from '@tcms/db';
import { ladeEreignisse } from '../bereiche/feststellungen-ereignisse/ereignisse-lesen';
import {
  ladeFeststellung,
  ladeFeststellungen,
} from '../bereiche/feststellungen-ereignisse/feststellungen-lesen';
import { ladeLaender } from '../bereiche/feststellungen-ereignisse/laender';
import { im, kanzlei } from '../bereiche/lesepfade/testhilfen';
import { ladeKontext, type FeststellungView } from './tcms-kontext';

const AKTIV = process.env['DB_TESTS'] === '1';
const STAND = '2026-10-15';
const tag = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe.skipIf(!AKTIV)('Rückrechnung zum Stichtag gegen PostgreSQL', () => {
  const tenant = randomUUID();
  const mandantId = randomUUID();
  const person = randomUUID();
  const a = kanzlei(person, mandantId, {
    tenantId: tenant,
    admin: true,
    bt: true,
    zustaendig: true,
  });
  const ids = {
    mitMassnahme: '',
    verworfen: '',
    bewertet: '',
    geklaert: '',
    neu: '',
    abgeschlossen: '',
    folge: '',
    spaet: '',
  };

  beforeAll(async () => {
    await mitTenant(tenant, async (tx) => {
      await tx.mandant.create({
        data: { id: mandantId, name: 'Rückblick GmbH', rechtsform: 'KapG' },
      });
      const programmId = (
        await tx.tcmsProgramm.create({
          data: { mandantId, paketId: 'ecommerce', paketVersion: '1.0' },
        })
      ).id;
      const audit = (aktion: string, objektTyp: string, objektId: string, detail = {}) =>
        schreibeAudit(tx, {
          actorId: person,
          actorName: 'Person',
          aktion,
          objektTyp,
          objektId,
          programmId,
          detail,
        });
      const feststellung = (nummer: string, daten: Record<string, unknown> = {}) =>
        tx.feststellung.create({
          data: {
            programmId,
            nummer,
            titel: `Feststellung ${nummer}`,
            sachverhalt: 'Sachverhalt',
            quelle: 'HINWEIS',
            quelleText: 'Test',
            klasse: 'STEUERLICHER_FEHLER',
            schwere: 'MITTEL',
            auswirkung: 'UNKLAR',
            erfasstVon: person,
            erfasstAm: tag('2026-10-01'),
            ...daten,
          },
        });
      // Zwei Audit-Tage für denselben Vorgang. Nur die Systemuhr für das
      // erste Test-Audit ersetzen, die Datenbankverbindung nutzt echte Timer.
      const geklaert = await feststellung('F-2026-004', {
        p153Entscheidung: 'KEINE_PFLICHT',
        p153EntschiedenAm: tag('2026-10-16'),
        p153EntschiedenVon: person,
        p153Begruendung: 'Belege vollständig',
        status: 'IN_WUERDIGUNG',
      });
      vi.useFakeTimers({ toFake: ['Date'], now: tag('2026-10-10') });
      try {
        await audit('tcms.feststellung.p153_entschieden', 'Feststellung', geklaert.id, {
          entscheidung: 'WEITERE_KLAERUNG',
          begruendung: 'Belege fehlen',
          frist: '2026-10-16',
          vorher: null,
        });
      } finally {
        vi.useRealTimers();
      }
      await audit('tcms.feststellung.p153_entschieden', 'Feststellung', geklaert.id, {
        entscheidung: 'KEINE_PFLICHT',
        vorher: 'WEITERE_KLAERUNG',
      });
      // Maßnahme erst nach dem Stichtag angelegt (offen, mit Frist).
      const f1 = await feststellung('F-2026-001', { status: 'MASSNAHMEN_OFFEN' });
      await tx.massnahme.create({
        data: {
          feststellungId: f1.id,
          wiedervorlageNr: 9001,
          beschreibung: 'Später angelegt',
          verantwortlich: person,
          frist: new Date('2026-11-30T00:00:00Z'),
          createdAt: tag('2026-10-16'),
        },
      });
      // Nach dem Stichtag verworfen: zum Stand in Würdigung, §-153 offen.
      const f2 = await feststellung('F-2026-002', {
        status: 'VERWORFEN',
        verwerfenBegruendung: 'Doppelt erfasst, siehe F-2026-001 (Begründung)',
        verwerfenBeantragtVon: person,
        verwerfenBestaetigtVon: randomUUID(),
      });
      await audit('tcms.feststellung.verwerfen_bestaetigt', 'Feststellung', f2.id, {
        von: 'IN_WUERDIGUNG',
        nach: 'VERWORFEN',
      });
      const bewertet = await feststellung('F-2026-003', {
        schwere: 'GERING',
        auswirkung: 'NEIN',
        ursache: 'Entkräftet',
      });
      await audit('tcms.feststellung.wuerdigung', 'Feststellung', bewertet.id, {
        vorher: { schwere: 'HOCH', auswirkung: 'UNKLAR', ursache: 'Prüfung offen' },
        nachher: { schwere: 'GERING', auswirkung: 'NEIN', ursache: 'Entkräftet' },
      });
      for (const [feststellungId, land] of [
        [bewertet.id, 'FR'],
        [f2.id, 'FR'],
        [bewertet.id, 'AT'],
      ] as const) {
        const x = await tx.betroffeneErklaerung.create({
          data: { feststellungId, land, steuerart: 'USt', zeitraum: '2026' },
        });
        if (land === 'AT')
          await audit('tcms.feststellung.erklaerung', 'Feststellung', feststellungId, {
            erklaerungId: x.id,
          });
      }
      const ereignis = (nummer: string, daten: Record<string, unknown>) =>
        tx.ereignis.create({
          data: {
            programmId,
            nummer,
            typ: 'Sonstiges',
            titel: `Ereignis ${nummer}`,
            beschreibung: 'Beschreibung',
            quelle: 'MANUELL',
            gemeldetAm: tag('2026-10-01'),
            ereignisDatum: new Date('2026-10-01T00:00:00Z'),
            ...daten,
          },
        });
      // Erst nach dem Stichtag triagiert und verworfen: zum Stand neu, ohne Triage und Antrag.
      const e1 = await ereignis('2026-T-9001', {
        status: 'VERWORFEN',
        triagiertVon: person,
        triagiertAm: tag('2026-10-16'),
        verwerfenBegruendung: 'Kein Bezug zum Tax-CMS (Begründung)',
        verwerfenBeantragtVon: person,
      });
      await audit('tcms.ereignis.verwerfen_beantragt', 'Ereignis', e1.id, {
        begruendung: 'Kein Bezug zum Tax-CMS (Begründung)',
      });
      await audit('tcms.ereignis.verwerfen_bestaetigt', 'Ereignis', e1.id);
      // Vor dem Stichtag triagiert, danach abgeschlossen: zum Stand in Triage; die Folge
      // wurde erst danach angelegt und erledigt, eine zweite erst danach hinzugefügt.
      const e2 = await ereignis('2026-T-9002', {
        status: 'ERLEDIGT',
        triagiertVon: person,
        triagiertAm: tag('2026-10-02'),
      });
      const folge = await tx.ereignisFolge.create({
        data: {
          ereignisId: e2.id,
          art: 'HINWEIS',
          ziel: 'EC-UST-01',
          text: 'Hinweis',
          status: 'ERLEDIGT',
          objektId: randomUUID(),
          erledigtAm: tag('2026-10-16'),
        },
      });
      const spaet = await tx.ereignisFolge.create({
        data: { ereignisId: e2.id, art: 'HINWEIS', text: 'Später', status: 'VERWORFEN' },
      });
      await audit('tcms.ereignis.folge_angelegt', 'EreignisFolge', folge.id);
      await audit('tcms.ereignis.folge_hinzugefuegt', 'EreignisFolge', spaet.id);
      await audit('tcms.ereignis.abgeschlossen', 'Ereignis', e2.id);
      Object.assign(ids, {
        mitMassnahme: f1.id,
        verworfen: f2.id,
        bewertet: bewertet.id,
        geklaert: geklaert.id,
        neu: e1.id,
        abgeschlossen: e2.id,
        folge: folge.id,
        spaet: spaet.id,
      });
    });
  });

  const kontext = (stand?: string) =>
    im(a, (ctx) => ladeKontext(ctx, { mandantId, ...(stand ? { stand } : {}) }));
  const lesbar = (liste: { id: string }[], id: string) =>
    liste.find((f) => f.id === id) as FeststellungView;

  it('behält eine frühere §-153-Klärung in Liste, Detail und Kontext nach einer Folgeentscheidung', async () => {
    const erwartung = {
      entscheidung: 'WEITERE_KLAERUNG',
      begruendung: 'Belege fehlen',
      frist: '2026-10-16',
      von: person,
      am: tag('2026-10-10').toISOString(),
    };
    const liste = await im(a, (ctx) => ladeFeststellungen(ctx, { mandantId, stand: STAND }));
    expect(liste.feststellungen.find((f) => f.id === ids.geklaert)).toMatchObject({
      p153: erwartung,
      p153Offen: true,
    });
    const detail = await im(a, (ctx) =>
      ladeFeststellung(ctx, { mandantId, feststellungId: ids.geklaert, stand: STAND }),
    );
    expect(detail).toMatchObject({ p153: erwartung });
    expect(lesbar((await kontext(STAND)).feststellungen, ids.geklaert)).toMatchObject({
      p153Entscheidung: 'WEITERE_KLAERUNG',
      p153Offen: true,
    });
    expect(lesbar((await kontext()).feststellungen, ids.geklaert)).toMatchObject({
      p153Entscheidung: 'KEINE_PFLICHT',
      p153Offen: false,
    });
  });

  it('hält die frühere Würdigung und den damaligen Länderbezug in Kontext, Liste, Detail und Länder-Monitor fest', async () => {
    const f = { schwere: 'HOCH', auswirkung: 'UNKLAR', p153Offen: true };
    expect(lesbar((await kontext(STAND)).feststellungen, ids.bewertet)).toMatchObject(f);
    const liste = await im(a, (ctx) => ladeFeststellungen(ctx, { mandantId, stand: STAND }));
    expect(liste.feststellungen.find((x) => x.id === ids.bewertet)).toMatchObject(f);
    const detail = await im(a, (ctx) =>
      ladeFeststellung(ctx, { mandantId, feststellungId: ids.bewertet, stand: STAND }),
    );
    expect(detail).toMatchObject({
      schwere: 'HOCH',
      auswirkung: 'UNKLAR',
      ursache: 'Prüfung offen',
      erklaerungen: [{ land: 'FR' }],
    });
    const laender = await im(a, (ctx) => ladeLaender(ctx, { mandantId, stand: STAND }));
    expect(laender.feststellungen).toEqual([
      {
        land: 'FR',
        eintraege: [
          expect.objectContaining({ id: ids.bewertet, p153Offen: true }),
          expect.objectContaining({ id: ids.verworfen, status: 'IN_WUERDIGUNG', p153Offen: true }),
        ],
      },
    ]);
    const heute = await im(a, (ctx) => ladeLaender(ctx, { mandantId }));
    expect(heute.feststellungen.map((l) => l.land).sort()).toEqual(['AT', 'FR']);
    expect(lesbar((await kontext()).feststellungen, ids.bewertet)).toMatchObject({
      schwere: 'GERING',
      auswirkung: 'NEIN',
      p153Offen: false,
    });
  });

  it('Maßnahmen: später angelegte fehlen in Kontext und Liste, auch in den Kennzahlen', async () => {
    const k = await kontext(STAND);
    expect(k.historisch).toBe(true);
    expect(lesbar(k.feststellungen, ids.mitMassnahme)).toMatchObject({
      massnahmen: 0,
      massnahmenOffen: 0,
      aeltesteFrist: null,
    });
    const liste = await im(a, (ctx) => ladeFeststellungen(ctx, { mandantId, stand: STAND }));
    const f = liste.feststellungen.find((x) => x.id === ids.mitMassnahme) as Extract<
      FeststellungListenEintrag,
      { maskiert: false }
    >;
    expect(f).toMatchObject({
      massnahmen: [],
      massnahmenGesamt: 0,
      massnahmenOffen: 0,
      aeltesteFrist: null,
    });
    // Heute: die Maßnahme zählt.
    expect(lesbar((await kontext()).feststellungen, ids.mitMassnahme)).toMatchObject({
      massnahmen: 1,
      massnahmenOffen: 1,
    });
  });

  it('Feststellung nach dem Stichtag verworfen: zum Stand in Würdigung, §-153 offen', async () => {
    const k = await kontext(STAND);
    expect(lesbar(k.feststellungen, ids.verworfen)).toMatchObject({
      status: 'IN_WUERDIGUNG',
      p153Offen: true,
    });
    const liste = await im(a, (ctx) => ladeFeststellungen(ctx, { mandantId, stand: STAND }));
    expect(liste.feststellungen.find((x) => x.id === ids.verworfen)).toMatchObject({
      status: 'IN_WUERDIGUNG',
      p153Offen: true,
    });
    expect(lesbar((await kontext()).feststellungen, ids.verworfen)).toMatchObject({
      status: 'VERWORFEN',
      p153Offen: false,
    });
  });

  it('Ereignisse und Folgen: Kontext und Liste rechnen gleich zurück', async () => {
    const k = await kontext(STAND);
    const neu = k.ereignisse.find((e) => e.id === ids.neu)!;
    expect(neu).toMatchObject({
      status: 'NEU',
      triagiertVon: null,
      triagiertAm: null,
      verwerfenBegruendung: null,
    });
    const zu = k.ereignisse.find((e) => e.id === ids.abgeschlossen)!;
    expect(zu.status).toBe('IN_TRIAGE');
    expect(zu.folgen.map((f) => [f.id, f.status, f.objektId])).toEqual([
      [ids.folge, 'VORGESCHLAGEN', null],
    ]);
    const liste = await im(a, (ctx) => ladeEreignisse(ctx, { mandantId, stand: STAND }));
    expect(liste.ereignisse.find((e) => e.id === ids.neu)).toMatchObject({
      status: 'NEU',
      triagiertVon: null,
      triagiertAm: null,
      verwerfenBeantragt: false,
    });
    const l2 = liste.ereignisse.find((e) => e.id === ids.abgeschlossen)!;
    expect(l2.status).toBe('IN_TRIAGE');
    expect(l2.folgen.map((f) => [f.id, f.status, f.objektId])).toEqual([
      [ids.folge, 'VORGESCHLAGEN', null],
    ]);
    // Heute: der gespeicherte Zustand.
    const heute = await kontext();
    expect(heute.ereignisse.find((e) => e.id === ids.neu)?.status).toBe('VERWORFEN');
    expect(heute.ereignisse.find((e) => e.id === ids.abgeschlossen)?.folgen).toHaveLength(2);
  });

  it('im aktuellen Stand keine Abfrage des Audits für die Rückrechnung', async () => {
    let audit = 0;
    await im(a, (ctx) => {
      const tx = new Proxy(ctx.tx, {
        get(ziel, name, empfaenger) {
          if (name === 'auditEvent') audit++;
          return Reflect.get(ziel, name, empfaenger) as unknown;
        },
      }) as Tx;
      return ladeKontext({ ...ctx, tx }, { mandantId });
    });
    expect(audit).toBe(0);
  });
});
