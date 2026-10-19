#!/usr/bin/env node
// =============================================================================
// Lokale Entwicklung (Demo `pnpm dev`, Dienst `pnpm api`): legt die `.env` im
// Repo-Root aus `.env.example` an bzw. ergänzt eine vorhandene (tcms-s9).
//
//   pnpm env:lokal [--wurzel <verzeichnis>]
//
// Erzeugt die Geheimnisse der lokalen Entwicklung mit node:crypto, wo der Wert
// fehlt, leer oder ein Platzhalter ist:
//
//   SESSION_SECRET        Sitzungs-Cookie der Demo-Anmeldung (TS-02)
//   TCMS_CODE_SCHLUESSEL  Schlüssel der Bestätigungscodes (Hinweis H5 aus
//                         RT4; dieselben Regeln wie der Dienst beim Start)
//
// Ein vorhandener gültiger Wert bleibt unverändert (ein neuer Code-Schlüssel
// ließe alle offenen Codes ablaufen). Die Datei hat danach Modus 0600 und wird
// atomar ersetzt. Die Ausgabe nennt nur Namen und Aktionen, nie Werte.
//
// Bricht ab (Exit 1, nichts geschrieben): mit NODE_ENV=production; wenn `.env`
// keine normale Datei ist (Symlink, Verzeichnis); wenn git sie versioniert oder
// nicht ignoriert (nie committen); wenn eine der beiden Variablen mehrfach
// oder mit einem ungültigen Wert gesetzt ist, der kein Platzhalter ist – was
// jemand selbst gesetzt hat, überschreibt das Skript nicht.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODUS = 0o600;

// Regeln wie apps/api/src/konfiguration.ts (geheimnisListe: Code-Schlüssel und
// Tokens) und apps/web/src/server/sitzung-regeln.ts (Demo); Tests prüfen die
// erzeugte Datei gegen beide Prüfungen.
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const PLATZHALTER_DIENST =
  /ersetzen|replace|change.?me|platzhalter|placeholder|beispiel|example|dummy|secret|geheim|passwor|xxxx/i;
const PLATZHALTER_DEMO =
  /(ersetzen|change.?me|placeholder|platzhalter|beispiel|example|zufallswert|your.?secret|geheimnis)/i;
const PLATZHALTER_DEMO_WOERTLICH = new Set(['changeme', 'change-me', 'secret', 'session-secret']);
const platzhalterDemo = (w) =>
  PLATZHALTER_DEMO_WOERTLICH.has(w.trim().toLowerCase()) || PLATZHALTER_DEMO.test(w);
const platzhalterDienst = (w) => PLATZHALTER_DIENST.test(w) || platzhalterDemo(w);

function fehler(meldung) {
  process.stderr.write(`env:lokal: ${meldung}\n`);
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
let wurzel = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (args.length === 2 && args[0] === '--wurzel') wurzel = resolve(args[1]);
else if (args.length !== 0) fehler('Aufruf: pnpm env:lokal [--wurzel <verzeichnis>]');
if (process.env.NODE_ENV === 'production') {
  fehler('nur für die lokale Entwicklung (NODE_ENV=production).');
}

const ziel = join(wurzel, '.env');
const vorlage = join(wurzel, '.env.example');

/** Code-Schlüssel: Liste wie im Dienst; `null` = gültig, sonst Grund ohne Wert. */
function pruefeCodeSchluessel(wert, tokens) {
  const eintraege = wert.split(',').map((t) => t.trim());
  for (const e of eintraege) {
    if (e.length < 32 || e.length > 512) return 'Eintrag nicht 32–512 Zeichen lang';
    if (!B64TOKEN.test(e)) return 'Eintrag mit Zeichen außerhalb von A-Z a-z 0-9 - . _ ~ + /';
    if (new Set(e).size < 8) return 'Eintrag mit zu wenigen verschiedenen Zeichen';
    if (tokens.includes(e)) return 'Eintrag gleich einem Dienst-Token';
  }
  if (new Set(eintraege).size !== eintraege.length) return 'Einträge doppelt';
  return null;
}

/** Sitzungsgeheimnis wie die Demo; `null` = gültig. */
function pruefeSessionSecret(wert) {
  if (wert.length < 32) return 'kürzer als 32 Zeichen';
  if (new Set(wert).size < 10) return 'zu gleichförmig';
  return null;
}

/** Ein frischer Wert, der die Regeln sicher erfüllt (Platzhalterwörter ausgeschlossen). */
function erzeuge(art) {
  for (;;) {
    const w =
      art === 'hex' ? randomBytes(32).toString('hex') : randomBytes(32).toString('base64url');
    if (!platzhalterDienst(w) && new Set(w).size >= 10) return w;
  }
}

const ohneAnfuehrung = (w) => {
  const t = w.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
};
const ZEILE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

// --- Zieldatei prüfen (nie über einen Symlink schreiben) --------------------
let vorhanden = null;
try {
  const st = lstatSync(ziel);
  if (!st.isFile()) fehler('.env ist keine normale Datei (Symlink oder Verzeichnis).');
  vorhanden = readFileSync(ziel, 'utf8');
} catch (e) {
  if (e.code !== 'ENOENT') fehler(`.env nicht lesbar (${e.code ?? 'Fehler'}).`);
}

// --- nie committen: git darf .env weder versionieren noch übersehen ---------
const git = (...a) => spawnSync('git', ['-C', wurzel, ...a], { encoding: 'utf8' });
const versioniert = git('ls-files', '--error-unmatch', '--', '.env');
if (versioniert.error?.code === 'ENOENT') {
  process.stdout.write('Hinweis: git nicht gefunden, .gitignore nicht geprüft.\n');
} else if (versioniert.status === 0) {
  fehler('.env ist im git-Index. Mit `git rm --cached .env` entfernen; nie committen.');
} else {
  const ignoriert = git('check-ignore', '-q', '--', '.env');
  if (ignoriert.status === 1) fehler('.env wird von git nicht ignoriert (.gitignore).');
  if (ignoriert.status !== 0) {
    process.stdout.write('Hinweis: kein git-Arbeitsbaum, .gitignore nicht geprüft.\n');
  }
}

// --- Inhalt ergänzen ---------------------------------------------------------
let text = vorhanden;
const meldungen = [];
if (text === null) {
  try {
    text = readFileSync(vorlage, 'utf8');
  } catch {
    fehler('.env.example fehlt.');
  }
  meldungen.push('.env angelegt aus .env.example');
}
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const zeilen = text.split(/\r?\n/);
const werte = new Map();
const positionen = new Map();
zeilen.forEach((z, i) => {
  const m = ZEILE.exec(z);
  if (!m || z.trim().startsWith('#')) return;
  positionen.set(m[1], [...(positionen.get(m[1]) ?? []), i]);
  werte.set(m[1], ohneAnfuehrung(m[2]));
});
const tokens = (werte.get('TCMS_SERVICE_TOKENS') ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter((t) => t && !platzhalterDienst(t));

let geaendert = vorhanden === null;
for (const [name, art, platzhalter, pruefe] of [
  ['SESSION_SECRET', 'hex', platzhalterDemo, (w) => pruefeSessionSecret(w)],
  [
    'TCMS_CODE_SCHLUESSEL',
    'base64url',
    (w) => w.split(',').some(platzhalterDienst),
    (w) => pruefeCodeSchluessel(w, tokens),
  ],
]) {
  const pos = positionen.get(name) ?? [];
  if (pos.length > 1) fehler(`${name} ist mehrfach gesetzt; bitte auf eine Zeile kürzen.`);
  const wert = werte.get(name) ?? '';
  // Leer oder Platzhalter: erzeugen. Sonst behalten, wenn gültig; ungültig → Abbruch.
  if (wert !== '' && !platzhalter(wert)) {
    const grund = pruefe(wert);
    if (grund) fehler(`${name} ist ungültig (${grund}); Zeile löschen, dann neu erzeugen lassen.`);
    meldungen.push(`${name}: vorhanden, unverändert`);
    continue;
  }
  const zeile = `${name}=${erzeuge(art)}`;
  if (pos.length === 1) zeilen[pos[0]] = zeile;
  else {
    if (zeilen.at(-1) === '') zeilen.splice(zeilen.length - 1, 0, zeile);
    else zeilen.push(zeile);
  }
  geaendert = true;
  meldungen.push(`${name}: neu erzeugt`);
}

// --- schreiben: atomar, Modus 0600 -------------------------------------------
if (geaendert) {
  const tmp = join(wurzel, `.env.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd;
  try {
    fd = openSync(tmp, 'wx', MODUS);
    writeSync(fd, zeilen.join(eol));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, MODUS);
    renameSync(tmp, ziel);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    fehler(`.env nicht geschrieben (${e.code ?? 'Fehler'}).`);
  }
} else if ((lstatSync(ziel).mode & 0o777) !== MODUS) {
  chmodSync(ziel, MODUS);
  meldungen.push('Modus auf 0600 gesetzt');
}
process.stdout.write(`${meldungen.join('\n')}\n.env: Modus 0600, Werte nicht ausgegeben.\n`);
