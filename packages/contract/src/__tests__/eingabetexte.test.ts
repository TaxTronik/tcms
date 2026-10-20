// =============================================================================
// Texte in Eingaben, geprüft über das ganze Endpunktregister (jedes
// Zeichenkettenfeld in Body, Query und Pfadparametern), damit ein neues Feld
// die Regeln nicht still umgeht:
//
//   - RT4-T-03: Titel und Namen (Feldname `titel`, `name`, `rechtsform`,
//     `funktion`) sowie die übrigen einzeiligen Bezeichnungen (Teilbereich,
//     Geschäftsprofil) sind einzeilig – ohne CR, LF, TAB, Richtungs-,
//     Nullbreiten- und unsichtbare Zeichen (`einzeilig`, Zeichenregel).
//     Dasselbe gilt für die Vorlagendaten der Nachrichten (`nachrichtTitel`).
//   - RT4-T-08: Jede Zeichenkette (auch mehrzeilige Freitexte) weist NUL und
//     einzelne Surrogate ab (`TEXT_UNZULAESSIG`, `mitTextBasis`), damit keine
//     vertragsgültige Eingabe erst beim Speichern scheitert (500).
//   - tcms-s9: Jede Zeichenkette weist die expliziten Richtungssteuerzeichen
//     U+202A–U+202E und U+2066–U+2069 ab (Anzeigefälschung in Inhalten mit
//     Beweiswert); ZWJ und Variantenselektoren bleiben in mehrzeiligen Texten
//     erlaubt. Antworten mit gespeicherten Texten nehmen sie an (Altbestand).
//
// Ein Feld gilt als geprüft, wenn ein harmloser Wert passender Länge
// angenommen und derselbe Wert mit dem Störzeichen in der Mitte abgewiesen
// wird. Felder mit festem Format (UUID, ID, Datum, Enum), die schon den
// harmlosen Wert abweisen, lassen Störzeichen erst recht nicht zu.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ENDPUNKT_LISTE } from '../endpunkte';
import { TEXT_UNZULAESSIG_MELDUNG } from '../bereiche/lesepfade';
import {
  NachrichtDatenEreignisGemeldetSchema,
  NachrichtDatenFreigabeAngefordertSchema,
  NachrichtDatenFreigabeCodeSchema,
  OffeneNachrichtSchema,
} from '../bereiche/programm-beschreibung';
import { ProfilAntwortenGespeichertSchema } from '../bereiche/risiken-kontrollen';

export interface Blatt {
  pfad: string;
  schluessel: string;
  schema: z.ZodType;
}

type Def = Record<string, unknown> & { type: string };
const def = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Alle Zeichenketten-Blätter eines Schemas mit Pfad und letztem Objektschlüssel. */
export function zeichenkettenBlaetter(wurzel: z.ZodType, praefix: string): Blatt[] {
  const out: Blatt[] = [];
  const stapel = new Set<z.ZodType>();
  const gehe = (s: z.ZodType, pfad: string, schluessel: string) => {
    if (stapel.has(s)) return; // Zyklus (lazy)
    stapel.add(s);
    const d = def(s);
    switch (d.type) {
      case 'string':
        out.push({ pfad, schluessel, schema: s });
        break;
      case 'object':
        for (const [k, v] of Object.entries(d['shape'] as Record<string, z.ZodType>)) {
          gehe(v, `${pfad}.${k}`, k);
        }
        break;
      case 'array':
        gehe(d['element'] as z.ZodType, `${pfad}[]`, schluessel);
        break;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
        gehe(d['innerType'] as z.ZodType, pfad, schluessel);
        break;
      case 'union':
        (d['options'] as z.ZodType[]).forEach((o, i) => gehe(o, `${pfad}|${i}`, schluessel));
        break;
      case 'pipe':
        gehe(d['in'] as z.ZodType, pfad, schluessel);
        break;
      case 'record':
        gehe(d['keyType'] as z.ZodType, `${pfad}{schluessel}`, schluessel);
        gehe(d['valueType'] as z.ZodType, `${pfad}{}`, schluessel);
        break;
      case 'tuple':
        (d['items'] as z.ZodType[]).forEach((o, i) => gehe(o, `${pfad}[${i}]`, schluessel));
        break;
      case 'lazy':
        gehe((d['getter'] as () => z.ZodType)(), pfad, schluessel);
        break;
      case 'intersection':
        gehe(d['left'] as z.ZodType, pfad, schluessel);
        gehe(d['right'] as z.ZodType, pfad, schluessel);
        break;
      default:
        break;
    }
    stapel.delete(s);
  };
  gehe(wurzel, praefix, '');
  return out;
}

/** Alle Eingabe-Blätter des Endpunktregisters (Body, Query, Pfadparameter). */
export function eingabeBlaetter(): Blatt[] {
  const out: Blatt[] = [];
  for (const e of ENDPUNKT_LISTE) {
    for (const [art, s] of [
      ['body', e.bodySchema],
      ['query', e.querySchema],
      ['params', e.paramsSchema],
    ] as const) {
      if (s) out.push(...zeichenkettenBlaetter(s as z.ZodType, `${e.name} ${art}`));
    }
  }
  return out;
}

/** Harmloser Wert passender Länge; `null`, wenn das Feld ein festes Format hat. */
export function harmlos(b: Blatt): string | null {
  const s = b.schema as unknown as { minLength: number | null; maxLength: number | null };
  const laenge = Math.min(Math.max(s.minLength ?? 0, 9), s.maxLength ?? 1000);
  const wert = 'Abcdefghijklmnopqrstuvwxyz'.repeat(40).slice(0, laenge);
  return laenge >= 3 && b.schema.safeParse(wert).success ? wert : null;
}

/** Derselbe Wert mit `stoer` in der Mitte. */
export function gestoert(wert: string, stoer: string): string {
  const m = Math.floor(wert.length / 2);
  return wert.slice(0, m) + stoer + wert.slice(m + 1);
}

/** Störzeichen einzeiliger Texte (Zeichen nur als Escape). */
const EINZEILIG_STOER: Record<string, string> = {
  LF: '\n',
  CR: '\r',
  TAB: '\t',
  RLO: '\u202e',
  ZWSP: '\u200b',
  VS16: '\ufe0f',
  'U+034F': '\u034f',
  NUL: '\u0000',
  Surrogat: '\ud800',
};

/** Feldnamen, die immer einzeilig sind (Titel und Namen, Stammdaten). */
const NAMEN_UND_TITEL = new Set(['titel', 'name', 'rechtsform', 'funktion']);
/** Weitere einzeilige Bezeichnungen (Teilbereich, Geschäftsprofil). */
const BEZEICHNUNGEN = new Set([
  'einschluesse',
  'ausschluesse',
  'shopSystem',
  'marktplaetze',
  'zollabwicklung',
  'zahlungswege',
  'art',
  'version',
  'anbieter',
]);

function einzeiligVerletzt(b: Blatt): string[] {
  const wert = harmlos(b);
  if (wert === null) return [];
  return Object.entries(EINZEILIG_STOER)
    .filter(([, z]) => b.schema.safeParse(gestoert(wert, z)).success)
    .map(([name]) => `${b.pfad} nimmt ${name} an`);
}

describe('Eingaben: Titel und Namen sind einzeilig (RT4-T-03)', () => {
  const blaetter = eingabeBlaetter();

  it('findet die Titel- und Namensfelder des Registers', () => {
    const titel = blaetter.filter((b) => NAMEN_UND_TITEL.has(b.schluessel) && harmlos(b));
    // Feststellung (3 Wege), Ereignis, Portal-Meldung, Benachrichtigung, Anker,
    // Kontaktfunktion, Verantwortung, Namen, Aufnahme, Teilbereich, Profil.
    expect(titel.length).toBeGreaterThanOrEqual(20);
    for (const p of [
      'feststellungErfassen body.titel',
      'ereignisErfassen body.titel',
      'portalMeldungErfassen body.titel',
      'portalMeldungErfassen body.benachrichtigen.name',
      'folgenAnlegen body.folgen[].feststellung.titel',
      'durchfuehrungGegenzeichnen body.feststellung.titel',
      'beschreibungsfreigabeAnfordern body.verantwortung.berufstraeger.name',
      'beschreibungsfreigabeAnfordern body.verantwortung.bearbeitung.name',
      'beschreibungsfreigabeAnfordern body.namen[].name',
      'profilRisikoAufnehmen body.verantwortliche.hauptbearbeitung.name',
      'einrichtungEntwurfSpeichern body|0.daten.teilbereich.name',
      'profilAendern body.profil.p4.warengruppen[].name',
    ]) {
      expect(
        titel.map((b) => b.pfad),
        p,
      ).toContain(p);
    }
  });

  it('jedes Titel- und Namensfeld weist Zeilenumbruch, TAB, Richtungs- und unsichtbare Zeichen ab', () => {
    const verletzt = blaetter
      .filter((b) => NAMEN_UND_TITEL.has(b.schluessel) || BEZEICHNUNGEN.has(b.schluessel))
      .flatMap(einzeiligVerletzt);
    expect(verletzt).toEqual([]);
  });

  it('Vorlagendaten der Nachrichten: Titel, Art und Nummer einzeilig (beim Anlegen und Ausliefern)', () => {
    const verletzt = [
      NachrichtDatenFreigabeAngefordertSchema,
      NachrichtDatenFreigabeCodeSchema,
      NachrichtDatenEreignisGemeldetSchema,
    ]
      .flatMap((s, i) => zeichenkettenBlaetter(s, `daten${i}`))
      .filter((b) => ['titel', 'typ', 'nummer'].includes(b.schluessel))
      .flatMap(einzeiligVerletzt);
    expect(verletzt).toEqual([]);
    const offen = zeichenkettenBlaetter(OffeneNachrichtSchema, 'offen').filter(
      (b) => b.schluessel === 'titel',
    );
    expect(offen.length).toBe(4);
    expect(offen.flatMap(einzeiligVerletzt)).toEqual([]);
  });

  it('gespeicherte Profile bleiben lesbar (Bezeichnungen ohne Zeichenregel)', () => {
    const blaetterGespeichert = zeichenkettenBlaetter(ProfilAntwortenGespeichertSchema, 'profil');
    const name = blaetterGespeichert.find((b) => b.pfad === 'profil.p4.warengruppen[].name')!;
    expect(name.schema.safeParse('Bücher\u202e').success).toBe(true);
  });
});

/**
 * Mehrzeilige Freitexte des Registers (nehmen Zeilenumbruch, TAB, ZWJ und
 * Variantenselektoren an): Begründungen, Kommentare, Sachverhalte,
 * Beschreibungen, Nachweise und Abschnittstexte – Prosa mit Beweiswert. Jedes
 * andere freie Textfeld ist einzeilig (tcms-s10). Ein neues mehrzeiliges Feld
 * gehört bewusst hierher; sonst scheitert der Test.
 */
const MEHRZEILIG = new Set([
  'durchfuehrungSpeichern body.schritte[].kommentar',
  'durchfuehrungSpeichern body.werte[].bemerkung', // Erläuterung einer Abweichung
  'durchfuehrungSpeichern body.ergebnisKommentar',
  'durchfuehrungZurueckweisen body.begruendung',
  'durchfuehrungGegenzeichnen body.feststellung.sachverhalt',
  'entfallenBeantragen body.begruendung',
  'entfallenAblehnen body.begruendung',
  'nachtragAnlegen body.begruendung',
  'portalAufgabeSpeichern body.schritte[].kommentar',
  'portalAufgabeSpeichern body.werte[].bemerkung',
  'portalAufgabeSpeichern body.ergebnisKommentar',
  'portalAufgabeZurueckgeben body.begruendung',
  'risikoNeuBewerten body.begruendung',
  'risikoBewertungBestaetigen body.begruendung',
  'uebersteuerungBeantragen body.begruendung',
  'uebersteuerungEntscheiden body.begruendung',
  'risikoZurueckweisen body.begruendung',
  'risikoakzeptanzAnfordern body.begruendung',
  'kontrolleDesignBeurteilen body.begruendung',
  'frequenzAbweichungBeantragen body.begruendung',
  'frequenzAbweichungEntscheiden body.begruendung',
  'frequenzAbweichungAufheben body.begruendung',
  'feststellungErfassen body.sachverhalt',
  'p153Entscheiden body.begruendung',
  'wuerdigungAktualisieren body.ursache',
  'massnahmeAnlegen body.beschreibung',
  'feststellungVerwerfenBeantragen body.begruendung',
  'massnahmeErledigen body.nachweis',
  'ereignisErfassen body.beschreibung',
  'folgeHinzufuegen body.text',
  'folgeVerwerfen body.begruendung',
  'ereignisVerwerfenBeantragen body.begruendung',
  'portalMeldungErfassen body.beschreibung',
  'einrichtungEntwurfSpeichern body|0.daten.teilbereich.abgrenzung',
  'einrichtungEntwurfSpeichern body|2.daten.ziele[].text',
  'einrichtungEntwurfSpeichern body|3.daten.risiken{}.begruendung',
  'beschreibungsabschnittSpeichern body.bloecke[]|0.text',
  'beschreibungsreviewZurueckweisen body.begruendung',
]);

describe('Eingaben: einzeilig, außer den ausdrücklich mehrzeiligen Freitexten (tcms-s10)', () => {
  const blaetter = eingabeBlaetter();
  const frei = blaetter.filter((b) => harmlos(b) !== null);

  it('jedes freie Textfeld außerhalb der Liste ist einzeilig (ganzes Register)', () => {
    expect(frei.filter((b) => !MEHRZEILIG.has(b.pfad)).flatMap(einzeiligVerletzt)).toEqual([]);
  });

  it('die Liste nennt nur mehrzeilige Felder, die es gibt', () => {
    const mehrzeilig = new Set(
      frei
        .filter((b) => b.schema.safeParse(gestoert(harmlos(b)!, '\n')).success)
        .map((b) => b.pfad),
    );
    expect([...MEHRZEILIG].filter((p) => !mehrzeilig.has(p))).toEqual([]);
  });

  it('Steuerart, Land und Zeitraum einer Erklärung sowie die Quellangabe sind einzeilig', () => {
    const pfade = [
      'erklaerungHinzufuegen body.steuerart',
      'erklaerungHinzufuegen body.land',
      'erklaerungHinzufuegen body.zeitraum',
      'feststellungErfassen body.quelleText',
    ];
    const felder = frei.filter((b) => pfade.includes(b.pfad));
    expect(felder.map((b) => b.pfad).sort()).toEqual([...pfade].sort());
    expect(felder.flatMap(einzeiligVerletzt)).toEqual([]);
  });

  it('gespeicherte Erklärungen und Quellangaben bleiben lesbar (Antwort ohne Zeichenregel)', () => {
    const altbestand = ENDPUNKT_LISTE.flatMap((e) =>
      zeichenkettenBlaetter(e.antwortSchema as z.ZodType, `${e.name} antwort`),
    ).filter(
      (b) =>
        (b.pfad.includes('.erklaerungen[].') &&
          ['steuerart', 'land', 'zeitraum'].includes(b.schluessel)) ||
        b.schluessel === 'quelleText',
    );
    expect(altbestand.length).toBeGreaterThanOrEqual(5);
    for (const b of altbestand) {
      expect(b.schema.safeParse('USt\n2024 \u202e alt').success, b.pfad).toBe(true);
    }
  });
});

describe('Eingaben: jede Zeichenkette ohne NUL und einzelne Surrogate (RT4-T-08)', () => {
  const blaetter = eingabeBlaetter();

  it('prüft eine plausible Zahl freier Textfelder', () => {
    const frei = blaetter.filter((b) => harmlos(b) !== null);
    expect(frei.length).toBeGreaterThanOrEqual(80);
    for (const p of [
      'durchfuehrungSpeichern body.schritte[].kommentar',
      'portalAufgabeSpeichern body.schritte[].kommentar',
      'beschreibungsabschnittSpeichern body.bloecke[]|0.text',
      'risikoNeuBewerten body.begruendung',
      'einrichtungEntwurfSpeichern body|0.daten.teilbereich.abgrenzung',
    ]) {
      expect(
        frei.map((b) => b.pfad),
        p,
      ).toContain(p);
    }
  });

  it('kein Feld nimmt NUL, ein einzelnes hohes oder tiefes Surrogat an', () => {
    const verletzt: string[] = [];
    for (const b of blaetter) {
      const wert = harmlos(b);
      if (wert === null) continue;
      for (const [name, z] of [
        ['NUL', '\u0000'],
        ['hohes Surrogat', '\ud800'],
        ['tiefes Surrogat', '\udfff'],
      ] as const) {
        if (b.schema.safeParse(gestoert(wert, z)).success)
          verletzt.push(`${b.pfad} nimmt ${name} an`);
      }
    }
    expect(verletzt).toEqual([]);
  });

  it('mehrzeilige Freitexte behalten Zeilenumbruch, TAB und Emoji', () => {
    const kommentar = blaetter.find(
      (b) => b.pfad === 'durchfuehrungSpeichern body.schritte[].kommentar',
    )!;
    expect(kommentar.schema.safeParse('Zeile 1\nZeile 2\tmit TAB \u{1f600}').success).toBe(true);
  });
});

/** Explizite Richtungssteuerzeichen (Einbettung, Überschreibung, Isolierung), nur als Escape. */
const RICHTUNG: Record<string, string> = {
  LRE: '\u202a',
  RLE: '\u202b',
  PDF: '\u202c',
  LRO: '\u202d',
  RLO: '\u202e',
  LRI: '\u2066',
  RLI: '\u2067',
  FSI: '\u2068',
  PDI: '\u2069',
};

/** Feld mit festem Format (Muster): Störzeichen scheitern schon am Format. */
const mitMuster = (b: Blatt) =>
  ((b.schema as unknown as { _zod: { bag: { patterns?: Set<RegExp> } } })._zod.bag.patterns?.size ??
    0) > 0;

describe('Eingaben: jede Zeichenkette ohne Richtungssteuerzeichen (tcms-s9)', () => {
  const blaetter = eingabeBlaetter();
  const frei = blaetter.filter((b) => harmlos(b) !== null);
  /** Mehrzeilige Freitexte: nehmen einen Zeilenumbruch an. */
  const mehrzeilig = frei.filter((b) => b.schema.safeParse(gestoert(harmlos(b)!, '\n')).success);

  it('prüft alle freien Felder, darunter die mehrzeiligen mit Beweiswert', () => {
    expect(frei.length).toBeGreaterThanOrEqual(80);
    expect(mehrzeilig.length).toBeGreaterThanOrEqual(20);
    for (const p of [
      'durchfuehrungSpeichern body.schritte[].kommentar',
      'durchfuehrungSpeichern body.ergebnisKommentar',
      'feststellungErfassen body.sachverhalt',
      'p153Entscheiden body.begruendung',
      'massnahmeErledigen body.nachweis',
      'risikoNeuBewerten body.begruendung',
      'beschreibungsabschnittSpeichern body.bloecke[]|0.text',
      'beschreibungsreviewZurueckweisen body.begruendung',
    ]) {
      expect(
        mehrzeilig.map((b) => b.pfad),
        p,
      ).toContain(p);
    }
  });

  it('kein Feld nimmt ein Richtungssteuerzeichen an', () => {
    const verletzt: string[] = [];
    for (const b of frei) {
      for (const [name, z] of Object.entries(RICHTUNG)) {
        if (b.schema.safeParse(gestoert(harmlos(b)!, z)).success) {
          verletzt.push(`${b.pfad} nimmt ${name} an`);
        }
      }
    }
    expect(verletzt).toEqual([]);
  });

  it('mehrzeilige Freitexte behalten ZWJ, Variantenselektoren und Richtungsmarken', () => {
    const verletzt: string[] = [];
    for (const b of mehrzeilig) {
      // Familie (ZWJ-Sequenz), Herz mit VS16, LRM/RLM/ALM.
      for (const z of ['\u{1f468}\u200d\u{1f469}', '\u2764\ufe0f', '\u200e', '\u200f', '\u061c']) {
        if (!b.schema.safeParse(gestoert(harmlos(b)!, z)).success) verletzt.push(`${b.pfad} ${z}`);
      }
    }
    expect(verletzt).toEqual([]);
  });

  it('Meldung wie bisher: Richtungssteuerzeichen „Unzulässige Zeichen“, NUL und Surrogat die Basismeldung', () => {
    const kommentar = blaetter.find(
      (b) => b.pfad === 'durchfuehrungSpeichern body.schritte[].kommentar',
    )!;
    const meldung = (s: string) => {
      const r = kommentar.schema.safeParse(s);
      return r.success ? null : r.error.issues.map((i) => i.message);
    };
    expect(meldung('a\u202eb')).toEqual(['Unzulässige Zeichen']);
    expect(meldung('a\u2069b')).toEqual(['Unzulässige Zeichen']);
    expect(meldung('a\u0000b')).toEqual([TEXT_UNZULAESSIG_MELDUNG]);
    expect(meldung('a\ud800b')).toEqual([TEXT_UNZULAESSIG_MELDUNG]);
  });
});

/**
 * Antworten mit gespeicherten Texten, die Richtungssteuerzeichen bewusst
 * abweisen (Pfad im Register → Begründung).
 */
const ANTWORT_STRENG: Record<string, string> = {
  'ereignisLesen antwort.anlagen[].dateiname':
    'Gespeicherte Anlagen: frühere Regel DATEINAME_GESPEICHERT_UNZULAESSIG, die Richtungssteuerzeichen schon immer abwies.',
  'ereignisAnlageLesen antwort.dateiname': 'wie ereignisLesen (DATEINAME_GESPEICHERT_UNZULAESSIG).',
  ...Object.fromEntries(
    [
      ...[0, 1, 2].map((i) => `nachrichtenOffenLesen antwort.nachrichten[]|${i}.daten.titel`),
      'nachrichtenOffenLesen antwort.nachrichten[]|3.daten.titel',
      'nachrichtenOffenLesen antwort.nachrichten[]|3.daten.nummer',
      'nachrichtenOffenLesen antwort.nachrichten[]|3.daten.typ',
    ].map((p) => [
      p,
      'Vorlagendaten der Nachrichten sind einzeilig; der Abruf verwirft Altdaten (DATEN_UNGUELTIG, RT4-T-03).',
    ]),
  ),
};

describe('Antworten: gespeicherte Texte bleiben lesbar (nur Länge, tcms-s9)', () => {
  const blaetter: Blatt[] = [];
  for (const e of ENDPUNKT_LISTE) {
    if (e.antwortSchema) {
      blaetter.push(...zeichenkettenBlaetter(e.antwortSchema as z.ZodType, `${e.name} antwort`));
    }
  }
  const frei = blaetter.filter((b) => harmlos(b) !== null && !mitMuster(b));

  it('prüft eine plausible Zahl gespeicherter Textfelder, auch Entwurf und Abschnitte', () => {
    expect(frei.length).toBeGreaterThanOrEqual(150);
    for (const p of [
      'einrichtungLesen antwort.entwurf.teilbereich.abgrenzung',
      'einrichtungLesen antwort.entwurf.ziele[].text',
      'einrichtungLesen antwort.entwurf.risiken{}.begruendung',
      'beschreibungLesen antwort.versionen[].abschnitte[].bloecke[]|0.text',
      'beschreibungLesen antwort.versionen[].snapshot.abschnitte[].bloecke[]|0.text',
    ]) {
      expect(
        frei.map((b) => b.pfad),
        p,
      ).toContain(p);
    }
  });

  it('jede Antwort nimmt Richtungssteuerzeichen in gespeicherten Texten an (Ausnahmen begründet)', () => {
    const verletzt: string[] = [];
    const streng = new Set<string>();
    for (const b of frei) {
      for (const [name, z] of Object.entries(RICHTUNG)) {
        if (b.schema.safeParse(gestoert(harmlos(b)!, z)).success) continue;
        if (b.pfad in ANTWORT_STRENG) streng.add(b.pfad);
        else verletzt.push(`${b.pfad} weist ${name} ab`);
      }
    }
    expect(verletzt).toEqual([]);
    // Jede Ausnahme wird gebraucht.
    expect([...streng].sort()).toEqual(Object.keys(ANTWORT_STRENG).sort());
  });
});
