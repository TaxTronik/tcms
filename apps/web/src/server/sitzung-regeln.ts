import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Reine Regeln der Demo-Sitzung (ohne Next-Abhängigkeiten, damit testbar).
// TS-01: Mit NODE_ENV=production ist die Demo-Anmeldung immer verweigert
//        (`next build` setzt NODE_ENV fest ein; nach dem Build gilt das
//        unabhängig vom Laufzeitwert). Die Demo bindet nur an 127.0.0.1.
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

// -----------------------------------------------------------------------------
// Serverseitiges Sitzungsregister: Jede Anmeldung erhält eine zufällige
// Sitzungskennung, die nur im laufenden Prozess gilt. Abmelden entfernt sie,
// danach ist auch ein kopierter Cookie-Wert ungültig. Ein Neustart beendet alle
// Sitzungen (fail closed, keine eigene Tabelle). Das Register liegt an
// `globalThis`, damit alle Bundles des Next-Servers (Seiten, Actions, Routen)
// dasselbe sehen.
// -----------------------------------------------------------------------------

const REGISTER = Symbol.for('tcms.demo.sitzungen');
type Register = Map<string, number>;

function register(): Register {
  const g = globalThis as { [REGISTER]?: Register };
  return (g[REGISTER] ??= new Map());
}

function raeumeAuf(jetztMs: number): void {
  const r = register();
  for (const [sid, ablauf] of r) if (ablauf <= jetztMs) r.delete(sid);
}

/** Signierte Teile eines Cookies (`<id>.<ablauf>.<sid>.<hmac>`), sonst null. */
function leseCookie(wert: string | undefined): { id: string; ablauf: number; sid: string } | null {
  if (!wert || wert.length > 512) return null;
  const teile = wert.split('.');
  if (teile.length !== 4) return null;
  const [id, ablauf, sid, sig] = teile as [string, string, string, string];
  if (!/^\d{1,16}$/.test(ablauf) || !/^[A-Za-z0-9_-]{22}$/.test(sid)) return null;
  const erwartet = Buffer.from(signiere(`${id}.${ablauf}.${sid}`));
  const geliefert = Buffer.from(sig);
  if (erwartet.length !== geliefert.length || !timingSafeEqual(erwartet, geliefert)) return null;
  return { id, ablauf: Number(ablauf), sid };
}

/** Prüft ein Sitzungs-Cookie (Signatur, Ablauf, Register); liefert die Personen-ID oder null. */
export function pruefeCookie(wert: string | undefined, jetztMs = Date.now()): string | null {
  const c = leseCookie(wert);
  if (!c || c.ablauf <= jetztMs) return null;
  const eingetragen = register().get(c.sid);
  if (eingetragen === undefined || eingetragen !== c.ablauf) return null;
  return c.id;
}

/**
 * Eröffnet eine Sitzung für eine Person: Cookie-Wert (Nutzlast
 * `<id>.<ablauf>.<sid>` plus HMAC) und Eintrag im Sitzungsregister.
 */
export function erzeugeCookie(personId: string, jetztMs = Date.now()): string {
  const ablauf = jetztMs + DAUER_MS;
  const sid = randomBytes(16).toString('base64url');
  const nutzlast = `${personId}.${ablauf}.${sid}`;
  const wert = `${nutzlast}.${signiere(nutzlast)}`;
  raeumeAuf(jetztMs);
  register().set(sid, ablauf);
  return wert;
}

/** Beendet die Sitzung eines Cookies serverseitig (nur mit gültiger Signatur). */
export function beendeCookie(wert: string | undefined): void {
  const c = leseCookie(wert);
  if (c) register().delete(c.sid);
}
