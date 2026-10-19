// Kontext als Antwort des Dienstes gegen PostgreSQL (DB_TESTS=1, Demo-Seed):
// strenger Vertrag, Rechte-Kennzeichen, kein Zugriff für Mandantenkontakte,
// Maskierung inklusive Beteiligter.

import { describe, expect, it } from 'vitest';
import { KontextAntwortSchema, type KontextEingabe } from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { leseKontext } from './kontext';
import { fehlerVon, im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';
const anna = kanzlei(DEMO_IDS.anna, DEMO_IDS.talwind, { admin: true, bt: true, zustaendig: true });
const thomas = kanzlei(DEMO_IDS.thomas, DEMO_IDS.talwind, { bt: true });
const leon = kanzlei(DEMO_IDS.leon, DEMO_IDS.talwind, { hb: true });

describe.skipIf(!AKTIV)('leseKontext gegen PostgreSQL', () => {
  it('liefert eine streng vertragsgemäße, JSON-serialisierbare Antwort', async () => {
    const a = await im(anna, (ctx) => leseKontext(ctx, { mandantId: DEMO_IDS.talwind }));
    expect(KontextAntwortSchema.parse(a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a.heute).toBe('2026-10-16');
    expect(a.risiken.length).toBeGreaterThan(0);
    expect(a.durchfuehrungen[0]?.faelligAm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Keine internen Felder: keine Namen, keine Zuständigkeit der Kanzlei.
    expect(a).not.toHaveProperty('namen');
    expect(a.mandant).not.toHaveProperty('berufstraegerId');
  });

  it('Rechte-Kennzeichen kommen aus dem Akteur; historisch nie schreibbar', async () => {
    const r = async (a: typeof anna, stand?: string) =>
      (
        await im(a, (ctx) =>
          leseKontext(ctx, { mandantId: DEMO_IDS.talwind, ...(stand ? { stand } : {}) }),
        )
      ).rechte;
    expect(await r(anna)).toEqual({ bearbeiten: true, wuerdigen: true });
    expect(await r(leon)).toEqual({ bearbeiten: true, wuerdigen: false });
    expect(await r(thomas)).toEqual({ bearbeiten: false, wuerdigen: false });
    expect(await r(anna, '2026-03-31')).toEqual({ bearbeiten: false, wuerdigen: false });
  });

  it('Mandantenkontakte erhalten den Kanzlei-Kontext nie (auch mit aktiver Rolle)', async () => {
    const f = await fehlerVon(
      im(kontakt(DEMO_IDS.jana, DEMO_IDS.talwind), (ctx) =>
        leseKontext(ctx, { mandantId: DEMO_IDS.talwind }),
      ),
    );
    expect(f.code).toBe('NICHT_GEFUNDEN');
  });

  it('fremder Mandant und ungültige Eingabe', async () => {
    const fremd = await fehlerVon(
      im(anna, (ctx) => leseKontext(ctx, { mandantId: DEMO_IDS.seestern })),
    );
    expect(fremd.code).toBe('NICHT_GEFUNDEN');
    const falsch = await fehlerVon(
      im(anna, (ctx) =>
        leseKontext(ctx, { mandantId: DEMO_IDS.talwind, x: 1 } as unknown as KontextEingabe),
      ),
    );
    expect(falsch.code).toBe('UNGUELTIG');
  });

  it('vertraulich: nur Nummer, Status und Erfassung wie der dedizierte Lesepfad (RT-01)', async () => {
    const f = await mitTenant(DEMO_TENANT_ID, async (tx) => {
      // Eine Feststellung aus dem Seed (Nummernkreis 2026, erfasst vor dem Demo-Tag), damit
      // Daten anderer Testläufe auf derselben Datenbank die Auswahl nicht verschieben: Die
      // Web-Tests erfassen mit der Demo-Uhr am Demo-Tag selbst (z. B. „Lager ohne
      // Registrierung“, Teil eines Katalogtitels – die Prüfung unten schlüge dann fehl).
      const x = await tx.feststellung.findFirstOrThrow({
        where: {
          programm: { mandantId: DEMO_IDS.talwind },
          erfasstVon: { not: DEMO_IDS.thomas },
          nummer: { startsWith: 'F-2026-' },
          erfasstAm: { lt: new Date('2026-10-16T00:00:00Z') },
        },
        include: { massnahmen: { select: { verantwortlich: true } } },
        orderBy: { nummer: 'desc' },
      });
      await tx.feststellung.update({ where: { id: x.id }, data: { vertraulich: true } });
      return x;
    });
    try {
      expect([
        f.p153EntschiedenVon,
        f.verwerfenBeantragtVon,
        ...f.massnahmen.map((m) => m.verantwortlich),
      ]).not.toContain(DEMO_IDS.thomas);
      const a = await im(thomas, (ctx) => leseKontext(ctx, { mandantId: DEMO_IDS.talwind }));
      const m = a.feststellungen.find((x) => x.id === f.id)!;
      expect(m).toEqual({
        maskiert: true,
        id: f.id,
        nummer: f.nummer,
        vertraulich: true,
        status: f.status,
        erfasstAm: f.erfasstAm.toISOString(),
      });
      expect(JSON.stringify(a)).not.toContain(f.titel);
      const sichtbar = await im(anna, (ctx) => leseKontext(ctx, { mandantId: DEMO_IDS.talwind }));
      expect(sichtbar.feststellungen.find((x) => x.id === f.id)).toMatchObject({
        maskiert: false,
        titel: f.titel,
      });
    } finally {
      await mitTenant(DEMO_TENANT_ID, (tx) =>
        tx.feststellung.update({ where: { id: f.id }, data: { vertraulich: false } }),
      );
    }
  });
});
