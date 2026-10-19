// =============================================================================
// RED TEAM RT-01 — Angreifermodell C (legitim angemeldete Kanzleiperson ohne
// Beteiligung an einer vertraulichen Feststellung).
//
// Der dedizierte Lesepfad (`ladeFeststellungen`/`ladeFeststellung`) maskiert
// vertrauliche Feststellungen für Nicht-Beteiligte vollständig (nur Nummer,
// Status, Wiedervorlagen – README „maskiert: true, Nummer und Status").
//
// Der Mandantenkontext (`GET /v1/mandanten/:id/kontext`, `leseKontext`)
// maskiert dagegen nur Titel, Sachverhalt, Quelltext, Risikocodes und
// Beteiligte (VERTRAULICH_MASKE in kern/tcms-kontext.ts). Steuerlich sensible
// Felder derselben vertraulichen Feststellung – insbesondere die §-153-
// Würdigungsentscheidung, die steuerliche Auswirkung (JA/NEIN/UNKLAR), die
// Schwere, die Feststellungsklasse und die Maßnahmen-Zähler – bleiben für
// Nicht-Beteiligte sichtbar.
//
// Dieser Test belegt den Leak. Er schlägt fehl, solange `leseKontext` die
// §-153-Entscheidung einer vertraulichen Feststellung an Nicht-Beteiligte
// ausliefert; nach einem Fix (gleiche Maskierung wie der dedizierte Lesepfad)
// wird er grün.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import { leseKontext } from '../../bereiche/lesepfade/kontext';
import { ladeFeststellungen } from '../../bereiche/feststellungen-ereignisse/feststellungen-lesen';
import {
  akteure,
  baueWelt,
  im,
  neueFeststellung,
  type Welt,
} from '../../bereiche/feststellungen-ereignisse/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT-01 kontext maskiert vertrauliche Feststellungen unvollständig', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
  });

  it('Nicht-Beteiligte sehen die §-153-Würdigung und Steuerwirkung einer vertraulichen Feststellung im Kontext', async () => {
    // Vertrauliche Feststellung mit entschiedener §-153-Würdigung (UEBERGABE)
    // und möglicher Steuerwirkung. Erfasst von zbt, nicht vom leser.
    const f = await neueFeststellung(w, {
      vertraulich: true,
      titel: 'Selbstanzeige Geschäftsführer – streng vertraulich',
      auswirkung: 'JA',
      p153Entscheidung: 'UEBERGABE',
      status: 'IN_WUERDIGUNG',
      erfasstVon: w.p.zbt,
    });

    // A.leser: Kanzleiperson mit Bezug (kannLesen), aber Berufsträger ohne
    // Zuständigkeit, kein Admin, keine Hauptbearbeitung, nicht beteiligt
    // => kannVertraulichLesen == false.
    const k = await im(A.leser, (ctx) => leseKontext(ctx, { mandantId: w.mandant }));
    const eintrag = k.feststellungen.find((x) => x.id === f.id);
    expect(eintrag, 'vertrauliche Feststellung erscheint im Kontext').toBeDefined();

    // Teilmaskierung ist aktiv (Titel ersetzt) – das belegt, dass der leser
    // als Nicht-Beteiligter gilt.
    expect(eintrag!.titel).toBe('Vertrauliche Feststellung');

    // Gegenprobe: der dedizierte Lesepfad maskiert dieselbe Feststellung für
    // denselben Akteur vollständig (keine Würdigung, keine Steuerwirkung).
    const liste = await im(A.leser, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
    const maskiert = liste.feststellungen.find((x) => x.id === f.id);
    expect(maskiert).toMatchObject({ maskiert: true });
    expect(maskiert as Record<string, unknown>).not.toHaveProperty('p153');
    expect(maskiert as Record<string, unknown>).not.toHaveProperty('auswirkung');

    // SICHERE ERWARTUNG: Auch der Kontext darf einem Nicht-Beteiligten weder die
    // §-153-Würdigungsentscheidung noch die steuerliche Auswirkung einer
    // vertraulichen Feststellung verraten.
    expect(
      eintrag!.p153Entscheidung,
      'Leak: §-153-Entscheidung einer vertraulichen Feststellung an Nicht-Beteiligte',
    ).toBeNull();
    expect(
      eintrag!.auswirkung,
      'Leak: steuerliche Auswirkung einer vertraulichen Feststellung an Nicht-Beteiligte',
    ).not.toBe('JA');
  });
});
