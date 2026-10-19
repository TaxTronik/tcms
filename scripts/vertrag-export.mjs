#!/usr/bin/env node
// =============================================================================
// Vertragsexport für die kanzleikonsole (Stufe 2): gibt Commit und SHA-256 je
// Datei von packages/contract/src (ohne Tests) als JSON aus – genau im Format
// von packages/tcms-contract/VENDOR.json der kanzleikonsole (dort geschrieben
// von scripts/tcms/sync-contract.mjs und geprüft von
// scripts/check-tcms-contract-vendor.mjs).
//
//   node scripts/vertrag-export.mjs [--repo tcms] [--wurzel <checkout>]
//
// Verweigert bei schmutzigem Baum (geänderte, vorgemerkte oder nicht
// versionierte Dateien im ganzen Repository): Der Commit im Ergebnis soll den
// Stand exakt reproduzieren. Liest nur; Ausgabe auf stdout, Meldungen auf
// stderr. Testdateien (`__tests__/`, `*.test.*`, `*.spec.*`) gehören nicht
// zum Vertrag. Dateien sind nach Pfad aufsteigend sortiert.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

export const QUELL_PFAD = 'packages/contract/src';
/** Wortgleich mit VENDOR_BESCHREIBUNG der kanzleikonsole (scripts/tcms/vendor-lib.mjs). */
export const BESCHREIBUNG =
  'Exakte Kopie von packages/contract/src des TCMS-Repos ohne Tests. Nicht von Hand ändern: ' +
  'Aktualisieren mit scripts/tcms/sync-contract.mjs, Prüfung mit scripts/check-tcms-contract-vendor.mjs ' +
  '(docs/development/tcms-anbindung.md).';

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const istTestdatei = (pfad) =>
  pfad.split('/').includes('__tests__') ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix.basename(pfad));

const istSichererPfad = (pfad) =>
  pfad.length > 0 &&
  pfad.length <= 300 &&
  pfad.split('/').every((s) => s !== '.' && s !== '..' && SEGMENT.test(s));

function fehler(meldung) {
  process.stderr.write(`vertrag-export: ${meldung}\n`);
  process.exit(1);
}

function argumente(argv) {
  const werte = { repo: 'tcms', wurzel: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, wert] = [argv[i], argv[i + 1]];
    if (wert === undefined || wert.startsWith('--')) fehler(`${name} braucht einen Wert`);
    if (name === '--repo') werte.repo = wert;
    else if (name === '--wurzel') werte.wurzel = resolve(wert);
    else fehler(`unbekanntes Argument ${name}`);
  }
  if (!REPO.test(werte.repo)) fehler('--repo ist ungültig');
  return werte;
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const args = argumente(process.argv.slice(2));
let wurzel;
try {
  wurzel = git(args.wurzel, ['rev-parse', '--show-toplevel']).trim();
} catch {
  fehler('kein Git-Checkout');
}
if (git(wurzel, ['status', '--porcelain=v1', '--untracked-files=all']).trim() !== '') {
  fehler('Baum hat ungesicherte Änderungen oder nicht versionierte Dateien – erst committen');
}
const commit = git(wurzel, ['rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) fehler('HEAD ist kein vollständiger SHA-1');

const dateien = git(wurzel, ['ls-files', '-z', '--', QUELL_PFAD])
  .split('\0')
  .filter(Boolean)
  .map((p) => p.slice(QUELL_PFAD.length + 1))
  .filter((p) => !istTestdatei(p))
  .sort();
if (dateien.length === 0) fehler(`${QUELL_PFAD} enthält keine Dateien`);
for (const p of dateien)
  if (!istSichererPfad(p)) fehler(`unzulässiger Dateiname unter ${QUELL_PFAD}`);

const ergebnis = {
  beschreibung: BESCHREIBUNG,
  quelle: { repo: args.repo, pfad: QUELL_PFAD, commit },
  dateien: dateien.map((pfad) => ({
    pfad,
    sha256: createHash('sha256')
      .update(readFileSync(join(wurzel, QUELL_PFAD, pfad)))
      .digest('hex'),
  })),
};
process.stdout.write(`${JSON.stringify(ergebnis, null, 2)}\n`);
