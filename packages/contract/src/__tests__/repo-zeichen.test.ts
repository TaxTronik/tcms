// =============================================================================
// Unsichtbare und bidirektionale Zeichen („Trojan Source", CVE-2021-42574 und
// CVE-2021-42694). Rohe Richtungs- und Formatzeichen lassen Quelltext in
// Editor, Review und Terminal anders erscheinen, als Compiler und Laufzeit ihn
// lesen (umgedrehte Bereiche in Regexen, versteckte Bedingungen, unsichtbare
// Bezeichner). Dieser statische Test prüft jede versionierte Datei – den Blob
// im Git-Index und, falls vorhanden, die Datei im Arbeitsbaum – und verbietet:
//
//   bidi      U+202A–U+202E, U+2066–U+2069 (Einbettung, Isolierung), U+200E,
//             U+200F, U+061C (Richtungsmarken)
//   format    jedes andere Formatzeichen (Unicode-Kategorie Cf), darunter
//             U+200B–U+200D, U+2060–U+2064, U+00AD, U+FEFF (auch als BOM: alle
//             Dateien BOM-frei) und die Tag-Zeichen U+E0000–U+E007F
//   trenner   U+2028/U+2029 (Zeilenende für JavaScript, in vielen Ansichten
//             unsichtbar)
//   steuer    C0-Steuerzeichen außer TAB und LF, ein CR ohne folgendes LF
//             (überschreibt im Terminal die Zeile), DEL und C1
//   fueller   unsichtbare „Buchstaben" U+115F, U+1160, U+3164, U+FFA0
//             (unsichtbare Bezeichner) und Variantenselektoren U+FE00–U+FE0F,
//             U+E0100–U+E01EF (versteckte Nutzlast)
//
// Im Quelltext gehören solche Zeichen als Escape geschrieben (`\u202e`). Eine
// Datei, die nicht gültiges UTF-8 ist oder ein NUL enthält, ist ein Befund,
// außer ihre Endung ist in `.gitattributes` als `binary` erklärt. Ausnahmen nur
// je Datei und Zeichen mit Begründung; eine nicht mehr gebrauchte Ausnahme lässt
// den Test ebenfalls scheitern.
// =============================================================================

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobInhalte, indexEintraege, REPO_WURZEL } from './repo-git';

type Art = 'bidi' | 'format' | 'trenner' | 'steuer' | 'fueller' | 'kodierung';

interface Befund {
  art: Art;
  /** Code Point als `U+XXXX`; bei `kodierung` die Beschreibung. */
  zeichen: string;
  zeile: number;
  spalte: number;
}

const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u;
const TRENNER = /[\u2028\u2029]/u;
const STEUER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\r(?!\n)/u;
const FUELLER = /[\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const FORMAT = /\p{Cf}/u;
/** Alles Verbotene in einem Durchlauf; die Art bestimmt `art()`. */
const VERBOTEN = new RegExp(
  [BIDI, TRENNER, STEUER, FUELLER, FORMAT].map((r) => r.source).join('|'),
  'gu',
);

function art(zeichen: string): Exclude<Art, 'kodierung'> {
  if (BIDI.test(zeichen)) return 'bidi';
  if (TRENNER.test(zeichen)) return 'trenner';
  if (STEUER.test(zeichen)) return 'steuer';
  if (FUELLER.test(zeichen)) return 'fueller';
  return 'format';
}

const codePoint = (z: string) =>
  `U+${z.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/** Befunde in einem Text (Zeilen und Spalten ab 1, Spalten in UTF-16-Einheiten). */
export function befundeIn(text: string): Befund[] {
  const befunde: Befund[] = [];
  const zeilenAnfaenge = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    zeilenAnfaenge.push(i + 1);
  }
  for (const m of text.matchAll(VERBOTEN)) {
    let zeile = zeilenAnfaenge.length - 1;
    while (zeilenAnfaenge[zeile]! > m.index) zeile -= 1;
    befunde.push({
      art: art(m[0]),
      zeichen: codePoint(m[0]),
      zeile: zeile + 1,
      spalte: m.index - zeilenAnfaenge[zeile]! + 1,
    });
  }
  return befunde;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Befunde in einem Dateiinhalt: Kodierung, dann Zeichen. */
export function befundeInDatei(inhalt: Buffer): Befund[] {
  if (inhalt.includes(0)) return [{ art: 'kodierung', zeichen: 'NUL', zeile: 0, spalte: 0 }];
  let text: string;
  try {
    text = UTF8.decode(inhalt);
  } catch {
    return [{ art: 'kodierung', zeichen: 'kein UTF-8', zeile: 0, spalte: 0 }];
  }
  return befundeIn(text);
}

/** Endungen, die `.gitattributes` als `binary` erklärt (`*.png binary`). */
export function binaerEndungen(gitattributes: string): Set<string> {
  const endungen = new Set<string>();
  for (const zeile of gitattributes.split('\n')) {
    const [muster, ...attribute] = zeile.trim().split(/\s+/);
    if (!muster || muster.startsWith('#') || !attribute.includes('binary')) continue;
    const m = /^\*(\.[A-Za-z0-9]+)$/.exec(muster);
    if (!m) throw new Error(`binary-Muster nicht unterstützt: ${muster}`);
    endungen.add(m[1]!.toLowerCase());
  }
  return endungen;
}

/** Ausnahmen: Datei → erlaubte Code Points (`U+XXXX`) mit Begründung. Derzeit keine. */
const AUSNAHMEN: Record<string, { zeichen: string[]; begruendung: string }> = {};

describe('befundeIn (Prüfer)', () => {
  // Jeder in der Aufgabe genannte Code Point einzeln – unabhängig davon, was
  // die Unicode-Tabelle der Laufzeit unter `\p{Cf}` führt.
  const PFLICHT: [number, Art][] = [
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e].map((c) => [c, 'bidi'] as [number, Art]),
    ...[0x2066, 0x2067, 0x2068, 0x2069].map((c) => [c, 'bidi'] as [number, Art]),
    [0x200e, 'bidi'],
    [0x200f, 'bidi'],
    [0x061c, 'bidi'],
    [0x200b, 'format'],
    [0x200c, 'format'],
    [0x200d, 'format'],
    [0x2060, 'format'],
    [0xfeff, 'format'],
    [0x00ad, 'format'],
    [0x2061, 'format'],
    [0x2064, 'format'],
    [0x206a, 'format'],
    [0xfff9, 'format'],
    [0xe0001, 'format'],
    [0xe0041, 'format'],
    [0xe007f, 'format'],
    [0x2028, 'trenner'],
    [0x2029, 'trenner'],
    [0x0000, 'steuer'],
    [0x0008, 'steuer'],
    [0x000b, 'steuer'],
    [0x000c, 'steuer'],
    [0x001b, 'steuer'],
    [0x007f, 'steuer'],
    [0x0085, 'steuer'],
    [0x009f, 'steuer'],
    [0x115f, 'fueller'],
    [0x1160, 'fueller'],
    [0x3164, 'fueller'],
    [0xffa0, 'fueller'],
    [0xfe00, 'fueller'],
    [0xfe0f, 'fueller'],
    [0xe0100, 'fueller'],
    [0xe01ef, 'fueller'],
  ];

  it.each(PFLICHT.map(([cp, a]) => [codePoint(String.fromCodePoint(cp)), cp, a] as const))(
    'erkennt %s',
    (name, cp, erwartet) => {
      expect(befundeIn(`const a = 'x${String.fromCodePoint(cp)}y';`)).toEqual([
        { art: erwartet, zeichen: name, zeile: 1, spalte: 13 },
      ]);
    },
  );

  it('meldet Zeile und Spalte, auch für ein BOM am Dateianfang', () => {
    expect(befundeIn('\ufeffa\nbc\u202ed\n')).toEqual([
      { art: 'format', zeichen: 'U+FEFF', zeile: 1, spalte: 1 },
      { art: 'bidi', zeichen: 'U+202E', zeile: 2, spalte: 3 },
    ]);
  });

  it('erkennt ein CR ohne LF, lässt CRLF, TAB und LF zu', () => {
    expect(befundeIn('a\r\nb\tc\n')).toEqual([]);
    expect(befundeIn('boese();\r// harmlos')).toEqual([
      { art: 'steuer', zeichen: 'U+000D', zeile: 1, spalte: 9 },
    ]);
  });

  it('lässt sichtbare Zeichen zu (Umlaute, §, –, geschütztes Leerzeichen, Emoji ohne Selektor)', () => {
    expect(befundeIn('Prüfung § 153 – „ok“ 1\u00a0000 € \u{1f600} \\u202e')).toEqual([]);
  });

  it('meldet Dateien mit NUL oder ungültigem UTF-8', () => {
    expect(befundeInDatei(Buffer.from([0x61, 0x00, 0x62]))[0]?.art).toBe('kodierung');
    expect(befundeInDatei(Buffer.from([0x61, 0xc3, 0x28]))[0]?.art).toBe('kodierung');
    expect(befundeInDatei(Buffer.from('\ufeffx', 'utf8'))[0]?.zeichen).toBe('U+FEFF');
    expect(befundeInDatei(Buffer.from('ä', 'utf8'))).toEqual([]);
  });

  it('liest binary-Endungen aus .gitattributes und weist unbekannte Muster ab', () => {
    expect([...binaerEndungen('* text=auto eol=lf\n*.png binary\n*.WOFF2 binary\n')]).toEqual([
      '.png',
      '.woff2',
    ]);
    expect(() => binaerEndungen('assets/** binary\n')).toThrow();
  });
});

describe('Repository: keine unsichtbaren oder bidirektionalen Zeichen', () => {
  const binaer = binaerEndungen(readFileSync(join(REPO_WURZEL, '.gitattributes'), 'utf8'));
  const eintraege = indexEintraege().filter((e) => e.modus !== '160000');
  const inhalte = blobInhalte(eintraege.map((e) => e.objekt));

  it('prüft eine plausible Zahl versionierter Dateien (Index lesbar)', () => {
    expect(eintraege.length).toBeGreaterThan(300);
    expect(eintraege.some((e) => e.pfad === 'packages/contract/src/bereiche/lesepfade.ts')).toBe(
      true,
    );
  });

  it('kein Befund im Index und im Arbeitsbaum (außer begründeten Ausnahmen)', () => {
    const gefunden: string[] = [];
    const genutzt = new Set<string>();
    for (const e of eintraege) {
      if (binaer.has(posix.extname(e.pfad).toLowerCase())) continue;
      const quellen: [string, Buffer][] = [['index', inhalte.get(e.objekt)!]];
      const datei = join(REPO_WURZEL, e.pfad);
      if (existsSync(datei) && lstatSync(datei).isFile()) {
        quellen.push(['arbeitsbaum', readFileSync(datei)]);
      }
      for (const [quelle, inhalt] of quellen) {
        for (const b of befundeInDatei(inhalt)) {
          const ausnahme = AUSNAHMEN[e.pfad];
          if (ausnahme?.zeichen.includes(b.zeichen)) {
            genutzt.add(`${e.pfad} ${b.zeichen}`);
            continue;
          }
          gefunden.push(`${e.pfad}:${b.zeile}:${b.spalte} ${b.art} ${b.zeichen} (${quelle})`);
        }
      }
    }
    expect([...new Set(gefunden)]).toEqual([]);
    const unnoetig = Object.entries(AUSNAHMEN).flatMap(([pfad, a]) =>
      a.zeichen.filter((z) => !genutzt.has(`${pfad} ${z}`)).map((z) => `${pfad} ${z}`),
    );
    expect(unnoetig).toEqual([]);
  });

  it('jede Ausnahme ist begründet', () => {
    for (const [pfad, a] of Object.entries(AUSNAHMEN)) {
      expect(a.begruendung.trim().length, pfad).toBeGreaterThanOrEqual(30);
      expect(a.zeichen.length, pfad).toBeGreaterThan(0);
    }
  });
});
