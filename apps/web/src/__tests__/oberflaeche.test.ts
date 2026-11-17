// =============================================================================
// Statische Wächter der Demo-Oberfläche (apps/web/src, ohne Tests):
//
//   UI-Sprache     Texte (String-Literale, Template-Teile, JSX-Text) ohne die
//                  Formulierungen, die AGENTS.md („UI-Sprache“) ausschließt.
//   Client-Grenze  'use client'-Module importieren keine Servermodule (nur
//                  Server Actions aus `server/actions/`), weder Datenbank noch
//                  Dienstkern noch Node-Module.
//   Actions        Jede exportierte Server Action ('use server') bildet zuerst
//                  den Akteur der angemeldeten Person (Sitzung), bevor sie den
//                  Dienst oder die Datenbank aufruft. Ausnahmen begründet in
//                  OHNE_SITZUNG.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function dateien(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : dateien(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')
      ? [p]
      : [];
  });
}

const QUELLEN = dateien(SRC).map((pfad) => {
  const text = readFileSync(pfad, 'utf8');
  return {
    pfad: relative(SRC, pfad).split(sep).join('/'),
    text,
    quelle: ts.createSourceFile(pfad, text, ts.ScriptTarget.Latest, true),
  };
});

// -----------------------------------------------------------------------------
// UI-Sprache
// -----------------------------------------------------------------------------

/** Formulierungen der Tabelle „UI-Sprache“ (AGENTS.md) und gleichartige Zusicherungen. */
const VERBOTEN: [RegExp, string][] = [
  [/\bwirksam\b/i, '„wirksam“ → „abgeschlossen – ohne Befund“ bzw. „gilt“'],
  [/Wirksamkeit[^.]*\bbelegt/i, 'Wirksamkeitsaussage des Systems'],
  [/PS[-\s]?980[-\s]?konform/i, '„PS-980-konform“ → „Nachweis dokumentiert“'],
  [/nach IDW PS 980/i, 'Zusicherung „nach IDW PS 980“'],
  [/zertifiziert/i, '„zertifiziert“ → „Nachweis dokumentiert“'],
  [/prüfungssicher|revisionssicher|auditgesichert/i, 'Zusicherung → „im Audit protokolliert“'],
  [/compliance[-\s]?score|reifegrad/i, 'Score/Reifegrad → „dokumentiert“ bzw. „Lücken (n)“'],
  [/risiko beseitigt/i, '„Risiko beseitigt“ → „Nettoklasse gering“'],
  [/anonymisiert/i, '„anonymisiert“ → „Platzhalter ersetzt“'],
  [/empfehl|empfohlen/i, 'keine Empfehlung (Regel 5, Regel 7)'],
];

/** JSX-Attribute mit technischen Werten (keine Anzeige). */
const TECHNISCH = new Set(['id', 'htmlFor', 'name', 'className', 'key', 'href', 'type']);

function texte(q: ts.SourceFile): { zeile: number; text: string }[] {
  const out: { zeile: number; text: string }[] = [];
  const zeile = (n: ts.Node) => q.getLineAndCharacterOfPosition(n.getStart(q)).line + 1;
  const besuche = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (
      ts.isJsxAttribute(n) &&
      ts.isIdentifier(n.name) &&
      TECHNISCH.has(n.name.text) &&
      n.initializer &&
      ts.isStringLiteral(n.initializer)
    )
      return;
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    )
      out.push({ zeile: zeile(n), text: n.text });
    else if (ts.isJsxText(n)) out.push({ zeile: zeile(n), text: n.text });
    ts.forEachChild(n, besuche);
  };
  besuche(q);
  return out;
}

describe('UI-Sprache (AGENTS.md)', () => {
  it('kein Text der Oberfläche verwendet ausgeschlossene Formulierungen', () => {
    const treffer = QUELLEN.flatMap(({ pfad, quelle }) =>
      texte(quelle).flatMap(({ zeile, text }) =>
        VERBOTEN.filter(([m]) => m.test(text.replace(/\s+/g, ' '))).map(
          ([, grund]) => `${pfad}:${zeile} ${grund}: ${text.trim().slice(0, 80)}`,
        ),
      ),
    );
    expect(treffer).toEqual([]);
  });

  it('der Wächter erkennt verbotene Texte (Selbsttest)', () => {
    const probe = ts.createSourceFile(
      'probe.tsx',
      `const a = 'Kontrolle wirksam'; const b = <p title="Nettoklasse (wirksam)">Wirksamkeit der Maßnahmen ist belegt</p>;
       const c = \`Programm \${x} zertifiziert\`; const d = <input id="wirksam-ab" />; // wirksam im Kommentar
       const wirksam = 1; const e = 'steuerwirksam, Wirksamkeitszeitraum';`,
      ts.ScriptTarget.Latest,
      true,
    );
    const gefunden = texte(probe).filter(({ text }) => VERBOTEN.some(([m]) => m.test(text)));
    expect(gefunden.map((t) => t.text.trim())).toEqual([
      'Kontrolle wirksam',
      'Nettoklasse (wirksam)',
      'Wirksamkeit der Maßnahmen ist belegt',
      'zertifiziert',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Client-Grenze
// -----------------------------------------------------------------------------

const direktive = (q: ts.SourceFile): string | null => {
  const erste = q.statements[0];
  return erste && ts.isExpressionStatement(erste) && ts.isStringLiteral(erste.expression)
    ? erste.expression.text
    : null;
};

const importe = (q: ts.SourceFile): string[] =>
  q.statements
    .filter(ts.isImportDeclaration)
    .filter((i) => !i.importClause?.isTypeOnly)
    .map((i) => (i.moduleSpecifier as ts.StringLiteral).text);

/** Module, die im Browser nichts verloren haben (Server Actions ausgenommen). */
function serverModul(spez: string): boolean {
  if (/(^@\/server\/|\/server\/)actions\//.test(spez)) return false;
  return (
    /^@\/server\//.test(spez) ||
    /(^|\/)server\//.test(spez) ||
    /^@tcms\/(db|service|contract)(\/|$)/.test(spez) ||
    /^(node:|server-only$|next\/headers$)/.test(spez)
  );
}

describe('Client-Grenze', () => {
  it('Client-Komponenten importieren keine Servermodule', () => {
    const clients = QUELLEN.filter((d) => direktive(d.quelle) === 'use client');
    expect(clients.length).toBeGreaterThan(10);
    const verstoesse = clients.flatMap((d) =>
      importe(d.quelle)
        .filter(serverModul)
        .map((m) => `${d.pfad}: ${m}`),
    );
    expect(verstoesse).toEqual([]);
  });

  it('Selbsttest der Modulregel', () => {
    expect(serverModul('@/server/actions/portal-ereignis')).toBe(false);
    expect(serverModul('@/components/durchfuehrung/werte')).toBe(false);
    expect(serverModul('@tcms/domain')).toBe(false);
    for (const m of ['@/server/demo', '../../server/zeit', '@tcms/db', '@tcms/service', 'node:fs'])
      expect(serverModul(m), m).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Server Actions: Sitzung vor Dienst und Datenbank
// -----------------------------------------------------------------------------

/** Einstiege, die den Akteur aus der Sitzung bilden (sonst Umleitung zur Anmeldung). */
const SITZUNG = [
  'brauchtKanzlei',
  'brauchtKanzleiFuer',
  'brauchtPortal',
  'demoAkteur',
  'fuehreAus',
  'kanzleiHandlung',
  'portalHandlung',
];
/** Zugriffe auf Dienst oder Datenbank. */
const ZUGRIFF =
  /\b(imDienst|imDemoDienst|imSystemdienst|mitTenant|liesDemo|liesImDienst|db)\s*[.(]/;

/** Server Actions ohne Sitzung, mit Begründung. */
const OHNE_SITZUNG: Record<string, string> = {
  'server/actions/sitzung.ts#anmelden':
    'die Anmeldung selbst (nur außerhalb von Produktion, TS-01)',
  'server/actions/sitzung.ts#abmelden': 'beendet nur die eigene Sitzung',
};

function aufrufe(n: ts.Node, q: ts.SourceFile): { name: string; pos: number }[] {
  const out: { name: string; pos: number }[] = [];
  const besuche = (k: ts.Node): void => {
    if (ts.isCallExpression(k) && ts.isIdentifier(k.expression))
      out.push({ name: k.expression.text, pos: k.getStart(q) });
    ts.forEachChild(k, besuche);
  };
  besuche(n);
  return out;
}

describe('Server Actions', () => {
  const actions = QUELLEN.filter((d) => direktive(d.quelle) === 'use server');

  it('jede Action bildet den Akteur aus der Sitzung, bevor sie Dienst oder Datenbank aufruft', () => {
    expect(actions.length).toBeGreaterThan(10);
    const fehler: string[] = [];
    let geprueft = 0;
    for (const { pfad, quelle } of actions) {
      // Lokale Helfer, die selbst die Sitzung lesen (z. B. `kanzlei(fd)`), zählen als Einstieg.
      const lokal = new Set(SITZUNG);
      const funktionen = quelle.statements.filter(ts.isFunctionDeclaration);
      for (let runde = 0; runde < 3; runde++)
        for (const f of funktionen)
          if (f.name && f.body && aufrufe(f.body, quelle).some((a) => lokal.has(a.name)))
            lokal.add(f.name.text);
      for (const f of funktionen) {
        const exportiert = f.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exportiert || !f.name || !f.body) continue;
        const id = `${pfad}#${f.name.text}`;
        geprueft++;
        if (OHNE_SITZUNG[id]) continue;
        const erste = aufrufe(f.body, quelle).find((a) => lokal.has(a.name));
        if (!erste) {
          fehler.push(`${id}: ohne Sitzung`);
          continue;
        }
        const vorher = quelle.text.slice(f.body.getStart(quelle), erste.pos);
        if (ZUGRIFF.test(vorher)) fehler.push(`${id}: Dienst/Datenbank vor der Sitzung`);
      }
    }
    expect(geprueft).toBeGreaterThan(50);
    expect(fehler).toEqual([]);
    for (const id of Object.keys(OHNE_SITZUNG)) {
      const [pfad, name] = id.split('#');
      expect(
        actions.some((a) => a.pfad === pfad && a.text.includes(`function ${name}(`)),
        `Ausnahme ohne Action: ${id}`,
      ).toBe(true);
    }
  });
});
