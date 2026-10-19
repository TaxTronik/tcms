// =============================================================================
// Portfolio und Arbeitskorb gegen PostgreSQL (DB_TESTS=1, Demo-Seed): nur die
// bestätigte Liste, Zuständigkeit nur aus der Liste, nur Kanzleipersonen,
// fremde Tenants unsichtbar, strenge Eingaben, Vertrag der Antwort.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArbeitskorbAntwortSchema,
  MAX_MANDANTEN_JE_ANFRAGE,
  PortfolioAntwortSchema,
  type MandantenListe,
} from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { DEMO_IDS, DEMO_MANDANTEN, DEMO_TENANT_ID } from '@tcms/db/demo';
import { ladeArbeitskorb } from './arbeitskorb';
import { ladePortfolio } from './portfolio';
import { fehlerVon, im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const ALLE = DEMO_MANDANTEN.map((m) => m.id);
const anna = kanzlei(DEMO_IDS.anna, null, { admin: true, bt: true });
const leon = kanzlei(DEMO_IDS.leon, null);
const thomas = kanzlei(DEMO_IDS.thomas, null, { bt: true });

/** Liste wie von der kanzleikonsole: Zuständigkeit laut Demo-Verzeichnis. */
const liste = (person: string, ids: readonly string[] = ALLE): MandantenListe => ({
  mandantIds: [...ids],
  bt: DEMO_MANDANTEN.filter((m) => ids.includes(m.id) && m.berufstraegerId === person).map(
    (m) => m.id,
  ),
  hb: DEMO_MANDANTEN.filter((m) => ids.includes(m.id) && m.bearbeitungId === person).map(
    (m) => m.id,
  ),
});

describe.skipIf(!AKTIV)('Portfolio und Arbeitskorb gegen PostgreSQL', () => {
  const tenantB = randomUUID();
  const mandantB = randomUUID();

  beforeAll(async () => {
    await mitTenant(tenantB, (tx) =>
      tx.mandant.create({ data: { id: mandantB, name: 'Fremd GmbH', rechtsform: 'KapG' } }),
    );
  });
  afterAll(async () => undefined);

  describe('Portfolio', () => {
    it('liefert je bestätigtem Mandanten eine vertragsgemäße Zeile', async () => {
      const p = await im(anna, (ctx) => ladePortfolio(ctx, liste(DEMO_IDS.anna)));
      expect(PortfolioAntwortSchema.parse(p)).toEqual(p);
      expect(p.heute).toBe('2026-10-16');
      expect(p.zeilen.map((z) => z.mandant.id).sort()).toEqual([...ALLE].sort());
      expect(p.zeilen.filter((z) => z.hatProgramm)).toHaveLength(4);
      // Sortierung: mit Programm vor ohne.
      expect(p.zeilen.at(-1)!.hatProgramm).toBe(false);
      expect(p.zeilen.every((z) => z.darfBearbeiten)).toBe(true); // Admin
    });

    it('lädt nur Mandanten der Liste; fremde Tenants und Unbekannte entfallen ohne Hinweis', async () => {
      const p = await im(anna, (ctx) =>
        ladePortfolio(ctx, { mandantIds: [DEMO_IDS.talwind, mandantB, randomUUID()] }),
      );
      expect(p.zeilen.map((z) => z.mandant.id)).toEqual([DEMO_IDS.talwind]);
      // Akteur eines anderen Tenants mit den Demo-IDs sieht nichts (RLS).
      const fremd = await im(
        kanzlei(randomUUID(), null, { tenantId: tenantB, admin: true }),
        (ctx) => ladePortfolio(ctx, { mandantIds: ALLE }),
      );
      expect(fremd.zeilen).toEqual([]);
    });

    it('Zuständigkeit nur aus der Liste: ohne bt/hb kein Bearbeitungsrecht', async () => {
      const ohne = await im(thomas, (ctx) =>
        ladePortfolio(ctx, { mandantIds: [DEMO_IDS.seestern, DEMO_IDS.talwind] }),
      );
      expect(ohne.zeilen.every((z) => !z.darfBearbeiten)).toBe(true);
      const mit = await im(thomas, (ctx) =>
        ladePortfolio(ctx, liste(DEMO_IDS.thomas, [DEMO_IDS.seestern, DEMO_IDS.talwind])),
      );
      const recht = Object.fromEntries(mit.zeilen.map((z) => [z.mandant.id, z.darfBearbeiten]));
      expect(recht).toEqual({ [DEMO_IDS.seestern]: true, [DEMO_IDS.talwind]: false });
    });

    it('nur Kanzleipersonen; ein bestätigter Bezug (cli) erweitert die Liste nie', async () => {
      const f = await fehlerVon(
        im(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), (ctx) =>
          ladePortfolio(ctx, { mandantIds: [DEMO_IDS.talwind] }),
        ),
      );
      expect(f.code).toBe('NICHT_BERECHTIGT');
      const mitCli = kanzlei(DEMO_IDS.anna, DEMO_IDS.talwind, { admin: true, zustaendig: true });
      const p = await im(mitCli, (ctx) => ladePortfolio(ctx, { mandantIds: [DEMO_IDS.seestern] }));
      expect(p.zeilen.map((z) => z.mandant.id)).toEqual([DEMO_IDS.seestern]);
    });

    it('ungültige Listen: doppelt, fremde bt/hb, zu viele', async () => {
      const ungueltig: unknown[] = [
        { mandantIds: [DEMO_IDS.talwind, DEMO_IDS.talwind] },
        { mandantIds: [DEMO_IDS.talwind, DEMO_IDS.talwind.toUpperCase()] },
        { mandantIds: [DEMO_IDS.talwind], bt: [DEMO_IDS.seestern] },
        { mandantIds: [DEMO_IDS.talwind], hb: [DEMO_IDS.talwind, DEMO_IDS.talwind] },
        { mandantIds: Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE + 1 }, () => randomUUID()) },
        { mandantIds: ['kein-uuid'] },
        { mandantIds: [], extra: true },
      ];
      for (const e of ungueltig) {
        const f = await fehlerVon(im(anna, (ctx) => ladePortfolio(ctx, e as MandantenListe)));
        expect(f.code).toBe('UNGUELTIG');
      }
    });
  });

  describe('Arbeitskorb', () => {
    it('liefert eine vertragsgemäße Antwort nur aus Mandanten der Liste', async () => {
      const k = await im(leon, (ctx) => ladeArbeitskorb(ctx, liste(DEMO_IDS.leon)));
      expect(ArbeitskorbAntwortSchema.parse(k)).toEqual(k);
      expect(k.mandantenZustaendig).toBe(4); // Hauptbearbeitung überall, Bergkamm ohne Programm
      const nur = await im(leon, (ctx) =>
        ladeArbeitskorb(ctx, liste(DEMO_IDS.leon, [DEMO_IDS.seestern])),
      );
      const mandanten = new Set(
        [
          ...nur.durchfuehrungen,
          ...nur.gegenzeichnungen,
          ...nur.vierAugen,
          ...nur.p153,
          ...nur.ereignisse,
          ...nur.beschreibungen,
        ].map((x) => x.mandant.id),
      );
      expect([...mandanten].every((id) => id === DEMO_IDS.seestern)).toBe(true);
    });

    it('Zuständigkeit nur aus der Liste: ohne hb keine Ereignisse und Vier-Augen-Aufgaben', async () => {
      const mit = await im(leon, (ctx) => ladeArbeitskorb(ctx, liste(DEMO_IDS.leon)));
      const ohne = await im(leon, (ctx) => ladeArbeitskorb(ctx, { mandantIds: ALLE }));
      expect(mit.ereignisse.length + mit.vierAugen.length).toBeGreaterThan(0);
      expect(ohne.ereignisse).toEqual([]);
      expect(ohne.vierAugen).toEqual([]);
      expect(ohne.mandantenZustaendig).toBe(0);
    });

    it('Vier-Augen: Übersteuerung erscheint bei der zweiten zuständigen Person, nie beim Antragsteller', async () => {
      const u = await mitTenant(DEMO_TENANT_ID, async (tx) => {
        const r = await tx.risiko.findFirstOrThrow({
          where: { programm: { mandantId: DEMO_IDS.talwind }, entscheidung: 'UEBERNOMMEN' },
          orderBy: { code: 'asc' },
        });
        return tx.uebersteuerung.create({
          data: {
            risikoId: r.id,
            sicht: 'DESIGN',
            klasse: 'GERING',
            berechnet: 'MITTEL',
            begruendung: 'Begründung der Übersteuerung mit ausreichender Länge',
            beantragtVon: DEMO_IDS.anna,
            beantragtAm: new Date('2026-10-15T10:00:00Z'),
          },
        });
      });
      try {
        const leonKorb = await im(leon, (ctx) => ladeArbeitskorb(ctx, liste(DEMO_IDS.leon)));
        expect(leonKorb.vierAugen).toContainEqual(
          expect.objectContaining({
            art: 'UEBERSTEUERUNG',
            key: u.id,
            objektId: u.risikoId,
            beantragtVon: [DEMO_IDS.anna],
          }),
        );
        const annaKorb = await im(anna, (ctx) => ladeArbeitskorb(ctx, liste(DEMO_IDS.anna)));
        expect(annaKorb.vierAugen.find((v) => v.key === u.id)).toBeUndefined();
        // Ohne Zuständigkeit für Talwind (Liste ohne hb) keine Bestätigungsaufgabe.
        const ohne = await im(leon, (ctx) =>
          ladeArbeitskorb(ctx, { mandantIds: [DEMO_IDS.talwind] }),
        );
        expect(ohne.vierAugen.find((v) => v.key === u.id)).toBeUndefined();
      } finally {
        await mitTenant(DEMO_TENANT_ID, (tx) =>
          tx.uebersteuerung.update({ where: { id: u.id }, data: { status: 'AUFGEHOBEN' } }),
        );
      }
    });

    it('Vier-Augen: nie eigene Anträge', async () => {
      for (const person of [DEMO_IDS.anna, DEMO_IDS.leon, DEMO_IDS.thomas]) {
        const a = kanzlei(person, null, {
          admin: person === DEMO_IDS.anna,
          bt: person !== DEMO_IDS.leon,
        });
        const k = await im(a, (ctx) => ladeArbeitskorb(ctx, liste(person)));
        for (const v of k.vierAugen) expect(v.beantragtVon).not.toContain(person);
      }
    });

    it('Verwerfen vertraulicher Feststellungen ohne Titel und Begründung', async () => {
      const f = await mitTenant(DEMO_TENANT_ID, async (tx) => {
        const x = await tx.feststellung.findFirstOrThrow({
          where: { programm: { mandantId: DEMO_IDS.talwind }, status: { not: 'VERWORFEN' } },
          orderBy: { nummer: 'asc' },
        });
        await tx.feststellung.update({
          where: { id: x.id },
          data: {
            vertraulich: true,
            verwerfenBeantragtVon: DEMO_IDS.anna,
            verwerfenBegruendung: 'Geheime Begründung mit genügend Länge für den Antrag',
          },
        });
        return x;
      });
      try {
        const k = await im(leon, (ctx) => ladeArbeitskorb(ctx, liste(DEMO_IDS.leon)));
        const v = k.vierAugen.find((x) => x.art === 'VERWERFEN' && x.objektId === f.id)!;
        expect(v.titel).toBe(`${f.nummer} · vertrauliche Feststellung`);
        expect(v.begruendung).toBeNull();
        expect(JSON.stringify(k)).not.toContain('Geheime Begründung');
      } finally {
        await mitTenant(DEMO_TENANT_ID, (tx) =>
          tx.feststellung.update({
            where: { id: f.id },
            data: {
              vertraulich: f.vertraulich,
              verwerfenBeantragtVon: f.verwerfenBeantragtVon,
              verwerfenBegruendung: f.verwerfenBegruendung,
            },
          }),
        );
      }
    });

    it('nur Kanzleipersonen', async () => {
      const f = await fehlerVon(
        im(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), (ctx) =>
          ladeArbeitskorb(ctx, { mandantIds: [DEMO_IDS.talwind] }),
        ),
      );
      expect(f.code).toBe('NICHT_BERECHTIGT');
    });
  });
});
