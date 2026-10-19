// =============================================================================
// Vertrag (zod) des Bereichs „feststellungen-ereignisse" (Welle 2): Eingaben
// und Antworten für Feststellungen und Maßnahmen (S10), Ereigniseingang und
// Triage (S11), Portal-Meldung (P3) und Länder-Monitor (S12).
//
// Grundsätze (ADR 0001 §7, AGENTS.md):
//   - Alle Objekte sind strikt: unbekannte Felder → UNGUELTIG.
//   - Eingabe = Body + Pfadparameter. Die Route setzt `mandantId` und Objekt-IDs
//     aus dem Pfad nach dem Body ein; Body-Schemas kennen diese Felder nicht.
//   - Schreibende Eingaben haben keinen Stichtag (TS-07). `stand` gibt es nur
//     in Lesern (`StandSchema`).
//   - §-153-Würdigung: vier gleichrangige Optionen ohne Standardwert und ohne
//     Empfehlung (AGENTS.md Regel 5); die Entscheidung ist Pflichtfeld.
//   - Personen: nur IDs der kanzleikonsole. Wo ein Anzeigename fachlich in
//     einen Text eingeht (Benachrichtigung der Kanzlei), liefert ihn die
//     kanzleikonsole ausdrücklich mit; er begründet nie ein Recht.
//   - Antworten: Datumswerte als ISO-Strings (`YYYY-MM-DD` für Kalendertage,
//     ISO-8601 mit Zeit für Zeitpunkte), Listen statt Map/Set.
// =============================================================================

import { z } from 'zod';
import { StandSchema } from './lesepfade';

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/** IDs von Tax-CMS-Objekten (cuid, Kleinbuchstaben und Ziffern). */
export const ObjektIdSchema = z.string().regex(/^[a-z0-9]{16,40}$/, 'Ungültige ID');

/** Kalendertag `YYYY-MM-DD` (nur gültige Tage). */
export const TagSchema = z.iso.date();

// NUL und andere Steuerzeichen (außer Tab/Zeilenumbruch) sowie einzelne
// Surrogate: PostgreSQL weist NUL ab (sonst 500), die übrigen sind nie fachlich.
const STEUERZEICHEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EINZELNES_SURROGAT = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Freitext: getrimmt, Längengrenzen, ohne Steuerzeichen. */
export function freitext(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !STEUERZEICHEN.test(s), 'Steuerzeichen sind nicht erlaubt')
    .refine((s) => !EINZELNES_SURROGAT.test(s), 'Ungültige Zeichenfolge');
}

const iso = z.iso.datetime();

export const FeststellungStatusSchema = z.enum([
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
  'VERWORFEN',
]);
export const FeststellungQuelleSchema = z.enum([
  'KONTROLLE',
  'EREIGNIS',
  'STICHPROBE',
  'HINWEIS',
  'AUSSENPRUEFUNG',
]);
export const FeststellungKlasseSchema = z.enum([
  'DESIGNMANGEL',
  'DURCHFUEHRUNGSMANGEL',
  'STEUERLICHER_FEHLER',
  'HINWEIS',
]);
export const SchwereSchema = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
export const AuswirkungSchema = z.enum(['JA', 'NEIN', 'UNKLAR']);
/** Die vier gleichrangigen §-153-Optionen (keine Reihenfolge als Empfehlung, kein Standard). */
export const P153EntscheidungSchema = z.enum([
  'BERICHTIGUNG',
  'KEINE_PFLICHT',
  'WEITERE_KLAERUNG',
  'UEBERGABE',
]);
export const MassnahmeStatusSchema = z.enum(['OFFEN', 'ERLEDIGT']);
export const EreignisStatusSchema = z.enum(['NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN']);
export const EreignisQuelleSchema = z.enum(['PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL']);
export const FolgeArtSchema = z.enum([
  'RISIKO_NEU_BEWERTEN',
  'RISIKO_AKTIVIEREN',
  'KONTROLLE_AUSSERPLANMAESSIG',
  'PROFIL_AENDERN',
  'FESTSTELLUNG_ANLEGEN',
  'HINWEIS',
]);
export const FolgeStatusSchema = z.enum(['VORGESCHLAGEN', 'ANGELEGT', 'ERLEDIGT', 'VERWORFEN']);
export const AnzeigeStatusSchema = z.enum([
  'GEPLANT',
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
  'UEBERFAELLIG',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'ENTFALLEN',
]);

/**
 * Person, der eine Aufgabe zugewiesen wird (Maßnahme, Folge). `art` sagt, ob
 * die ID ein Mitarbeiter (KANZLEI) oder ein Mandantenkontakt (MANDANT) der
 * kanzleikonsole ist; Mandantenkontakte prüft der Dienst gegen ihre aktive Rolle.
 */
export const PersonZuweisungSchema = z
  .object({ id: z.uuid(), art: z.enum(['KANZLEI', 'MANDANT']) })
  .strict();

/** Mandant im Pfad (UUID der kanzleikonsole). */
const mandant = { mandantId: z.uuid() };
const lesen = { ...mandant, stand: StandSchema.optional() };

/** Query der Leser: nur `?stand=YYYY-MM-DD`. */
export const StandQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

/** Name-Wert-Paar für aufgelöste Anzeigenamen (im Dienst leer, ADR 0001 §5). */
export const NamenSchema = z.array(z.object({ id: z.string(), name: z.string() }).strict());

// ===========================================================================
// Feststellungen und Maßnahmen (S10)
// ===========================================================================

export const FeststellungenLesenSchema = z.object(lesen).strict();
export const FeststellungLesenSchema = z
  .object({ ...lesen, feststellungId: ObjektIdSchema })
  .strict();

const feststellung = { ...mandant, feststellungId: ObjektIdSchema };

// ---- Status weiterschalten ----
export const FeststellungWeiterBodySchema = z
  .object({
    /** Status, den der Aufrufer gesehen hat; weicht er ab → KONFLIKT (TS-05). */
    von: FeststellungStatusSchema,
  })
  .strict();
export const FeststellungWeiterSchema = FeststellungWeiterBodySchema.extend(feststellung).strict();

// ---- §-153-Würdigung ----
export const P153BodySchema = z
  .object({
    /** Pflicht, ohne Standardwert (AGENTS.md Regel 5). */
    entscheidung: P153EntscheidungSchema,
    begruendung: freitext(30, 4000),
    /** Pflicht bei Berichtigung und weiterer Klärung; sonst ohne Wirkung. */
    frist: TagSchema.optional(),
    /** Bisherige Entscheidung, die der Aufrufer gesehen hat (null = keine); Abweichung → KONFLIKT. */
    bisher: P153EntscheidungSchema.nullable(),
  })
  .strict();
export const P153Schema = P153BodySchema.extend(feststellung).strict();

// ---- Würdigungsangaben ----
export const WuerdigungBodySchema = z
  .object({
    schwere: SchwereSchema,
    auswirkung: AuswirkungSchema,
    ursache: freitext(0, 2000).nullable().optional(),
  })
  .strict();
export const WuerdigungSchema = WuerdigungBodySchema.extend(feststellung).strict();

// ---- Betroffene Erklärung ----
/** Spalte DECIMAL(14,2): Beträge betragsmäßig unter 10^12. */
export const MAX_BETRAG_EUR = 999_999_999_999.99;
export const ErklaerungBodySchema = z
  .object({
    steuerart: freitext(2, 120),
    land: freitext(2, 40),
    zeitraum: freitext(2, 40),
    /** Geschätzte Auswirkung in EUR; null = noch zu klären. */
    auswirkungEur: z.number().min(-MAX_BETRAG_EUR).max(MAX_BETRAG_EUR).nullable().optional(),
  })
  .strict();
export const ErklaerungSchema = ErklaerungBodySchema.extend(feststellung).strict();

// ---- Maßnahme anlegen / erledigen ----
export const MassnahmeBodySchema = z
  .object({
    beschreibung: freitext(5, 500),
    verantwortlich: PersonZuweisungSchema,
    frist: TagSchema,
  })
  .strict();
export const MassnahmeSchema = MassnahmeBodySchema.extend(feststellung).strict();

export const MassnahmeErledigenBodySchema = z.object({ nachweis: freitext(10, 2000) }).strict();
export const MassnahmeErledigenSchema = MassnahmeErledigenBodySchema.extend({
  ...mandant,
  massnahmeId: ObjektIdSchema,
}).strict();

// ---- Nachkontrolle ----
export const NachkontrolleBodySchema = z
  .object({ kontrolleId: ObjektIdSchema, faelligAm: TagSchema })
  .strict();
export const NachkontrolleSchema = NachkontrolleBodySchema.extend(feststellung).strict();

// ---- Verwerfen (Vier-Augen) ----
export const VerwerfenBeantragenBodySchema = z.object({ begruendung: freitext(30, 2000) }).strict();
export const FeststellungVerwerfenBeantragenSchema =
  VerwerfenBeantragenBodySchema.extend(feststellung).strict();
/** Bestätigen, Ablehnen: nur Pfadparameter. */
export const FeststellungAktionSchema = z.object(feststellung).strict();

// ---- Vertraulich ----
export const VertraulichBodySchema = z.object({ vertraulich: z.boolean() }).strict();
export const VertraulichSchema = VertraulichBodySchema.extend(feststellung).strict();

// ---- Feststellung erfassen ----
export const FeststellungErfassenBodySchema = z
  .object({
    titel: freitext(5, 200),
    sachverhalt: freitext(20, 4000),
    quelle: FeststellungQuelleSchema,
    quelleText: freitext(2, 200),
    /** Nur bei Quelle KONTROLLE: Durchführung desselben Programms. */
    durchfuehrungId: ObjektIdSchema.optional(),
    klasse: FeststellungKlasseSchema,
    schwere: SchwereSchema,
    /** „NEIN" wirkt nur mit Würdigungsrecht, sonst entsteht „UNKLAR" (TS-04). */
    auswirkung: AuswirkungSchema,
    risikoIds: z
      .array(ObjektIdSchema)
      .max(100)
      .refine((l) => new Set(l).size === l.length, 'Risiken doppelt angegeben')
      .optional(),
  })
  .strict();
export const FeststellungErfassenSchema = FeststellungErfassenBodySchema.extend(mandant).strict();

// ---- Antworten ----
export const MassnahmeZeileSchema = z
  .object({
    id: z.string(),
    feststellungId: z.string(),
    wiedervorlageNr: z.number().int(),
    beschreibung: z.string(),
    verantwortlich: z.string(),
    frist: TagSchema,
    /** Status zum Stichtag. */
    status: MassnahmeStatusSchema,
    erledigtAm: iso.nullable(),
    erledigtVon: z.string().nullable(),
    createdAt: iso,
  })
  .strict();

/** Maßnahme einer vertraulichen Feststellung für Nicht-Beteiligte (Wiedervorlage ohne Inhalt). */
export const MassnahmeMaskiertSchema = MassnahmeZeileSchema.pick({
  id: true,
  feststellungId: true,
  wiedervorlageNr: true,
  frist: true,
  status: true,
}).strict();

const P153StandSchema = z
  .object({
    entscheidung: P153EntscheidungSchema,
    begruendung: z.string().nullable(),
    frist: TagSchema.nullable(),
    von: z.string().nullable(),
    am: iso,
  })
  .strict();

export const FeststellungListenEintragSchema = z.discriminatedUnion('maskiert', [
  z
    .object({
      maskiert: z.literal(false),
      id: z.string(),
      nummer: z.string(),
      titel: z.string(),
      quelle: FeststellungQuelleSchema,
      quelleText: z.string(),
      klasse: FeststellungKlasseSchema,
      schwere: SchwereSchema,
      auswirkung: AuswirkungSchema,
      /** Status zum Stichtag. */
      status: FeststellungStatusSchema,
      vertraulich: z.boolean(),
      erfasstVon: z.string(),
      erfasstAm: iso,
      durchfuehrungId: z.string().nullable(),
      ereignisId: z.string().nullable(),
      p153: P153StandSchema.nullable(),
      p153Offen: z.boolean(),
      verwerfenOffen: z.boolean(),
      massnahmenOffen: z.number().int(),
      massnahmenGesamt: z.number().int(),
      aeltesteFrist: TagSchema.nullable(),
      risikoCodes: z.array(z.string()),
      massnahmen: z.array(MassnahmeZeileSchema),
    })
    .strict(),
  z
    .object({
      /** Vertrauliche Feststellung, Akteur nicht beteiligt (Fachkonzept §13). */
      maskiert: z.literal(true),
      id: z.string(),
      nummer: z.string(),
      vertraulich: z.literal(true),
      status: FeststellungStatusSchema,
      erfasstAm: iso,
      massnahmen: z.array(MassnahmeMaskiertSchema),
    })
    .strict(),
]);

export const FeststellungListeSchema = z
  .object({
    stand: TagSchema,
    historisch: z.boolean(),
    programmId: z.string().nullable(),
    feststellungen: z.array(FeststellungListenEintragSchema),
    namen: NamenSchema,
  })
  .strict();

export const VerlaufEintragSchema = z
  .object({ seq: z.number().int(), at: iso, actorId: z.string().nullable(), text: z.string() })
  .strict();

export const FeststellungDetailSchema = z.discriminatedUnion('maskiert', [
  z
    .object({
      maskiert: z.literal(false),
      stand: TagSchema,
      historisch: z.boolean(),
      id: z.string(),
      programmId: z.string(),
      nummer: z.string(),
      titel: z.string(),
      sachverhalt: z.string(),
      quelle: FeststellungQuelleSchema,
      quelleText: z.string(),
      klasse: FeststellungKlasseSchema,
      schwere: SchwereSchema,
      auswirkung: AuswirkungSchema,
      ursache: z.string().nullable(),
      status: FeststellungStatusSchema,
      /** Vertraulich zum Stichtag. */
      vertraulich: z.boolean(),
      /** Vertraulich heute (unabhängig vom Stichtag). */
      vertraulichAktuell: z.boolean(),
      p153: P153StandSchema.nullable(),
      durchfuehrung: z
        .object({
          id: z.string(),
          kontrolleId: z.string(),
          code: z.string(),
          periodeLabel: z.string(),
        })
        .strict()
        .nullable(),
      ereignis: z
        .object({ id: z.string(), nummer: z.string(), typ: z.string(), titel: z.string() })
        .strict()
        .nullable(),
      nachkontrolle: z
        .object({
          id: z.string(),
          kontrolleId: z.string(),
          code: z.string(),
          titel: z.string(),
          periodeLabel: z.string(),
          faelligAm: TagSchema,
          anzeige: AnzeigeStatusSchema,
          ausserplanmaessig: z.boolean(),
        })
        .strict()
        .nullable(),
      verwerfen: z
        .object({
          begruendung: z.string(),
          beantragtVon: z.string(),
          bestaetigtVon: z.string().nullable(),
        })
        .strict()
        .nullable(),
      erfasstVon: z.string(),
      erfasstAm: iso,
      geschlossenAm: iso.nullable(),
      risiken: z.array(z.object({ id: z.string(), code: z.string() }).strict()),
      erklaerungen: z.array(
        z
          .object({
            id: z.string(),
            steuerart: z.string(),
            land: z.string(),
            zeitraum: z.string(),
            auswirkungEur: z.number().nullable(),
          })
          .strict(),
      ),
      massnahmen: z.array(
        MassnahmeZeileSchema.extend({ nachweis: z.string().nullable() }).strict(),
      ),
      verlauf: z.array(VerlaufEintragSchema),
      namen: NamenSchema,
    })
    .strict(),
  z
    .object({
      maskiert: z.literal(true),
      stand: TagSchema,
      historisch: z.boolean(),
      id: z.string(),
      nummer: z.string(),
      vertraulich: z.literal(true),
    })
    .strict(),
]);

export const FeststellungErgebnisSchema = z
  .object({ id: z.string(), nummer: z.string(), status: FeststellungStatusSchema })
  .strict();
export const FeststellungErfasstSchema = z
  .object({
    id: z.string(),
    nummer: z.string(),
    auswirkung: AuswirkungSchema,
    /** „NEIN" angegeben, aber ohne Würdigungsrecht als „UNKLAR" angelegt (TS-04). */
    auswirkungHerabgestuft: z.boolean(),
  })
  .strict();
export const P153ErgebnisSchema = z
  .object({
    id: z.string(),
    entscheidung: P153EntscheidungSchema,
    wiedervorlageNr: z.number().int().nullable(),
  })
  .strict();
export const ErklaerungErgebnisSchema = z
  .object({ id: z.string(), feststellungId: z.string() })
  .strict();
export const MassnahmeErgebnisSchema = z
  .object({ id: z.string(), wiedervorlageNr: z.number().int() })
  .strict();
export const NachkontrolleErgebnisSchema = z
  .object({ durchfuehrungId: z.string(), kontrolleCode: z.string() })
  .strict();
export const VertraulichErgebnisSchema = z
  .object({ id: z.string(), vertraulich: z.boolean(), geaendert: z.boolean() })
  .strict();
export const VerwerfenAbgelehntSchema = z
  .object({ id: z.string(), zurueckgezogen: z.boolean() })
  .strict();

// ===========================================================================
// Typen
// ===========================================================================

export type FeststellungenLesen = z.infer<typeof FeststellungenLesenSchema>;
export type FeststellungLesen = z.infer<typeof FeststellungLesenSchema>;
export type FeststellungWeiter = z.infer<typeof FeststellungWeiterSchema>;
export type P153Eingabe = z.infer<typeof P153Schema>;
export type WuerdigungEingabe = z.infer<typeof WuerdigungSchema>;
export type ErklaerungEingabe = z.infer<typeof ErklaerungSchema>;
export type MassnahmeEingabe = z.infer<typeof MassnahmeSchema>;
export type MassnahmeErledigenEingabe = z.infer<typeof MassnahmeErledigenSchema>;
export type NachkontrolleEingabe = z.infer<typeof NachkontrolleSchema>;
export type FeststellungVerwerfenBeantragen = z.infer<typeof FeststellungVerwerfenBeantragenSchema>;
export type FeststellungAktion = z.infer<typeof FeststellungAktionSchema>;
export type VertraulichEingabe = z.infer<typeof VertraulichSchema>;
export type FeststellungErfassen = z.infer<typeof FeststellungErfassenSchema>;
export type PersonZuweisung = z.infer<typeof PersonZuweisungSchema>;

export type MassnahmeZeile = z.infer<typeof MassnahmeZeileSchema>;
export type FeststellungListenEintrag = z.infer<typeof FeststellungListenEintragSchema>;
export type FeststellungListe = z.infer<typeof FeststellungListeSchema>;
export type FeststellungDetail = z.infer<typeof FeststellungDetailSchema>;
export type FeststellungErgebnis = z.infer<typeof FeststellungErgebnisSchema>;
export type FeststellungErfasst = z.infer<typeof FeststellungErfasstSchema>;
export type P153Ergebnis = z.infer<typeof P153ErgebnisSchema>;
export type ErklaerungErgebnis = z.infer<typeof ErklaerungErgebnisSchema>;
export type MassnahmeErgebnis = z.infer<typeof MassnahmeErgebnisSchema>;
export type NachkontrolleErgebnis = z.infer<typeof NachkontrolleErgebnisSchema>;
export type VertraulichErgebnis = z.infer<typeof VertraulichErgebnisSchema>;
export type VerwerfenAbgelehnt = z.infer<typeof VerwerfenAbgelehntSchema>;
export type VerlaufEintrag = z.infer<typeof VerlaufEintragSchema>;
