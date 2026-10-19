#!/usr/bin/env node
// =============================================================================
// Build-Kontext der Images ohne Docker bestimmen (kein Daemon in Entwicklung
// und Prüfung, ADR 0001 §8): wendet `.dockerignore` mit der Semantik von
// Docker/BuildKit an (Muster relativ zur Wurzel, `*`, `?`, `**`, `!`-Ausnahmen,
// die letzte passende Regel gewinnt, ein Muster für ein Verzeichnis gilt für
// alles darunter) auf die Dateien des Arbeitsbaums (`git ls-files`, ohne
// .gitignore-Ausgeschlossenes).
//
//   node scripts/docker-kontext.mjs --liste            # Dateien des Kontexts
//   node scripts/docker-kontext.mjs --kopiere <ziel>   # Kontext nach <ziel> kopieren
//
// Genutzt von scripts/simuliere-image.sh und scripts/pruefe-dockerfile.mjs.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WURZEL = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Ein Muster aus .dockerignore als regulärer Ausdruck über POSIX-Pfade. */
export function musterRegex(muster) {
  let m = muster.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < m.length; i++) {
    const z = m[i];
    if (z === '*' && m[i + 1] === '*') {
      if (m[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (z === '*') re += '[^/]*';
    else if (z === '?') re += '[^/]';
    else re += z.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  m = re;
  return new RegExp(`^${m}$`);
}

/** Regeln aus dem Text einer .dockerignore. */
export function leseRegeln(text) {
  return text
    .split('\n')
    .map((z) => z.trim())
    .filter((z) => z !== '' && !z.startsWith('#'))
    .map((z) => {
      const ausnahme = z.startsWith('!');
      return { ausnahme, regex: musterRegex(ausnahme ? z.slice(1).trim() : z) };
    });
}

/** Gehört `pfad` (POSIX, relativ) zum Kontext? Ein Pfad passt, wenn er oder ein Elternteil passt. */
export function imKontext(pfad, regeln) {
  const teile = pfad.split('/');
  const kandidaten = teile.map((_, i) => teile.slice(0, i + 1).join('/'));
  let ausgeschlossen = false;
  for (const r of regeln) {
    if (kandidaten.some((k) => r.regex.test(k))) ausgeschlossen = !r.ausnahme;
  }
  return !ausgeschlossen;
}

export function kontextDateien(wurzel = WURZEL) {
  const regeln = leseRegeln(readFileSync(join(wurzel, '.dockerignore'), 'utf8'));
  const dateien = execFileSync(
    'git',
    ['-C', wurzel, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((p) => existsSync(join(wurzel, p)));
  return dateien.filter((p) => imKontext(p, regeln)).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [befehl, ziel] = process.argv.slice(2);
  const dateien = kontextDateien();
  if (befehl === '--liste') {
    process.stdout.write(`${dateien.join('\n')}\n`);
  } else if (befehl === '--kopiere' && ziel) {
    for (const p of dateien) {
      mkdirSync(dirname(join(ziel, p)), { recursive: true });
      cpSync(join(WURZEL, p), join(ziel, p));
    }
    process.stdout.write(`docker-kontext: ${dateien.length} Dateien nach ${ziel}\n`);
  } else {
    process.stderr.write('Aufruf: docker-kontext.mjs --liste | --kopiere <ziel>\n');
    process.exit(64);
  }
}
