// =============================================================================
// Schlüssel der Bestätigungscodes in der Demo (Hinweis H5 aus RT4): wie im
// Dienst aus `TCMS_CODE_SCHLUESSEL` (kommagetrennt, der erste signiert neue
// Codes). Ohne Next-Abhängigkeiten, damit testbar. Gelesen und geprüft erst,
// wenn ein Code ausgestellt oder geprüft wird – die übrige Demo (und der
// Build) läuft ohne die Variable; ein Code-Vorgang ohne gültigen Schlüssel
// bricht ab (fail closed). Meldungen nennen nie Werte.
// =============================================================================

import { erzeugeCodeSchluessel, MIN_CODE_SCHLUESSEL, type CodeSchluessel } from '@tcms/service';
import { istPlatzhalter } from './sitzung-regeln';

/** Prüft die Liste wie der Dienst (Länge, Platzhalter, Dubletten); wirft ohne Werte. */
export function pruefeCodeSchluesselListe(wert: string | undefined): string[] {
  const eintraege = (wert ?? '').split(',').map((s) => s.trim());
  if (eintraege.length === 0 || eintraege.some((s) => s.length < MIN_CODE_SCHLUESSEL)) {
    throw new Error(
      `[demo] TCMS_CODE_SCHLUESSEL fehlt oder ein Eintrag ist kürzer als ${MIN_CODE_SCHLUESSEL} Zeichen. Siehe .env.example.`,
    );
  }
  if (eintraege.some(istPlatzhalter)) {
    throw new Error(
      '[demo] TCMS_CODE_SCHLUESSEL enthält einen Platzhalter. Eigenen Zufallswert setzen.',
    );
  }
  if (new Set(eintraege).size !== eintraege.length) {
    throw new Error('[demo] TCMS_CODE_SCHLUESSEL enthält doppelte Einträge.');
  }
  return eintraege;
}

/** Schlüsselbund, der die Umgebung erst beim ersten Gebrauch liest. */
export function demoCodeSchluessel(
  lies: () => string | undefined = () => process.env['TCMS_CODE_SCHLUESSEL'],
): CodeSchluessel {
  let bund: CodeSchluessel | null = null;
  const holen = () => (bund ??= erzeugeCodeSchluessel(pruefeCodeSchluesselListe(lies())));
  return {
    get aktuelleId() {
      return holen().aktuelleId;
    },
    kennt: (id) => holen().kennt(id),
    hmac: (id, nachricht) => holen().hmac(id, nachricht),
  };
}
