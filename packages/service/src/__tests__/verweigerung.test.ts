// =============================================================================
// Maschinenlesbarer Verweigerungsgrund (`fehler.grund`, VERWEIGERUNG_GRUENDE im
// Vertrag): Jede Stelle, an der der Dienst `403 NICHT_BERECHTIGT` erzeugt,
// liefert einen Grund aus der festen Liste – statisch für den ganzen
// Laufzeitcode geprüft (Dienst, API, Demo):
//
//   direkt     `new DienstFehler('NICHT_BERECHTIGT', …)` statt
//              `nichtBerechtigt(grund, meldung)` (der Typ verbietet es ohnehin,
//              der Konstruktor zur Laufzeit auch)
//   dynamisch  `new DienstFehler(<kein String-Literal>, …)` – der Code ließe sich
//              an der Prüfung vorbei wählen
//   grund      `nichtBerechtigt(…)` bzw. die Ablehnungen der Rechtefunktionen
//              (`abgelehnt` in rechte.ts, `recht` in durchfuehrung/rechte.ts)
//              mit einem Grund, der weder ein Literal der Liste noch eine
//              freigegebene Weitergabe einer Rechtefunktion ist
//
// Das Inventar (Datei → Gründe in Quelltextreihenfolge) hält jede Stelle mit
// ihrem Grund fest: Eine neue oder geänderte Stelle lässt den Test scheitern,
// bis sie hier mit ihrem Grund eingetragen ist (Review der Zuordnung zur
// Rechtefunktion). Dass `NICHT_GEFUNDEN` nie einen Grund trägt, erzwingen der
// Konstruktor von `DienstFehler` und `FehlerSchema` (Vertragstests).
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERWEIGERUNG_GRUENDE } from '@tcms/contract';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const VERZEICHNISSE = ['packages/service/src', 'apps/api/src', 'apps/web/src'];
const ENDUNGEN = /\.(?:[cm]?ts|tsx)$/;
const NIE = new Set(['node_modules', '.next', 'generated', 'dist']);
const TEST = /(?:\.test\.[cm]?tsx?$)|(?:\/__tests__\/)|(?:^apps\/web\/src\/test\/)/;

/** Funktionen, deren erstes Argument ein Verweigerungsgrund ist (je Datei). */
const GRUND_AUFRUFE: Record<string, string> = {
  'packages/service/src/rechte.ts': 'abgelehnt',
  'packages/service/src/bereiche/durchfuehrung/rechte.ts': 'recht',
};

/**
 * Freigegebene Weitergaben: Der Grund stammt aus dem Ergebnis einer
 * Rechtefunktion (`Entscheidung`/`Recht`, Typ `VerweigerungGrund`), deren
 * Gründe selbst im Inventar stehen.
 */
const WEITERGABEN: Record<string, string[]> = {
  'packages/service/src/bereiche/durchfuehrung/lage.ts': ['r.verweigerung'],
  'packages/service/src/bereiche/durchfuehrung/rechte.ts': ['g.verweigerung'],
  'packages/service/src/bereiche/feststellungen-ereignisse/feststellungen.ts': [
    'recht.verweigerung',
  ],
};

type Befund = { regel: 'direkt' | 'dynamisch' | 'grund'; zeile: number };

const GUELTIG = new Set<string>(VERWEIGERUNG_GRUENDE);

/** Gründe eines Ausdrucks: Literal, Bedingung aus Literalen oder Weitergabe. */
function gruende(n: ts.Expression, weitergaben: readonly string[]): string[] | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return GUELTIG.has(n.text) ? [n.text] : null;
  }
  if (ts.isParenthesizedExpression(n)) return gruende(n.expression, weitergaben);
  if (ts.isConditionalExpression(n)) {
    const a = gruende(n.whenTrue, weitergaben);
    const b = gruende(n.whenFalse, weitergaben);
    return a && b ? [`${a.join('|')}|${b.join('|')}`] : null;
  }
  const text = n.getText();
  return weitergaben.includes(text) ? [`weiter:${text}`] : null;
}

/** Befunde und Gründe einer Quelldatei (rein, für die Prüferfälle direkt aufrufbar). */
export function pruefeQuelltext(
  text: string,
  datei = 'x.ts',
): { befunde: Befund[]; gruende: string[] } {
  const quelle = ts.createSourceFile(datei, text, ts.ScriptTarget.Latest, true);
  const befunde: Befund[] = [];
  const gefunden: string[] = [];
  const weitergaben = WEITERGABEN[datei] ?? [];
  const grundAufruf = GRUND_AUFRUFE[datei];
  const melde = (regel: Befund['regel'], n: ts.Node) =>
    befunde.push({ regel, zeile: quelle.getLineAndCharacterOfPosition(n.getStart()).line + 1 });

  const besuche = (n: ts.Node): void => {
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'DienstFehler'
    ) {
      const code = n.arguments?.[0];
      if (!code || !(ts.isStringLiteral(code) || ts.isNoSubstitutionTemplateLiteral(code))) {
        melde('dynamisch', n);
      } else if (code.text === 'NICHT_BERECHTIGT') {
        melde('direkt', n);
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (name === 'nichtBerechtigt' || name === grundAufruf) {
        const arg = n.arguments[0];
        const g = arg ? gruende(arg, weitergaben) : null;
        if (g) gefunden.push(...g);
        else melde('grund', n);
      }
    }
    ts.forEachChild(n, besuche);
  };
  besuche(quelle);
  return { befunde, gruende: gefunden };
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

/** Jede Stelle mit Grund, Quelltextreihenfolge (Zuordnung: VERWEIGERUNG_GRUENDE im Vertrag). */
const INVENTAR: Record<string, string[]> = {
  // Rechtefunktionen (Entscheidung): kannGegenzeichnen, kannVerwerfenBestaetigen.
  'packages/service/src/rechte.ts': [
    'VIER_AUGEN', // Gegenzeichnung durch die durchführende Person
    'PARTEI', // Mandant, Kontrolle ohne Gegenzeichnung beim Mandanten
    'PORTAL_ROLLE', // Mandant ohne aktive Rolle
    'GEGENZEICHNEN', // ohne Bezug
    'GEGENZEICHNEN', // Bestätigung beim Mandanten steht aus
    'GEGENZEICHNEN', // weder zugewiesen noch zuständige:r BT
    'VIER_AUGEN', // Verwerfen: keine zweite Person
    'WUERDIGEN', // Verwerfen bei möglicher Steuerwirkung
  ],
  // Rechte je Handlung der Durchführung (Recht, auch Flags der Oberfläche).
  'packages/service/src/bereiche/durchfuehrung/rechte.ts': [
    'PARTEI', // Kontrolle der Mandantenseite, Kanzleiperson
    'PARTEI', // Kontrolle der Kanzlei, Mandantenkontakt
    'PORTAL_ZUGEORDNET|DURCHFUEHREN', // nicht zugewiesen (Portal bzw. Kanzlei)
    'PARTEI', // Abschluss nur durch die Kanzlei
    'VIER_AUGEN', // Beteiligte zeichnen nicht gegen
    'weiter:g.verweigerung', // kannGegenzeichnen (Kanzlei)
    'PARTEI|PORTAL_ROLLE', // Bestätigung beim Mandanten: Kanzleiperson bzw. ohne Rolle
    'VIER_AUGEN', // Beteiligte bestätigen nicht
    'weiter:g.verweigerung', // kannGegenzeichnen (Mandant)
    'PARTEI', // Entfallen beantragen nur Kanzlei
    'BEARBEITEN', // Entfallen beantragen: weder zugewiesen noch kannBearbeiten
    'WUERDIGEN', // Entfallen freigeben: kannWuerdigen
    'VIER_AUGEN', // Entfallen freigeben: nicht die antragstellende Person
    'PARTEI', // Nachtrag nur Kanzlei
    'BEARBEITEN', // Nachtrag: weder zugewiesen noch kannBearbeiten
  ],
  'packages/service/src/bereiche/durchfuehrung/lage.ts': ['weiter:r.verweigerung'],
  'packages/service/src/bereiche/feststellungen-ereignisse/ereignisse.ts': [
    'BEARBEITEN', // ladeZumAendern
    'BEARBEITEN', // erledigeFolge (oder zuständig)
    'BEARBEITEN', // verwerfeFolge
    'VIER_AUGEN', // bestaetigeEreignisVerwerfen
    'BEARBEITEN', // erfasseEreignis
  ],
  'packages/service/src/bereiche/feststellungen-ereignisse/feststellungen.ts': [
    'VERTRAULICH', // pruefeVertraulich
    'BEARBEITEN', // pruefeBearbeiten
    'WUERDIGEN', // §-153-Entscheidung
    'WUERDIGEN', // Würdigung: Auswirkung auf „nein"
    'BEARBEITEN', // erledigeMassnahme (oder verantwortlich)
    'weiter:recht.verweigerung', // kannVerwerfenBestaetigen
    'WUERDIGEN', // setzeVertraulich
    'BEARBEITEN', // erfasseFeststellung
  ],
  'packages/service/src/bereiche/feststellungen-ereignisse/laender.ts': ['BEARBEITEN'],
  'packages/service/src/bereiche/feststellungen-ereignisse/portal.ts': [
    'PORTAL_ROLLE|PARTEI', // meldeEreignis: Kontakt ohne GV/TCB bzw. Kanzleiperson
  ],
  'packages/service/src/bereiche/lesepfade/audit.ts': ['VERWALTUNG'],
  'packages/service/src/bereiche/lesepfade/hilfen.ts': ['PARTEI'], // nurKanzlei
  'packages/service/src/bereiche/lesepfade/mandant.ts': ['BEARBEITEN'], // Anker, Kontaktrollen
  'packages/service/src/bereiche/lesepfade/portal.ts': ['PARTEI'], // Portal-Übersicht
  'packages/service/src/bereiche/programm-beschreibung/beschreibung.ts': [
    'VIER_AUGEN', // Review-Abschluss
  ],
  'packages/service/src/bereiche/programm-beschreibung/freigaben.ts': [
    'PORTAL_ROLLE', // Freigabe mit Code nur GV
    'PORTAL_ZUGEORDNET', // Freigabe an andere Person
    'PORTAL_ZUGEORDNET', // Kenntnisnahme an andere Person
  ],
  'packages/service/src/bereiche/programm-beschreibung/gemeinsam.ts': ['BEARBEITEN'],
  'packages/service/src/bereiche/risiken-kontrollen/gemeinsam.ts': ['BEARBEITEN'],
  'packages/service/src/bereiche/risiken-kontrollen/kontrollen.ts': ['VIER_AUGEN'],
  'packages/service/src/bereiche/risiken-kontrollen/risiken.ts': [
    'VIER_AUGEN', // Übersteuerung entscheiden
    'VIER_AUGEN', // Freigabeschritt nur durch Vier-Augen übersprungen
    'VIER_AUGEN', // Zurückweisen
  ],
};

describe('Verweigerungsgrund an jeder 403-Stelle (statisch)', () => {
  describe('Prüfer', () => {
    it('erkennt direkte und dynamische Codes und Gründe außerhalb der Liste', () => {
      const r = pruefeQuelltext(`
        throw new DienstFehler('NICHT_BERECHTIGT', 'x');
        throw new DienstFehler(code, 'x');
        throw nichtBerechtigt(grund, 'x');
        throw nichtBerechtigt('ERFUNDEN', 'x');
        throw nichtBerechtigt(\`BEARBEITEN\`, 'x');
        throw nichtBerechtigt(a ? 'VIER_AUGEN' : wert, 'x');
        throw new DienstFehler('NICHT_GEFUNDEN');
        throw nichtBerechtigt(a ? 'PARTEI' : 'PORTAL_ROLLE', 'x');
      `);
      expect(r.befunde.map((b) => `${b.regel}:${b.zeile}`)).toEqual([
        'direkt:2',
        'dynamisch:3',
        'grund:4',
        'grund:5',
        'grund:7',
      ]);
      expect(r.gruende).toEqual(['BEARBEITEN', 'PARTEI|PORTAL_ROLLE']);
    });

    it('lässt eine Weitergabe nur in der freigegebenen Datei und nur mit dem freigegebenen Ausdruck zu', () => {
      const code = 'throw nichtBerechtigt(r.verweigerung, r.grund);';
      expect(pruefeQuelltext(code).befunde.map((b) => b.regel)).toEqual(['grund']);
      const lage = 'packages/service/src/bereiche/durchfuehrung/lage.ts';
      expect(pruefeQuelltext(code, lage)).toEqual({
        befunde: [],
        gruende: ['weiter:r.verweigerung'],
      });
      expect(
        pruefeQuelltext('throw nichtBerechtigt(x.verweigerung, x.grund);', lage).befunde,
      ).toHaveLength(1);
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

  it('kein 403 ohne Grund aus der festen Liste', () => {
    expect(befunde).toEqual([]);
  });

  it('jede Stelle steht mit ihrem Grund im Inventar', () => {
    expect(gefunden).toEqual(INVENTAR);
  });

  it('jeder Grund der Liste kommt im Laufzeitcode vor', () => {
    const genutzt = new Set(
      Object.values(gefunden)
        .flat()
        .flatMap((g) => g.split('|')),
    );
    expect(VERWEIGERUNG_GRUENDE.filter((g) => !genutzt.has(g))).toEqual([]);
  });
});
