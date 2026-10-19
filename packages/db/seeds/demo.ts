// =============================================================================
// Statisches Demo-Verzeichnis (fiktiv). Ersetzt die frühere Tabelle `Person`:
// Personen, Mandanten und Zuständigkeiten gehören im Zielbild der kanzleikonsole
// (ADR 0001 §5). Seed und Demo-Oberfläche (`@tcms/db/demo`) teilen sich diese
// festen UUIDs; der Dienst (apps/api) importiert dieses Modul nie.
// =============================================================================

/** Fester Tenant (Kanzlei) der Demo. */
export const DEMO_TENANT_ID = '7a1e0000-0000-4000-8000-00000000d3e0';

export type DemoMandantRolle =
  | 'GESETZLICHER_VERTRETER'
  | 'TAX_COMPLIANCE_BEAUFTRAGTER'
  | 'MITARBEITER';

export interface DemoPerson {
  id: string;
  name: string;
  kuerzel: string;
  email: string;
  telefon: string | null;
  funktion: string;
  art: 'KANZLEI' | 'MANDANT';
  /** Kanzlei: Admin/Partner. */
  istAdmin: boolean;
  /** Kanzlei: Berufsträger:in. */
  istBerufstraeger: boolean;
  /** Mandantenkontakt: Mandant und Rolle (wird als MandantKontaktRolle geseedet). */
  mandantId: string | null;
  rolle: DemoMandantRolle | null;
}

export interface DemoMandant {
  id: string;
  name: string;
  rechtsform: string;
  datevNr: string;
  /** Zuständige:r Berufsträger:in (in der kanzleikonsole: `cli.bt`). */
  berufstraegerId: string;
  /** Hauptbearbeitung (in der kanzleikonsole: `cli.hb`). */
  bearbeitungId: string;
}

const pid = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mid = (datev: string) => `a1000000-0000-4000-8000-${datev.padStart(12, '0')}`;

export const DEMO_IDS = {
  anna: pid(1),
  leon: pid(2),
  thomas: pid(3),
  jana: pid(11),
  murat: pid(12),
  sabine: pid(13),
  clara: pid(21),
  ole: pid(22),
  jonas: pid(31),
  pia: pid(41),
  henrik: pid(42),
  lea: pid(51),
  nils: pid(52),
  talwind: mid('4711'),
  seestern: mid('4720'),
  kleinwerk: mid('4733'),
  pixelhafen: mid('4698'),
  bergkamm: mid('4752'),
} as const;

const I = DEMO_IDS;

const kanzlei = (
  id: string,
  name: string,
  kuerzel: string,
  email: string,
  funktion: string,
  p: { admin?: boolean; bt?: boolean; telefon?: string },
): DemoPerson => ({
  id,
  name,
  kuerzel,
  email,
  telefon: p.telefon ?? null,
  funktion,
  art: 'KANZLEI',
  istAdmin: p.admin ?? false,
  istBerufstraeger: p.bt ?? false,
  mandantId: null,
  rolle: null,
});

const kontakt = (
  id: string,
  name: string,
  kuerzel: string,
  email: string,
  funktion: string,
  mandantId: string,
  rolle: DemoMandantRolle,
): DemoPerson => ({
  id,
  name,
  kuerzel,
  email,
  telefon: null,
  funktion,
  art: 'MANDANT',
  istAdmin: false,
  istBerufstraeger: false,
  mandantId,
  rolle,
});

export const DEMO_PERSONEN: readonly DemoPerson[] = Object.freeze([
  kanzlei(
    I.anna,
    'StB Dr. Anna Roth',
    'AR',
    'anna.roth@kanzlei-roth.example',
    'Berufsträgerin, Partnerin',
    {
      admin: true,
      bt: true,
      telefon: '+49 561 1234567',
    },
  ),
  kanzlei(I.leon, 'Leon Brandt', 'LB', 'leon.brandt@kanzlei-roth.example', 'Bearbeitung', {
    telefon: '+49 561 1234568',
  }),
  kanzlei(I.thomas, 'StB Thomas Kern', 'TK', 'thomas.kern@kanzlei-roth.example', 'Berufsträger', {
    bt: true,
  }),
  kontakt(
    I.jana,
    'Jana Weller',
    'JW',
    'jana.weller@talwind.example',
    'Geschäftsführerin',
    I.talwind,
    'GESETZLICHER_VERTRETER',
  ),
  kontakt(
    I.murat,
    'Murat Aydin',
    'MA',
    'murat.aydin@talwind.example',
    'Leitung Finanzen',
    I.talwind,
    'TAX_COMPLIANCE_BEAUFTRAGTER',
  ),
  kontakt(
    I.sabine,
    'Sabine Kraus',
    'SK',
    'sabine.kraus@talwind.example',
    'Buchhaltung',
    I.talwind,
    'MITARBEITER',
  ),
  kontakt(
    I.clara,
    'Clara Seemann',
    'CS',
    'clara.seemann@seestern.example',
    'Geschäftsführerin',
    I.seestern,
    'GESETZLICHER_VERTRETER',
  ),
  kontakt(
    I.ole,
    'Ole Brink',
    'OB',
    'ole.brink@seestern.example',
    'Kaufmännische Leitung',
    I.seestern,
    'TAX_COMPLIANCE_BEAUFTRAGTER',
  ),
  kontakt(
    I.jonas,
    'Jonas Klein',
    'JK',
    'jonas.klein@kleinwerk.example',
    'Geschäftsführer',
    I.kleinwerk,
    'GESETZLICHER_VERTRETER',
  ),
  kontakt(
    I.pia,
    'Pia Hafner',
    'PH',
    'pia.hafner@pixelhafen.example',
    'Komplementärin',
    I.pixelhafen,
    'GESETZLICHER_VERTRETER',
  ),
  kontakt(
    I.henrik,
    'Henrik Vogt',
    'HV',
    'henrik.vogt@pixelhafen.example',
    'Leitung Rechnungswesen',
    I.pixelhafen,
    'TAX_COMPLIANCE_BEAUFTRAGTER',
  ),
  kontakt(
    I.lea,
    'Lea Berg',
    'LE',
    'lea.berg@bergkamm.example',
    'Geschäftsführerin',
    I.bergkamm,
    'GESETZLICHER_VERTRETER',
  ),
  kontakt(
    I.nils,
    'Nils Ohm',
    'NO',
    'nils.ohm@bergkamm.example',
    'Buchhaltung',
    I.bergkamm,
    'TAX_COMPLIANCE_BEAUFTRAGTER',
  ),
]);

export const DEMO_MANDANTEN: readonly DemoMandant[] = Object.freeze([
  {
    id: I.talwind,
    name: 'Talwind Outdoor GmbH',
    rechtsform: 'KapG',
    datevNr: '4711',
    berufstraegerId: I.anna,
    bearbeitungId: I.leon,
  },
  {
    id: I.seestern,
    name: 'Seestern Home & Living GmbH',
    rechtsform: 'KapG',
    datevNr: '4720',
    berufstraegerId: I.thomas,
    bearbeitungId: I.leon,
  },
  {
    id: I.kleinwerk,
    name: 'Kleinwerk Manufaktur UG (haftungsbeschränkt)',
    rechtsform: 'KapG',
    datevNr: '4733',
    berufstraegerId: I.anna,
    bearbeitungId: I.leon,
  },
  {
    id: I.pixelhafen,
    name: 'Pixelhafen Electronics KG',
    rechtsform: 'PersG',
    datevNr: '4698',
    berufstraegerId: I.thomas,
    bearbeitungId: I.leon,
  },
  {
    id: I.bergkamm,
    name: 'Bergkamm Kaffeerösterei GmbH',
    rechtsform: 'KapG',
    datevNr: '4752',
    berufstraegerId: I.anna,
    bearbeitungId: I.leon,
  },
]);

export function demoPerson(id: string | null | undefined): DemoPerson | null {
  if (!id) return null;
  return DEMO_PERSONEN.find((p) => p.id === id.toLowerCase()) ?? null;
}

export function demoMandant(id: string | null | undefined): DemoMandant | null {
  if (!id) return null;
  return DEMO_MANDANTEN.find((m) => m.id === id.toLowerCase()) ?? null;
}
