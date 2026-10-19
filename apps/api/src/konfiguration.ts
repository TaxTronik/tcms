// =============================================================================
// Konfiguration des Dienstes, beim Start mit zod geprüft (fail closed).
//
// Fehlermeldungen nennen Variable und Grund, nie den Wert (Tokens, Passwörter,
// Schlüssel). Platzhalter aus der `.env.example` im Repo-Root werden
// abgewiesen, auch wenn sie die Längenregel erfüllen (TS-02).
//
// `TCMS_CODE_SCHLUESSEL` (Hinweis H5 aus RT4): Schlüssel der
// Bestätigungscodes (HMAC-SHA-256), Liste nach denselben Regeln wie die
// Dienst-Tokens; der erste Eintrag signiert neue Codes, alle prüfen (Rotation).
// =============================================================================

import type { KeyObject } from 'node:crypto';
import { parseSchluesselListe } from '@tcms/contract';
import { z } from 'zod';
import { B64TOKEN } from './dienst-token';
import { LOG_STUFEN, type LogStufe } from './log';

export interface Konfiguration {
  dienstTokens: string[];
  /** Schlüssel der Bestätigungscodes; der erste signiert neue Codes. Nie ausgeben. */
  codeSchluessel: string[];
  akteurSchluessel: Map<string, KeyObject>;
  datenbankUrl: string;
  host: string;
  port: number;
  logStufe: LogStufe;
}

export class KonfigurationsFehler extends Error {
  readonly probleme: string[];

  constructor(probleme: string[]) {
    super(`Konfiguration ungültig:\n${probleme.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'KonfigurationsFehler';
    this.probleme = probleme;
  }
}

/** Wörtliche Platzhalter aus `.env.example` (auch früherer Stände). */
export const BEKANNTE_PLATZHALTER: ReadonlySet<string> = new Set([
  'bitte-durch-einen-zufaelligen-dienst-token-ersetzen',
  'bitte-durch-einen-langen-zufallswert-ersetzen',
  'bitte-durch-einen-zufaelligen-code-schluessel-ersetzen',
]);
/** Typische Platzhalterwörter; in zufälligen Tokens praktisch ausgeschlossen. */
const PLATZHALTER_MUSTER =
  /ersetzen|replace|change.?me|platzhalter|placeholder|beispiel|example|dummy|secret|geheim|passwor|xxxx/i;
/** Bekannte Standardpasswörter; in Produktion für DATABASE_URL abgewiesen. */
const SCHWACHE_DB_PASSWOERTER = new Set([
  '',
  'tcms',
  'tcms_app',
  'tcms_owner',
  'postgres',
  'password',
  'passwort',
  'admin',
  'root',
  'test',
]);
const MIN_TOKEN = 32;
const MAX_TOKEN = 512;
const MIN_VERSCHIEDENE_ZEICHEN = 8;

const istPlatzhalter = (wert: string) =>
  BEKANNTE_PLATZHALTER.has(wert) || PLATZHALTER_MUSTER.test(wert);

/**
 * Kommagetrennte Liste geheimer Werte (Dienst-Tokens, Code-Schlüssel): je
 * Eintrag 32–512 Zeichen aus dem b64token-Zeichensatz, kein Platzhalter,
 * mindestens 8 verschiedene Zeichen, keine Dubletten. Meldungen ohne Werte.
 */
function geheimnisListe() {
  return z.string({ error: 'fehlt' }).transform((wert, ctx) => {
    const fehler = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    const eintraege = wert.split(',').map((t) => t.trim());
    for (const [i, eintrag] of eintraege.entries()) {
      const nr = `Eintrag ${i + 1}`;
      if (eintrag === '') return fehler(`${nr} ist leer`);
      if (eintrag.length < MIN_TOKEN) return fehler(`${nr} ist kürzer als ${MIN_TOKEN} Zeichen`);
      if (eintrag.length > MAX_TOKEN) return fehler(`${nr} ist länger als ${MAX_TOKEN} Zeichen`);
      if (!B64TOKEN.test(eintrag)) {
        return fehler(
          `${nr} enthält Zeichen außerhalb von A-Z a-z 0-9 - . _ ~ + / (= nur am Ende)`,
        );
      }
      if (istPlatzhalter(eintrag)) return fehler(`${nr} ist ein Platzhalter`);
      if (new Set(eintrag).size < MIN_VERSCHIEDENE_ZEICHEN) {
        return fehler(`${nr} hat zu wenige verschiedene Zeichen`);
      }
    }
    if (new Set(eintraege).size !== eintraege.length) return fehler('Einträge doppelt');
    return eintraege;
  });
}

function schema(produktion: boolean) {
  return z
    .object({
      TCMS_SERVICE_TOKENS: geheimnisListe(),
      TCMS_CODE_SCHLUESSEL: geheimnisListe(),
      TCMS_ACTOR_PUBLIC_KEYS: z.string({ error: 'fehlt' }).transform((wert, ctx) => {
        try {
          return parseSchluesselListe(wert);
        } catch (e) {
          // Meldungen von parseSchluesselListe enthalten kein Schlüsselmaterial.
          ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'ungültig' });
          return z.NEVER;
        }
      }),
      DATABASE_URL: z.string({ error: 'fehlt' }).transform((wert, ctx) => {
        const fehler = (message: string) => {
          ctx.addIssue({ code: 'custom', message });
          return z.NEVER;
        };
        if (BEKANNTE_PLATZHALTER.has(wert)) return fehler('ist ein Platzhalter');
        let url: URL;
        try {
          url = new URL(wert);
        } catch {
          return fehler('ist keine URL');
        }
        if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
          return fehler('muss mit postgresql:// beginnen');
        }
        if (url.hostname === '' || url.pathname.length <= 1) {
          return fehler('braucht Host und Datenbank');
        }
        const passwort = decodeURIComponentSicher(url.password);
        if (passwort === null || (passwort !== '' && istPlatzhalter(passwort))) {
          return fehler('Passwort ist ein Platzhalter');
        }
        if (produktion && SCHWACHE_DB_PASSWOERTER.has(passwort)) {
          return fehler('Passwort ist ein bekanntes Standardpasswort (Produktion)');
        }
        return wert;
      }),
      HOST: z
        .string()
        .regex(/^[A-Za-z0-9.:-]{1,253}$/, 'ist kein Hostname und keine IP-Adresse')
        .default('0.0.0.0'),
      PORT: z
        .string()
        .regex(/^[1-9][0-9]{0,4}$/, 'ist keine Portnummer')
        .transform(Number)
        .refine((p) => p <= 65_535, 'ist keine Portnummer')
        .default(3200),
      TCMS_LOG_LEVEL: z
        .enum(LOG_STUFEN, { error: `erlaubt sind ${LOG_STUFEN.join(', ')}` })
        .default('info'),
    })
    .superRefine((k, ctx) => {
      // Ein Code-Schlüssel ist kein Dienst-Token: Wer ein Token kennt (Aufrufer),
      // darf damit keine gespeicherten Code-Hashes nachrechnen können.
      const tokens = new Set(k.TCMS_SERVICE_TOKENS);
      if (k.TCMS_CODE_SCHLUESSEL.some((s) => tokens.has(s))) {
        ctx.addIssue({
          code: 'custom',
          path: ['TCMS_CODE_SCHLUESSEL'],
          message: 'ein Eintrag gleicht einem Dienst-Token',
        });
      }
    });
}

function decodeURIComponentSicher(wert: string): string | null {
  try {
    return decodeURIComponent(wert);
  } catch {
    return null;
  }
}

/** Liest und prüft die Konfiguration; wirft `KonfigurationsFehler` ohne Werte. */
export function ladeKonfiguration(
  env: Readonly<Record<string, string | undefined>>,
): Konfiguration {
  const ergebnis = schema(env.NODE_ENV === 'production').safeParse(env);
  if (!ergebnis.success) {
    throw new KonfigurationsFehler(
      ergebnis.error.issues.map((i) => `${i.path.join('.') || '(Umgebung)'}: ${i.message}`),
    );
  }
  const d = ergebnis.data;
  return {
    dienstTokens: d.TCMS_SERVICE_TOKENS,
    codeSchluessel: d.TCMS_CODE_SCHLUESSEL,
    akteurSchluessel: d.TCMS_ACTOR_PUBLIC_KEYS,
    datenbankUrl: d.DATABASE_URL,
    host: d.HOST,
    port: d.PORT,
    logStufe: d.TCMS_LOG_LEVEL,
  };
}
