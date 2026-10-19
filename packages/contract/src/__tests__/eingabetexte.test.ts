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
//
// Ein Feld gilt als geprüft, wenn ein harmloser Wert passender Länge
// angenommen und derselbe Wert mit dem Störzeichen in der Mitte abgewiesen
// wird. Felder mit festem Format (UUID, ID, Datum, Enum), die schon den
// harmlosen Wert abweisen, lassen Störzeichen erst recht nicht zu.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ENDPUNKT_LISTE } from '../endpunkte';
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
