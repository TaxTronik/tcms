// =============================================================================
// Testqualität: kein Abgleich gegen den Text eines Fehlers, der von Prisma oder
// der Datenbank stammen kann (tcms-s10, statisch für alle Tests).
//
// Prisma hängt an die Meldung eines Fehlers einen Codeausschnitt der
// aufrufenden Stelle an; ein Muster, das nur dort steht, lässt einen
// Negativtest auch dann bestehen, wenn die geprüfte Regel fehlt (db-fehler.ts).
// Ebenso besteht ein allgemeines Muster an jeder anderen Regel derselben Art.
// Fehler der Datenbank prüfen Tests deshalb nur über `dbAbgewiesen`
// (SQLSTATE und Meldung des Servers), eigene Fehler mit Datenbankbezug über
// `abgewiesenOhneDb` oder über Typ und Code (`DienstFehler`).
//
// Regeln (jede Testdatei und Testhilfe der Pakete und Apps):
//
//   text-matcher       `toThrow(x)` / `toThrowError(x)` / `toThrowErrorMatching…`
//                      mit einem Muster, Text oder Wert statt einer Fehlerklasse
//   leer-db            `toThrow()` ohne Argument in einer DB-Suite
//                      (`*.db.test.ts`): besteht mit jedem Fehler
//   rejects-meldung    `rejects.toMatch(…)` bzw. `rejects.toMatchObject` /
//                      `toHaveProperty` / `toEqual` mit `message`
//   meldung-text       `expect(<Meldung eines unbekannten Fehlers>)` mit einem
//                      positiven Abgleich (`toMatch`, `toContain`, `toBe` …):
//                      `String(e)`, `String(x.message)`, `(e as Error).message`
//                      und jede `.message` außer an einer einfachen Variablen
//                      (die ihren Typ trägt, z. B. ein `DienstFehler` aus
//                      `fehlerVon`)
//   meldung-extraktor  ein `catch` (Klausel oder Rückruf), der die Meldung des
//                      gefangenen Fehlers zurückgibt oder zuweist
//
// Ausnahmen nur für Dateien ohne Datenbank (nie `*.db.test.ts`, kein Client,
// kein `pg`, kein `DB_TESTS`), je Datei und Regel mit Anzahl und Begründung.
// Eine Ausnahme, die nicht mehr gebraucht wird, lässt den Test scheitern.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Regel = 'text-matcher' | 'leer-db' | 'rejects-meldung' | 'meldung-text' | 'meldung-extraktor';

interface Befund {
  regel: Regel;
  zeile: number;
}

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

const VERZEICHNISSE = [
  'apps/api/src',
  'apps/web/src',
  'packages/contract/src',
  'packages/db/src',
  'packages/db/seeds',
  'packages/domain/src',
  'packages/service/src',
  'scripts',
];
const ENDUNGEN = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const NIE = new Set(['node_modules', '.next', 'generated', 'dist']);

/** Tests und Testhilfen (wie `.dockerignore` und scripts/pruefe-dockerfile.mjs). */
const TEST =
  /(?:\.test\.[cm]?[tj]sx?$)|(?:(?:^|\/)__tests__\/)|(?:^apps\/web\/src\/test\/)|(?:\/(?:testwelt|testfall|testhilfen|testprogramm|fixture)\.ts$)|(?:\.(?:testhilfe|testapp)\.ts$)/;
const DB_SUITE = /\.db\.test\.[cm]?[tj]sx?$/;
/** Spuren eines Datenbankzugriffs: Dateien damit können keine Ausnahme bekommen. */
const DB_SPUR = /erzeugeClient\(|from 'pg'|@prisma\/client|DB_TESTS|DATABASE_URL/;

const KLASSE = /^(?:[A-Z]\w*)?(?:Error|Fehler)$/;
const THROW = new Set([
  'toThrow',
  'toThrowError',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
]);
const POSITIV = new Set([
  'toMatch',
  'toContain',
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toMatchInlineSnapshot',
  'toMatchSnapshot',
]);

/** Ausnahmen: Datei → Anzahl je Regel und Begründung (nur ohne Datenbank). */
const AUSNAHMEN: Record<string, { regeln: Partial<Record<Regel, number>>; begruendung: string }> = {
  'apps/api/src/__tests__/app.test.ts': {
    regeln: { 'text-matcher': 13 },
    begruendung:
      'Aufbau der App (Schlüssel, Konfiguration, Routentabelle) mit Fake-Datenzugriff: ' +
      'Meldungen aus eigenem Code, kein Prisma.',
  },
  'apps/api/src/__tests__/beenden.test.ts': {
    regeln: { 'text-matcher': 1 },
    begruendung: 'Geordnetes Beenden mit Fake-Server, keine Datenbank.',
  },
  'apps/api/src/__tests__/jti.test.ts': {
    regeln: { 'text-matcher': 1 },
    begruendung: 'jti-Speicher im Speicher (ohne pg), eigene Meldungen.',
  },
  'apps/api/src/__tests__/register.test.ts': {
    regeln: { 'text-matcher': 6 },
    begruendung: 'Abgleich Routentabelle/Register beim Start (eigene Texte), Fake-Datenzugriff.',
  },
  'apps/api/src/__tests__/systemakteur.test.ts': {
    regeln: { 'meldung-text': 1 },
    begruendung: 'Fake-Datenzugriff wirft einen eigenen Fehler „Datenzugriff“, keine Datenbank.',
  },
  'apps/api/src/__tests__/vertrag.test.ts': {
    regeln: { 'text-matcher': 6 },
    begruendung: 'Vertragsprüfung der Testantworten (`VertragsVerletzung`), ohne Datenbank.',
  },
  'apps/web/src/server/code-schluessel.test.ts': {
    regeln: { 'text-matcher': 1, 'meldung-extraktor': 1 },
    begruendung:
      'Konfiguration des Code-Schlüssels der Demo (eigene Startmeldungen), ohne Datenbank.',
  },
  'apps/web/src/server/lokale-env.test.ts': {
    regeln: { 'text-matcher': 1 },
    begruendung: 'Lokale .env der Demo (Dateisystem), keine Datenbank.',
  },
  'apps/web/src/server/sitzung-regeln.test.ts': {
    regeln: { 'text-matcher': 2 },
    begruendung: 'Sitzungsregeln der Demo (Cookies, Geheimnis), ohne Datenbank.',
  },
  'packages/contract/src/__tests__/endpunkte.test.ts': {
    regeln: { 'text-matcher': 6 },
    begruendung: 'Laden des Endpunktregisters (eigene Texte), ohne Datenbank.',
  },
  'packages/contract/src/__tests__/signatur.test.ts': {
    regeln: { 'text-matcher': 20 },
    begruendung: 'Signieren und Prüfen der Akteursbestätigung (node:crypto), ohne Datenbank.',
  },
  'packages/service/src/__tests__/kontext.test.ts': {
    regeln: { 'text-matcher': 3 },
    begruendung:
      'Dienstkontext mit gemocktem mitTenant/schreibeAuditFolge, keine Datenbank; die Meldungen stammen aus mitAudit selbst (reservierter Detail-Schlüssel, fehlendes Protokoll).',
  },
  'packages/service/src/bereiche/programm-beschreibung/code.test.ts': {
    regeln: { 'text-matcher': 4 },
    begruendung: 'Reine Codefunktionen (Schlüsselbund, HMAC), keine Datenbank.',
  },
};

const ohneHuelle = (n: ts.Expression): ts.Expression => {
  let x = n;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isAwaitExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isSatisfiesExpression(x)
  ) {
    x = x.expression;
  }
  return x;
};

/** Fehlerklasse als Argument von `toThrow` (`TypeError`, `DienstFehler`, `z.ZodError`). */
function istKlasse(n: ts.Expression): boolean {
  const x = ohneHuelle(n);
  if (ts.isIdentifier(x)) return KLASSE.test(x.text);
  if (ts.isPropertyAccessExpression(x)) return KLASSE.test(x.name.text);
  return false;
}

/** `expect(…)` am Anfang einer Matcher-Kette und die Glieder danach. */
function kette(n: ts.CallExpression): { expect: ts.CallExpression; glieder: string[] } | null {
  const glieder: string[] = [];
  let x: ts.Expression = n.expression;
  while (ts.isPropertyAccessExpression(x)) {
    glieder.unshift(x.name.text);
    x = x.expression;
  }
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'expect') {
    return { expect: x, glieder };
  }
  return null;
}

const istString = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String';

const istMeldung = (n: ts.Node): n is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(n) && n.name.text === 'message';

/** Meldung eines Fehlers unbekannter Herkunft (siehe Regel `meldung-text`). */
function istFremdeMeldung(n: ts.Expression): boolean {
  const x = ohneHuelle(n);
  if (istString(x)) {
    const a = x.arguments[0] ? ohneHuelle(x.arguments[0]) : null;
    return !!a && (ts.isIdentifier(a) || (istMeldung(a) && !ts.isIdentifier(a.expression)));
  }
  return istMeldung(x) && !ts.isIdentifier(x.expression);
}

function nennt(n: ts.Node, name: string): boolean {
  let ja = false;
  const lauf = (k: ts.Node) => {
    if (ja) return;
    if ((ts.isIdentifier(k) || ts.isStringLiteral(k)) && k.text === name) ja = true;
    else ts.forEachChild(k, lauf);
  };
  lauf(n);
  return ja;
}

/** Ausdruck enthält `<v>.message` oder `String(<v>…)` des gefangenen Fehlers `v`. */
function liefertMeldung(n: ts.Node, v: string): boolean {
  let ja = false;
  const lauf = (k: ts.Node) => {
    if (ja) return;
    if (istMeldung(k) && nennt(k.expression, v)) ja = true;
    else if (istString(k) && k.arguments.some((a) => nennt(a, v))) ja = true;
    else ts.forEachChild(k, lauf);
  };
  lauf(n);
  return ja;
}

/** Befunde einer Quelldatei (rein, für die Prüferfälle unten direkt aufrufbar). */
export function pruefeFehlerabgleiche(text: string, datei = 'x.test.ts'): Befund[] {
  const quelle = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  const befunde: Befund[] = [];
  const dbSuite = DB_SUITE.test(datei);
  const melde = (regel: Regel, n: ts.Node) =>
    befunde.push({ regel, zeile: quelle.getLineAndCharacterOfPosition(n.getStart()).line + 1 });

  /** Rückgaben und Zuweisungen der Meldung in einem `catch`-Körper. */
  const pruefeFangkoerper = (koerper: ts.Node, v: string) => {
    const lauf = (k: ts.Node) => {
      if (ts.isFunctionLike(k)) return;
      const wert = ts.isReturnStatement(k)
        ? k.expression
        : ts.isBinaryExpression(k) && k.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? k.right
          : ts.isVariableDeclaration(k)
            ? k.initializer
            : undefined;
      if (wert && liefertMeldung(wert, v)) melde('meldung-extraktor', k);
      else ts.forEachChild(k, lauf);
    };
    ts.forEachChild(koerper, lauf);
  };

  const besuche = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const k = kette(n);
      const matcher = k?.glieder.at(-1);
      if (k && matcher) {
        const rejects = k.glieder.includes('rejects');
        const verneint = k.glieder.includes('not');
        if (THROW.has(matcher)) {
          const arg = n.arguments[0];
          if (matcher !== 'toThrow' && matcher !== 'toThrowError') melde('text-matcher', n);
          else if (arg && !istKlasse(arg)) melde('text-matcher', n);
          else if (!arg && dbSuite) melde('leer-db', n);
        } else if (rejects) {
          if (matcher === 'toMatch' || n.arguments.some((a) => nennt(a, 'message'))) {
            melde('rejects-meldung', n);
          }
        } else if (
          !verneint &&
          POSITIV.has(matcher) &&
          k.expect.arguments[0] &&
          istFremdeMeldung(k.expect.arguments[0])
        ) {
          melde('meldung-text', n);
        }
      }
      // `.catch((e) => …)` bzw. `.then(_, (e) => …)`
      if (ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        const cb = name === 'catch' ? n.arguments[0] : name === 'then' ? n.arguments[1] : undefined;
        if (
          cb &&
          (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          cb.parameters[0] &&
          ts.isIdentifier(cb.parameters[0].name)
        ) {
          const v = cb.parameters[0].name.text;
          if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) {
            if (liefertMeldung(cb.body, v)) melde('meldung-extraktor', cb);
          } else {
            pruefeFangkoerper(cb.body, v);
          }
        }
      }
    }
    if (
      ts.isCatchClause(n) &&
      n.variableDeclaration &&
      ts.isIdentifier(n.variableDeclaration.name)
    ) {
      pruefeFangkoerper(n.block, n.variableDeclaration.name.text);
    }
    ts.forEachChild(n, besuche);
  };
  besuche(quelle);
  return befunde;
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

describe('Fehlerabgleich in Tests nur über Datenbankfelder oder Typ (statisch)', () => {
  describe('Prüfer', () => {
    const regeln = (code: string, datei = 'x.test.ts') =>
      pruefeFehlerabgleiche(code, datei).map((b) => b.regel);

    it('meldet Muster und Texte an toThrow in jeder Form', () => {
      expect(
        regeln(`
          await expect(p).rejects.toThrow(/check constraint/);
          await expect(p).rejects.toThrow('permission denied');
          expect(() => f()).toThrow(\`x\${y}\`);
          expect(() => f()).toThrowError(muster);
          await expect(p).rejects.toThrow(new RegExp(x));
          expect(() => f()).toThrowErrorMatchingInlineSnapshot();
          expect(() => f()).toThrow(expect.objectContaining({ message: 'x' }));
        `),
      ).toEqual(Array(7).fill('text-matcher'));
    });

    it('erlaubt Fehlerklassen und in Suiten ohne Datenbank ein leeres toThrow', () => {
      expect(
        regeln(`
          await expect(p).rejects.toThrow(TenantFehler);
          expect(() => f()).toThrow(TypeError);
          expect(() => f()).toThrow(Error);
          expect(() => f()).toThrow(z.ZodError);
          await expect(p).rejects.toBeInstanceOf(DienstFehler);
          expect(() => f()).toThrow();
          await expect(p).rejects.toMatchObject({ ziel: '/anmelden' });
        `),
      ).toEqual([]);
    });

    it('meldet ein leeres toThrow nur in DB-Suiten', () => {
      const code = 'await expect(p).rejects.toThrow();';
      expect(regeln(code, 'x.db.test.ts')).toEqual(['leer-db']);
      expect(regeln(code, 'x.test.ts')).toEqual([]);
    });

    it('meldet Abgleiche gegen die Meldung eines abgewiesenen Versprechens', () => {
      expect(
        regeln(`
          await expect(p).rejects.toMatch(/x/);
          await expect(p).rejects.toMatchObject({ message: expect.stringMatching(/x/) });
          await expect(p).rejects.toHaveProperty('message', 'x');
        `),
      ).toEqual(['rejects-meldung', 'rejects-meldung', 'rejects-meldung']);
    });

    it('meldet positive Abgleiche gegen die Meldung eines unbekannten Fehlers', () => {
      expect(
        regeln(`
          expect((fehler as Error).message).toMatch(/x/);
          expect(String((e as Error).message), 'wo').toMatch(/x/);
          expect(String(e)).toContain('x');
          expect((await fehlerVon(p)).message).toBe('x');
          expect(r.fehler!.message).toEqual('x');
        `),
      ).toEqual(Array(5).fill('meldung-text'));
    });

    it('erlaubt typisierte Variablen, Verneinungen und Antwortfelder', () => {
      expect(
        regeln(`
          const e = await fehlerVon(p);
          expect(e.message).toMatch(/Vier-Augen/);
          expect((fehler as Error).message).not.toContain(geheim);
          expect(String(e.message)).not.toMatch(/geheim/);
          expect(String((hb.json['fehler'] as { meldung?: string }).meldung)).toMatch(/§ 153/);
        `),
      ).toEqual([]);
    });

    it('meldet catch-Blöcke und -Rückrufe, die die Meldung herausgeben', () => {
      expect(
        regeln(`
          async function fehlerVon(p) {
            try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); }
          }
          const m = await p.catch((e) => (e as Error).message);
          const n = await p.then(() => null, (e) => { return String(e); });
          try { f(); } catch (x) { meldung = (x as Error).message; }
          try { f(); } catch (x) { const t = String(x); }
        `),
      ).toEqual(Array(5).fill('meldung-extraktor'));
    });

    it('erlaubt catch-Blöcke, die den Fehler selbst oder seinen Code weitergeben', () => {
      expect(
        regeln(`
          try { await p; } catch (e) { if (e instanceof DienstFehler) return e; throw e; }
          try { await p; } catch (e) { return \`roh \${(e as { code?: string }).code}\`; }
          const f = await p.catch((e: unknown) => e);
          try { await p; } catch (e) { expect((e as Error).message).not.toContain('x'); }
        `),
      ).toEqual([]);
    });
  });

  const gefunden: Record<string, Partial<Record<Regel, number>>> = {};
  const fundstellen: string[] = [];
  for (const v of VERZEICHNISSE) {
    for (const datei of dateien(v)) {
      if (!TEST.test(datei)) continue;
      const befunde = pruefeFehlerabgleiche(readFileSync(join(WURZEL, datei), 'utf8'), datei);
      if (befunde.length === 0) continue;
      const je: Partial<Record<Regel, number>> = {};
      for (const b of befunde) {
        je[b.regel] = (je[b.regel] ?? 0) + 1;
        fundstellen.push(`${datei}:${b.zeile} ${b.regel}`);
      }
      gefunden[datei] = je;
    }
  }

  it('keine ungeschützten Fehlerabgleiche außer den begründeten Ausnahmen', () => {
    expect(fundstellen.filter((f) => !(f.split(':')[0]! in AUSNAHMEN))).toEqual([]);
    expect(gefunden).toEqual(
      Object.fromEntries(Object.entries(AUSNAHMEN).map(([d, a]) => [d, a.regeln])),
    );
  });

  it('Ausnahmen nur für Tests ohne Datenbank, mit Begründung', () => {
    for (const [datei, a] of Object.entries(AUSNAHMEN)) {
      expect(TEST.test(datei), datei).toBe(true);
      expect(DB_SUITE.test(datei), datei).toBe(false);
      expect(DB_SPUR.test(readFileSync(join(WURZEL, datei), 'utf8')), datei).toBe(false);
      expect(a.begruendung.length, datei).toBeGreaterThan(20);
    }
  });

  it('erfasst die DB-Suiten aller Pakete mit Datenbank', () => {
    const suiten = VERZEICHNISSE.flatMap(dateien).filter((d) => DB_SUITE.test(d));
    for (const p of ['apps/api/', 'apps/web/', 'packages/db/', 'packages/service/']) {
      expect(
        suiten.some((d) => d.startsWith(p)),
        p,
      ).toBe(true);
    }
  });
});
