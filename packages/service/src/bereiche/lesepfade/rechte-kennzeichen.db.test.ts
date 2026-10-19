// =============================================================================
// Rechte-Kennzeichen für die Oberfläche (Stufe 5) gegen PostgreSQL
// (DB_TESTS=1): `rechte.bearbeiten` in `GET …/kontakte` und
// `mandant.rechte.bearbeiten` im Kontext stimmen für jede Rolle mit dem
// tatsächlichen Recht der Schreiboperationen überein – Anker setzen
// (`PUT /v1/mandanten/:id`) und Kontaktrollen setzen (`PUT …/kontakte`).
// Geschrieben wird jeweils der unveränderte Stand (keine Änderung, kein
// Audit), damit nur das Recht entscheidet. Im historischen Stand ist das
// Kennzeichen im Kontext immer `false` (AGENTS.md Regel 6).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DienstFehler, type Akteur } from '@tcms/contract';
import { ladeKontakte, setzeKontaktRollen } from './kontakte';
import { leseKontext } from './kontext';
import { setzeMandantAnker } from './mandant';
import { im, kanzlei, kontakt } from './testhilfen';

const AKTIV = process.env['DB_TESTS'] === '1';

type Ergebnis = { ok: true; wert: unknown } | { ok: false; code: string };

async function ergebnis(p: Promise<unknown>): Promise<Ergebnis> {
  try {
    return { ok: true, wert: await p };
  } catch (e) {
    if (e instanceof DienstFehler) return { ok: false, code: e.code };
    throw e;
  }
}

describe.skipIf(!AKTIV)('Rechte-Kennzeichen = tatsächliches Recht (Anker, Kontaktrollen)', () => {
  const tenant = randomUUID();
  const mandant = randomUUID();
  const andererMandant = randomUUID();
  const kontaktId = randomUUID();
  const ANKER = { name: 'Kennzeichen GmbH', rechtsform: 'KapG', datevNr: '4711' } as const;
  const k = (p: Parameters<typeof kanzlei>[2], m: string | null = mandant) =>
    kanzlei(randomUUID(), m, { tenantId: tenant, ...p });
  const admin = k({ admin: true, bt: true });

  /** Akteur → erwartetes Recht: true, false (403) oder null (404, nicht sichtbar). */
  const FAELLE: [string, Akteur, boolean | null][] = [
    ['Admin/Partner (BT)', admin, true],
    ['Admin/Partner ohne BT', k({ admin: true }), true],
    ['zuständige Berufsträgerin', k({ bt: true, zustaendig: true }), true],
    ['Hauptbearbeitung', k({ hb: true }), true],
    ['Berufsträger ohne Zuständigkeit', k({ bt: true }), false],
    ['Kanzleiperson ohne Zuständigkeit', k({}), false],
    ['Admin mit Bezug auf anderen Mandanten', k({ admin: true, bt: true }, andererMandant), null],
    ['Admin ohne Bezug', k({ admin: true, bt: true }, null), null],
    ['Mandantenkontakt (GV)', kontakt(kontaktId, mandant, tenant), null],
  ];

  beforeAll(async () => {
    await im(admin, (ctx) => setzeMandantAnker(ctx, { mandantId: mandant, ...ANKER }));
    await im(admin, (ctx) =>
      setzeKontaktRollen(ctx, {
        mandantId: mandant,
        kontaktId,
        rollen: ['GESETZLICHER_VERTRETER'],
        funktion: null,
      }),
    );
  });

  for (const [name, a, erwartet] of FAELLE) {
    it(`${name}: Kennzeichen und Schreibrecht stimmen überein (erwartet ${String(erwartet)})`, async () => {
      const kontakte = await ergebnis(im(a, (ctx) => ladeKontakte(ctx, { mandantId: mandant })));
      const kontext = await ergebnis(im(a, (ctx) => leseKontext(ctx, { mandantId: mandant })));
      const anker = await ergebnis(
        im(a, (ctx) => setzeMandantAnker(ctx, { mandantId: mandant, ...ANKER })),
      );
      const rollen = await ergebnis(
        im(a, (ctx) =>
          setzeKontaktRollen(ctx, {
            mandantId: mandant,
            kontaktId,
            rollen: ['GESETZLICHER_VERTRETER'],
            funktion: null,
          }),
        ),
      );
      if (erwartet === null) {
        for (const e of [kontakte, kontext, anker, rollen]) {
          expect(e).toEqual({ ok: false, code: 'NICHT_GEFUNDEN' });
        }
        return;
      }
      // Tatsächliches Recht: beide Schreiboperationen gleich, wie erwartet.
      const recht = (e: Ergebnis) => (e.ok ? true : e.code === 'NICHT_BERECHTIGT' ? false : e.code);
      expect([recht(anker), recht(rollen)]).toEqual([erwartet, erwartet]);
      if (anker.ok) expect(anker.wert).toMatchObject({ geaendert: false });
      if (rollen.ok) expect(rollen.wert).toMatchObject({ geaendert: false });
      // Kennzeichen = tatsächliches Recht.
      expect(kontakte).toMatchObject({ ok: true, wert: { rechte: { bearbeiten: erwartet } } });
      expect(kontext).toMatchObject({
        ok: true,
        wert: { historisch: false, mandant: { rechte: { bearbeiten: erwartet } } },
      });
    });
  }

  it('historischer Stand: Kennzeichen im Kontext immer false, auch bei Schreibrecht', async () => {
    for (const [name, a, erwartet] of FAELLE) {
      if (erwartet === null) continue;
      const alt = await im(a, (ctx) =>
        leseKontext(ctx, { mandantId: mandant, stand: '2026-10-01' }),
      );
      expect(alt.historisch, name).toBe(true);
      expect(alt.mandant.rechte, name).toEqual({ bearbeiten: false });
      expect(alt.rechte, name).toEqual({ bearbeiten: false, wuerdigen: false });
    }
  });

  it('fremder Tenant: Kontakte und Kontext nicht gefunden', async () => {
    const fremd = kanzlei(randomUUID(), mandant, { tenantId: randomUUID(), admin: true, bt: true });
    expect(await ergebnis(im(fremd, (ctx) => ladeKontakte(ctx, { mandantId: mandant })))).toEqual({
      ok: false,
      code: 'NICHT_GEFUNDEN',
    });
    expect(await ergebnis(im(fremd, (ctx) => leseKontext(ctx, { mandantId: mandant })))).toEqual({
      ok: false,
      code: 'NICHT_GEFUNDEN',
    });
  });
});
