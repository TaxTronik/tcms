// =============================================================================
// Keine parallelen Abfragen auf einer Transaktion (statisch): Jede Operation
// und jeder Lader läuft in genau einer interaktiven Transaktion (`ctx.tx`), und
// die hat genau eine Verbindung. Weder Prisma noch @prisma/adapter-pg
// serialisieren Abfragen darauf; pg reiht sie ein und warnt ab der dritten
// gleichzeitig wartenden Abfrage („Calling client.query() when the client is
// already executing a query is deprecated“, nicht im JSON-Log), und künftige
// pg-Versionen reihen nicht mehr ein. Schneller wird nichts. Deshalb nutzt der
// Laufzeitcode des Dienstes kein `Promise.all`/`allSettled`/`race`/`any`;
// Testhilfen, die gleichzeitige Transaktionen auf verschiedenen Verbindungen
// starten (TS-05), sind ausgenommen.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const VERZEICHNIS = 'packages/service/src';
const ENDUNGEN = /\.(?:[cm]?ts|tsx)$/;
const NIE = new Set(['node_modules', 'generated', 'dist']);
/** Tests und Testhilfen (testwelt, testfall, testhilfen, testprogramm …). */
const TEST = /(?:\.test\.[cm]?tsx?$)|(?:\/__tests__\/)|(?:\/test[a-z]*\.ts$)/;
const KOMBINATOREN = new Set(['all', 'allSettled', 'race', 'any']);

/** Zeilen mit `Promise.<Kombinator>(…)` (auch `globalThis.Promise…`, `Promise['all']`). */
export function parallelStellen(text: string, datei = 'x.ts'): number[] {
  const quelle = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  const zeilen: number[] = [];
  const istPromise = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === 'Promise') ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'Promise');
  const besuche = (n: ts.Node) => {
    let ziel: { objekt: ts.Expression; name: string } | null = null;
    if (ts.isPropertyAccessExpression(n)) ziel = { objekt: n.expression, name: n.name.text };
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      ziel = { objekt: n.expression, name: n.argumentExpression.text };
    }
    if (ziel && istPromise(ziel.objekt) && KOMBINATOREN.has(ziel.name)) {
      zeilen.push(quelle.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    }
    ts.forEachChild(n, besuche);
  };
  besuche(quelle);
  return zeilen;
}

function dateien(verzeichnis: string): string[] {
  const out: string[] = [];
  const lauf = (d: string) => {
    for (const name of readdirSync(d)) {
      if (NIE.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) lauf(p);
      else if (ENDUNGEN.test(name)) out.push(relative(WURZEL, p).split(sep).join('/'));
    }
  };
  lauf(join(WURZEL, verzeichnis));
  return out;
}

describe('Keine parallelen Abfragen auf einer Transaktion (statisch)', () => {
  it('Prüfer: erkennt jeden Kombinator, auch über Elementzugriff und globalThis', () => {
    const r = parallelStellen(`
      const [a, b] = await Promise.all([x(), y()]);
      await Promise.allSettled(liste);
      await globalThis.Promise.race([x()]);
      await Promise['any']([x()]);
      const ok = await Promise.resolve(1);
      liste.all(1);
    `);
    expect(r).toEqual([2, 3, 4, 5]);
  });

  it('Testhilfen sind ausgenommen, Laufzeitdateien nicht', () => {
    for (const d of [
      'packages/service/src/bereiche/x/testwelt.ts',
      'packages/service/src/bereiche/x/testhilfen.ts',
      'packages/service/src/__tests__/sperr-hilfen.ts',
      'packages/service/src/bereiche/x/lesen.db.test.ts',
    ])
      expect(TEST.test(d)).toBe(true);
    for (const d of [
      'packages/service/src/bereiche/x/lesen.ts',
      'packages/service/src/kern/tcms-kontext.ts',
    ])
      expect(TEST.test(d)).toBe(false);
  });

  it('Laufzeitcode des Dienstes ohne Promise.all/allSettled/race/any', () => {
    const befunde: string[] = [];
    for (const datei of dateien(VERZEICHNIS)) {
      if (TEST.test(datei)) continue;
      for (const z of parallelStellen(readFileSync(join(WURZEL, datei), 'utf8'), datei)) {
        befunde.push(`${datei}:${z}`);
      }
    }
    expect(befunde).toEqual([]);
  });
});
