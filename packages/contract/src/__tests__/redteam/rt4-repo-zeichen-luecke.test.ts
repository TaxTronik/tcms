// =============================================================================
// RED TEAM RT4-T-02 — Angreifermodell D (Zeichenregel), statischer Repo-Test s5.
//
// `repo-zeichen.test.ts` soll „Trojan Source“ (CVE-2021-42574/-42694)
// verhindern und nennt ausdrücklich „unsichtbare Bezeichner“: Er sperrt
// Richtungszeichen, jedes Formatzeichen (Cf), die Hangul-Füller und die
// Variantenselektoren. Nicht erfasst sind die standardmäßig unsichtbaren
// KOMBINIERENDEN Zeichen der Kategorie Mn außerhalb der Variantenselektoren:
// U+034F (Combining Grapheme Joiner), U+17B4, U+17B5, U+180B–U+180D, U+180F.
// Sie sind in JavaScript/TypeScript gültige Fortsetzungszeichen eines
// Bezeichners (ID_Continue). Ein Beitrag kann so zwei Bezeichner einführen,
// die in Editor und Review identisch aussehen, für den Compiler aber
// verschieden sind (z. B. eine zweite, unsichtbar markierte `istAdmin`-
// Variable), ohne dass der statische Test anschlägt.
//
// Der Test ruft den Prüfer des Repo-Tests (`befundeIn`) direkt auf. Er ist rot,
// solange der Prüfer für einen dieser Code Points keinen Befund meldet, und wird
// grün, sobald er jedes Default_Ignorable-Zeichen (auch Mn) meldet.
// Die Zeichen stehen hier nur als Zahlen (keine rohen Zeichen in der Datei).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { befundeIn } from '../repo-zeichen.test';

const UNSICHTBARE_KOMBINIERENDE = [0x034f, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f];
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

describe('RT4-T-02 Repo-Zeichentest übersieht unsichtbare Bezeichnerzeichen', () => {
  it('die Zeichen sind unsichtbar und bilden für JavaScript einen anderen Bezeichner', () => {
    for (const cp of UNSICHTBARE_KOMBINIERENDE) {
      const z = String.fromCodePoint(cp);
      expect(/\p{Default_Ignorable_Code_Point}/u.test(z), hex(cp)).toBe(true);
      // Zwei „gleich aussehende“ Bindungen, zwei verschiedene Werte.
      const werte = new Function(
        `const istAdmin = false; const istAdmin${z} = true; return [istAdmin, istAdmin${z}];`,
      )() as boolean[];
      expect(werte, hex(cp)).toEqual([false, true]);
    }
  });

  it('der statische Prüfer meldet einen unsichtbar markierten Bezeichner', () => {
    const uebersehen: string[] = [];
    for (const cp of UNSICHTBARE_KOMBINIERENDE) {
      const z = String.fromCodePoint(cp);
      const quelltext = [
        'const istAdmin = pruefeRolle(akteur);',
        `const istAdmin${z} = true;`,
        `if (istAdmin${z}) gibFrei();`,
      ].join('\n');
      if (befundeIn(quelltext).length === 0) uebersehen.push(hex(cp));
    }
    // SICHERE ERWARTUNG: jeder dieser Code Points ist ein Befund (wie U+3164 oder U+FE0F).
    expect(uebersehen, 'unsichtbare Bezeichnerzeichen ohne Befund').toEqual([]);
  });
});
