// =============================================================================
// Unzulässige Zeichen in einzeiligen Stammdaten und Dateinamen (Anzeige-
// Spoofing, „Trojan Source"): Eine Regel (`UNZULAESSIGE_ZEICHEN`,
// `DATEINAME_UNZULAESSIG` in lesepfade.ts) gilt für `einzeilig` (Anker,
// Kontaktfunktion), Dateinamen von Ereignis-Anlagen (`AnlageVerweisSchema`)
// und Nachweisen (`gueltigerNachweisDateiname`). Der Test prüft jeden Code
// Point der BMP (ohne Surrogate) und die Tag-Zeichen samt Nachbarn gegen eine
// hier ausdrücklich aufgeschriebene Liste – unabhängig von der Umsetzung.
// Gespeicherte Ereignis-Anlagen in Antworten (`AnlageGespeichertSchema`,
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
import { KontaktRollenBodySchema, MandantAnkerBodySchema } from './lesepfade';

const z = (cp: number) => String.fromCodePoint(cp);

/** Erwartet unzulässig in einzeiligen Texten und Dateinamen (Bereiche, je inklusive). */
const UNZULAESSIG: readonly [number, number, string][] = [
  [0x0000, 0x001f, 'C0-Steuerzeichen'],
  [0x007f, 0x009f, 'DEL und C1-Steuerzeichen'],
  [0x00ad, 0x00ad, 'weiches Trennzeichen'],
  [0x061c, 0x061c, 'ALM'],
  [0x115f, 0x1160, 'Hangul-Füller'],
  [0x180e, 0x180e, 'Mongolischer Vokaltrenner'],
  [0x200b, 0x200d, 'ZWSP, ZWNJ, ZWJ'],
  [0x200e, 0x200f, 'LRM, RLM'],
  [0x2028, 0x2029, 'Zeilen- und Absatztrenner'],
  [0x202a, 0x202e, 'Einbettung, Überschreibung'],
  [0x2060, 0x2064, 'Wortverbinder, unsichtbare Operatoren'],
  [0x2066, 0x2069, 'Isolierung'],
  [0x3164, 0x3164, 'Hangul-Füller'],
  [0xfeff, 0xfeff, 'ZWNBSP/BOM'],
  [0xffa0, 0xffa0, 'Hangul-Füller (halbbreit)'],
  [0xe0000, 0xe007f, 'Tag-Zeichen'],
];
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

const unzulaessig = (cp: number) => UNZULAESSIG.some(([a, b]) => cp >= a && cp <= b);

/** Alle BMP-Code-Points ohne Surrogate, dazu Tag-Zeichen, Nachbarn und Beispiele außerhalb. */
function codePoints(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0xffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) out.push(cp);
  for (let cp = 0xdffff; cp <= 0xe0080; cp += 1) out.push(cp);
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
  it('einzeilig (Anker, Kontaktfunktion) weist genau die Liste ab', () => {
    const abweichend: string[] = [];
    for (const cp of codePoints()) {
      const text = `A${z(cp)}B`;
      const erwartet = !unzulaessig(cp);
      const anker = MandantAnkerBodySchema.safeParse({ name: text, rechtsform: 'GmbH' }).success;
      const funktion = KontaktRollenBodySchema.safeParse({
        kontaktId: '11111111-1111-4111-8111-111111111111',
        rollen: [],
        funktion: text,
      }).success;
      if (anker !== erwartet || funktion !== erwartet) abweichend.push(cp.toString(16));
    }
    expect(abweichend).toEqual([]);
  });

  it('Dateinamen (Ereignis-Anlage, Nachweis) weisen die Liste und Pfadtrenner ab', () => {
    const abweichend: string[] = [];
    for (const cp of codePoints()) {
      const dateiname = `a${z(cp)}b.pdf`;
      const erwartet = !unzulaessig(cp) && !PFADTRENNER.includes(cp);
      const anlage = AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success;
      const nachweis = gueltigerNachweisDateiname(dateiname);
      if (anlage !== erwartet || nachweis !== erwartet) abweichend.push(cp.toString(16));
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
        abweichend.push(cp.toString(16));
      }
    }
    expect(abweichend).toEqual([]);
    // Neue Verweise bleiben streng: LRM und ZWSP nur in gespeicherten Namen lesbar.
    for (const cp of [0x200e, 0x200b]) {
      const dateiname = `a${z(cp)}b.pdf`;
      expect(AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success).toBe(false);
      expect(AnlageGespeichertSchema.safeParse({ ...VERWEIS, dateiname }).success).toBe(true);
    }
  });

  it('lässt übliche Namen zu (Umlaute, Akzente, Leerzeichen, Emoji)', () => {
    for (const name of ['Müller & Söhne', 'Café Crème', 'A B']) {
      expect(MandantAnkerBodySchema.safeParse({ name, rechtsform: 'KG' }).success, name).toBe(true);
    }
    for (const dateiname of ['Prüfung 2026.pdf', `Bericht ${z(0x1f600)}.pdf`]) {
      expect(AnlageVerweisSchema.safeParse({ ...VERWEIS, dateiname }).success, dateiname).toBe(
        true,
      );
      expect(gueltigerNachweisDateiname(dateiname), dateiname).toBe(true);
    }
  });
});
