// Demo-Ablage (`@tcms/db/demo-ablage`, Befunde 50 und 73): atomares Schreiben,
// Fragmente früherer Läufe werden ersetzt, gleichzeitiges Speichern desselben
// Inhalts gelingt. Ohne Datenbank, in einem eigenen temporären Verzeichnis.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leseDatei, speichereDatei } from '../storage';

let wurzel = '';
let vorher: string | undefined;

beforeEach(() => {
  vorher = process.env['TCMS_STORAGE_DIR'];
  wurzel = mkdtempSync(join(tmpdir(), 'tcms-ablage-'));
  process.env['TCMS_STORAGE_DIR'] = wurzel;
});

afterEach(() => {
  if (vorher === undefined) delete process.env['TCMS_STORAGE_DIR'];
  else process.env['TCMS_STORAGE_DIR'] = vorher;
  rmSync(wurzel, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Alle Dateien der Ablage (relativ), auch temporäre. */
const dateien = () =>
  readdirSync(wurzel, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(wurzel, d.name)).map((n) => `${d.name}/${n}`))
    .sort();

describe('Demo-Ablage', () => {
  it('legt unter dem SHA-256 ab und liest geprüft zurück, ohne temporäre Dateien', async () => {
    const inhalt = randomBytes(4096);
    const d = await speichereDatei(inhalt);
    expect(d).toEqual({
      sha256: sha(inhalt),
      speicherpfad: `${sha(inhalt).slice(0, 2)}/${sha(inhalt)}`,
      groesse: inhalt.length,
    });
    expect(dateien()).toEqual([d.speicherpfad]);
    expect((await leseDatei(d.speicherpfad, d.sha256)).equals(inhalt)).toBe(true);
  });

  it('ersetzt ein Fragment eines abgebrochenen Schreibvorgangs am Zielpfad', async () => {
    const inhalt = randomBytes(8192);
    const h = sha(inhalt);
    mkdirSync(join(wurzel, h.slice(0, 2)), { recursive: true });
    // Abbruch nach der Hälfte (bzw. leere Datei nach `wx`): früher dauerhaft unlesbar.
    for (const fragment of [inhalt.subarray(0, 4096), Buffer.alloc(0)]) {
      writeFileSync(join(wurzel, h.slice(0, 2), h), fragment);
      await expect(leseDatei(`${h.slice(0, 2)}/${h}`)).rejects.toThrow(
        'Integritätsprüfung fehlgeschlagen',
      );
      const d = await speichereDatei(inhalt);
      expect((await leseDatei(d.speicherpfad, h)).equals(inhalt)).toBe(true);
      expect(dateien()).toEqual([d.speicherpfad]);
    }
  });

  it('gleichzeitiges Speichern desselben Inhalts gelingt in jedem Aufruf', async () => {
    for (let runde = 0; runde < 5; runde++) {
      const inhalt = randomBytes(64 * 1024);
      const ergebnisse = await Promise.allSettled(
        Array.from({ length: 8 }, () => speichereDatei(inhalt)),
      );
      expect(ergebnisse.map((e) => e.status)).toEqual(Array(8).fill('fulfilled'));
      const pfad = `${sha(inhalt).slice(0, 2)}/${sha(inhalt)}`;
      expect((await leseDatei(pfad, sha(inhalt))).equals(inhalt)).toBe(true);
      expect(dateien().filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
  });

  it('eine unversehrte vorhandene Datei bleibt unverändert (kein erneutes Schreiben)', async () => {
    const inhalt = randomBytes(1024);
    const d = await speichereDatei(inhalt);
    const zweite = await speichereDatei(Buffer.from(inhalt));
    expect(zweite).toEqual(d);
    expect(dateien()).toEqual([d.speicherpfad]);
  });

  it('weist fremde Speicherpfade beim Lesen ab', async () => {
    const h = sha(Buffer.from('x'));
    for (const p of [`../${h}`, `${h.slice(0, 2)}/.${h}.0011223344556677.tmp`, `ab/${h}`]) {
      await expect(leseDatei(p)).rejects.toThrow('Ungültiger Speicherpfad');
    }
  });
});
