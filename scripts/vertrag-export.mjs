#!/usr/bin/env node
// =============================================================================
// Vertragsexport für die kanzleikonsole (Stufe 2, Domain-Paket ab Stufe 3):
// gibt Commit und SHA-256 je Datei eines vendorten Pakets (ohne Tests und ohne
// die Ausschlüsse des Pakets) als JSON aus – genau im Format von
// packages/tcms-<paket>/VENDOR.json der kanzleikonsole (dort geschrieben von
// scripts/tcms/sync-contract.mjs und geprüft von
// scripts/check-tcms-contract-vendor.mjs).
//
//   node scripts/vertrag-export.mjs [--paket contract|domain] [--repo tcms] [--wurzel <checkout>]
//
// Pakete (Standard `contract`; dieselbe Liste wie VENDOR_PAKETE in
// scripts/tcms/vendor-lib.mjs der kanzleikonsole):
//   contract → packages/contract/src
//   domain   → packages/domain/src ohne audit.ts (node:crypto; die Hashkette
//              rechnet nur der Dienst)
//
// Verweigert bei schmutzigem Baum (geänderte, vorgemerkte oder nicht
// versionierte Dateien im ganzen Repository): Der Commit im Ergebnis soll den
// Stand exakt reproduzieren. Liest nur; Ausgabe auf stdout, Meldungen auf
// stderr. Testdateien (`__tests__/`, `*.test.*`, `*.spec.*`) gehören nicht
// zur Kopie. Dateien sind nach Pfad aufsteigend sortiert.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';

/**
 * Vendorte Pakete. `beschreibung` ist wortgleich mit VENDOR_PAKETE der
 * kanzleikonsole (scripts/tcms/vendor-lib.mjs), `ausschluesse` sind exakte
 * Pfade relativ zu `quellPfad`.
 */
export const PAKETE = Object.freeze({
  contract: Object.freeze({
    quellPfad: 'packages/contract/src',
    ausschluesse: Object.freeze([]),
    beschreibung:
      'Exakte Kopie von packages/contract/src des TCMS-Repos ohne Tests. Nicht von Hand ändern: ' +
      'Aktualisieren mit scripts/tcms/sync-contract.mjs, Prüfung mit scripts/check-tcms-contract-vendor.mjs ' +
      '(docs/development/tcms-anbindung.md).',
  }),
  domain: Object.freeze({
    quellPfad: 'packages/domain/src',
    ausschluesse: Object.freeze(['audit.ts']),
    beschreibung:
      'Exakte Kopie von packages/domain/src des TCMS-Repos ohne Tests und ohne audit.ts. Nicht von Hand ' +
      'ändern: Aktualisieren mit scripts/tcms/sync-contract.mjs --paket domain, Prüfung mit ' +
      'scripts/check-tcms-contract-vendor.mjs (docs/development/tcms-anbindung.md).',
  }),
});

/** Vertrag (Standardpaket); Namen aus Stufe 2. */
export const QUELL_PFAD = PAKETE.contract.quellPfad;
export const BESCHREIBUNG = PAKETE.contract.beschreibung;

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
  const werte = { repo: 'tcms', wurzel: process.cwd(), paket: 'contract' };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, wert] = [argv[i], argv[i + 1]];
    if (wert === undefined || wert.startsWith('--')) fehler(`${name} braucht einen Wert`);
    if (name === '--repo') werte.repo = wert;
    else if (name === '--paket') werte.paket = wert;
    else if (name === '--wurzel') werte.wurzel = resolve(wert);
    else fehler(`unbekanntes Argument ${name}`);
  }
  if (!REPO.test(werte.repo)) fehler('--repo ist ungültig');
  if (!Object.hasOwn(PAKETE, werte.paket)) {
    fehler(`--paket muss einer von ${Object.keys(PAKETE).join(', ')} sein`);
  }
  return werte;
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const args = argumente(process.argv.slice(2));
const paket = PAKETE[args.paket];
const quellPfad = paket.quellPfad;
const ausgeschlossen = new Set(paket.ausschluesse);
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

// Gehasht wird der Git-Blob des gemeldeten Commits (`git ls-tree` +
// `git cat-file blob`), nie der Arbeitsbaum: skip-worktree/assume-unchanged
// verbergen Abweichungen vor `git status` (Red Team RT2-T-02). Nur normale
// Dateien (Modus 100644); Symlinks, ausführbare Dateien und Submodule brechen
// ab – wie im Sync der kanzleikonsole (RT2-K-01). Ausgeschlossene Dateien
// werden wie Tests weder gelesen noch geprüft.
const baum = git(wurzel, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', quellPfad])
  .split('\0')
  .filter(Boolean)
  .map((zeile) => {
    const tab = zeile.indexOf('\t');
    const [modus, typ, objekt] = zeile.slice(0, tab).split(' ');
    return { modus, typ, objekt, pfad: zeile.slice(tab + 1).slice(quellPfad.length + 1) };
  })
  .filter((e) => !istTestdatei(e.pfad) && !ausgeschlossen.has(e.pfad))
  .sort((a, b) => (a.pfad < b.pfad ? -1 : a.pfad > b.pfad ? 1 : 0));
if (baum.length === 0) fehler(`${quellPfad} enthält keine Dateien`);
for (const e of baum) {
  if (!istSichererPfad(e.pfad)) fehler(`unzulässiger Dateiname unter ${quellPfad}`);
  if (e.modus !== '100644' || e.typ !== 'blob' || !/^[0-9a-f]{40}$/.test(e.objekt)) {
    fehler(`${quellPfad}/${e.pfad} ist keine normale Datei (Modus ${e.modus})`);
  }
}

const ergebnis = {
  beschreibung: paket.beschreibung,
  quelle: { repo: args.repo, pfad: quellPfad, commit },
  dateien: baum.map(({ pfad, objekt }) => ({
    pfad,
    sha256: createHash('sha256')
      .update(
        execFileSync('git', ['-C', wurzel, 'cat-file', 'blob', objekt], {
          maxBuffer: 16 * 1024 * 1024,
        }),
      )
      .digest('hex'),
  })),
};
process.stdout.write(`${JSON.stringify(ergebnis, null, 2)}\n`);
