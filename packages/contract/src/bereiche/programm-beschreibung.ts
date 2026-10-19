// =============================================================================
// Vertrag (zod) des Bereichs „programm-beschreibung" (Welle 2): Eingaben und
// Antworten für Einrichtungsassistent, CMS-Beschreibung, Freigaben (Kanzlei
// und Portal), Kommunikation und Postausgang.
//
// Grundsätze:
//   - Eingaben sind strikt (unbekannte Felder → UNGUELTIG). Die Service-
//     Funktionen prüfen dieselben Schemas noch einmal (die Demo ruft ohne HTTP).
//   - Bodys enthalten nie `mandantId`; sie kommt aus dem Pfad (Mandantenbindung,
//     ADR 0001 §3.3). Eingabe = Body + Pfadparameter.
//   - Schreibende Operationen nehmen keinen Stichtag an (TS-07).
//   - Personen sind IDs der kanzleikonsole. Wo eine Operation Namen braucht
//     (eingefrorene Beschreibung), kommen sie als ausdrückliche Eingabe und
//     werden nie für Rechte verwendet (ADR 0001 §5, Nachtrag Welle 2).
//   - Antworten sind JSON: Zeitpunkte als ISO-Strings, keine Codes, keine
//     Code-Hashes (Freigabe-Codes erreichen den Empfänger nur über den
//     Postausgang).
// Dieses Modul hängt nur von zod ab (die kanzleikonsole importiert es); die
// Gleichheit mit den Typen aus @tcms/domain prüft der Service beim Übersetzen.
// =============================================================================

import { z } from 'zod';
import { StandSchema } from './lesepfade';

const uuid = z.uuid();
/** ID eines Tax-CMS-Objekts (cuid). */
const objektId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const isoZeit = z.string().max(40);
const isoTag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const klasse = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
const governanceTyp = z.enum(['FP', 'FF', 'IN']);
const turnus = z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']);
const partei = z.enum(['KANZLEI', 'MANDANT']);

/** Person der kanzleikonsole mit Anzeigenamen (nur Anzeige, nie für Rechte). */
const namensEintrag = z.object({ id: uuid, name: z.string().trim().min(1).max(200) }).strict();

// -----------------------------------------------------------------------------
// Postausgang (Zustellung durch die kanzleikonsole, Stufe 4)
// -----------------------------------------------------------------------------

export const NACHRICHT_ZWECKE = [
  /** Hinweis auf eine neue Anforderung (ohne Code). */
  'FREIGABE_ANGEFORDERT',
  /** Bestätigungscode für genau eine Freigabe. */
  'FREIGABE_CODE',
  /** Die Kanzlei hat eine Anforderung an diese Person neu adressiert (ohne Code). */
  'FREIGABE_NEU_ADRESSIERT',
] as const;
export const NachrichtZweckSchema = z.enum(NACHRICHT_ZWECKE);
export type NachrichtZweck = z.infer<typeof NachrichtZweckSchema>;
export const MAX_NACHRICHTEN_JE_ABRUF = 100;

export const NachrichtenOffenQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_NACHRICHTEN_JE_ABRUF))
      .optional(),
  })
  .strict();
export const NachrichtenOffenEingabeSchema = z
  .object({ limit: z.number().int().min(1).max(MAX_NACHRICHTEN_JE_ABRUF).optional() })
  .strict();
export type NachrichtenOffenEingabe = z.infer<typeof NachrichtenOffenEingabeSchema>;
export const OffeneNachrichtSchema = z
  .object({
    id: z.string(),
    empfaengerId: z.string(),
    zweck: NachrichtZweckSchema,
    betreff: z.string(),
    text: z.string(),
    erstelltAm: isoZeit,
  })
  .strict();
export type OffeneNachricht = z.infer<typeof OffeneNachrichtSchema>;
export const NachrichtenOffenSchema = z
  .object({ nachrichten: z.array(OffeneNachrichtSchema) })
  .strict();

export const NachrichtZugestelltEingabeSchema = z.object({ nachrichtId: objektId }).strict();
export type NachrichtZugestelltEingabe = z.infer<typeof NachrichtZugestelltEingabeSchema>;
export const NachrichtZugestelltErgebnisSchema = z
  .object({ nachrichtId: z.string(), zugestellt: z.literal(true) })
  .strict();
export type NachrichtZugestelltErgebnis = z.infer<typeof NachrichtZugestelltErgebnisSchema>;

// -----------------------------------------------------------------------------
// Einrichtungsassistent (Schritte 1–5, Version 1)
// -----------------------------------------------------------------------------

export const SetupTurnusSchema = z.enum(['MONATLICH', 'QUARTALSWEISE', 'JAEHRLICH']);
export const SetupAppetitSchema = z.enum(['GERING', 'MITTEL', 'HOCH']);
/** Katalogcode eines Risikos bzw. einer Kontrolle (z. B. EC-UST-01, K-EC-01). */
const katalogCode = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/);
const kurz = z.string().trim().max(200);
const tagOderLeer = isoTag.or(z.literal(''));

export const TeilbereichSchrittSchema = z
  .object({
    teilbereich: z
      .object({
        name: z.string().trim().min(1).max(200),
        abgrenzung: z.string().trim().max(4000),
        einschluesse: z.array(kurz).max(30),
        ausschluesse: z.array(kurz).max(30),
      })
      .strict(),
    zeitraum: z
      .object({
        angemessenheitStichtag: tagOderLeer,
        wirksamAb: tagOderLeer,
        wirksamBis: tagOderLeer,
        erklaerungsTurnus: SetupTurnusSchema,
      })
      .strict(),
  })
  .strict();

const monat = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const land = z.string().regex(/^[A-Z]{2}$/);
const text = (max = 120) => z.string().trim().max(max);
const betrag = z.number().finite().min(0).max(1e12);

/** Geschäftsprofil P1–P12 (Struktur wie `Geschaeftsprofil` in @tcms/domain). */
export const EinrichtungProfilSchema = z
  .object({
    p1: z
      .object({
        eigenerShop: z.boolean(),
        shopSystem: text(),
        marktplaetze: z.array(text(40)).max(20),
      })
      .strict(),
    p2: z
      .object({
        eigenversandDE: z.boolean(),
        lager: z
          .array(
            z
              .object({
                land,
                seit: monat,
                art: z.enum(['EIGEN', 'FBA', 'PAN-EU', 'CEE', '3PL']),
              })
              .strict(),
          )
          .max(40),
      })
      .strict(),
    p3: z
      .object({
        laender: z.array(land).max(40),
        b2bAnteilProzent: z.number().finite().min(0).max(100),
        b2bEU: z.boolean(),
        b2bInland: z.boolean(),
      })
      .strict(),
    p4: z
      .object({
        warengruppen: z
          .array(z.object({ name: text(), abweichenderSatz: z.boolean() }).strict())
          .max(40),
        gebrauchtware: z.boolean(),
      })
      .strict(),
    p5: z
      .object({
        drittlandImport: z.boolean(),
        laender: z.array(land).max(40),
        zollabwicklung: text(200),
      })
      .strict(),
    p6: z.object({ zahlungswege: z.array(text(40)).max(20) }).strict(),
    p7: z.object({ gutscheine: z.boolean(), abos: z.boolean(), bundles: z.boolean() }).strict(),
    p8: z
      .object({
        systeme: z
          .array(z.object({ art: text(60), name: text(), version: text(40) }).strict())
          .max(30),
      })
      .strict(),
    p9: z
      .object({
        ossSeit: monat.nullable(),
        ioss: z.boolean(),
        lokaleUstNr: z.array(land).max(40),
        dauerfrist: z.boolean(),
      })
      .strict(),
    p10: z
      .object({
        vorjahresumsatzEur: betrag,
        euFernverkaeufeVorjahrEur: betrag,
        euFernverkaeufeLfdEur: betrag,
      })
      .strict(),
    p11: z.object({ vorhanden: z.boolean(), anbieter: z.array(text()).max(30) }).strict(),
    p12: z.object({ buchhaltung: z.enum(['KANZLEI', 'INTERN']) }).strict(),
  })
  .strict();

export const ProfilSchrittSchema = z.object({ profil: EinrichtungProfilSchema }).strict();

export const EntwurfZielSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/),
    text: z.string().trim().max(1000),
    wesentlichkeitEur: z.number().int().min(0).max(1e9),
    risikoappetit: SetupAppetitSchema,
    aktiv: z.boolean(),
    eigen: z.boolean(),
  })
  .strict();

export const ZieleSchrittSchema = z
  .object({
    ziele: z.array(EntwurfZielSchema).max(20),
    /** Freigabe der Ziele bei einer gesetzlichen Vertretung (ID der kanzleikonsole). */
    freigabe: z.object({ anfordern: z.boolean(), empfaengerId: uuid.nullable() }).strict(),
  })
  .strict();

export const EntwurfRisikoSchema = z
  .object({ uebernehmen: z.boolean(), begruendung: z.string().trim().max(2000) })
  .strict();

export const RisikenSchrittSchema = z
  .object({ risiken: z.record(katalogCode, EntwurfRisikoSchema) })
  .strict();

export const EntwurfKontrolleSchema = z
  .object({
    partei,
    durchfuehrendId: uuid.nullable(),
    vertretungId: uuid.nullable(),
    gegenzeichnerId: uuid.nullable(),
  })
  .strict();

export const KontrollenSchrittSchema = z
  .object({ kontrollen: z.record(katalogCode, EntwurfKontrolleSchema) })
  .strict();

/** Gespeicherter Entwurf (TcmsProgramm.setupEntwurf), wie ihn der Service liefert. */
export const SetupEntwurfSchema = z
  .object({
    v: z.literal(1),
    /** Höchster geprüft abgeschlossener Schritt (0–5). */
    abgeschlossen: z.number().int().min(0).max(5),
    teilbereich: TeilbereichSchrittSchema.shape.teilbereich,
    zeitraum: TeilbereichSchrittSchema.shape.zeitraum,
    profil: EinrichtungProfilSchema,
    ziele: ZieleSchrittSchema.shape.ziele,
    freigabe: ZieleSchrittSchema.shape.freigabe,
    risiken: RisikenSchrittSchema.shape.risiken,
    kontrollen: KontrollenSchrittSchema.shape.kontrollen,
    /** Person (ID), die zuletzt gespeichert hat. */
    gespeichertVon: uuid.nullable().optional(),
    gespeichertAm: isoZeit.nullable().optional(),
  })
  .strict();

export type SetupEntwurf = z.infer<typeof SetupEntwurfSchema>;
export type EntwurfZiel = z.infer<typeof EntwurfZielSchema>;
export type EntwurfRisiko = z.infer<typeof EntwurfRisikoSchema>;
export type EntwurfKontrolle = z.infer<typeof EntwurfKontrolleSchema>;

/**
 * Personen der Kanzlei für Vorbelegung und Prüfung der Zuständigkeiten
 * (ausdrückliche Eingabe der kanzleikonsole, nie für Rechte): zuständige:r
 * Berufsträger:in, Hauptbearbeitung und alle Kanzleipersonen mit Zugriff auf
 * den Mandanten (Reihenfolge = Vorschlagsreihenfolge für die Vertretung).
 */
export const EinrichtungPersonenSchema = z
  .object({
    berufstraegerId: uuid.nullable(),
    bearbeitungId: uuid.nullable(),
    kanzlei: z.array(uuid).max(2000),
  })
  .strict();
export type EinrichtungPersonen = z.infer<typeof EinrichtungPersonenSchema>;

/**
 * Einrichtung lesen (GET, ohne Body): Zuständigkeit und eine Vertretung der
 * Kanzlei für die Vorbelegung (nur Anzeige). Die vollständige Liste der
 * Kanzleipersonen braucht erst das Speichern bzw. Anlegen.
 */
export const EinrichtungLesenQuerySchema = z
  .object({
    berufstraegerId: uuid.optional(),
    bearbeitungId: uuid.optional(),
    vertretungId: uuid.optional(),
  })
  .strict();
export const EinrichtungLesenEingabeSchema = EinrichtungLesenQuerySchema.extend({
  mandantId: uuid,
}).strict();
export type EinrichtungLesenEingabe = z.infer<typeof EinrichtungLesenEingabeSchema>;

const ZielAktion = z.enum(['speichern', 'weiter', 'zurueck']);

function entwurfVarianten<M extends z.ZodRawShape>(basis: M) {
  const v = <S extends z.ZodRawShape>(s: S) =>
    z.object({ ...basis, ziel: ZielAktion, personen: EinrichtungPersonenSchema, ...s }).strict();
  return z.discriminatedUnion('schritt', [
    v({ schritt: z.literal(1), daten: TeilbereichSchrittSchema }),
    v({ schritt: z.literal(2), daten: ProfilSchrittSchema }),
    v({ schritt: z.literal(3), daten: ZieleSchrittSchema }),
    v({ schritt: z.literal(4), daten: RisikenSchrittSchema }),
    v({ schritt: z.literal(5), daten: KontrollenSchrittSchema }),
  ]);
}

/** Einen Schritt speichern (`speichern`), prüfen und abschließen (`weiter`) oder zurück. */
export const EntwurfSpeichernBodySchema = entwurfVarianten({});
export const EntwurfSpeichernEingabeSchema = entwurfVarianten({ mandantId: uuid });
export type EntwurfSpeichernEingabe = z.infer<typeof EntwurfSpeichernEingabeSchema>;

export const EntwurfSpeichernErgebnisSchema = z
  .object({
    programmId: z.string(),
    /** Das Programm wurde mit diesem Aufruf angelegt (Status ENTWURF). */
    angelegt: z.boolean(),
    abgeschlossen: z.number().int().min(0).max(5),
    geaendert: z.boolean(),
  })
  .strict();
export type EntwurfSpeichernErgebnis = z.infer<typeof EntwurfSpeichernErgebnisSchema>;

/** Version 1 anlegen: Zuständigkeiten aus Schritt 5 und Personen (wie beim Speichern). */
export const ProgrammAnlegenBodySchema = z
  .object({ daten: KontrollenSchrittSchema, personen: EinrichtungPersonenSchema })
  .strict();
export const ProgrammAnlegenEingabeSchema = ProgrammAnlegenBodySchema.extend({
  mandantId: uuid,
}).strict();
export type ProgrammAnlegenEingabe = z.infer<typeof ProgrammAnlegenEingabeSchema>;

export const ProgrammAnlegenErgebnisSchema = z
  .object({
    programmId: z.string(),
    risiken: z.number().int(),
    abgelehnt: z.number().int(),
    kontrollen: z.number().int(),
    durchfuehrungen: z.number().int(),
    ziele: z.number().int(),
    /** Freigabe der Ziele, falls angefordert. */
    freigabeId: z.string().nullable(),
  })
  .strict();
export type ProgrammAnlegenErgebnis = z.infer<typeof ProgrammAnlegenErgebnisSchema>;

const FrequenzSchema = z.object({ turnus, anlass: z.boolean() }).strict();

export const PlanViewSchema = z
  .object({
    appetit: klasse,
    zeitraum: z.object({ stichtag: isoTag, ab: isoTag, bis: isoTag }).strict().nullable(),
    risiken: z.array(
      z
        .object({
          code: z.string(),
          titel: z.string(),
          kern: z.boolean(),
          gt: governanceTyp,
          grund: z.string(),
          frage: z.string(),
          uebernehmen: z.boolean(),
          begruendung: z.string(),
          brutto: klasse,
          ueberAppetit: z.boolean(),
        })
        .strict(),
    ),
    nichtVorgeschlagen: z.array(z.object({ code: z.string(), titel: z.string() }).strict()),
    kontrollen: z.array(
      z
        .object({
          code: z.string(),
          titel: z.string(),
          schluessel: z.boolean(),
          risikoCodes: z.array(z.string()),
          primaer: z.string().nullable(),
          vorlage: FrequenzSchema,
          effektiv: FrequenzSchema,
          gt: governanceTyp.nullable(),
          begruendung: z.string(),
          zust: EntwurfKontrolleSchema.extend({ gegenzeichnungMandant: z.boolean() }).strict(),
          perioden: z.number().int(),
        })
        .strict(),
    ),
    prueflast: z.array(
      z
        .object({
          monat: z.string(),
          FP: z.number(),
          FF: z.number(),
          IN: z.number(),
          ausloesungen: z.number(),
          gesamt: z.number(),
        })
        .strict(),
    ),
    durchfuehrungen: z.number().int(),
  })
  .strict();
export type PlanView = z.infer<typeof PlanViewSchema>;

export const EinrichtungViewSchema = z
  .object({
    programm: z
      .object({
        id: z.string(),
        status: z.enum(['ENTWURF', 'AKTIV']),
        version1Am: isoZeit.nullable(),
        createdAt: isoZeit,
      })
      .strict()
      .nullable(),
    /** Version 1 ist angelegt: Der Assistent ist geschlossen. */
    eingerichtet: z.boolean(),
    entwurf: SetupEntwurfSchema.nullable(),
    plan: PlanViewSchema.nullable(),
    /** Offene Punkte je Schritt (leer = vollständig). */
    pruefung: z.array(z.object({ schritt: z.number().int(), fehler: z.array(z.string()) })),
    /** Gesetzliche Vertretungen des Mandanten (IDs aus MandantKontaktRolle). */
    gesetzlicheVertreter: z.array(z.string()),
    /** Darf der Akteur den Entwurf ändern (Bearbeitungsrecht)? */
    darfBearbeiten: z.boolean(),
  })
  .strict();
export type EinrichtungView = z.infer<typeof EinrichtungViewSchema>;
