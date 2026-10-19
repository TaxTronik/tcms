// =============================================================================
// Ablage der Nachweisdateien im Dateisystem (Stufe 1). Dateien werden unter
// ihrem SHA-256 abgelegt; nach dem Einreichen sperrt die Anwendung sie.
// Kein WORM-Speicher: der Schutz ist anwendungsseitig, nicht speicherseitig.
// =============================================================================

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Repo-Root = nächstes Verzeichnis mit pnpm-workspace.yaml, ausgehend vom
 * Arbeitsverzeichnis. (import.meta.dirname ist im Next-Bundle nicht gesetzt.)
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, 'pnpm-workspace.yaml'))) return dir;
    const hoeher = dirname(dir);
    if (hoeher === dir) break;
    dir = hoeher;
  }
  return process.cwd();
}

export function speicherWurzel(): string {
  const dir = process.env['TCMS_STORAGE_DIR'] ?? '.data/nachweise';
  return isAbsolute(dir) ? dir : join(/*turbopackIgnore: true*/ repoRoot(), dir);
}

export interface GespeicherteDatei {
  sha256: string;
  speicherpfad: string;
  groesse: number;
}

export async function speichereDatei(inhalt: Buffer): Promise<GespeicherteDatei> {
  const sha256 = createHash('sha256').update(inhalt).digest('hex');
  const rel = join(sha256.slice(0, 2), sha256);
  const ziel = join(/*turbopackIgnore: true*/ speicherWurzel(), rel);
  await mkdir(join(/*turbopackIgnore: true*/ speicherWurzel(), sha256.slice(0, 2)), {
    recursive: true,
  });
  try {
    await access(ziel);
  } catch {
    await writeFile(ziel, inhalt, { flag: 'wx' });
  }
  return { sha256, speicherpfad: rel, groesse: inhalt.length };
}

export async function leseDatei(speicherpfad: string): Promise<Buffer> {
  if (speicherpfad.includes('..') || isAbsolute(speicherpfad))
    throw new Error('Ungültiger Speicherpfad');
  return readFile(join(/*turbopackIgnore: true*/ speicherWurzel(), speicherpfad));
}
