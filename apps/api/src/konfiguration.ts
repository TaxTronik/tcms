// =============================================================================
// Konfiguration des Dienstes, beim Start mit zod geprüft (fail closed).
//
// Fehlermeldungen nennen Variable und Grund, nie den Wert (Tokens, Passwörter).
// Platzhalter aus `apps/api/.env.example` und der Demo-`.env.example` werden
// abgewiesen, auch wenn sie die Längenregel erfüllen (TS-02).
// =============================================================================

import type { KeyObject } from 'node:crypto';
import { parseSchluesselListe } from '@tcms/contract';
import { z } from 'zod';
import { B64TOKEN } from './dienst-token';

export interface Konfiguration {
  dienstTokens: string[];
  akteurSchluessel: Map<string, KeyObject>;
  datenbankUrl: string;
  host: string;
  port: number;
}

export class KonfigurationsFehler extends Error {
  readonly probleme: string[];

  constructor(probleme: string[]) {
    super(`Konfiguration ungültig:\n${probleme.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'KonfigurationsFehler';
    this.probleme = probleme;
  }
}

/** Wörtliche Platzhalter aus den `.env.example`-Dateien. */
export const BEKANNTE_PLATZHALTER: ReadonlySet<string> = new Set([
  'bitte-durch-einen-zufaelligen-dienst-token-ersetzen',
  'bitte-durch-einen-langen-zufallswert-ersetzen',
  'postgresql://tcms_app:bitte-ersetzen@127.0.0.1:5433/tcms',
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

function schema(produktion: boolean) {
  return z.object({
    TCMS_SERVICE_TOKENS: z.string({ error: 'fehlt' }).transform((wert, ctx) => {
      const fehler = (message: string) => {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      };
      const tokens = wert.split(',').map((t) => t.trim());
      for (const [i, token] of tokens.entries()) {
        const nr = `Eintrag ${i + 1}`;
        if (token === '') return fehler(`${nr} ist leer`);
        if (token.length < MIN_TOKEN) return fehler(`${nr} ist kürzer als ${MIN_TOKEN} Zeichen`);
        if (token.length > MAX_TOKEN) return fehler(`${nr} ist länger als ${MAX_TOKEN} Zeichen`);
        if (!B64TOKEN.test(token)) {
          return fehler(
            `${nr} enthält Zeichen außerhalb von A-Z a-z 0-9 - . _ ~ + / (= nur am Ende)`,
          );
        }
        if (istPlatzhalter(token)) return fehler(`${nr} ist ein Platzhalter`);
        if (new Set(token).size < MIN_VERSCHIEDENE_ZEICHEN) {
          return fehler(`${nr} hat zu wenige verschiedene Zeichen`);
        }
      }
      if (new Set(tokens).size !== tokens.length) return fehler('Einträge doppelt');
      return tokens;
    }),
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
    akteurSchluessel: d.TCMS_ACTOR_PUBLIC_KEYS,
    datenbankUrl: d.DATABASE_URL,
    host: d.HOST,
    port: d.PORT,
  };
}
