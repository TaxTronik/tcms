// =============================================================================
// scripts/ci-apt.sh: apt-get in CI nur gegen Ubuntu-Archiv und PGDG, `update`
// mit drei Versuchen (Lauf 3895 der kanzleikonsole: git-core-PPA des
// Runner-Images mit 503). apt-get ist eine Attrappe, die Argumente und die
// übergebenen Quellen protokolliert. Gegenstück zu scripts/tests/ci-apt.test.sh
// der kanzleikonsole.
// =============================================================================

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_WURZEL } from './repo-git';

const SKRIPT = join(REPO_WURZEL, 'scripts/ci-apt.sh');
const tmp = mkdtempSync(join(tmpdir(), 'ci-apt-'));
const ETC = join(tmp, 'etc');
const APT = join(tmp, 'apt-get');
const PROTOKOLL = join(tmp, 'protokoll');
const AUFRUFE = join(tmp, 'aufrufe');

beforeAll(() => {
  mkdirSync(join(ETC, 'sources.list.d'), { recursive: true });
  writeFileSync(
    join(ETC, 'sources.list'),
    [
      '# Kommentar',
      'deb http://archive.ubuntu.com/ubuntu/ jammy main restricted',
      'deb-src http://archive.ubuntu.com/ubuntu/ jammy main',
      'deb http://security.ubuntu.com/ubuntu/ jammy-security main',
      'deb http://archive.ubuntu.com.evil.example/ubuntu/ jammy main',
      'deb http://evilarchive.ubuntu.com/ubuntu/ jammy main',
      'deb ftp://archive.ubuntu.com/ubuntu/ jammy universe',
      '',
    ].join('\n'),
  );
  const teil = (name: string, inhalt: string) =>
    writeFileSync(join(ETC, 'sources.list.d', name), inhalt);
  teil(
    'git-core-ubuntu-ppa-jammy.list',
    'deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/ jammy main\n',
  );
  teil(
    'microsoft-prod.list',
    'deb [arch=amd64,armhf,arm64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/22.04/prod jammy main\n',
  );
  teil(
    'tcms-pgdg.list',
    'deb [signed-by=/usr/share/keyrings/tcms-pgdg.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main\n',
  );
  teil(
    'ubuntu.sources',
    'Types: deb\nURIs: http://de.archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n\n' +
      'Types: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main\n',
  );
  teil(
    'gemischt.sources',
    'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/ https://packagecloud.io/github/git-lfs/ubuntu/\nSuites: jammy\nComponents: main\n',
  );
  // Attrappe: protokolliert Aufruf und Inhalt der übergebenen Quellen; scheitert,
  // solange FEHLER_BIS größer als die Zahl der Aufrufe ist.
  writeFileSync(
    APT,
    `#!/usr/bin/env bash
n=$(cat '${AUFRUFE}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >'${AUFRUFE}'
{
  printf 'AUFRUF %s\\n' "$*"
  for a in "$@"; do
    case $a in
      Dir::Etc::sourcelist=*) cat "\${a#*=}" ;;
      Dir::Etc::sourceparts=*) for d in "\${a#*=}"/*; do [ -f "$d" ] && { echo "TEIL $(basename "$d")"; cat "$d"; }; done ;;
    esac
  done
} >>'${PROTOKOLL}'
[ "$n" -gt "\${FEHLER_BIS:-0}" ]
`,
  );
  chmodSync(APT, 0o755);
  mkdirSync(join(tmp, 'tmp'));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function lauf(args: string[], env: Record<string, string> = {}, etc = ETC) {
  rmSync(PROTOKOLL, { force: true });
  rmSync(AUFRUFE, { force: true });
  const r = spawnSync('bash', [SKRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      CI_APT_ETC: etc,
      CI_APT_GET: APT,
      CI_APT_PAUSE: '0',
      TMPDIR: join(tmp, 'tmp'),
      ...env,
    },
  });
  return {
    code: r.status,
    ausgabe: `${r.stdout}${r.stderr}`,
    protokoll: existsSync(PROTOKOLL) ? readFileSync(PROTOKOLL, 'utf8') : '',
    aufrufe: existsSync(AUFRUFE) ? Number(readFileSync(AUFRUFE, 'utf8')) : 0,
  };
}

describe('scripts/ci-apt.sh', () => {
  it('lässt nur Ubuntu-Archiv und PGDG zu und meldet jede übergangene Quelle', () => {
    const r = lauf(['update']);
    expect(r.code, r.ausgabe).toBe(0);
    for (const erlaubt of [
      'deb http://archive.ubuntu.com/ubuntu/ jammy main restricted',
      'deb-src http://archive.ubuntu.com/ubuntu/ jammy main',
      'deb http://security.ubuntu.com/ubuntu/ jammy-security main',
      'https://apt.postgresql.org/pub/repos/apt jammy-pgdg main',
      'URIs: http://de.archive.ubuntu.com/ubuntu/',
      'TEIL ubuntu.sources',
    ]) {
      expect(r.protokoll).toContain(erlaubt);
    }
    for (const fremd of [
      'launchpadcontent',
      'microsoft',
      'evil.example',
      'evilarchive',
      'packagecloud',
      'ftp://',
      'TEIL gemischt.sources',
      '# Kommentar',
    ]) {
      expect(r.protokoll).not.toContain(fremd);
    }
    for (const host of [
      'ppa.launchpadcontent.net',
      'packages.microsoft.com',
      'archive.ubuntu.com.evil.example',
      'evilarchive.ubuntu.com',
      'packagecloud.io',
    ]) {
      expect(r.ausgabe).toContain(`Quelle uebergangen: ${host}`);
    }
    expect(r.protokoll).toMatch(/^AUFRUF .*APT::Get::List-Cleanup=0 update$/m);
  });

  it('versucht update dreimal und scheitert danach laut', () => {
    const erholt = lauf(['update'], { FEHLER_BIS: '2' });
    expect(erholt.code, erholt.ausgabe).toBe(0);
    expect(erholt.aufrufe).toBe(3);
    const gescheitert = lauf(['update'], { FEHLER_BIS: '3' });
    expect(gescheitert.code).not.toBe(0);
    expect(gescheitert.aufrufe).toBe(3);
    expect(gescheitert.ausgabe).toContain('dreimal fehlgeschlagen');
  });

  it('reicht install-Argumente unverändert und gegen dieselben Quellen weiter', () => {
    const r = lauf(['install', '-y', '--no-install-recommends', 'postgresql-client-18']);
    expect(r.code, r.ausgabe).toBe(0);
    expect(r.protokoll).toMatch(
      /^AUFRUF .* install -y --no-install-recommends postgresql-client-18$/m,
    );
    expect(r.aufrufe).toBe(1);
    expect(r.protokoll).not.toMatch(/launchpadcontent|microsoft/);
    expect(lauf(['install', '-y', 'paket'], { FEHLER_BIS: '1' }).code).not.toBe(0);
  });

  it('bricht ohne erlaubte Quelle oder ohne Befehl vor apt-get ab', () => {
    const leer = join(tmp, 'leer');
    mkdirSync(join(leer, 'sources.list.d'), { recursive: true });
    writeFileSync(
      join(leer, 'sources.list'),
      'deb https://ppa.launchpadcontent.net/x/ppa/ubuntu/ jammy main\n',
    );
    const ohne = lauf(['update'], {}, leer);
    expect(ohne.code).not.toBe(0);
    expect(ohne.ausgabe).toContain('keine erlaubte Paketquelle');
    expect(ohne.aufrufe).toBe(0);
    const befehl = lauf([]);
    expect(befehl.code).toBe(64);
    expect(befehl.aufrufe).toBe(0);
  });

  it('entfernt die gefilterte Kopie der Quellen danach, auch nach einem Fehler', () => {
    const r = lauf(['update']);
    expect(r.protokoll).toContain(`Dir::Etc::sourceparts=${join(tmp, 'tmp')}/`);
    expect(readdirSync(join(tmp, 'tmp'))).toEqual([]);
    lauf(['update'], { FEHLER_BIS: '3' });
    expect(readdirSync(join(tmp, 'tmp'))).toEqual([]);
  });
});
