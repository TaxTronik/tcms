// =============================================================================
// Zeitraumzahlen der Prüfungsvorbereitung im Tax-CMS-Kontext (DB_TESTS=1):
// Kontrollen ohne Durchführung im Wirksamkeitszeitraum (+ 60 Tage Nachlauf),
// Summe der Nachweise abgeschlossener Durchführungen, entfallene
// Durchführungen – Regeln wie bisher in der Demo-Seite „Prüfung", jetzt im
// Service. Eigener Tenant mit gezielt gebauten Durchführungen.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import { mitTenant, type Tx } from '@tcms/db';
import { verweisAblage } from '../ablage';
import { imDienst, keinPersonenVerzeichnis, type Uhr } from '../kontext';
import { ladeKontext } from './tcms-kontext';

const AKTIV = process.env['DB_TESTS'] === '1';
const UHR: Uhr = { jetzt: () => new Date('2026-10-16T10:00:00Z'), heute: () => '2026-10-16' };
const PORTS = { uhr: UHR, personen: keinPersonenVerzeichnis, ablage: verweisAblage };
const tag = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Turnus = 'KEIN' | 'MONATLICH';
type Status = 'GEPLANT' | 'OHNE_BEFUND' | 'MIT_BEFUND' | 'ENTFALLEN';

describe.skipIf(!AKTIV)('Zeitraumzahlen im Kontext (Service, PostgreSQL)', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const person = randomUUID();
  const akteur: Akteur = {
    art: 'KANZLEI',
    tenantId: tenant,
    id: person,
    name: 'Kanzleiperson',
    istAdmin: false,
    istBerufstraeger: true,
    mandant: { id: mandant, zustaendigBerufstraeger: true, hauptbearbeitung: false },
  };
  const lade = (stand?: string) =>
    imDienst(akteur, PORTS, (ctx) =>
      ladeKontext(ctx, { mandantId: mandant, ...(stand ? { stand } : {}) }),
    );

  beforeAll(async () => {
    await mitTenant(tenant, async (tx) => {
      await tx.mandant.create({ data: { id: mandant, name: 'Zeitraum GmbH', rechtsform: 'KapG' } });
      const p = await tx.tcmsProgramm.create({
        data: {
          mandantId: mandant,
          paketId: 'ecommerce',
          paketVersion: '1.0',
          status: 'AKTIV',
          erklaerungsTurnus: 'MONATLICH',
          wirksamAb: tag('2026-07-01'),
          wirksamBis: tag('2026-12-31'),
        },
      });
      const kontrolle = async (code: string, turnus: Turnus) => {
        const k = await tx.kontrolle.create({
          data: { programmId: p.id, code, aktivAb: tag('2026-01-01') },
        });
        const s = await tx.kontrolleStand.create({
          data: {
            kontrolleId: k.id,
            version: 1,
            titel: `Kontrolle ${code}`,
            ziel: 'Abgleich',
            art: 'D',
            ausfuehrung: 'M',
            vorlageTurnus: turnus,
            vorlageAnlass: turnus === 'KEIN',
            partei: 'KANZLEI',
            schluessel: false,
            nachweis: 'Liste',
            mindestNachweise: 1,
            schritte: [],
            kennzahlen: [],
            faelligNachTagen: 30,
            durchfuehrendId: person,
            vertretungId: randomUUID(),
            gueltigAb: tag('2026-01-01'),
          },
        });
        return { id: k.id, standId: s.id };
      };
      const durchfuehrung = async (
        k: { id: string; standId: string },
        faellig: string,
        status: Status,
        nachweise = 0,
        entfernt = 0,
      ) => {
        const d = await tx.durchfuehrung.create({
          data: {
            kontrolleId: k.id,
            kontrolleStandId: k.standId,
            periodeLabel: faellig,
            periodeVon: tag(faellig),
            periodeBis: tag(faellig),
            faelligAm: tag(faellig),
            status,
            createdAt: tag('2026-06-01'),
            ...(status === 'OHNE_BEFUND' || status === 'MIT_BEFUND'
              ? { eingereichtAm: tag(faellig), abgeschlossenAm: tag(faellig) }
              : {}),
            ...(status === 'ENTFALLEN' ? { entfallenAm: tag(faellig) } : {}),
          },
        });
        await legeNachweiseAn(tx, d.id, nachweise, false);
        await legeNachweiseAn(tx, d.id, entfernt, true);
      };
      // K-A: abgeschlossen (2 + 1 Nachweise, ein entfernter zählt nicht), entfallen,
      // geplant im Nachlauf, abgeschlossen außerhalb (zählt nicht).
      const a = await kontrolle('K-A', 'MONATLICH');
      await durchfuehrung(a, '2026-08-30', 'OHNE_BEFUND', 2, 1);
      await durchfuehrung(a, '2026-09-30', 'MIT_BEFUND', 1);
      await durchfuehrung(a, '2026-10-01', 'ENTFALLEN');
      await durchfuehrung(a, '2027-01-30', 'GEPLANT');
      await durchfuehrung(a, '2027-03-15', 'OHNE_BEFUND', 5);
      // K-B: nur eine entfallene Durchführung im Zeitraum → ohne Durchführung.
      await durchfuehrung(await kontrolle('K-B', 'MONATLICH'), '2026-09-15', 'ENTFALLEN');
      // K-C: ohne Turnus (nur bei Auslösung) → keine wiederkehrende Kontrolle.
      await kontrolle('K-C', 'KEIN');
      // K-D: nur geplant im Zeitraum → hat eine Durchführung.
      await durchfuehrung(await kontrolle('K-D', 'MONATLICH'), '2026-12-30', 'GEPLANT');
      // K-E: nur außerhalb (nach dem Nachlauf) → ohne Durchführung.
      await durchfuehrung(await kontrolle('K-E', 'MONATLICH'), '2027-05-01', 'GEPLANT');
      // K-F: Fälligkeit genau am letzten Tag des Nachlaufs (31.12. + 60 Tage) → zählt.
      await durchfuehrung(await kontrolle('K-F', 'MONATLICH'), '2027-03-01', 'GEPLANT');
    });
  });

  it('zählt Nachweise abgeschlossener und entfallene Durchführungen im Zeitraum', async () => {
    const k = await lade();
    expect(k.zeitraum).toMatchObject({ ohneBefund: 1, mitBefund: 1, nachweise: 3, entfallen: 2 });
  });

  it('nennt wiederkehrende Kontrollen ohne (auch geplante) Durchführung im Zeitraum + 60 Tage', async () => {
    const k = await lade();
    expect(k.kontrollen.find((x) => x.code === 'K-C')?.frequenz.turnus).toBe('KEIN');
    expect(k.zeitraum?.ohneDurchfuehrung).toEqual(['K-B', 'K-E']);
  });

  it('vor Beginn des Zeitraums: keine Lücke „ohne Durchführung" (n. a.)', async () => {
    const vorher = await lade('2026-06-15');
    expect(vorher.historisch).toBe(true);
    expect(vorher.zeitraum).not.toBeNull();
    expect(vorher.zeitraum?.ohneDurchfuehrung).toEqual([]);
    // Am ersten Tag des Zeitraums zählt die Lücke bereits; der Status gilt zum
    // Stand (die Durchführung von K-B entfiel erst später und war noch geplant).
    const erster = await lade('2026-07-01');
    expect(erster.zeitraum?.ohneDurchfuehrung).toEqual(['K-E']);
  });
});

async function legeNachweiseAn(tx: Tx, durchfuehrungId: string, n: number, entfernt: boolean) {
  for (let i = 0; i < n; i++) {
    await tx.nachweis.create({
      data: {
        durchfuehrungId,
        dokumentId: randomUUID(),
        dateiname: `Nachweis ${i}.pdf`,
        mime: 'application/pdf',
        groesse: 100,
        sha256: randomBytes(32).toString('hex'),
        hochgeladenVon: randomUUID(),
        ...(entfernt ? { entferntAm: tag('2026-09-01'), entferntVon: randomUUID() } : {}),
      },
    });
  }
}
