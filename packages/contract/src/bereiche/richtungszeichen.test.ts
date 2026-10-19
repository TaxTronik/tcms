// =============================================================================
// Unzulässige Zeichen in einzeiligen Stammdaten und Dateinamen (Anzeige-
// Spoofing, „Trojan Source"): Eine Regel (`UNZULAESSIGE_ZEICHEN`,
// `DATEINAME_UNZULAESSIG` in lesepfade.ts) gilt für `einzeilig` (Anker,
// Kontaktfunktion, Titel und Namen), Dateinamen von Ereignis-Anlagen
// (`AnlageVerweisSchema`) und Nachweisen (`gueltigerNachweisDateiname`).
//
// Seit RT4-T-01 folgt die Regel aus Unicode-Eigenschaften. Der Test prüft sie
// zweifach unabhängig von der Umsetzung: (1) gegen die Eigenschaften, je für
// sich abgefragt, für jeden Code Point (Regex) bzw. für die BMP, die
// Tag-Zeichen, die übrigen unsichtbaren Bereiche und Stichproben außerhalb
// (Schemas); (2) gegen eine hier ausdrücklich aufgeschriebene Pflichtliste,
// die nie durchgehen darf – auch wenn eine Laufzeit die Eigenschaften anders
// führte. Gespeicherte Ereignis-Anlagen in Antworten (`AnlageGespeichertSchema`,
// Detail `AnlageSchema`, `ereignisAnlageLesen`) prüft nur die frühere Regel,
// damit Namen aus dem unveränderlichen Meldungs-Audit lesbar bleiben.
// Die Code Points stehen nur als Zahlen im Test (keine rohen Zeichen).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { gueltigerNachweisDateiname } from './durchfuehrung';
import { ENDPUNKTE } from '../endpunkte';
import {
  AnlageGespeichertSchema,
  AnlageSchema,
  AnlageVerweisSchema,
} from './feststellungen-ereignisse';
import {
  DATEINAME_UNZULAESSIG,
  KontaktRollenBodySchema,
  MandantAnkerBodySchema,
  UNZULAESSIGE_ZEICHEN,
} from './lesepfade';

const z = (cp: number) => String.fromCodePoint(cp);
const hex = (cp: number) => cp.toString(16);

/** Unzulässig nach Unicode-Eigenschaften, jede Eigenschaft einzeln abgefragt. */
const EIGENSCHAFTEN = [
  /\p{Cc}/u,
  /\p{Cf}/u,
  /\p{Zl}/u,
  /\p{Zp}/u,
  /\p{Default_Ignorable_Code_Point}/u,
  /\p{Cs}/u,
];
const unzulaessig = (cp: number) => EIGENSCHAFTEN.some((r) => r.test(z(cp)));

/**
 * Pflichtliste (Bereiche, je inklusive): die frühere Liste und die Lücken aus
 * RT4-T-01. Jeder dieser Code Points ist unzulässig, unabhängig von der Regel.
 */
const PFLICHT: readonly [number, number, string][] = [
  [0x0000, 0x001f, 'C0-Steuerzeichen'],
  [0x007f, 0x009f, 'DEL und C1-Steuerzeichen'],
  [0x00ad, 0x00ad, 'weiches Trennzeichen'],
  [0x034f, 0x034f, 'Combining Grapheme Joiner'],
  [0x061c, 0x061c, 'ALM'],
  [0x115f, 0x1160, 'Hangul-Füller'],
  [0x17b4, 0x17b5, 'Khmer, unsichtbare Vokale'],
  [0x180b, 0x180f, 'Mongolische Variantenselektoren und Vokaltrenner'],
  [0x200b, 0x200d, 'ZWSP, ZWNJ, ZWJ'],
  [0x200e, 0x200f, 'LRM, RLM'],
  [0x2028, 0x2029, 'Zeilen- und Absatztrenner'],
  [0x202a, 0x202e, 'Einbettung, Überschreibung'],
  [0x2060, 0x2064, 'Wortverbinder, unsichtbare Operatoren'],
  [0x2066, 0x2069, 'Isolierung'],
  [0x206a, 0x206f, 'veraltete Formatzeichen'],
  [0x3164, 0x3164, 'Hangul-Füller'],
  [0xfe00, 0xfe0f, 'Variantenselektoren'],
  [0xfeff, 0xfeff, 'ZWNBSP/BOM'],
  [0xffa0, 0xffa0, 'Hangul-Füller (halbbreit)'],
  [0x1bca0, 0x1bca3, 'Kurzschrift-Formatzeichen'],
  [0x1d173, 0x1d17a, 'Notenschrift-Formatzeichen'],
  [0xe0000, 0xe007f, 'Tag-Zeichen'],
  [0xe0100, 0xe01ef, 'Variantenselektoren (Ergänzung)'],
];
const pflicht = (cp: number) => PFLICHT.some(([a, b]) => cp >= a && cp <= b);

/** Nur in Dateinamen zusätzlich: Pfadtrenner. */
const PFADTRENNER = [0x2f, 0x5c];
/** Frühere Eingaberegel für Anlagen; gilt für gespeicherte Namen in Antworten. */
const FRUEHER_UNZULAESSIG: readonly [number, number][] = [
  [0x0000, 0x001f],
  [0x002f, 0x002f],
  [0x005c, 0x005c],
  [0x007f, 0x007f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/**
 * BMP ohne Surrogate, die Ebenen mit unsichtbaren oder Format-Zeichen
 * außerhalb (Kurzschrift, Notenschrift, Hieroglyphen-Format, Kaithi, Tags und
 * Variantenselektoren) samt Nachbarn und Stichproben.
 */
function codePoints(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0xffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) out.push(cp);
  for (const [a, b] of [
    [0x110b0, 0x110d0],
    [0x13420, 0x13460],
    [0x1bc90, 0x1bcb0],
    [0x1d160, 0x1d190],
    [0xdffff, 0xe1000],
  ] as const) {
    for (let cp = a; cp <= b; cp += 1) out.push(cp);
  }
  out.push(0x10000, 0x1f600, 0x1f1e9, 0x10ffff);
  return out;
}

const VERWEIS = {
  dokumentId: 'ab/0123',
  mime: 'application/pdf',
  groesse: 1,
  sha256: 'a'.repeat(64),
};

describe('unzulässige Zeichen: eine Regel für Stammdaten und Dateinamen', () => {
  it('die Regel ist genau die Vereinigung der Eigenschaften, für jeden Code Point', () => {
    const abweichend: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      // Einzelne Surrogate nur als eigene Zeichenkette (String.fromCodePoint liefert sie).
      const erwartet = unzulaessig(cp);
      if (UNZULAESSIGE_ZEICHEN.test(`A${z(cp)}B`) !== erwartet) abweichend.push(hex(cp));
      if (DATEINAME_UNZULAESSIG.test(`a${z(cp)}b`) !== (erwartet || PFADTRENNER.includes(cp))) {
        abweichend.push(`datei ${hex(cp)}`);
      }
    }
    expect(abweichend).toEqual([]);
  });

  it('jeder Code Point der Pflichtliste ist unzulässig (auch unabhängig von der Laufzeit)', () => {
    const durch: string[] = [];
    for (const [a, b] of PFLICHT) {
      for (let cp = a; cp <= b; cp += 1) {
        if (!unzulaessig(cp)) durch.push(`Eigenschaft ${hex(cp)}`);
        if (!UNZULAESSIGE_ZEICHEN.test(z(cp))) durch.push(hex(cp));
      }
    }
    expect(durch).toEqual([]);
  });

  it('einzelne Surrogate sind unzulässig, Paare (Emoji) nicht', () => {
    for (const s of ['\ud800', '\udbff', '\udc00', '\udfff', 'a\ud83d', '\ude00b']) {
      expect(UNZULAESSIGE_ZEICHEN.test(s), JSON.stringify(s)).toBe(true);
    }
    expect(UNZULAESSIGE_ZEICHEN.test('😀')).toBe(false);
  });

  it('einzeilig (Anker, Kontaktfunktion) weist genau die Regel ab', () => {
    const abweichend: string[] = [];
    for (const cp of codePoints()) {
      const text = `A${z(cp)}B`;
      const erwartet = !unzulaessig(cp) && !pflicht(cp);
      const anker = MandantAnkerBodySchema.safeParse({ name: text, rechtsform: 'GmbH' }).success;
      const funktion = KontaktRollenBodySchema.safeParse({
        kontaktId: '11111111-1111-4111-8111-111111111111',
        rollen: [],
        funktion: text,
      }).success;
      if (anker !== erwartet || funktion !== erwartet) abweichend.push(hex(cp));
    }
    expect(abweichend).toEqual([]);
  });

  it('Dateinamen (Ereignis-Anlage, Nachweis) weisen die Regel und Pfadtrenner ab', () => {
    const abweichend: string[] = [];
    for (const cp of codePoints()) {
      const dateiname = `a${z(cp)}b.pdf`;
      const erwartet = !unzulaessig(cp) && !pflicht(cp) && !PFADTRENNER.includes(cp);
      const anlage = AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success;
      const nachweis = gueltigerNachweisDateiname(dateiname);
      if (anlage !== erwartet || nachweis !== erwartet) abweichend.push(hex(cp));
    }
    expect(abweichend).toEqual([]);
  });

  it('gespeicherte Anlagen (Antworten) prüfen nur die frühere Regel', () => {
    const abweichend: string[] = [];
    const antwort = ENDPUNKTE.ereignisAnlageLesen.antwortSchema;
    for (const cp of codePoints()) {
      const dateiname = `a${z(cp)}b.pdf`;
      const erwartet = !FRUEHER_UNZULAESSIG.some(([a, b]) => cp >= a && cp <= b);
      const { dokumentId: _d, ...ohneId } = VERWEIS;
      const gespeichert = AnlageGespeichertSchema.safeParse({ ...VERWEIS, dateiname }).success;
      const detail = AnlageSchema.safeParse({ ...ohneId, dateiname }).success;
      const endpunkt = antwort.safeParse({ ...VERWEIS, dateiname }).success;
      if (gespeichert !== erwartet || detail !== erwartet || endpunkt !== erwartet) {
        abweichend.push(hex(cp));
      }
    }
    expect(abweichend).toEqual([]);
    // Neue Verweise bleiben streng: LRM, ZWSP und Variantenselektor nur in gespeicherten Namen lesbar.
    for (const cp of [0x200e, 0x200b, 0xfe0f]) {
      const dateiname = `a${z(cp)}b.pdf`;
      expect(AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success).toBe(false);
      expect(AnlageGespeichertSchema.safeParse({ ...VERWEIS, dateiname }).success).toBe(true);
    }
  });

  it('lässt übliche Namen zu (Umlaute, Akzente, Leerzeichen, Emoji ohne Selektor)', () => {
    for (const name of ['Müller & Söhne', 'Café Crème', 'A B', 'Łódź Sp. z o.o.', 'Ελληνικά']) {
      expect(MandantAnkerBodySchema.safeParse({ name, rechtsform: 'KG' }).success, name).toBe(true);
    }
    for (const dateiname of ['Prüfung 2026.pdf', `Bericht ${z(0x1f600)}.pdf`, 'a b.pdf']) {
      expect(AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success, dateiname).toBe(
        true,
      );
      expect(gueltigerNachweisDateiname(dateiname), dateiname).toBe(true);
    }
  });
});
