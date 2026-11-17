// =============================================================================
// RT-02 (ADR 0001 §10 „Bekannte Restrisiken"): RLS trennt Tenants nur, solange
// niemand beliebiges SQL als Laufzeitrolle ausführt – der Tenant-Kontext
// `tcms.tenant_id` ist ein frei setzbarer GUC. Voraussetzung ist also: keine
// SQL-Injection. Dieser statische Test sichert sie maschinell ab und prüft
// jede Quelldatei der Pakete und Apps (Laufzeitcode, Tests, Seed):
//
//   unsafe      `$queryRawUnsafe` / `$executeRawUnsafe` (SQL aus Text)
//   raw         `Prisma.raw`, `sql.raw`, jeder Aufruf `<x>.raw(…)` außer
//               `String.raw` sowie ein Import namens `raw` (roher SQL-Baustein)
//               und der Zugriff `Prisma['raw']` bzw. `const { raw } = …`
//   raw-aufruf  `$queryRaw` / `$executeRaw` anders als als Tag eines Template-
//               Literals (z. B. als Funktionsaufruf mit zusammengesetztem Text),
//               auch über einen Alias aus einer Destrukturierung
//   baustein    rohe SQL-Bausteine, die in ein erlaubtes Tagged Template als
//               `${…}` eingesetzt Text unverändert ins SQL bringen:
//               `sql`/`sqltag` nur als Tag (nie `Prisma.sql([text])`, kein
//               Alias), `new …Sql(…)`, `Prisma.join` nur mit festen
//               String-Literalen als Trenner, Präfix und Suffix; Prisma-Bausteine
//               nur über den Namensraum `Prisma` (kein Import, keine
//               Destrukturierung, kein Elementzugriff `Prisma['sql']`)
//   pg-text     `.query(…)` (Treiber `pg`) mit einem SQL-Text, der kein festes
//               String-Literal ist (Verkettung, Template mit `${…}`, Variable)
//   tenant-guc  `set_config` oder `tcms.tenant_id` in einem String – außer in
//               `packages/db/src/tenant.ts`, der einzigen Implementierung des
//               Mandantenkontexts (AGENTS.md)
//
// Ausnahmen gibt es nur für Tests und den Seed, je Datei und Regel mit
// Begründung. Laufzeitcode kann nie freigestellt werden; eine Ausnahme, die
// nicht mehr gebraucht wird, lässt den Test ebenfalls scheitern.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Regel = 'unsafe' | 'raw' | 'raw-aufruf' | 'baustein' | 'pg-text' | 'tenant-guc';

interface Befund {
  regel: Regel;
  zeile: number;
}

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

/** Geprüfte Verzeichnisse (relativ zur Wurzel). */
const VERZEICHNISSE = [
  'apps/api/src',
  'apps/web/src',
  'packages/contract/src',
  'packages/db/seeds',
  'packages/db/src',
  'packages/domain/src',
  'packages/service/src',
  'scripts',
];
const ENDUNGEN = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const NIE = new Set(['node_modules', '.next', 'generated', 'dist']);

/** Einzige Datei, die den Tenant-Kontext setzen darf (AGENTS.md, ADR 0001 §4). */
const TENANT_DATEI = 'packages/db/src/tenant.ts';

/** Nur Tests und Seed dürfen Ausnahmen haben. */
const TEST_ODER_SEED =
  /(?:\.test\.[cm]?[tj]sx?$)|(?:\/__tests__\/)|(?:^apps\/web\/src\/test\/)|(?:\/seeds\/)|(?:\/testwelt\.ts$)/;

/** Ausnahmen: Datei → Regeln mit Begründung. */
const AUSNAHMEN: Record<string, { regeln: Regel[]; begruendung: string }> = {
  'packages/db/seeds/seed.ts': {
    regeln: ['unsafe'],
    begruendung:
      'Seed (nur Entwicklung, bricht mit NODE_ENV=production ab, Eigentümerrolle): TRUNCATE und ' +
      'UPDATE über Tabellennamen aus pg_catalog/information_schema, keine Eingabewerte.',
  },
  'packages/db/src/__tests__/rls.db.test.ts': {
    regeln: ['unsafe', 'pg-text', 'tenant-guc'],
    begruendung:
      'RLS-Test: prüft jede Tabelle des Katalogs mit generiertem SQL (feste Tabellenliste) und ' +
      'setzt den Kontext auf einer rohen Verbindung, um RLS ohne mitTenant nachzuweisen.',
  },
  'packages/db/src/__tests__/migrate.db.test.ts': {
    regeln: ['pg-text'],
    begruendung:
      'Test des Migrationsläufers (nur mit TCMS_MIGRATE_TESTS=1, Superuser einer Testinstanz): ' +
      'CREATE/DROP/ALTER DATABASE mit vom Test erzeugten Namen (Hex), keine Eingabewerte.',
  },
  'packages/db/src/__tests__/redteam/migrate-metabefehl.db.test.ts': {
    regeln: ['pg-text'],
    begruendung:
      'Beweistest RT2-T-01 (nur mit TCMS_MIGRATE_TESTS=1, Superuser einer Testinstanz): ' +
      'CREATE/DROP DATABASE mit vom Test erzeugten Namen (Hex), keine Eingabewerte.',
  },
  'packages/db/src/__tests__/roh-sql.test.ts': {
    regeln: ['tenant-guc'],
    begruendung: 'Dieser Test: Testfälle des Prüfers enthalten verbotene Muster als Text.',
  },
  'apps/api/src/__tests__/jti.db.test.ts': {
    regeln: ['tenant-guc'],
    begruendung:
      'Liest nach einer gescheiterten Route den Kontext der Poolverbindung (muss leer sein); ' +
      'setzt ihn nicht.',
  },
  'apps/api/src/__tests__/tenant-guc.db.test.ts': {
    regeln: ['tenant-guc'],
    begruendung: 'Negativtest: eine Route setzt den Tenant-Kontext um (muss zurückrollen).',
  },
  'packages/service/src/__tests__/redteam/rls-tenant-pivot.db.test.ts': {
    regeln: ['tenant-guc'],
    begruendung: 'Beweistest RT-02: Tenant-Pivot über set_config (Schutzziel und Restrisiko).',
  },
  'packages/service/src/bereiche/programm-beschreibung/testwelt.ts': {
    regeln: ['unsafe', 'tenant-guc'],
    begruendung:
      'Testhilfe für Manipulationstests: ändert als Eigentümerrolle mit abgeschaltetem ' +
      'Einfrier-Trigger, SQL nur aus den Tests selbst.',
  },
  'packages/service/src/bereiche/lesepfade/portfolio.perf.test.ts': {
    regeln: ['unsafe'],
    begruendung: 'Lasttest: klont Demo-Mandanten mit generiertem SQL aus festen IDs.',
  },
  'apps/web/src/test/demo-daten.ts': {
    regeln: ['unsafe', 'tenant-guc'],
    begruendung:
      'Web-DB-Tests: setzt einen Demo-Mandanten als Eigentümerrolle zurück; feste Löschfolge, ' +
      'Mandanten-ID als Parameter $1.',
  },
};

const RAW_TAGS = new Set(['$queryRaw', '$executeRaw']);
const UNSAFE = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
/** Rohe SQL-Bausteine von Prisma (`@prisma/client-runtime-utils`): nur über `Prisma.…`. */
const BAUSTEINE = new Set(['sql', 'sqltag', 'join', 'Sql', 'raw']);
/** Tags, die Werte zu Parametern machen – nur als Tag eines Template-Literals erlaubt. */
const SQL_TAGS = new Set(['sql', 'sqltag']);

function istFesterText(n: ts.Node | undefined): boolean {
  return !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
}

/** Name eines Zugriffs `x.name` bzw. `x['name']` (festes Literal), sonst `null`. */
function zugriffsname(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && istFesterText(n.argumentExpression)) {
    return (n.argumentExpression as ts.StringLiteral).text;
  }
  return null;
}

const ohneKlammern = (n: ts.Expression): ts.Expression => {
  let x = n;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) {
    x = x.expression;
  }
  return x;
};

/** Ausdruck ist der Namensraum `Prisma` (auch `x.Prisma`). */
const istPrisma = (n: ts.Expression): boolean => {
  const x = ohneKlammern(n);
  return (ts.isIdentifier(x) && x.text === 'Prisma') || zugriffsname(x) === 'Prisma';
};

/**
 * Destrukturierung aus `Prisma` oder aus einem Prisma-Modul
 * (`require('@prisma/…')`, `await import('@prisma/…')`).
 */
function ausPrisma(n: ts.BindingElement): boolean {
  let x: ts.Node = n;
  while (ts.isBindingElement(x) || ts.isObjectBindingPattern(x) || ts.isArrayBindingPattern(x)) {
    x = x.parent;
  }
  const init = ts.isVariableDeclaration(x) ? x.initializer : undefined;
  if (!init) return false;
  let quelle = ohneKlammern(init);
  if (ts.isAwaitExpression(quelle)) quelle = ohneKlammern(quelle.expression);
  if (istPrisma(quelle)) return true;
  return (
    ts.isCallExpression(quelle) &&
    quelle.arguments.length > 0 &&
    istFesterText(quelle.arguments[0]) &&
    /prisma/i.test((quelle.arguments[0] as ts.StringLiteral).text)
  );
}

/** Befunde einer Quelldatei (rein, für die Testfälle unten auch direkt aufrufbar). */
export function pruefeQuelltext(text: string, datei = 'x.ts', tenantErlaubt = false): Befund[] {
  const quelle = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  const befunde: Befund[] = [];
  const melde = (regel: Regel, n: ts.Node) =>
    befunde.push({ regel, zeile: quelle.getLineAndCharacterOfPosition(n.getStart()).line + 1 });

  const besuche = (n: ts.Node): void => {
    // unsafe: jede Erwähnung als Name (Aufruf, Zugriff, Alias, Destrukturierung).
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && UNSAFE.has(n.text)) melde('unsafe', n);
    if (
      ts.isElementAccessExpression(n) &&
      istFesterText(n.argumentExpression) &&
      /^\$(?:query|execute)Raw/.test((n.argumentExpression as ts.StringLiteral).text)
    ) {
      melde(
        UNSAFE.has((n.argumentExpression as ts.StringLiteral).text) ? 'unsafe' : 'raw-aufruf',
        n,
      );
    }
    // raw: `Prisma.raw`/`sql.raw` in jeder Form, jeder Aufruf `<x>.raw(…)` (außer
    // `String.raw`) und der Import eines Bausteins `raw`. Ein bloßer Zugriff wie
    // `c.req.raw` (Hono-Request) ist kein SQL-Baustein.
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'raw') {
      const ziel = ts.isIdentifier(n.expression) ? n.expression.text : null;
      const aufruf = ts.isCallExpression(n.parent) && n.parent.expression === n;
      if (ziel === 'Prisma' || ziel === 'sql' || (aufruf && ziel !== 'String')) melde('raw', n);
    }
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'raw') melde('raw', n);
    if (ts.isElementAccessExpression(n) && zugriffsname(n) === 'raw') melde('raw', n);
    // raw-aufruf: $queryRaw/$executeRaw nur als Tag eines Template-Literals.
    if (ts.isPropertyAccessExpression(n) && RAW_TAGS.has(n.name.text)) {
      const p = n.parent;
      if (!(ts.isTaggedTemplateExpression(p) && p.tag === n)) melde('raw-aufruf', n);
    }
    // Destrukturierung: `const { raw } = Prisma` (raw), `const { $queryRaw: q } = tx`
    // (Alias, später als Funktionsaufruf mit Sql-Objekt nicht mehr erkennbar),
    // `const { sql, join } = Prisma` (baustein).
    if (ts.isBindingElement(n)) {
      const name = n.propertyName ?? n.name;
      const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
      if (text === 'raw') melde('raw', n);
      else if (text !== null && RAW_TAGS.has(text)) melde('raw-aufruf', n);
      else if (text !== null && BAUSTEINE.has(text) && ausPrisma(n)) melde('baustein', n);
    }
    // baustein: Prisma-Bausteine nur über `Prisma.…` (kein Import, kein Re-Export) …
    if (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) {
      const name = (n.propertyName ?? n.name).text;
      const modul = ts.isImportSpecifier(n)
        ? n.parent.parent.parent.moduleSpecifier
        : n.parent.parent.moduleSpecifier;
      const ausModul = !!modul && ts.isStringLiteral(modul) && /prisma/i.test(modul.text);
      if (ausModul && name === 'raw' && ts.isExportSpecifier(n)) melde('raw', n);
      else if (ausModul && name !== 'raw' && BAUSTEINE.has(name)) melde('baustein', n);
    }
    if (ts.isElementAccessExpression(n) && istPrisma(n.expression)) {
      const name = zugriffsname(n);
      if (name !== null && name !== 'raw' && BAUSTEINE.has(name)) melde('baustein', n);
    }
    // … `sql`/`sqltag` nur als Tag (ein Aufruf `sql([text])` setzt den Text roh ein) …
    if (ts.isCallExpression(n)) {
      const c = ohneKlammern(n.expression);
      const name = ts.isIdentifier(c) ? c.text : zugriffsname(c);
      if (name !== null && SQL_TAGS.has(name)) melde('baustein', n);
    }
    if (ts.isPropertyAccessExpression(n) && SQL_TAGS.has(n.name.text) && istPrisma(n.expression)) {
      const p = n.parent;
      const tag = ts.isTaggedTemplateExpression(p) && p.tag === n;
      const aufruf = ts.isCallExpression(p) && p.expression === n; // meldet die Regel davor
      if (!tag && !aufruf) melde('baustein', n);
    }
    // … kein `new Sql(…)` (Text und Werte frei wählbar) …
    if (ts.isNewExpression(n)) {
      const c = ohneKlammern(n.expression);
      if ((ts.isIdentifier(c) ? c.text : zugriffsname(c)) === 'Sql') melde('baustein', n);
    }
    // … und `Prisma.join` nur aufgerufen, Trenner/Präfix/Suffix als feste Literale.
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'join' && istPrisma(n.expression)) {
      const p = n.parent;
      if (!(ts.isCallExpression(p) && p.expression === n)) melde('baustein', n);
      else if (p.arguments.slice(1).some((a) => !istFesterText(a))) melde('baustein', p);
    }
    // pg-text: .query(<fester Text>, [werte]) – SQL nie zusammengesetzt.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'query' &&
      n.arguments.length > 0 &&
      !istFesterText(n.arguments[0])
    ) {
      melde('pg-text', n);
    }
    // tenant-guc: den Tenant-Kontext setzt nur tenant.ts.
    if (!tenantErlaubt) {
      const texte: string[] = [];
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texte.push(n.text);
      if (ts.isTemplateExpression(n)) {
        texte.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
      }
      if (texte.some((t) => /set_config|tcms\.tenant_id/i.test(t))) melde('tenant-guc', n);
    }
    ts.forEachChild(n, besuche);
  };
  besuche(quelle);
  return befunde;
}

function dateien(verzeichnis: string): string[] {
  const out: string[] = [];
  const abs = join(WURZEL, verzeichnis);
  const lauf = (d: string) => {
    for (const name of readdirSync(d)) {
      if (NIE.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) lauf(p);
      else if (ENDUNGEN.test(name)) out.push(relative(WURZEL, p).split(sep).join('/'));
    }
  };
  lauf(abs);
  return out;
}

describe('RT-02: keine SQL-Injection-Bausteine (statisch)', () => {
  describe('Prüfer', () => {
    const regeln = (code: string, tenantErlaubt = false) =>
      pruefeQuelltext(code, 'x.ts', tenantErlaubt).map((b) => b.regel);

    it('erlaubt parametrisierte Tagged Templates und feste pg-Texte', () => {
      expect(
        regeln(`
          await tx.$queryRaw\`SELECT id FROM "Feststellung" WHERE id = \${id} FOR UPDATE\`;
          await tx.$executeRaw\`UPDATE "X" SET a = \${a} WHERE id IN (\${Prisma.join(ids)})\`;
          await tx.$queryRaw\`SELECT 1 WHERE \${Prisma.sql\`a = \${b}\`}\`;
          await pool.query('INSERT INTO akteur_jti (jti, exp) VALUES ($1, $2)', [j, e]);
          await pool.query(\`DELETE FROM akteur_jti WHERE exp < now() LIMIT $1\`, [n]);
          const re = String.raw\`\\d+\`;
          c.req.query();
          const h = c.req.raw.headers;
        `),
      ).toEqual([]);
    });

    it('meldet unsichere Raw-Abfragen in jeder Form', () => {
      expect(regeln('await tx.$queryRawUnsafe(`SELECT * FROM x WHERE id = ${id}`);')).toEqual([
        'unsafe',
      ]);
      expect(regeln('await tx.$executeRawUnsafe(sql, id);')).toEqual(['unsafe']);
      expect(regeln("const f = tx['$executeRawUnsafe'];")).toEqual(['unsafe']);
      expect(regeln('const { $queryRawUnsafe: q } = tx;')).toEqual(['unsafe']);
      expect(regeln('await tx.$queryRaw`SELECT ${Prisma.raw(spalte)} FROM x`;')).toEqual(['raw']);
      expect(regeln('const t = sql.raw(name);')).toEqual(['raw']);
      expect(regeln('const t = db.raw(name);')).toEqual(['raw']);
      expect(regeln('const r = Prisma.raw;')).toEqual(['raw']);
      expect(regeln("import { raw } from '@prisma/client/runtime/library';")).toEqual(['raw']);
      expect(regeln("import { raw as r } from 'x';")).toEqual(['raw']);
    });

    it('meldet Raw-Abfragen außerhalb eines Tagged Templates (Verkettung)', () => {
      expect(regeln("await tx.$queryRaw('SELECT * FROM x WHERE a = ' + a);")).toEqual([
        'raw-aufruf',
      ]);
      expect(regeln('await tx.$executeRaw(Prisma.sql`UPDATE x SET a = 1`);')).toEqual([
        'raw-aufruf',
      ]);
      expect(regeln('const q = tx.$queryRaw; await q`SELECT 1`;')).toEqual(['raw-aufruf']);
      expect(regeln("await tx['$queryRaw']`SELECT 1`;")).toEqual(['raw-aufruf']);
    });

    it('erlaubt Prisma-Bausteine als Tag bzw. mit festen Trennern und gleichnamige fremde Funktionen', () => {
      expect(
        regeln(`
          await tx.$queryRaw\`SELECT 1 WHERE id IN (\${Prisma.join(ids, ', ')})\`;
          await tx.$queryRaw\`SELECT 1 WHERE \${Prisma.join(bed, ' OR ', '(', ')')}\`;
          const teil: Prisma.Sql = Prisma.sql\`a = \${b}\`;
          if (teil instanceof Prisma.Sql) void 0;
          import { join } from 'node:path';
          const { join: verbinde } = path;
          const p = join(a, b) + path.join(a, b) + liste.join(trenner);
        `),
      ).toEqual([]);
    });

    it('meldet rohe SQL-Bausteine in einem erlaubten Tagged Template (Befunde 48, 93)', () => {
      // Text aus der Eingabe landet wörtlich im SQL (sql([text]).values ist leer).
      expect(regeln('await tx.$queryRaw`SELECT id FROM r WHERE ${Prisma.sql([filter])}`;')).toEqual(
        ['baustein'],
      );
      expect(regeln('await tx.$queryRaw`SELECT 1 WHERE ${Prisma.sqltag([f])}`;')).toEqual([
        'baustein',
      ]);
      expect(regeln('await tx.$queryRaw`SELECT 1 WHERE ${new Prisma.Sql([f], [])}`;')).toEqual([
        'baustein',
      ]);
      expect(regeln('const s = sql([text]);')).toEqual(['baustein']);
      // Trenner, Präfix und Suffix von join stehen roh im SQL.
      expect(regeln('const j = Prisma.join(ids, trenner);')).toEqual(['baustein']);
      expect(regeln("const j = Prisma.join(ids, ', ', praefix);")).toEqual(['baustein']);
      expect(regeln('const j = Prisma.join(ids, `${a} OR `);')).toEqual(['baustein']);
      // Aliase und Elementzugriffe entziehen sich den Regeln oben.
      expect(regeln('const j = Prisma.join;')).toEqual(['baustein']);
      expect(regeln('const s = Prisma.sql;')).toEqual(['baustein']);
      expect(regeln('f(Prisma.sql);')).toEqual(['baustein']);
      expect(regeln("const t = Prisma['sql']`x`;")).toEqual(['baustein']);
      expect(regeln("const r = Prisma['raw'];")).toEqual(['raw']);
      expect(regeln('const { raw } = Prisma;')).toEqual(['raw']);
      expect(regeln('const { sql: s, join } = Prisma;')).toEqual(['baustein', 'baustein']);
      expect(regeln("const { sql } = require('@prisma/client/runtime/client');")).toEqual([
        'baustein',
      ]);
      expect(regeln("const { Sql } = await import('@prisma/client-runtime-utils');")).toEqual([
        'baustein',
      ]);
      expect(
        regeln("import { sql as s, join as j } from '@prisma/client/runtime/client';"),
      ).toEqual(['baustein', 'baustein']);
      expect(
        regeln("import { Sql } from '@prisma/client-runtime-utils'; const x = new Sql([f], []);"),
      ).toEqual(['baustein', 'baustein']);
      expect(regeln("export { sql } from '@prisma/client-runtime-utils';")).toEqual(['baustein']);
      expect(regeln("export { raw } from '@prisma/client-runtime-utils';")).toEqual(['raw']);
    });

    it('meldet Aliase von $queryRaw/$executeRaw aus einer Destrukturierung', () => {
      expect(regeln('const { $queryRaw: q } = tx; await q(Prisma.sql([text]));')).toEqual([
        'raw-aufruf',
        'baustein',
      ]);
      expect(regeln('const { $executeRaw } = tx;')).toEqual(['raw-aufruf']);
      expect(regeln("const { '$queryRaw': q } = tx;")).toEqual(['raw-aufruf']);
    });

    it('meldet zusammengesetzte pg-Texte', () => {
      expect(regeln("await pool.query('SELECT * FROM x WHERE a = ' + a);")).toEqual(['pg-text']);
      expect(regeln('await pool.query(`SELECT * FROM ${tabelle}`);')).toEqual(['pg-text']);
      expect(regeln('await pool.query(sql, [a]);')).toEqual(['pg-text']);
    });

    it('meldet das Setzen des Tenant-Kontexts außerhalb von tenant.ts', () => {
      expect(
        regeln("await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${t}, true)`;"),
      ).toEqual(['tenant-guc']);
      expect(regeln("const g = 'tcms.tenant_id';")).toEqual(['tenant-guc']);
      expect(regeln('await tx.$executeRaw`SET LOCAL tcms.tenant_id = ${t}`;')).toEqual([
        'tenant-guc',
      ]);
      expect(regeln("const g = 'tcms.tenant_id';", true)).toEqual([]);
    });
  });

  describe('Quelltexte des Repositorys', () => {
    const alle = VERZEICHNISSE.flatMap(dateien);
    const befundeJe = new Map<string, Befund[]>();
    for (const datei of alle) {
      const b = pruefeQuelltext(
        readFileSync(join(WURZEL, datei), 'utf8'),
        datei,
        datei === TENANT_DATEI,
      );
      if (b.length) befundeJe.set(datei, b);
    }

    it('findet die Quelltexte (Prüfer läuft wirklich)', () => {
      expect(alle).toContain(TENANT_DATEI);
      expect(alle).toContain('packages/service/src/kern/tcms-kontext.ts');
      expect(alle).toContain('apps/api/src/jti.ts');
      expect(alle.length).toBeGreaterThan(200);
    });

    it('kein Laufzeitcode und kein Test/Seed ohne begründete Ausnahme verletzt eine Regel', () => {
      const verstoesse: string[] = [];
      for (const [datei, befunde] of befundeJe) {
        const erlaubt = new Set(AUSNAHMEN[datei]?.regeln ?? []);
        for (const b of befunde) {
          if (!erlaubt.has(b.regel)) verstoesse.push(`${datei}:${b.zeile} ${b.regel}`);
        }
      }
      expect(verstoesse).toEqual([]);
    });

    it('Ausnahmen nur für Tests und Seed, jede begründet und noch gebraucht', () => {
      for (const [datei, a] of Object.entries(AUSNAHMEN)) {
        expect(TEST_ODER_SEED.test(datei), `${datei}: keine Test- oder Seed-Datei`).toBe(true);
        expect(a.begruendung.length, `${datei}: Begründung fehlt`).toBeGreaterThan(30);
        const gefunden = new Set((befundeJe.get(datei) ?? []).map((b) => b.regel));
        for (const r of a.regeln) {
          expect(gefunden.has(r), `${datei}: Ausnahme ${r} wird nicht mehr gebraucht`).toBe(true);
        }
      }
    });
  });
});
