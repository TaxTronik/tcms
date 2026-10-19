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
