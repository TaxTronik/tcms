// Reine Tests der gemeinsamen Bausteine (ohne Datenbank).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DienstFehler, FeststellungWeiterSchema } from '@tcms/contract';
import { alsKonflikt, EINGABE_UNGUELTIG, pruefe } from './gemeinsam';

const WURZEL = fileURLToPath(new URL('../../../../../', import.meta.url));
/** Test- und Fixture-Dateien legen Testdaten direkt an; sie sind kein Anlagepfad. */
const TESTDATEI =
  /(\.test\.tsx?|testwelt\.ts|testfall\.ts|testhilfen?\.ts|testprogramm\.ts|fixture\.ts|testapp\.ts)$/;

function quelldateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((e) => {
    const pfad = join(ordner, e.name);
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name === '.next' ? [] : quelldateien(pfad);
    return /\.tsx?$/.test(e.name) && !TESTDATEI.test(e.name) ? [pfad] : [];
  });
}

describe('gemeinsame Bausteine', () => {
  it('Unique-Verletzung und Schreibkonflikt werden KONFLIKT, andere Fehler bleiben', () => {
    for (const code of ['P2002', 'P2034']) {
      const e = alsKonflikt(Object.assign(new Error('x'), { code }));
      expect(e).toBeInstanceOf(DienstFehler);
      expect((e as DienstFehler).code).toBe('KONFLIKT');
    }
    const anders = Object.assign(new Error('x'), { code: 'P2025' });
    expect(alsKonflikt(anders)).toBe(anders);
    const d = new DienstFehler('NICHT_GEFUNDEN');
    expect(alsKonflikt(d)).toBe(d);
    expect(alsKonflikt(null)).toBe(null);
  });

  it('pruefe: strikte Eingabe, Feldfehler ohne Eingabewerte', () => {
    const geheim = 'geheimer-wert-1234567890';
    try {
      pruefe(FeststellungWeiterSchema, {
        mandantId: geheim,
        feststellungId: 'x',
        von: 'ERFASST',
        unbekannt: geheim,
      });
      throw new Error('keine Ausnahme');
    } catch (e) {
      expect(e).toBeInstanceOf(DienstFehler);
      const f = e as DienstFehler;
      expect(f.code).toBe('UNGUELTIG');
      expect(f.message).toBe(EINGABE_UNGUELTIG);
      expect(Object.keys(f.felder ?? {})).toEqual(
        expect.arrayContaining(['mandantId', 'feststellungId']),
      );
      expect(JSON.stringify(f.felder)).not.toContain(geheim);
    }
  });

  it('genau ein Anlagepfad für Feststellungen: nur legeFeststellungAn legt an (TS-04, Nummern)', () => {
    const treffer = ['packages/service/src', 'apps/api/src', 'apps/web/src'].flatMap((o) =>
      quelldateien(join(WURZEL, o)).flatMap((datei) =>
        /\.feststellung\.(create|createMany|createManyAndReturn|upsert)\(/.test(
          readFileSync(datei, 'utf8'),
        )
          ? [relative(WURZEL, datei)]
          : [],
      ),
    );
    expect(treffer).toEqual([
      'packages/service/src/bereiche/feststellungen-ereignisse/gemeinsam.ts',
    ]);
  });
});
