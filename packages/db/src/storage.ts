// =============================================================================
// Lokale Dateiablage der Demo-Oberfläche (`@tcms/db/demo-ablage`). Der Dienst
// nimmt keine Dateien an (ADR 0001 §6) und importiert dieses Modul nie.
// Dateien liegen unter ihrem SHA-256; nach dem Einreichen sperrt die Anwendung
// sie. Kein WORM-Speicher: der Schutz ist anwendungsseitig, nicht speicherseitig.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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

const sha256Von = (inhalt: Buffer) => createHash('sha256').update(inhalt).digest('hex');

/** Liegt unter `ziel` genau der Inhalt mit diesem SHA-256? (Fehlt die Datei: nein.) */
async function liegtUnversehrt(ziel: string, sha256: string): Promise<boolean> {
  try {
    return sha256Von(await readFile(ziel)) === sha256;
  } catch {
    return false;
  }
}

/**
 * Legt den Inhalt unter seinem SHA-256 ab. Atomar: Geschrieben wird in eine
 * eigene temporäre Datei im selben Verzeichnis (fsync), die dann per `rename`
 * an den endgültigen Namen tritt – ein Abbruch hinterlässt dort nie ein
 * Fragment. Eine vorhandene Datei gilt nur, wenn ihr Inhalt den Hash ergibt;
 * ein Fragment früherer Läufe wird ersetzt. Gleichzeitiges Speichern desselben
 * Inhalts gelingt in jedem Aufruf (gleicher Inhalt, gleicher Name).
 */
export async function speichereDatei(inhalt: Buffer): Promise<GespeicherteDatei> {
  const sha256 = sha256Von(inhalt);
  const rel = `${sha256.slice(0, 2)}/${sha256}`;
  const verzeichnis = join(/*turbopackIgnore: true*/ speicherWurzel(), sha256.slice(0, 2));
  const ziel = join(/*turbopackIgnore: true*/ verzeichnis, sha256);
  const ergebnis = { sha256, speicherpfad: rel, groesse: inhalt.length };
  await mkdir(verzeichnis, { recursive: true });
  if (await liegtUnversehrt(ziel, sha256)) return ergebnis;

  const temp = join(
    /*turbopackIgnore: true*/ verzeichnis,
    `.${sha256}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    const datei = await open(temp, 'wx', 0o600);
    try {
      await datei.writeFile(inhalt);
      await datei.sync();
    } finally {
      await datei.close();
    }
    try {
      await rename(temp, ziel);
    } catch (e) {
      // Windows: Ein gleichzeitiges Ersetzen derselben Datei kann scheitern
      // (EPERM/EACCES). Liegt der richtige Inhalt inzwischen dort, ist das Ziel erreicht.
      if (!(await liegtUnversehrt(ziel, sha256))) throw e;
    }
  } finally {
    await rm(temp, { force: true });
  }
  return ergebnis;
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
