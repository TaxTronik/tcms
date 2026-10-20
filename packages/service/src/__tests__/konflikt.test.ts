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
// Der Ablauf eines Endpunkts ist die Operation, die seine Route ruft, mit allen
// Funktionen, die sie transitiv aufruft (gleiche Datei und relative Importe des
// Dienstes; Funktionen aus @tcms/contract und @tcms/db werfen keinen Konflikt).
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

const quellen = new Map<string, ts.SourceFile>();
function quelle(datei: string): ts.SourceFile {
  let q = quellen.get(datei);
  if (!q) {
    q = ts.createSourceFile(
      datei,
      readFileSync(join(WURZEL, datei), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    quellen.set(datei, q);
  }
  return q;
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

/** Relativer Import eines Namens → Datei des Dienstes (sonst null: Paket, nicht verfolgt). */
function importDatei(sf: ts.SourceFile, datei: string, name: string): string | null {
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const ziel = s.moduleSpecifier.text;
    const benannt = s.importClause?.namedBindings;
    if (!benannt || !ts.isNamedImports(benannt)) continue;
    if (!benannt.elements.some((e) => e.name.text === name)) continue;
    if (!ziel.startsWith('.')) return null;
    const basis = resolve(WURZEL, dirname(datei), ziel);
    for (const kandidat of [`${basis}.ts`, join(basis, 'index.ts')]) {
      try {
        if (statSync(kandidat).isFile()) return relative(WURZEL, kandidat).split(sep).join('/');
      } catch {
        // nächster Kandidat
      }
    }
    throw new Error(`Import ${ziel} in ${datei} nicht gefunden`);
  }
  return null;
}

/** Ablauf: Funktion samt transitiv aufgerufener Funktionen des Dienstes. */
function ablauf(datei: string, start: string) {
  const besucht = new Set<string>();
  const befunde: string[] = [];
  const gefunden = new Set<string>();
  const folge = (d: string, name: string) => {
    const schluessel = `${d}#${name}`;
    if (besucht.has(schluessel)) return;
    const sf = quelle(d);
    const f = funktion(sf, name);
    if (!f) {
      const ziel = importDatei(sf, d, name);
      if (ziel) folge(ziel, name);
      return;
    }
    besucht.add(schluessel);
    const r = untersuche(f, sf, true);
    for (const b of r.befunde) befunde.push(`${d}:${b.zeile} ${b.regel}`);
    for (const g of r.gruende) for (const x of g.split('|')) gefunden.add(x);
    const aufrufe = new Set<string>();
    const lauf = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) aufrufe.add(n.expression.text);
      ts.forEachChild(n, lauf);
    };
    lauf(f);
    for (const a of aufrufe) folge(d, a);
  };
  folge(datei, start);
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

/** Operation je Endpunkt mit `konflikte` (Route in apps/api/src/routen/*). */
const ABLAEUFE: Record<string, { datei: string; funktion: string }> = {
  portalFreigabeCodeAnfordern: { datei: FREIGABEN, funktion: 'fordereFreigabeCodeAn' },
  portalFreigabeErteilen: { datei: FREIGABEN, funktion: 'erteileFreigabe' },
  portalMeldungErfassen: { datei: PORTAL, funktion: 'meldeEreignis' },
};

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

  it('jeder Endpunkt mit `konflikte` hat einen geprüften Ablauf und umgekehrt', () => {
    expect(
      Object.values(ENDPUNKTE)
        .filter((e) => e.konflikte.length > 0)
        .map((e) => e.name)
        .sort(),
    ).toEqual(Object.keys(ABLAEUFE).sort());
  });

  for (const [name, a] of Object.entries(ABLAEUFE)) {
    it(`${name}: jedes 409 mit Grund, genau die Gründe des Registers`, () => {
      const r = ablauf(a.datei, a.funktion);
      // Der Ablauf wurde wirklich verfolgt (Prüfung, Sperre, Rollen, Nachricht, Audit).
      expect(r.besucht.length).toBeGreaterThan(8);
      expect(r.befunde).toEqual([]);
      const register = (ENDPUNKTE as Record<string, { konflikte: readonly string[] }>)[name]!;
      expect([...r.gruende].sort()).toEqual([...register.konflikte].sort());
    });
  }
});
