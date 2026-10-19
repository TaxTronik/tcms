// scripts/akteur-schluessel.mjs: Ausgabe passt zu parseSchluesselListe und
// parsePrivatenSchluessel, signierte Bestätigungen sind prüfbar, nichts wird
// auf die Platte geschrieben.

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  bodySha256,
  parsePrivatenSchluessel,
  parseSchluesselListe,
  pruefeAkteur,
  signiereAkteur,
} from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { JETZT, claims } from './hilfen';

const SKRIPT = fileURLToPath(new URL('../../../../scripts/akteur-schluessel.mjs', import.meta.url));
const ausfuehren = promisify(execFile);

async function lauf(args: string[] = []) {
  const arbeit = await mkdtemp(join(tmpdir(), 'akteur-schluessel-'));
  const heim = await mkdtemp(join(tmpdir(), 'akteur-heim-'));
  try {
    const r = await ausfuehren(process.execPath, [SKRIPT, ...args], {
      cwd: arbeit,
      env: { PATH: process.env.PATH ?? '', HOME: heim },
    }).catch((e: { code: number; stdout: string; stderr: string }) => e);
    const geschrieben = [...(await readdir(arbeit)), ...(await readdir(heim))];
    const code = 'code' in r && typeof r.code === 'number' ? r.code : 0;
    return { code, stdout: r.stdout, stderr: r.stderr, geschrieben };
  } finally {
    await rm(arbeit, { recursive: true, force: true });
    await rm(heim, { recursive: true, force: true });
  }
}

function zerlege(stdout: string) {
  const zeilen = stdout.split('\n').filter((z) => z !== '' && !z.startsWith('#'));
  const kid = zeilen[0]!.replace(/^kid: /, '');
  return { kid, oeffentlich: zeilen[1]!, privat: zeilen[2]! };
}

describe('scripts/akteur-schluessel.mjs', () => {
  it('erzeugt ein Paar, das Dienst und kanzleikonsole lesen und das prüfbar signiert', async () => {
    const r = await lauf();
    expect(r.code).toBe(0);
    expect(r.geschrieben).toEqual([]);
    const { kid, oeffentlich, privat } = zerlege(r.stdout);
    expect(kid).toMatch(/^kk-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]{8}$/);
    expect(oeffentlich.startsWith(`${kid}=`)).toBe(true);
    const liste = parseSchluesselListe(oeffentlich);
    const privateKey = parsePrivatenSchluessel(privat);
    const c = claims({ req: { m: 'GET', p: '/v1/ich', b: bodySha256(new Uint8Array()) } });
    const token = signiereAkteur(c, { kid, privateKey });
    const e = pruefeAkteur(token, {
      schluessel: liste,
      jetzt: JETZT,
      anfrage: { methode: 'GET', pfad: '/v1/ich', bodySha256: bodySha256(new Uint8Array()) },
    });
    expect(e.ok).toBe(true);
  });

  it('übernimmt einen gültigen kid und erzeugt jedes Mal neue Schlüssel', async () => {
    const [a, b] = await Promise.all([lauf(['--kid', 'kk-2027.1']), lauf(['--kid', 'kk-2027.1'])]);
    expect(zerlege(a.stdout).kid).toBe('kk-2027.1');
    expect(zerlege(a.stdout).privat).not.toBe(zerlege(b.stdout).privat);
  });

  it('weist ungültige Argumente ab, ohne Schlüssel auszugeben', async () => {
    for (const args of [['--kid', 'kk a'], ['--kid', 'x'.repeat(65)], ['--kid'], ['--unbekannt']]) {
      const r = await lauf(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
    }
  });

  it('importiert kein Dateisystem-Modul', async () => {
    const quelle = await readFile(SKRIPT, 'utf8');
    expect(quelle).not.toMatch(/node:fs|from 'fs'|require\(/);
  });
});
