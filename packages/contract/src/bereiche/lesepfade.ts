// =============================================================================
// Vertrag (zod) des Bereichs „lesepfade" (Welle 2): Eingaben und Antworten.
//
// Antworten sind streng (`.strict()`): Der Dienst prüft seine eigene Antwort
// vor dem Senden gegen diese Schemas, damit kein Feld ungeplant nach außen
// gelangt (fail closed). Zeitpunkte als ISO-8601 (UTC), Kalendertage als
// `YYYY-MM-DD`, Personen nur als IDs der kanzleikonsole (ADR 0001 §5, §7).
// =============================================================================

import { z } from 'zod';

/**
 * Stichtag `YYYY-MM-DD` (nur gültige Kalendertage). Gemeinsam für alle Leser
 * mit `?stand=` (ADR 0001 §7); schreibende Operationen nehmen keinen Stichtag
 * an (TS-07).
 */
export const StandSchema = z.iso.date();

/**
 * Tax-CMS-Kontext eines Mandanten lesen. Ohne `stand` gilt „heute" der Uhr;
 * ein Stand ab heute ist der aktuelle Stand (nicht historisch).
 */
export const KontextEingabeSchema = z
  .object({
    mandantId: z.uuid(),
    stand: StandSchema.optional(),
  })
  .strict();

export type KontextEingabe = z.infer<typeof KontextEingabeSchema>;

/** Query von `GET /v1/mandanten/:mandantId/kontext`. */
export const KontextQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

// ---------------------------------------------------------------------------
// Bausteine der Antworten (modulintern, damit Namen anderer Bereiche frei bleiben)
// ---------------------------------------------------------------------------

const zeitpunkt = z.iso.datetime();
const objektId = z.string().min(1).max(200);
/** Personen-ID der kanzleikonsole (Mitarbeiter oder Mandantenkontakt). */
const personId = z.string().min(1).max(200);
const text = (max: number) => z.string().max(max);
const klasse = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
const governanceTyp = z.enum(['FP', 'FF', 'IN']);
const turnus = z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']);
const frequenz = z.object({ turnus, anlass: z.boolean() }).strict();
const anzeigeStatus = z.enum([
  'GEPLANT',
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'UEBERFAELLIG',
  'ENTFALLEN',
]);
const design = z.enum(['ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL']);
const betriebsStand = z.enum(['OK', 'MIT_BEFUND', 'UEBERFAELLIG', 'KEINE']);
const partei = z.enum(['KANZLEI', 'MANDANT']);
const mandantRolle = z.enum([
  'GESETZLICHER_VERTRETER',
  'TAX_COMPLIANCE_BEAUFTRAGTER',
  'MITARBEITER',
]);
const grundelementKey = z.enum([
  'kultur',
  'ziele',
  'risiken',
  'programm',
  'organisation',
  'kommunikation',
  'ueberwachung',
]);
const bausteinArt = z.enum([
  'TEILBEREICH',
  'ZIELE',
  'RISIKOINVENTAR',
  'KONTROLLMATRIX',
  'VERANTWORTUNG',
  'LAENDER',
  'FESTSTELLUNGEN',
]);
const abschnitt = z
  .object({
    key: z.enum([
      'teilbereich',
      'kultur',
      'ziele',
      'risiken',
      'programm',
      'organisation',
      'kommunikation',
      'ueberwachung',
      'anhang',
    ]),
    bloecke: z.array(
      z.discriminatedUnion('typ', [
        z.object({ typ: z.literal('text'), text: text(100_000) }).strict(),
        z.object({ typ: z.literal('baustein'), art: bausteinArt }).strict(),
      ]),
    ),
  })
  .strict();
const nettoErgebnis = z
  .object({
    klasse,
    abschlag: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    erklaerung: text(2000),
    zaehlend: z.array(text(50)),
  })
  .strict();
const risikoBewertung = z
  .object({
    brutto: z
      .object({
        klasse,
        punkte: z.number(),
        basis: klasse,
        angehoben: z.boolean(),
        erklaerung: text(2000),
      })
      .strict(),
    nettoDesign: nettoErgebnis,
    nettoBetrieb: nettoErgebnis,
    wirksamDesign: klasse,
    wirksamBetrieb: klasse,
    uebersteuertDesign: z.boolean(),
    uebersteuertBetrieb: z.boolean(),
    modell: text(500),
  })
  .strict();
const frequenzAbleitung = z
  .object({
    mindest: frequenz,
    effektiv: frequenz,
    gt: governanceTyp.nullable(),
    quelle: z
      .object({ code: text(50), gt: governanceTyp, brutto: klasse })
      .strict()
      .nullable(),
    abweichendVonVorlage: z.boolean(),
    begruendung: text(2000),
  })
  .strict();

const durchfuehrungSicht = z
  .object({
    id: objektId,
    kontrolleId: objektId,
    code: text(50),
    titel: text(500),
    periodeLabel: text(100),
    periodeVon: zeitpunkt,
    periodeBis: zeitpunkt,
    faelligAm: zeitpunkt,
    status: text(50),
    anzeige: anzeigeStatus,
    ausserplanmaessig: z.boolean(),
    anlass: text(2000).nullable(),
    partei,
    durchfuehrendId: personId.nullable(),
    gegenzeichnerId: personId.nullable(),
    durchgefuehrtVon: personId.nullable(),
    gegengezeichnetVon: personId.nullable(),
    mandantBestaetigtVon: personId.nullable(),
    eingereichtAm: zeitpunkt.nullable(),
    abgeschlossenAm: zeitpunkt.nullable(),
    nachweise: z.number().int(),
    mindestNachweise: z.number().int(),
    gt: governanceTyp.nullable(),
    schluessel: z.boolean(),
  })
  .strict();

const risikoSicht = z
  .object({
    id: objektId,
    code: text(50),
    gruppe: z.enum(['UST', 'GOB', 'ERT', 'VER']),
    gruppeLabel: text(100),
    kern: z.boolean(),
    herkunft: z.enum(['KATALOG', 'BERATER']),
    freigabe: z.enum(['IDENTIFIZIERT', 'BEWERTET', 'ZUR_FREIGABE', 'FREIGEGEBEN']),
    freigabeEingereichtVon: personId.nullable(),
    freigegebenVon: personId.nullable(),
    freigegebenAm: zeitpunkt.nullable(),
    ownerId: personId.nullable(),
    neuBewerten: z.boolean(),
    vorschlagsgrund: text(2000).nullable(),
    standId: objektId,
    titel: text(500),
    fehlerquelle: text(10_000),
    folge: text(10_000),
    normanker: z.array(
      z
        .object({ text: text(500), stufe: z.enum(['GEPRUEFT', 'UNGEPRUEFT', 'KI_VERMUTUNG']) })
        .strict(),
    ),
    s: z.enum(['N', 'M', 'H']),
    w: z.enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG']),
    r: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    gt: governanceTyp,
    gueltigAb: zeitpunkt,
    kontrollIds: z.array(objektId),
    bewertung: risikoBewertung,
    netto: klasse,
    ueberAppetit: z.boolean(),
    uebersteuerungen: z.array(
      z
        .object({
          id: objektId,
          sicht: z.enum(['DESIGN', 'BETRIEB']),
          klasse,
          berechnet: klasse,
          begruendung: text(10_000),
          status: z.enum(['BEANTRAGT', 'FREIGEGEBEN', 'ABGELEHNT', 'AUFGEHOBEN']),
          beantragtVon: personId,
          beantragtAm: zeitpunkt,
          entschiedenVon: personId.nullable(),
          entschiedenAm: zeitpunkt.nullable(),
        })
        .strict(),
    ),
    offeneEreignisse: z.number().int(),
    wirktAuf: z.array(text(100)),
  })
  .strict();

const kontrolleSicht = z
  .object({
    id: objektId,
    code: text(50),
    standId: objektId,
    version: z.number().int(),
    titel: text(500),
    ziel: text(10_000),
    art: z.enum(['P', 'D', 'K']),
    ausfuehrung: z.enum(['M', 'IT', 'A']),
    vorlage: frequenz,
    abweichung: z
      .object({
        frequenz,
        begruendung: text(10_000).nullable(),
        freigegebenVon: personId.nullable(),
      })
      .strict()
      .nullable(),
    partei,
    schluessel: z.boolean(),
    durchfuehrendId: personId.nullable(),
    vertretungId: personId.nullable(),
    gegenzeichnerId: personId.nullable(),
    gegenzeichnungMandant: z.boolean(),
    nachweis: text(10_000),
    mindestNachweise: z.number().int(),
    schritte: z.array(z.object({ titel: text(500), hinweis: text(5000) }).strict()),
    kennzahlen: z.array(
      z
        .object({
          key: text(100),
          label: text(500),
          sollEur: z.number().nullable(),
          differenzAus: z.tuple([text(100), text(100)]).optional(),
        })
        .strict(),
    ),
    toleranzEur: z.number().nullable(),
    faelligNachTagen: z.number().int(),
    design,
    designVon: personId.nullable(),
    designAm: zeitpunkt.nullable(),
    designBegruendung: text(10_000).nullable(),
    risikoIds: z.array(objektId),
    risikoCodes: z.array(text(50)),
    ableitung: frequenzAbleitung,
    frequenz,
    gt: governanceTyp.nullable(),
    betrieb: betriebsStand,
    letzte: durchfuehrungSicht.nullable(),
    naechste: durchfuehrungSicht.nullable(),
    pflichtattributeOk: z.boolean(),
  })
  .strict();

const feststellungSicht = z
  .object({
    id: objektId,
    nummer: text(50),
    titel: text(500),
    sachverhalt: text(20_000),
    quelle: z.enum(['KONTROLLE', 'EREIGNIS', 'STICHPROBE', 'HINWEIS', 'AUSSENPRUEFUNG']),
    quelleText: text(2000),
    klasse: z.enum(['DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS']),
    schwere: klasse,
    auswirkung: z.enum(['JA', 'NEIN', 'UNKLAR']),
    status: z.enum([
      'ERFASST',
      'IN_WUERDIGUNG',
      'MASSNAHMEN_OFFEN',
      'NACHKONTROLLE',
      'GESCHLOSSEN',
      'VERWORFEN',
    ]),
    vertraulich: z.boolean(),
    beteiligte: z.array(personId),
    p153Entscheidung: z
      .enum(['BERICHTIGUNG', 'KEINE_PFLICHT', 'WEITERE_KLAERUNG', 'UEBERGABE'])
      .nullable(),
    p153Offen: z.boolean(),
    massnahmenOffen: z.number().int(),
    massnahmen: z.number().int(),
    aeltesteFrist: zeitpunkt.nullable(),
    erfasstAm: zeitpunkt,
    risikoCodes: z.array(text(50)),
  })
  .strict();

const ereignisSicht = z
  .object({
    id: objektId,
    nummer: text(50),
    typ: text(100),
    titel: text(500),
    beschreibung: text(20_000),
    quelle: z.enum(['PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL']),
    gemeldetVon: personId.nullable(),
    gemeldetAm: zeitpunkt,
    ereignisDatum: zeitpunkt,
    status: z.enum(['NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN']),
    verwerfenBegruendung: text(10_000).nullable(),
    triagiertVon: personId.nullable(),
    triagiertAm: zeitpunkt.nullable(),
    folgen: z.array(
      z
        .object({
          id: objektId,
          art: text(100),
          ziel: text(200).nullable(),
          text: text(10_000),
          zustaendig: personId.nullable(),
          frist: zeitpunkt.nullable(),
          status: z.enum(['VORGESCHLAGEN', 'ANGELEGT', 'ERLEDIGT', 'VERWORFEN']),
          objektId: objektId.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const landSicht = z
  .object({
    id: objektId,
    land: text(10),
    fernverkaeufeLfdEur: z.number(),
    fernverkaeufeVorjahrEur: z.number(),
    lagerSeit: text(20).nullable(),
    oss: z.boolean(),
    lokaleUstNr: z.boolean(),
    zmRelevant: z.boolean(),
    steuersaetzeGeprueftAm: zeitpunkt.nullable(),
    stand: zeitpunkt,
    quelle: z.enum(['MANUELL', 'CSV']),
    erfasstVon: personId.nullable(),
    registrierung: z.enum(['VOLLSTAENDIG', 'FEHLT', 'PRUEFEN']),
  })
  .strict();

const beschreibungSicht = z
  .object({
    id: objektId,
    nummer: text(50),
    status: z.enum(['ENTWURF', 'KANZLEI_REVIEW', 'BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST']),
    abschnitte: z.array(abschnitt),
    createdAt: zeitpunkt,
    erstelltVon: personId.nullable(),
    reviewAngefordertVon: personId.nullable(),
    reviewAngefordertAm: zeitpunkt.nullable(),
    reviewVon: personId.nullable(),
    reviewAm: zeitpunkt.nullable(),
    freigabeAngefordertAm: zeitpunkt.nullable(),
    freigegebenVon: personId.nullable(),
    freigegebenAm: zeitpunkt.nullable(),
    snapshotSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

const prueflastSicht = z
  .object({
    monat: z.string().regex(/^\d{4}-\d{2}$/),
    FP: z.number().int(),
    FF: z.number().int(),
    IN: z.number().int(),
    ausloesungen: z.number().int(),
    gesamt: z.number().int(),
  })
  .strict();

/** Rechte des Akteurs für diesen Mandanten als Kennzeichen für die Oberfläche (ADR 0001 §5). */
const kontextRechte = z
  .object({
    /** Bearbeiten (aktueller Stand und `kannBearbeiten`). */
    bearbeiten: z.boolean(),
    /** §-153-Würdigung (aktueller Stand und `kannWuerdigen`). */
    wuerdigen: z.boolean(),
  })
  .strict();

/** Antwort von `GET /v1/mandanten/:mandantId/kontext`. */
export const KontextAntwortSchema = z
  .object({
    heute: StandSchema,
    stand: StandSchema,
    historisch: z.boolean(),
    mandant: z
      .object({
        id: z.uuid(),
        name: text(200),
        rechtsform: text(50),
        datevNr: text(20).nullable(),
      })
      .strict(),
    rechte: kontextRechte,
    kontaktRollen: z.array(
      z
        .object({ kontaktId: personId, rolle: mandantRolle, funktion: text(200).nullable() })
        .strict(),
    ),
    programm: z
      .object({
        id: objektId,
        status: z.enum(['ENTWURF', 'AKTIV']),
        paketVersion: text(50),
        erklaerungsTurnus: turnus,
        angemessenheitStichtag: zeitpunkt.nullable(),
        wirksamAb: zeitpunkt.nullable(),
        wirksamBis: zeitpunkt.nullable(),
        version1Am: zeitpunkt.nullable(),
        createdAt: zeitpunkt,
      })
      .strict()
      .nullable(),
    teilbereich: z
      .object({
        id: objektId,
        name: text(500),
        abgrenzung: text(20_000),
        einschluesse: z.array(text(2000)),
        ausschluesse: z.array(text(2000)),
      })
      .strict()
      .nullable(),
    ziele: z.array(
      z
        .object({
          id: objektId,
          text: text(10_000),
          wesentlichkeitEur: z.number(),
          risikoappetit: klasse,
          freigabe: z.enum(['ENTWURF', 'AUSSTEHEND', 'FREIGEGEBEN']),
          freigegebenAm: zeitpunkt.nullable(),
          freigegebenVon: personId.nullable(),
        })
        .strict(),
    ),
    appetit: klasse,
    /** Geschäftsprofil (beim Speichern geprüft, hier unverändert). */
    profil: z.record(z.string(), z.json()).nullable(),
    profilGueltigAb: zeitpunkt.nullable(),
    risiken: z.array(risikoSicht),
    vorschlaege: z.array(
      z
        .object({
          id: objektId,
          code: text(50),
          grund: text(2000).nullable(),
          entscheidung: z.enum(['VORGESCHLAGEN', 'ABGELEHNT']),
          ablehnungsgrund: text(10_000).nullable(),
        })
        .strict(),
    ),
    kontrollen: z.array(kontrolleSicht),
    durchfuehrungen: z.array(durchfuehrungSicht),
    feststellungen: z.array(feststellungSicht),
    ereignisse: z.array(ereignisSicht),
    laender: z.array(landSicht),
    schwelle: z
      .object({
        status: z.enum(['UNTERSCHRITTEN', 'WARNUNG', 'UEBERSCHRITTEN']),
        anteilLfd: z.number(),
        anteilVorjahr: z.number(),
        label: text(200),
      })
      .strict(),
    fernverkaeufeLfd: z.number(),
    fernverkaeufeVorjahr: z.number(),
    laenderStand: zeitpunkt.nullable(),
    laenderQuelle: z.enum(['MANUELL', 'CSV']).nullable(),
    beschreibungen: z.array(beschreibungSicht),
    phasen: z.array(
      z
        .object({
          nr: z.number().int(),
          name: text(200),
          bedingungen: z.array(
            z
              .object({ text: text(500), erfuellt: z.boolean(), link: text(100).optional() })
              .strict(),
          ),
          erfuellt: z.boolean(),
        })
        .strict(),
    ),
    aktivePhase: z.number().int(),
    grundelemente: z.array(
      z
        .object({
          key: grundelementKey,
          titel: text(200),
          icon: text(100),
          luecken: z.array(text(500)),
        })
        .strict(),
    ),
    prueflast: z.array(prueflastSicht),
    zeitraum: z
      .object({
        monat: z.number().int(),
        monate: z.number().int(),
        relevante: z.number().int(),
        ohneBefund: z.number().int(),
        mitBefund: z.number().int(),
        offen: z.number().int(),
        ohneGegenzeichnung: z.number().int(),
        ueberfaellig: z.number().int(),
        fehlendeNachweise: z.number().int(),
      })
      .strict()
      .nullable(),
    ausgeblendet: z.number().int(),
  })
  .strict();

export type KontextAntwort = z.infer<typeof KontextAntwortSchema>;
