// =============================================================================
// Lokale Dateiablage der Demo-Oberfläche (`@tcms/db/demo-ablage`). Der Dienst
// nimmt keine Dateien an (ADR 0001 §6) und importiert dieses Modul nie.
// Dateien liegen unter ihrem SHA-256; nach dem Einreichen sperrt die Anwendung
// sie. Kein WORM-Speicher: der Schutz ist anwendungsseitig, nicht speicherseitig.
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
  /** Relativer Ablagepfad `<2 Hex>/<SHA-256>`; wird als `dokumentId` gespeichert. */
  speicherpfad: string;
  groesse: number;
}

/** Einzig gültige Form eines Ablagepfads (kein `..`, kein absoluter Pfad, kein Fremdname). */
const ABLAGEPFAD = /^([0-9a-f]{2})\/([0-9a-f]{64})$/;

export async function speichereDatei(inhalt: Buffer): Promise<GespeicherteDatei> {
  const sha256 = createHash('sha256').update(inhalt).digest('hex');
  const rel = `${sha256.slice(0, 2)}/${sha256}`;
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

/**
 * Liest eine abgelegte Datei und prüft ihre Integrität: Der Inhalt muss den
 * SHA-256 ergeben, unter dem er liegt (TS-09), und – falls angegeben – den
 * erwarteten Hash des Nachweises.
 */
export async function leseDatei(speicherpfad: string, erwartetSha256?: string): Promise<Buffer> {
  const m = ABLAGEPFAD.exec(speicherpfad);
  if (!m || m[1] !== m[2]!.slice(0, 2)) throw new Error('Ungültiger Speicherpfad');
  const inhalt = await readFile(join(/*turbopackIgnore: true*/ speicherWurzel(), speicherpfad));
  const ist = createHash('sha256').update(inhalt).digest('hex');
  if (ist !== m[2] || (erwartetSha256 !== undefined && ist !== erwartetSha256)) {
    throw new Error('Integritätsprüfung fehlgeschlagen');
  }
  return inhalt;
}
