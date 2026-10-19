import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Reine Regeln der Demo-Sitzung (ohne Next-Abhängigkeiten, damit testbar).
// TS-01: Mit NODE_ENV=production ist die Demo-Anmeldung immer verweigert.
// TS-02: Bekannte Platzhalter für SESSION_SECRET werden abgewiesen.
// =============================================================================

export const COOKIE = 'tcms_sitzung';
export const DAUER_MS = 12 * 60 * 60 * 1000;
/** Platzhalter aus Vorlagen und Dokumentation; nie als Geheimnis zulässig. */
const BEKANNTE_PLATZHALTER = new Set([
  'bitte-durch-einen-langen-zufallswert-ersetzen',
  'changeme',
  'change-me',
  'secret',
  'session-secret',
  'session_secret',
]);
const PLATZHALTER_MUSTER =
  /(ersetzen|change.?me|placeholder|platzhalter|beispiel|example|zufallswert|your.?secret|geheimnis)/i;

/** Bekannter Platzhalter oder typisches Platzhalterwort (TS-02); auch für den Code-Schlüssel. */
export function istPlatzhalter(s: string): boolean {
  return BEKANNTE_PLATZHALTER.has(s.trim().toLowerCase()) || PLATZHALTER_MUSTER.test(s);
}

/** Liefert das Sitzungsgeheimnis oder wirft (fail closed, TS-02). */
export function pruefeSessionSecret(wert: string | undefined): string {
  const s = wert ?? '';
  if (s.length < 32) {
    throw new Error(
      '[auth] SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen. Siehe .env.example.',
    );
  }
  if (istPlatzhalter(s)) {
    throw new Error('[auth] SESSION_SECRET ist ein Platzhalter. Eigenen Zufallswert setzen.');
  }
  if (new Set(s).size < 10) {
    throw new Error('[auth] SESSION_SECRET ist zu gleichförmig. Eigenen Zufallswert setzen.');
  }
  return s;
}

export function signiere(wert: string): string {
  return createHmac('sha256', pruefeSessionSecret(process.env['SESSION_SECRET']))
    .update(wert)
    .digest('base64url');
}

/** Demo-Anmeldung nur außerhalb von Produktion (TS-01), ohne Schalter zum Übersteuern. */
export function demoLoginErlaubt(): boolean {
  return process.env['NODE_ENV'] !== 'production';
}

/** Prüft ein Sitzungs-Cookie; liefert die Personen-ID oder null. */
export function pruefeCookie(wert: string | undefined, jetztMs = Date.now()): string | null {
  if (!wert || wert.length > 512) return null;
  const teile = wert.split('.');
  if (teile.length !== 3) return null;
  const [id, ablauf, sig] = teile as [string, string, string];
  if (!/^\d{1,16}$/.test(ablauf)) return null;
  const erwartet = Buffer.from(signiere(`${id}.${ablauf}`));
  const geliefert = Buffer.from(sig);
  if (erwartet.length !== geliefert.length || !timingSafeEqual(erwartet, geliefert)) return null;
  if (Number(ablauf) < jetztMs) return null;
  return id;
}

/** Cookie-Wert für eine Person (Nutzlast `<id>.<ablauf>` plus HMAC). */
export function erzeugeCookie(personId: string, jetztMs = Date.now()): string {
  const nutzlast = `${personId}.${jetztMs + DAUER_MS}`;
  return `${nutzlast}.${signiere(nutzlast)}`;
}
