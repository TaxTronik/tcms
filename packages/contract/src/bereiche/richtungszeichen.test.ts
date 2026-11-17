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
  einzeilig,
  freitext,
  KontaktRollenBodySchema,
  MandantAnkerBodySchema,
  sichtbareLaenge,
  TEXT_UNZULAESSIG,
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
  /\p{Co}/u,
  /\p{Noncharacter_Code_Point}/u,
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
  [0xe000, 0xf8ff, 'Privatnutzung'],
  [0xfdd0, 0xfdef, 'Nichtzeichen'],
  [0xfe00, 0xfe0f, 'Variantenselektoren'],
  [0xfeff, 0xfeff, 'ZWNBSP/BOM'],
  [0xffa0, 0xffa0, 'Hangul-Füller (halbbreit)'],
  [0xfffe, 0xffff, 'Nichtzeichen'],
  [0x1bca0, 0x1bca3, 'Kurzschrift-Formatzeichen'],
  [0x1d173, 0x1d17a, 'Notenschrift-Formatzeichen'],
  [0xe0000, 0xe007f, 'Tag-Zeichen'],
  [0xe0100, 0xe01ef, 'Variantenselektoren (Ergänzung)'],
  [0xf0000, 0xf0001, 'Privatnutzung (Ebene 15)'],
  [0x10fffe, 0x10ffff, 'Nichtzeichen und Privatnutzung (Ebene 16)'],
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

  it('Basisregel der Freitexte: NUL, Surrogate, Steuer-, Richtungs- und Versteckzeichen (tcms-s9)', () => {
    const in_ = (cp: number, a: number, b: number) => cp >= a && cp <= b;
    // Explizite Einbettung/Überschreibung U+202A–U+202E und Isolierung U+2066–U+2069.
    const richtung = (cp: number) => in_(cp, 0x202a, 0x202e) || in_(cp, 0x2066, 0x2069);
    const surrogat = (cp: number) => in_(cp, 0xd800, 0xdfff);
    // Steuerzeichen außer TAB, LF, CR: C0, DEL und C1 (NEL, CSI …).
    const steuer = (cp: number) =>
      (cp <= 0x1f && ![0x09, 0x0a, 0x0d].includes(cp)) || in_(cp, 0x7f, 0x9f);
    // Text verstecken oder anders umbrechen: Zeilen-/Absatztrenner, veraltete
    // Formatzeichen, BOM, Interlinear-Anmerkungen, Tag-Zeichen.
    const versteck = (cp: number) =>
      in_(cp, 0x2028, 0x2029) ||
      in_(cp, 0x206a, 0x206f) ||
      cp === 0xfeff ||
      in_(cp, 0xfff9, 0xfffb) ||
      in_(cp, 0xe0000, 0xe007f);
    const text = freitext(0, 100);
    const abweichend: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const basis = surrogat(cp) || richtung(cp) || steuer(cp) || versteck(cp);
      if (TEXT_UNZULAESSIG.test(`A${z(cp)}B`) !== basis) abweichend.push(hex(cp));
      if (cp <= 0x30000 || cp >= 0xe0000) {
        if (text.safeParse(`A${z(cp)}B`).success !== !basis) abweichend.push(`freitext ${hex(cp)}`);
      }
    }
    expect(abweichend).toEqual([]);
    // Pflichtliste der Steuerzeichen (Befund 87: ESC, BS, FF, DEL, NEL, CSI).
    for (const cp of [0x1b, 0x08, 0x0c, 0x7f, 0x85, 0x9b]) {
      expect(TEXT_UNZULAESSIG.test(z(cp)), hex(cp)).toBe(true);
    }
    // TAB, LF und CR bleiben erlaubt.
    expect(text.safeParse('A\tB\r\nC').success).toBe(true);
    // Pflichtliste der Richtungssteuerzeichen, unabhängig von der Umsetzung oben.
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(TEXT_UNZULAESSIG.test(z(cp)), hex(cp)).toBe(true);
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

// Befunde 86 und 87 (Prüfung 17.11.2026): leer wirkende Texte, Zeichenstapel,
// Mindestlängen aus unsichtbaren Zeichen, Dateinamen mit Rand- und Füllzeichen.
describe('sichtbarer Inhalt: Mindestlängen, Zeichenstapel, Dateinamen', () => {
  const zs = (cp: number, n: number) => z(cp).repeat(n);
  const text = (...cps: number[]) => cps.map(z).join('');
  const ZWSP = 0x200b;
  const BRAILLE_LEER = 0x2800;
  const OBJEKT = 0xfffc;
  const GEVIERT = 0x2003;
  const AKUT = 0x0301;
  const EMOJI = 0x1f600;
  // Vietnamesisch (vorkomponiert und zerlegt), Devanagari, Umlaut in NFD.
  const VIETNAMESISCH = `Nguy${z(0x1ec5)}n V${z(0x103)}n An`;
  const VIETNAMESISCH_NFD = `Nguye${z(0x0302)}${z(0x0303)}n`;
  const DEVANAGARI = text(0x939, 0x93f, 0x928, 0x94d, 0x926, 0x940, 0x20, 0x915, 0x902, 0x92a);

  it('sichtbareLaenge zählt weder Unsichtbares noch Platzhalter, Leerraumfolgen einfach', () => {
    expect(sichtbareLaenge('abc')).toBe(3);
    expect(sichtbareLaenge(`a${zs(ZWSP, 28)}b`)).toBe(2);
    expect(sichtbareLaenge(zs(BRAILLE_LEER, 30))).toBe(0);
    expect(sichtbareLaenge(zs(OBJEKT, 5))).toBe(0);
    expect(sichtbareLaenge(`a${zs(0x20, 28)}b`)).toBe(3);
    expect(sichtbareLaenge('Satz eins.\n\nSatz zwei.')).toBe(21);
    // Emoji außerhalb der BMP zählen je einmal, ZWJ nicht.
    expect(sichtbareLaenge(text(0x1f468, 0x200d, 0x1f469))).toBe(2);
  });

  it('Begründungen ab 30 Zeichen: unsichtbare Zeichen und Platzhalter erfüllen die Mindestlänge nicht', () => {
    const begruendung = freitext(30, 2000);
    expect(begruendung.safeParse(`a${zs(ZWSP, 28)}b`).success).toBe(false);
    expect(begruendung.safeParse(zs(BRAILLE_LEER, 30)).success).toBe(false);
    expect(begruendung.safeParse(`a${zs(0x20, 28)}b`).success).toBe(false);
    const r = begruendung.safeParse(`a${zs(ZWSP, 28)}b`);
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      'Mindestens 30 sichtbare Zeichen',
    ]);
    // Gültige Begründungen bleiben gültig (auch mit Zeilenumbruch und Emoji).
    expect(begruendung.safeParse('Die Prüfung ergab keinen Befund.').success).toBe(true);
    expect(begruendung.safeParse(`Befund im Q3:\nkeine Abweichung ${z(EMOJI)} ok.`).success).toBe(
      true,
    );
    // Zu kurz: nur die eine Meldung der Längenprüfung.
    const kurz = begruendung.safeParse('zu kurz');
    expect(kurz.success ? 0 : kurz.error.issues.length).toBe(1);
  });

  it('Freitexte nehmen Tag-Zeichen nur in einer Emoji-Flagge an (kein Tag-Schmuggel)', () => {
    const frei = freitext(1, 200);
    // Schottland: U+1F3F4, Tags g b s c t, Tag-Ende.
    const schottland = text(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
    expect(frei.safeParse(`Team ${schottland}`).success).toBe(true);
    // Unsichtbare ASCII-Kopie „hi“ hinter sichtbarem Text, mit und ohne Flagge davor.
    expect(frei.safeParse(`Hallo${text(0xe0068, 0xe0069)}`).success).toBe(false);
    expect(frei.safeParse(`Hallo${text(0x1f3f4, 0xe0068)}`).success).toBe(false);
  });

  it('einzeilige Texte: nicht leer wirkend, ohne Zeichenstapel', () => {
    const titel = einzeilig(5, 200);
    for (const wert of [
      zs(BRAILLE_LEER, 5),
      zs(0x0300, 5),
      zs(OBJEKT, 5),
      `a${zs(AKUT, 199)}`,
      `${z(AKUT)}abcde`,
      `ab${zs(AKUT, 5)}cde`,
    ]) {
      expect(titel.safeParse(wert).success, JSON.stringify(wert)).toBe(false);
    }
    const anker = MandantAnkerBodySchema.safeParse({ name: z(BRAILLE_LEER), rechtsform: 'KG' });
    expect(anker.success).toBe(false);
    for (const wert of [VIETNAMESISCH, VIETNAMESISCH_NFD, DEVANAGARI, `Mu${z(0x0308)}ller GmbH`]) {
      expect(titel.safeParse(wert).success, JSON.stringify(wert)).toBe(true);
    }
  });

  it('Dateinamen: Rand, Punkt am Ende, Füllzeichen, Stapel, Länge – eine Regel für Anlage und Nachweis', () => {
    const anlage = (dateiname: string) =>
      AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success;
    for (const dateiname of [
      ' beleg.pdf',
      'beleg.pdf ',
      'beleg.pdf.',
      ' ..',
      '. .',
      '...',
      `rechnung.pdf${zs(GEVIERT, 60)}.exe`,
      `rechnung.pdf${zs(0x20, 4)}.exe`,
      z(BRAILLE_LEER),
      `a${zs(AKUT, 5)}.pdf`,
      `${z(0xe000)}.pdf`,
      `a${z(0xfffe)}.pdf`,
      // Länge: 128 Emoji sind 256 UTF-16-Einheiten (für Anlage und Nachweis gleich).
      zs(EMOJI, 128),
    ]) {
      expect(anlage(dateiname), JSON.stringify(dateiname)).toBe(false);
      expect(gueltigerNachweisDateiname(dateiname), JSON.stringify(dateiname)).toBe(false);
    }
    for (const dateiname of [
      'Rechnung  2026.pdf',
      '.htaccess',
      'a'.repeat(255),
      zs(EMOJI, 127),
      `Bericht ${z(EMOJI)}.pdf`,
      `${VIETNAMESISCH}.pdf`,
    ]) {
      expect(anlage(dateiname), JSON.stringify(dateiname)).toBe(true);
      expect(gueltigerNachweisDateiname(dateiname), JSON.stringify(dateiname)).toBe(true);
    }
  });

  it('gespeicherte Anlagen bleiben nach der früheren Regel lesbar (auch 255 Emoji)', () => {
    for (const dateiname of [' beleg.pdf', 'beleg.pdf.', zs(EMOJI, 255)]) {
      expect(AnlageGespeichertSchema.safeParse({ ...VERWEIS, dateiname }).success).toBe(true);
    }
  });
});
