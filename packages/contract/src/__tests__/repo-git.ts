// =============================================================================
// Testhilfe der repo-weiten statischen Prüfungen (Zeichen, Dateimodi): liest
// den Git-Index eines Checkouts – Modus, Objekt und Inhalt jeder versionierten
// Datei. Geprüft wird der Blob im Index, nicht nur der Arbeitsbaum:
// skip-worktree/assume-unchanged verbergen Abweichungen vor `git status`
// (Red Team RT2-T-02). Ohne Git scheitert der Aufruf (fail closed, kein
// Überspringen).
// =============================================================================

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Wurzel dieses Repositorys. */
export const REPO_WURZEL = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export interface IndexEintrag {
  /** Git-Modus, z. B. `100644`, `100755`, `120000` (Symlink), `160000` (Submodul). */
  modus: string;
  objekt: string;
  /** Pfad relativ zur Wurzel, mit `/`. */
  pfad: string;
}

function git(wurzel: string, args: string[], eingabe?: Buffer): Buffer {
  return execFileSync('git', ['-C', wurzel, '-c', 'core.hooksPath=/dev/null', ...args], {
    input: eingabe,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Alle Einträge des Index (`git ls-files -s -z`); Konfliktstufen ≠ 0 sind ein Fehler. */
export function indexEintraege(wurzel: string = REPO_WURZEL): IndexEintrag[] {
  const roh = git(wurzel, ['ls-files', '-s', '-z']).toString('utf8');
  const eintraege = roh
    .split('\0')
    .filter(Boolean)
    .map((zeile) => {
      const tab = zeile.indexOf('\t');
      const [modus, objekt, stufe] = zeile.slice(0, tab).split(' ');
      if (!modus || !objekt || stufe !== '0') {
        throw new Error(`Index nicht auswertbar oder mit Konflikt: ${zeile.slice(tab + 1)}`);
      }
      return { modus, objekt, pfad: zeile.slice(tab + 1) };
    });
  if (eintraege.length === 0) throw new Error('Index leer – kein Git-Checkout?');
  return eintraege;
}

/** Inhalte der Blobs (`git cat-file --batch`), je Objekt-ID. */
export function blobInhalte(objekte: readonly string[], wurzel: string = REPO_WURZEL) {
  const eindeutig = [...new Set(objekte)];
  const aus = git(wurzel, ['cat-file', '--batch'], Buffer.from(eindeutig.join('\n') + '\n'));
  const inhalte = new Map<string, Buffer>();
  let pos = 0;
  for (const objekt of eindeutig) {
    const ende = aus.indexOf(0x0a, pos);
    const [id, typ, groesse] = aus.subarray(pos, ende).toString('utf8').split(' ');
    if (id !== objekt || typ !== 'blob' || !groesse || !/^[0-9]+$/.test(groesse)) {
      throw new Error(`Objekt ${objekt} ist kein lesbarer Blob`);
    }
    const start = ende + 1;
    inhalte.set(objekt, aus.subarray(start, start + Number(groesse)));
    pos = start + Number(groesse) + 1;
  }
  return inhalte;
}
