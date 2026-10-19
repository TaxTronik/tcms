// =============================================================================
// Stabile Reihenfolge (tcms-s9): Ohne ORDER BY liefert PostgreSQL Zeilen in der
// Reihenfolge des Abfrageplans – nach Schreibvorgängen, VACUUM oder einem
// anderen Plan eine andere. Antworten, Vergleiche (Einzel- gegen
// Blockabfrage), eingefrorene Snapshots und ihr SHA-256 hingen dann vom Zufall
// ab (Flake im s8-Lauf, Commit 4752652). Dieser statische Test prüft den
// Laufzeitcode des Dienstes mit dem TypeScript-Parser und dem Prisma-Schema:
//
//   findmany    `<x>.<modell>.findMany(…)` ohne `orderBy`
//   relation    eine Listenrelation (`feld Modell[]`) in einem `include` oder
//               `select` ohne `orderBy` (auch als `true`), in jeder Tiefe
//   eindeutig   ein `orderBy` dieser Stellen, das Gleichstände (gleicher
//               Zeitpunkt, gleicher Code) nicht auflöst: Die letzte Stufe ist
//               `id`, wo das Modell eine `id` hat. Sonst (Verknüpfungstabellen,
//               Audit) decken die Stufen zusammen mit den festen Feldern einen
//               Schlüssel des Schemas (`@id`, `@@id`, `@unique`, `@@unique`) ab und
//               die letzte Stufe gehört dazu; fest sind `tenantId` (RLS, eine
//               Transaktion je Tenant) und bei einer Relation der Fremdschlüssel
//               zum Elternobjekt (z. B. `risikoId` je Kontrolle in
//               `RisikoKontrolle`, `pos` je Tenant im Audit).
//   unbestimmt  Argumente, `include`, `select` oder `orderBy`, die der Prüfer
//               nicht als Objekt-Literal bzw. Modell auflösen kann
//
// `_count` zählt nur und braucht keine Reihenfolge. Ausnahmen je Datei, Regel
// und Ort mit Begründung; eine nicht mehr gebrauchte Ausnahme lässt den Test
// scheitern. Rohe Abfragen (`$queryRaw`) prüft der Test nicht: Im Dienst
// sperren sie Zeilen bzw. lesen höchstens eine Zeile oder eine Menge, deren
// Reihenfolge nicht ausgegeben wird (s9-Bericht).
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Regel = 'findmany' | 'relation' | 'eindeutig' | 'unbestimmt';

export interface Befund {
  regel: Regel;
  ort: string;
  zeile: number;
}

interface Feld {
  typ: string;
  liste: boolean;
  relationName: string | null;
  fremdschluessel: string[];
}
interface Modell {
  felder: Map<string, Feld>;
  schluessel: string[][];
}
export type Schema = Map<string, Modell>;

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const VERZEICHNIS = 'packages/service/src';
const SCHEMA = 'packages/db/prisma/schema.prisma';
const ENDUNGEN = /\.(?:[cm]?ts|tsx)$/;
const NIE = new Set(['node_modules', '.next', 'generated', 'dist']);
const TEST = /(?:\.test\.[cm]?tsx?$)|(?:\/__tests__\/)|(?:\/testwelt\.ts$)|(?:\/testprogramm\.ts$)/;

/** Methoden eines Prisma-Delegates, deren Argument `include`/`select` tragen kann. */
const METHODEN = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'create',
  'createManyAndReturn',
  'update',
  'updateManyAndReturn',
  'upsert',
  'delete',
]);

const liste = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Modelle, Felder, Relationen und Schlüssel aus dem Prisma-Schema. */
export function leseSchema(text: string): Schema {
  const namen = new Set([...text.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!));
  const schema: Schema = new Map();
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const felder = new Map<string, Feld>();
    const schluessel: string[][] = [];
    for (const zeile of m[2]!.split('\n')) {
      const z = zeile.trim();
      const block = /^@@(?:id|unique)\(\s*\[([^\]]+)\]/.exec(z);
      if (block) schluessel.push(liste(block[1]!));
      const f = /^(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(z);
      if (!f || z.startsWith('//') || z.startsWith('@@')) continue;
      const [, name, typ, klammern, rest] = f as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (/(?:^|\s)@id\b/.test(rest) || /(?:^|\s)@unique\b/.test(rest)) schluessel.push([name]);
      if (!namen.has(typ)) {
        felder.set(name, { typ, liste: !!klammern, relationName: null, fremdschluessel: [] });
        continue;
      }
      const rel = /@relation\(\s*(?:"([^"]+)"|[^)]*name:\s*"([^"]+)")/.exec(rest);
      const fk = /fields:\s*\[([^\]]+)\]/.exec(rest);
      felder.set(name, {
        typ,
        liste: !!klammern,
        relationName: rel ? (rel[1] ?? rel[2] ?? null) : null,
        fremdschluessel: fk ? liste(fk[1]!) : [],
      });
    }
    schema.set(m[1]!, { felder, schluessel });
  }
  return schema;
}

/**
 * Lösen die Stufen (Feldnamen in Reihenfolge) mit den festen Feldern jeden
 * Gleichstand auf? Mit `id` im Modell: letzte Stufe `id` („eindeutig durch eine
 * ID als letzte Stufe“, tcms-s9). Ohne `id`: Stufen und feste Felder decken
 * einen Schlüssel ab, und die letzte Stufe gehört zu ihm.
 */
export function eindeutig(
  schema: Schema,
  modell: string,
  fest: Set<string>,
  stufen: string[],
): boolean {
  const m = schema.get(modell);
  const letzte = stufen.at(-1);
  if (!m || !letzte) return false;
  if (m.schluessel.some((s) => s.length === 1 && s[0] === 'id')) return letzte === 'id';
  const bekannt = new Set([...fest, ...stufen]);
  return m.schluessel.some(
    (s) => s.includes(letzte) && !fest.has(letzte) && s.every((f) => bekannt.has(f)),
  );
}

/** Fremdschlüssel des Zielmodells zum Elternmodell einer Listenrelation. */
function rueckSchluessel(schema: Schema, eltern: string, feld: Feld): string[] {
  for (const g of schema.get(feld.typ)?.felder.values() ?? []) {
    if (g.typ === eltern && !g.liste && g.relationName === feld.relationName) {
      return g.fremdschluessel;
    }
  }
  return [];
}

/** Klammern, `as`, `satisfies` und `!` um einen Ausdruck entfernen. */
function kern(n: ts.Expression): ts.Expression {
  let e = n;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
}

const gross = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Befunde einer Quelldatei (rein, für die Prüferfälle direkt aufrufbar). */
export function pruefeQuelltext(text: string, schema: Schema, datei = 'x.ts'): Befund[] {
  const quelle = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  const befunde: Befund[] = [];
  const zeile = (n: ts.Node) => quelle.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const listenNamen = new Set<string>();
  for (const m of schema.values()) {
    for (const [n, f] of m.felder) if (f.liste && schema.has(f.typ)) listenNamen.add(n);
  }

  // Konstanten der Datei (Name → Initialisierer), um `include: X` aufzulösen.
  const konstanten = new Map<string, ts.Expression>();
  const sammle = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      konstanten.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, sammle);
  };
  sammle(quelle);

  const objekt = (n: ts.Expression, tiefe = 0): ts.ObjectLiteralExpression | null => {
    const e = kern(n);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isIdentifier(e) && tiefe < 5) {
      const init = konstanten.get(e.text);
      return init ? objekt(init, tiefe + 1) : null;
    }
    return null;
  };

  /** Eigenschaften eines Objekt-Literals samt aufgelöster Spreads (`null` = unauflösbar). */
  const eigenschaften = (
    o: ts.ObjectLiteralExpression,
  ): { name: string; wert: ts.Expression; knoten: ts.Node }[] | null => {
    const out: { name: string; wert: ts.Expression; knoten: ts.Node }[] = [];
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p)) {
        out.push({
          name: p.name.getText().replace(/^['"]|['"]$/g, ''),
          wert: p.initializer,
          knoten: p,
        });
      } else if (ts.isShorthandPropertyAssignment(p)) {
        out.push({ name: p.name.text, wert: p.name, knoten: p });
      } else if (ts.isSpreadAssignment(p)) {
        const s = objekt(p.expression);
        const innen = s ? eigenschaften(s) : null;
        if (!innen) return null;
        out.push(...innen);
      } else return null;
    }
    return out;
  };
  const eigenschaft = (o: ts.ObjectLiteralExpression, name: string) =>
    eigenschaften(o)
      ?.filter((p) => p.name === name)
      .at(-1);

  /** `orderBy` vorhanden, auflösbar und mit einem eindeutigen Feld als letzter Stufe. */
  const pruefeOrderBy = (
    o: ts.ObjectLiteralExpression,
    modell: string,
    fest: Set<string>,
    ort: string,
    stelle: ts.Node,
    regel: Regel,
  ) => {
    const ob = eigenschaft(o, 'orderBy');
    if (!ob) {
      befunde.push({ regel, ort, zeile: zeile(stelle) });
      return;
    }
    let e: ts.Expression | null = kern(ob.wert);
    if (ts.isIdentifier(e)) {
      const init = konstanten.get(e.text);
      e = init ? kern(init) : null;
    }
    if (!e) {
      befunde.push({ regel: 'unbestimmt', ort: `${ort}.orderBy`, zeile: zeile(stelle) });
      return;
    }
    const elemente = ts.isArrayLiteralExpression(e) ? [...e.elements] : [e];
    const stufen: string[] = [];
    for (const el of elemente) {
      const o2 = ts.isSpreadElement(el) ? null : objekt(el);
      const props = o2 ? eigenschaften(o2) : null;
      if (!props || props.length === 0) {
        befunde.push({ regel: 'unbestimmt', ort: `${ort}.orderBy`, zeile: zeile(stelle) });
        return;
      }
      stufen.push(...props.map((p) => p.name));
    }
    if (!eindeutig(schema, modell, fest, stufen)) {
      befunde.push({ regel: 'eindeutig', ort: `${ort}.orderBy`, zeile: zeile(stelle) });
    }
  };

  /** `include`/`select`-Baum eines Modells, rekursiv über alle Relationen. */
  const geprueft = new Set<ts.Node>();
  const pruefeBaum = (wert: ts.Expression, modell: string, ort: string, stelle: ts.Node) => {
    const v = kern(wert);
    if (v.kind === ts.SyntaxKind.TrueKeyword) return;
    const o = objekt(v);
    const props = o ? eigenschaften(o) : null;
    if (!o || !props) {
      befunde.push({ regel: 'unbestimmt', ort, zeile: zeile(stelle) });
      return;
    }
    // Ein ausgelagerter Baum (Konstante) wird einmal geprüft, nicht je Verwendung.
    if (geprueft.has(o)) return;
    geprueft.add(o);
    for (const p of props) {
      if (p.name === '_count') {
        // `_count: { select: { … } }` zählt nur: keine Reihenfolge nötig.
        const c = objekt(p.wert);
        const s = c && eigenschaft(c, 'select');
        const so = s ? objekt(s.wert) : null;
        if (so) geprueft.add(so);
        continue;
      }
      const feld = schema.get(modell)?.felder.get(p.name);
      if (!feld || !schema.has(feld.typ)) continue; // Skalar
      const relOrt = `${ort}.${p.name}`;
      const r = kern(p.wert);
      if (feld.liste && r.kind === ts.SyntaxKind.TrueKeyword) {
        befunde.push({ regel: 'relation', ort: relOrt, zeile: zeile(p.knoten) });
        continue;
      }
      if (r.kind === ts.SyntaxKind.TrueKeyword) continue;
      const ro = objekt(r);
      if (!ro) {
        befunde.push({ regel: 'unbestimmt', ort: relOrt, zeile: zeile(p.knoten) });
        continue;
      }
      if (feld.liste) {
        const fest = new Set(['tenantId', ...rueckSchluessel(schema, modell, feld)]);
        pruefeOrderBy(ro, feld.typ, fest, relOrt, p.knoten, 'relation');
      }
      for (const art of ['include', 'select']) {
        const unter = eigenschaft(ro, art);
        if (unter) pruefeBaum(unter.wert, feld.typ, `${relOrt}.${art}`, unter.knoten);
      }
    }
  };

  const besuche = (n: ts.Node) => {
    // Aufrufe `<x>.<delegate>.<methode>({ … })`: Modell aus dem Delegate.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      METHODEN.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression)
    ) {
      const methode = n.expression.name.text;
      const modell = gross(n.expression.expression.name.text);
      const ort = n.expression.getText().replace(/\s+/g, '');
      if (schema.has(modell)) {
        const arg = n.arguments[0];
        const o = arg ? objekt(arg) : null;
        if (!o) {
          if (methode === 'findMany' || arg) {
            befunde.push({ regel: 'unbestimmt', ort, zeile: zeile(n) });
          }
        } else {
          if (methode === 'findMany') {
            pruefeOrderBy(o, modell, new Set(['tenantId']), ort, n, 'findmany');
          }
          for (const art of ['include', 'select']) {
            const b = eigenschaft(o, art);
            if (b) pruefeBaum(b.wert, modell, `${ort}.${art}`, b.knoten);
          }
        }
      }
    }
    // Ausgelagerte Bäume: `const X = { … } satisfies Prisma.<Modell>Include|Select`.
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let e: ts.Expression = n.initializer;
      let typ: ts.TypeNode | undefined = n.type;
      for (;;) {
        if (ts.isSatisfiesExpression(e) || ts.isAsExpression(e)) {
          if (!ts.isConstTypeReference(e.type)) typ = e.type;
          e = e.expression;
        } else if (ts.isParenthesizedExpression(e)) e = e.expression;
        else break;
      }
      const m = typ ? /^Prisma\.(\w+?)(?:Include|Select)$/.exec(typ.getText()) : null;
      if (m && schema.has(m[1]!)) pruefeBaum(e, m[1]!, n.name.getText(), n);
    }
    ts.forEachChild(n, besuche);
  };
  besuche(quelle);

  // Jeder übrige `include`/`select`-Baum mit einem Listenrelationsnamen, den kein
  // Modell erreicht hat (z. B. als Parameter einer Hilfsfunktion), ist unbestimmt.
  const rest = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ['include', 'select'].includes(n.name.getText())) {
      const o = objekt(n.initializer);
      if (o && !geprueft.has(o)) {
        const namen = eigenschaften(o)?.map((p) => p.name) ?? ['?'];
        if (namen.some((x) => listenNamen.has(x) || x === '?')) {
          befunde.push({ regel: 'unbestimmt', ort: n.name.getText(), zeile: zeile(n) });
        }
      }
    }
    ts.forEachChild(n, rest);
  };
  rest(quelle);

  // Dieselbe Stelle über Konstante und Verwendung nur einmal melden.
  const gesehen = new Set<string>();
  return befunde.filter((b) => {
    const k = `${b.regel} ${b.ort} ${b.zeile}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
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

/** Ausnahmen: `<datei> <regel> <ort>` → Begründung. */
const AUSNAHMEN: Record<string, string> = {};

const SCHEMA_TEXT = readFileSync(join(WURZEL, SCHEMA), 'utf8');

describe('Stabile Reihenfolge jeder Listenabfrage des Dienstes (statisch)', () => {
  const schema = leseSchema(SCHEMA_TEXT);

  describe('Prüfer', () => {
    it('liest Listenrelationen, Fremdschlüssel und Schlüssel aus dem Schema', () => {
      expect(schema.get('Kontrolle')?.felder.get('staende')).toMatchObject({
        typ: 'KontrolleStand',
        liste: true,
      });
      const t = new Set(['tenantId']);
      expect(eindeutig(schema, 'Risiko', t, ['code', 'id'])).toBe(true);
      expect(eindeutig(schema, 'Risiko', t, ['id', 'code'])).toBe(false);
      // Mit `id` im Modell genügt ein anderer Schlüssel nicht (ID als letzte Stufe).
      const staende = schema.get('Kontrolle')!.felder.get('staende')!;
      const fest = new Set(['tenantId', ...rueckSchluessel(schema, 'Kontrolle', staende)]);
      expect(eindeutig(schema, 'KontrolleStand', fest, ['version'])).toBe(false);
      expect(eindeutig(schema, 'KontrolleStand', fest, ['version', 'id'])).toBe(true);
      // Verknüpfungstabelle: der Fremdschlüssel zum Elternobjekt steht fest.
      const risiken = schema.get('Kontrolle')!.felder.get('risiken')!;
      const festRk = new Set(['tenantId', ...rueckSchluessel(schema, 'Kontrolle', risiken)]);
      expect(eindeutig(schema, 'RisikoKontrolle', festRk, ['risikoId'])).toBe(true);
      expect(eindeutig(schema, 'RisikoKontrolle', festRk, ['kontrolleId'])).toBe(false);
      expect(eindeutig(schema, 'RisikoKontrolle', t, ['risikoId'])).toBe(false);
      expect(eindeutig(schema, 'RisikoKontrolle', t, ['kontrolleId', 'risikoId'])).toBe(true);
      // Zwei Relationen zwischen denselben Modellen: der Name entscheidet.
      const nk = schema.get('Durchfuehrung')!.felder.get('nachkontrolleFuer')!;
      expect(rueckSchluessel(schema, 'Durchfuehrung', nk)).toEqual(['tenantId', 'nachkontrolleId']);
      // Audit ohne `id`: Position je Tenant oder Schlüssel `seq`.
      expect(eindeutig(schema, 'AuditEvent', t, ['pos'])).toBe(true);
      expect(eindeutig(schema, 'AuditEvent', t, ['at'])).toBe(false);
    });

    it('erkennt fehlende, nicht eindeutige und unbestimmte Reihenfolgen in jeder Tiefe', () => {
      const r = pruefeQuelltext(
        `
        await tx.risiko.findMany({ where: { a: 1 } });
        await tx.risiko.findMany({ orderBy: { code: 'asc' } });
        await tx.risiko.findMany({ orderBy: [{ code: 'asc' }, { id: 'asc' }] });
        await tx.kontrolle.findFirst({ include: { staende: true, risiken: { orderBy: { risikoId: 'asc' } } } });
        await tx.tcmsProgramm.findFirst({ include: { risiken: { orderBy: [{ code: 'asc' }, { id: 'asc' }], include: { staende: { orderBy: { version: 'asc' } } } } } });
        await tx.feststellung.findUnique({ include: { massnahmen: { orderBy: x } } });
        await tx.feststellung.findMany(args);
        const B = { kontrollen: { include: { durchfuehrungen: true } } } satisfies Prisma.TcmsProgrammInclude;
        await tx.kontrolle.findMany({ orderBy: { id: 'asc' }, select: { _count: { select: { durchfuehrungen: true } } } });
        hilfe({ include: { staende: true } });
      `,
        schema,
      );
      expect(r.map((b) => `${b.regel}:${b.zeile} ${b.ort}`)).toEqual([
        'findmany:2 tx.risiko.findMany',
        'eindeutig:3 tx.risiko.findMany.orderBy',
        'relation:5 tx.kontrolle.findFirst.include.staende',
        'eindeutig:6 tx.tcmsProgramm.findFirst.include.risiken.include.staende.orderBy',
        'unbestimmt:7 tx.feststellung.findUnique.include.massnahmen.orderBy',
        'unbestimmt:8 tx.feststellung.findMany',
        'relation:9 B.kontrollen',
        'relation:9 B.kontrollen.include.durchfuehrungen',
        'unbestimmt:11 include',
      ]);
    });
  });

  const befunde: string[] = [];
  for (const datei of dateien(VERZEICHNIS)) {
    if (TEST.test(datei)) continue;
    for (const b of pruefeQuelltext(readFileSync(join(WURZEL, datei), 'utf8'), schema, datei)) {
      befunde.push(`${datei} ${b.regel} ${b.ort}`);
    }
  }

  it('jede Listenabfrage und jede Listenrelation ist eindeutig sortiert', () => {
    expect(befunde.filter((b) => !(b in AUSNAHMEN))).toEqual([]);
  });

  it('jede Ausnahme wird noch gebraucht', () => {
    expect(Object.keys(AUSNAHMEN).filter((a) => !befunde.includes(a))).toEqual([]);
  });
});
