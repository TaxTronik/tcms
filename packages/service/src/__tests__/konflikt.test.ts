// =============================================================================
// Konfliktgrund (`fehler.konflikt`, KONFLIKT_GRUENDE im Vertrag, tcms-s10)
// statisch: Die Abläufe der Endpunkte mit `konflikte` im Register werfen jedes
// `409` mit einem Grund, und genau die Gründe des Registereintrags kommen dort
// vor (Abgleich Register ↔ Code, wie beim Start des Dienstes zur Laufzeit).
//
//   dynamisch   `konfliktMitGrund(<kein Literal der Liste>, …)` – der Grund ließe sich
//               an der Prüfung vorbei wählen
//   direkt      `new DienstFehler(…)` mit Konfliktgrund statt `konfliktMitGrund(…)`
//   ohne-grund  `new DienstFehler('KONFLIKT', …)` in einem Ablauf mit
//               `konflikte` (auch in aufgerufenen Hilfsfunktionen)
//
// Der Ablauf eines Endpunkts ist die Operation, die seine Route ruft (aus den
// Routendateien in apps/api/src/routen abgeleitet: genau eine Funktion aus
// @tcms/service im Handler von `endpunkt(ENDPUNKTE.<name>, …)`), mit allen
// Funktionen, die sie transitiv aufruft: gleiche Datei, benannte (auch
// umbenannte) und Namensraum-Importe des Dienstes, Re-Exporte über
// Barrel-Dateien (`export { … } from`, `export * from`); Funktionen aus
// @tcms/contract und @tcms/db werfen keinen Konflikt. Ein Name aus einem
// relativen Modul, der dort nicht aufzulösen ist, lässt den Test scheitern
// (kein stilles Ende der Verfolgung). Nicht verfolgt werden Methodenaufrufe an
// Objekten (Ports wie `ctx.ablage.annehmen`, Delegates): Sie stammen aus dem
// Dienstkontext bzw. der Datenbank und werfen keinen Konfliktgrund.
// Das Inventar hält jede Stelle mit ihrem Grund fest (Review der Zuordnung).
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPUNKTE, KONFLIKT_GRUENDE } from '@tcms/contract';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const VERZEICHNISSE = ['packages/service/src', 'apps/api/src', 'apps/web/src'];
const ENDUNGEN = /\.(?:[cm]?ts|tsx)$/;
const NIE = new Set(['node_modules', '.next', 'generated', 'dist']);
const TEST = /(?:\.test\.[cm]?tsx?$)|(?:\/__tests__\/)|(?:^apps\/web\/src\/test\/)/;
const GUELTIG = new Set<string>(KONFLIKT_GRUENDE);

type Befund = { regel: 'dynamisch' | 'direkt' | 'ohne-grund'; zeile: number };

/** Dateien der Prüferfälle (Pfad relativ zur Wurzel → Quelltext), statt der Platte. */
const VIRTUELL = new Map<string, string>();
const quellen = new Map<string, ts.SourceFile>();
function quelle(datei: string): ts.SourceFile {
  let q = quellen.get(datei);
  if (!q) {
    q = ts.createSourceFile(
      datei,
      VIRTUELL.get(datei) ?? readFileSync(join(WURZEL, datei), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    quellen.set(datei, q);
  }
  return q;
}

function existiert(datei: string): boolean {
  if (VIRTUELL.has(datei)) return true;
  try {
    return statSync(join(WURZEL, datei)).isFile();
  } catch {
    return false;
  }
}

/** Gründe eines Ausdrucks: Literal der Liste oder Bedingung aus solchen. */
function gruende(n: ts.Expression): string[] | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return GUELTIG.has(n.text) ? [n.text] : null;
  }
  if (ts.isParenthesizedExpression(n)) return gruende(n.expression);
  if (ts.isConditionalExpression(n)) {
    const a = gruende(n.whenTrue);
    const b = gruende(n.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

const istText = (n: ts.Node | undefined, text: string) =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === text;

/** Befunde und Gründe eines Knotens (rein, für die Prüferfälle direkt aufrufbar). */
function untersuche(
  wurzel: ts.Node,
  sf: ts.SourceFile,
  ablauf: boolean,
): { befunde: Befund[]; gruende: string[] } {
  const befunde: Befund[] = [];
  const gefunden: string[] = [];
  const melde = (regel: Befund['regel'], n: ts.Node) =>
    befunde.push({ regel, zeile: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
  const besuche = (n: ts.Node): void => {
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'DienstFehler'
    ) {
      const args = n.arguments ?? [];
      if (args.length >= 5) melde('direkt', n);
      else if (ablauf && istText(args[0], 'KONFLIKT')) melde('ohne-grund', n);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'konfliktMitGrund'
    ) {
      const g = n.arguments[0] ? gruende(n.arguments[0]) : null;
      if (g) gefunden.push(g.join('|'));
      else melde('dynamisch', n);
    }
    ts.forEachChild(n, besuche);
  };
  besuche(wurzel);
  return { befunde, gruende: gefunden };
}

export function pruefeQuelltext(text: string, datei = 'x.ts', ablauf = false) {
  const sf = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  return untersuche(sf, sf, ablauf);
}

/** Funktion `name` einer Datei (Deklaration oder `const name = (…) =>`). */
function funktion(sf: ts.SourceFile, name: string): ts.Node | null {
  let treffer: ts.Node | null = null;
  const lauf = (n: ts.Node) => {
    if (treffer) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) treffer = n;
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      treffer = n.initializer;
    } else ts.forEachChild(n, lauf);
  };
  lauf(sf);
  return treffer;
}

/** Der Prüfer kann einen Namen, ein Modul oder eine Route nicht auflösen (Test scheitert). */
class AufloesungsFehler extends Error {}

/** Pakete, deren Quelltext verfolgt wird (Einstieg der Routen in den Dienst). */
const PAKETE: Record<string, string> = { '@tcms/service': 'packages/service/src/index.ts' };

/** Modul eines Imports bzw. Re-Exports → Datei; andere Pakete (contract, db, domain, node:…) → null. */
function modulDatei(von: string, modul: string): string | null {
  if (!modul.startsWith('.')) return PAKETE[modul] ?? null;
  const basis = relative(WURZEL, resolve(WURZEL, dirname(von), modul))
    .split(sep)
    .join('/');
  for (const k of [`${basis}.ts`, `${basis}.tsx`, `${basis}/index.ts`]) if (existiert(k)) return k;
  throw new AufloesungsFehler(`Import ${modul} in ${von} nicht gefunden`);
}

interface Deklaration {
  datei: string;
  name: string;
  knoten: ts.Node;
}

/**
 * Deklaration der Funktion `name`, gesehen aus `datei`: dort selbst, über einen
 * benannten (auch umbenannten) Import oder einen Re-Export (`export { a as b }
 * from`, `export * from`), transitiv. `null`: kein Import und keine Funktion der
 * Datei (Parameter, Variable, global) oder aus einem Paket außer dem Dienst.
 * Kommt der Name aus einem Modul des Dienstes, wird er dort aber nicht
 * gefunden, scheitert der Test.
 */
function deklaration(
  datei: string,
  name: string,
  kette: readonly string[] = [],
): Deklaration | null {
  const schluessel = `${datei}#${name}`;
  if (kette.includes(schluessel)) return null;
  const weiter = [...kette, schluessel];
  const sf = quelle(datei);
  const f = funktion(sf, name);
  if (f) return { datei, name, knoten: f };
  const aus = (modul: string, original: string): Deklaration | null => {
    const ziel = modulDatei(datei, modul);
    if (!ziel) return null;
    const d = deklaration(ziel, original, weiter);
    if (!d) throw new AufloesungsFehler(`${original} aus ${modul} (${datei}) nicht gefunden`);
    return d;
  };
  const sterne: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const b = st.importClause?.namedBindings;
      const el = b && ts.isNamedImports(b) ? b.elements.find((e) => e.name.text === name) : null;
      if (el) return aus(st.moduleSpecifier.text, el.propertyName?.text ?? name);
    }
    if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      const k = st.exportClause;
      if (!k) sterne.push(st.moduleSpecifier.text);
      else if (ts.isNamedExports(k)) {
        const el = k.elements.find((e) => e.name.text === name);
        if (el) return aus(st.moduleSpecifier.text, el.propertyName?.text ?? name);
      }
    }
  }
  for (const modul of sterne) {
    const ziel = modulDatei(datei, modul);
    const d = ziel ? deklaration(ziel, name, weiter) : null;
    if (d) return d;
  }
  return null;
}

/** Namensraum-Importe einer Datei (`import * as ns from '…'`): Name → Modul. */
function namensraeume(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) out.set(b.name.text, st.moduleSpecifier.text);
  }
  return out;
}

/** Ablauf: Funktion samt transitiv aufgerufener Funktionen des Dienstes. */
function ablauf(datei: string, start: string) {
  const besucht = new Set<string>();
  const befunde: string[] = [];
  const gefunden = new Set<string>();
  const besuche = (d: Deklaration) => {
    const schluessel = `${d.datei}#${d.name}`;
    if (besucht.has(schluessel)) return;
    besucht.add(schluessel);
    const sf = quelle(d.datei);
    const r = untersuche(d.knoten, sf, true);
    for (const b of r.befunde) befunde.push(`${d.datei}:${b.zeile} ${b.regel}`);
    for (const g of r.gruende) for (const x of g.split('|')) gefunden.add(x);
    const ns = namensraeume(sf);
    const lauf = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if (ts.isIdentifier(e)) {
          const x = deklaration(d.datei, e.text);
          if (x) besuche(x);
        } else if (
          ts.isPropertyAccessExpression(e) &&
          ts.isIdentifier(e.expression) &&
          ns.has(e.expression.text)
        ) {
          const ziel = modulDatei(d.datei, ns.get(e.expression.text)!);
          if (ziel) {
            const x = deklaration(ziel, e.name.text);
            if (!x) throw new AufloesungsFehler(`${e.getText()} (${d.datei}) nicht gefunden`);
            besuche(x);
          }
        }
      }
      ts.forEachChild(n, lauf);
    };
    lauf(d.knoten);
  };
  const s0 = deklaration(datei, start);
  if (!s0) throw new AufloesungsFehler(`${start} in ${datei} nicht gefunden`);
  besuche(s0);
  return { besucht: [...besucht].sort(), befunde, gruende: gefunden };
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

const FREIGABEN = 'packages/service/src/bereiche/programm-beschreibung/freigaben.ts';
const PORTAL = 'packages/service/src/bereiche/feststellungen-ereignisse/portal.ts';
const ROUTEN = 'apps/api/src/routen';

/**
 * Operation je Endpunkt aus den Routendateien: der Handler von
 * `<r>.endpunkt(ENDPUNKTE.<name>, …)` und die Funktionen aus @tcms/service, die
 * er ruft (Deklaration über die Re-Exporte des Dienstes aufgelöst).
 */
function ablaeufeAusRouten(): Record<string, { datei: string; funktionen: string[] }> {
  const out: Record<string, { datei: string; funktionen: string[] }> = {};
  for (const datei of dateien(ROUTEN)) {
    if (TEST.test(datei)) continue;
    const sf = quelle(datei);
    const dienst = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (st.moduleSpecifier.text !== '@tcms/service') continue;
      const b = st.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) for (const e of b.elements) dienst.add(e.name.text);
    }
    const lauf = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'endpunkt' &&
        n.arguments.length >= 2 &&
        ts.isPropertyAccessExpression(n.arguments[0]!) &&
        ts.isIdentifier(n.arguments[0].expression) &&
        n.arguments[0].expression.text === 'ENDPUNKTE'
      ) {
        const name = n.arguments[0].name.text;
        const gerufen = new Set<string>();
        const handler = (h: ts.Node) => {
          if (
            ts.isCallExpression(h) &&
            ts.isIdentifier(h.expression) &&
            dienst.has(h.expression.text)
          )
            gerufen.add(h.expression.text);
          ts.forEachChild(h, handler);
        };
        handler(n.arguments[1]!);
        if (out[name]) throw new AufloesungsFehler(`Endpunkt ${name} doppelt in den Routen`);
        const ziele = [...gerufen].map((g) => deklaration(PAKETE['@tcms/service']!, g));
        if (ziele.some((z) => !z))
          throw new AufloesungsFehler(`${name}: Operation nicht im Dienst gefunden`);
        const dateienDerZiele = [...new Set(ziele.map((z) => z!.datei))];
        out[name] = {
          datei: dateienDerZiele.length === 1 ? dateienDerZiele[0]! : '',
          funktionen: ziele.map((z) => z!.name).sort(),
        };
      }
      ts.forEachChild(n, lauf);
    };
    lauf(sf);
  }
  return out;
}

/** Jede Stelle mit Grund, Quelltextreihenfolge (Zuordnung: KONFLIKT_GRUENDE im Vertrag). */
const INVENTAR: Record<string, string[]> = {
  [FREIGABEN]: [
    'BEREITS_ERLEDIGT', // pruefeFreigabeRecht: Freigabe nicht mehr offen
    'CODE_GESPERRT', // Code anfordern: 5 Fehlversuche
    'ZU_VIELE_CODES', // Code anfordern: H1, 5 Codes je Stunde
    'ZWISCHENZEITLICH_GEAENDERT', // Code anfordern: bedingtes Update ohne Treffer
    'CODE_GESPERRT', // Freigeben: 5 Fehlversuche
    'CODE_FEHLT', // Freigeben: kein Code angefordert
    'CODE_ABGELAUFEN', // Freigeben: Schlüssel nicht mehr konfiguriert (H5)
    'CODE_ABGELAUFEN', // Freigeben: Frist abgelaufen
    'VERSION_NICHT_VORGELEGT', // Beschreibung nicht mehr beim Mandanten
    'INHALT_VERAENDERT', // Snapshot fehlt oder passt nicht zum Hash
    'ZWISCHENZEITLICH_GEAENDERT', // falscher Code: Zähler-Update ohne Treffer
    'ZWISCHENZEITLICH_GEAENDERT', // richtiger Code: Update ohne Treffer
    'VERSION_NICHT_VORGELEGT', // Version gleichzeitig geändert
  ],
  [PORTAL]: [
    'IDEMPOTENZ_ABWEICHUNG', // gleicher Schlüssel, anderer Inhalt (24 h)
    'ZWISCHENZEITLICH_GEAENDERT', // Unique-Verletzung oder Schreibkonflikt der Meldung
  ],
};

describe('Konfliktgrund an jedem 409 der Abläufe mit `konflikte` (statisch)', () => {
  describe('Prüfer', () => {
    it('verfolgt Barrel-Re-Exporte, Umbenennungen und Namensräume; scheitert an Unauflösbarem', () => {
      const v = 'packages/service/src/__virtuell__';
      const dateien: Record<string, string> = {
        [`${v}/op.ts`]: `
          import { helfer as h } from './barrel';
          import * as ns from './ns';
          import { fremd } from '@tcms/contract';
          export function op() { h(); ns.tief(); fremd(); lokal(); }
          function lokal() { return 1; }`,
        [`${v}/barrel.ts`]: `export { helfer } from './helfer';`,
        [`${v}/helfer.ts`]: `export function helfer() { throw new DienstFehler('KONFLIKT', 'x'); }`,
        [`${v}/ns.ts`]: `export * from './andere';\nexport * from './tief';`,
        [`${v}/andere.ts`]: `export function anderes() { return 0; }`,
        [`${v}/tief.ts`]: `export const tief = () => { throw konfliktMitGrund('CODE_FEHLT', 'x'); };`,
        [`${v}/kaputt.ts`]: `import { fehlt } from './barrel';\nexport function op() { fehlt(); }`,
      };
      for (const [d, t] of Object.entries(dateien)) VIRTUELL.set(d, t);
      try {
        const r = ablauf(`${v}/op.ts`, 'op');
        expect(r.besucht).toEqual([
          `${v}/helfer.ts#helfer`,
          `${v}/op.ts#lokal`,
          `${v}/op.ts#op`,
          `${v}/tief.ts#tief`,
        ]);
        expect(r.befunde).toEqual([`${v}/helfer.ts:1 ohne-grund`]);
        expect([...r.gruende]).toEqual(['CODE_FEHLT']);
        expect(() => ablauf(`${v}/kaputt.ts`, 'op')).toThrow(AufloesungsFehler);
      } finally {
        for (const d of Object.keys(dateien)) {
          VIRTUELL.delete(d);
          quellen.delete(d);
        }
      }
    });

    it('erkennt dynamische Gründe, direkte Konstruktion und 409 ohne Grund im Ablauf', () => {
      const code = `
        throw konfliktMitGrund('CODE_FEHLT', 'x');
        throw konfliktMitGrund(grund, 'x');
        throw konfliktMitGrund('ERFUNDEN', 'x');
        throw konfliktMitGrund(a ? 'CODE_GESPERRT' : 'BEREITS_ERLEDIGT', 'x');
        throw new DienstFehler('KONFLIKT', 'x', undefined, undefined, 'CODE_FEHLT');
        throw new DienstFehler('KONFLIKT', 'x');
      `;
      const ausserhalb = pruefeQuelltext(code);
      expect(ausserhalb.befunde.map((b) => `${b.regel}:${b.zeile}`)).toEqual([
        'dynamisch:3',
        'dynamisch:4',
        'direkt:6',
      ]);
      expect(ausserhalb.gruende).toEqual(['CODE_FEHLT', 'CODE_GESPERRT|BEREITS_ERLEDIGT']);
      expect(pruefeQuelltext(code, 'x.ts', true).befunde.map((b) => b.regel)).toContain(
        'ohne-grund',
      );
    });
  });

  const gefunden: Record<string, string[]> = {};
  const befunde: string[] = [];
  for (const v of VERZEICHNISSE) {
    for (const datei of dateien(v)) {
      if (TEST.test(datei)) continue;
      const r = pruefeQuelltext(readFileSync(join(WURZEL, datei), 'utf8'), datei);
      for (const b of r.befunde) befunde.push(`${datei}:${b.zeile} ${b.regel}`);
      if (r.gruende.length > 0) gefunden[datei] = r.gruende;
    }
  }

  it('kein Konfliktgrund außerhalb von konfliktMitGrund(<Literal der Liste>)', () => {
    expect(befunde).toEqual([]);
  });

  it('jede Stelle steht mit ihrem Grund im Inventar', () => {
    expect(gefunden).toEqual(INVENTAR);
  });

  const ABLAEUFE = ablaeufeAusRouten();
  const MIT_KONFLIKTEN = Object.values(ENDPUNKTE)
    .filter((e) => e.konflikte.length > 0)
    .map((e) => e.name)
    .sort();

  it('jeder Endpunkt mit `konflikte` hat eine Route, die genau eine Operation des Dienstes ruft', () => {
    for (const name of MIT_KONFLIKTEN) {
      expect(ABLAEUFE[name]?.funktionen, name).toHaveLength(1);
    }
    // Abgleich mit dem Inventar: die Abläufe liegen in den inventarisierten Dateien.
    expect(MIT_KONFLIKTEN.map((n) => `${n} ${ABLAEUFE[n]!.datei}`)).toEqual([
      `portalFreigabeCodeAnfordern ${FREIGABEN}`,
      `portalFreigabeErteilen ${FREIGABEN}`,
      `portalMeldungErfassen ${PORTAL}`,
    ]);
  });

  for (const name of MIT_KONFLIKTEN) {
    it(`${name}: jedes 409 mit Grund, genau die Gründe des Registers`, () => {
      const a = ABLAEUFE[name]!;
      const r = ablauf(a.datei, a.funktionen[0]!);
      // Der Ablauf wurde wirklich verfolgt (Prüfung, Sperre, Rollen, Nachricht, Audit).
      expect(r.besucht.length).toBeGreaterThan(8);
      expect(r.befunde).toEqual([]);
      const register = (ENDPUNKTE as Record<string, { konflikte: readonly string[] }>)[name]!;
      expect([...r.gruende].sort()).toEqual([...register.konflikte].sort());
    });
  }
});
