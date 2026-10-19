// Produktions-Images ohne Docker-Daemon: statische Prüfung von Dockerfile und
// Build-Kontext (scripts/pruefe-dockerfile.mjs) und die .dockerignore-Semantik
// (scripts/docker-kontext.mjs). Jede Regel scheitert an einer passenden
// Veränderung des echten Dockerfiles bzw. Kontexts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Werkzeuge im Repo-Root (JavaScript ohne Typen), dynamisch geladen.
interface DockerKontext {
  imKontext(pfad: string, regeln: unknown[]): boolean;
  kontextDateien(): string[];
  leseRegeln(text: string): unknown[];
  musterRegex(muster: string): RegExp;
}
const werkzeug = (name: string) => new URL(`../../../../scripts/${name}`, import.meta.url).href;
const { imKontext, kontextDateien, leseRegeln, musterRegex } = (await import(
  werkzeug('docker-kontext.mjs')
)) as DockerKontext;
const { pruefeDockerfile } = (await import(werkzeug('pruefe-dockerfile.mjs'))) as {
  pruefeDockerfile: (text: string, kontext: string[]) => string[];
};

const pruefe = pruefeDockerfile;
const DOCKERFILE = readFileSync(new URL('../../../../Dockerfile', import.meta.url), 'utf8');
const KONTEXT = kontextDateien();

const ersetze = (alt: string, neu: string) => {
  expect(DOCKERFILE).toContain(alt);
  return DOCKERFILE.replace(alt, neu);
};

describe('Dockerfile und Build-Kontext', () => {
  it('erfüllen alle Regeln', () => {
    expect(pruefe(DOCKERFILE, KONTEXT)).toEqual([]);
  });

  it('der Kontext enthält keine .env, Tests, Seeds, Demo-Quellen und keine Doku', () => {
    expect(KONTEXT).toContain('apps/api/src/server.ts');
    expect(KONTEXT).toContain('packages/db/prisma/migrations/20261019000000_init/migration.sql');
    for (const p of KONTEXT) {
      expect(p).not.toMatch(/(^|\/)\.env|__tests__|\.test\.ts$|^packages\/db\/seeds\/|^docs\//);
      if (p.startsWith('apps/web/')) expect(p).toBe('apps/web/package.json');
    }
  });

  const faelle: [string, string, RegExp][] = [
    ['anderer Digest', ersetze('595398b0', '00000000'), /ARG NODE_IMAGE nicht wie gepinnt/],
    [
      'Basis ohne ARG',
      ersetze('FROM ${NODE_IMAGE} AS api', 'FROM node:24 AS api'),
      /nicht über gepinnte ARG/,
    ],
    ['syntax-Zeile', `# syntax=docker/dockerfile:1\n${DOCKERFILE}`, /# syntax=/],
    [
      'ADD',
      ersetze('WORKDIR /app\n', 'WORKDIR /app\nADD https://x.invalid/a /a\n'),
      /ADD nicht erlaubt/,
    ],
    ['root im api-Stage', ersetze('USER 10001:10001\n', ''), /api: USER 10001:10001 fehlt/],
    [
      'ohne Healthcheck',
      ersetze('CMD ["node", "/app/healthcheck.mjs"]', 'CMD ["true"]'),
      /HEALTHCHECK/,
    ],
    ['npm bleibt', ersetze('rm -rf /usr/local/lib/node_modules/npm', 'true'), /npm\/Corepack/],
    [
      'Kontext im Laufzeit-Stage',
      ersetze('COPY --from=bau --chown=0:0 /app /app', 'COPY . /app'),
      /api: COPY aus dem Kontext/,
    ],
    [
      'Werkzeug im Laufzeit-Stage',
      ersetze('WORKDIR /app\n', 'WORKDIR /app\nRUN apk add --no-cache curl\n'),
      /Werkzeug oder Download/,
    ],
    [
      'Geheimnis',
      ersetze('ENV NODE_ENV=production', 'ENV TCMS_SERVICE_TOKENS=x NODE_ENV=production'),
      /Geheimnis in ENV/,
    ],
    [
      'Code-Schlüssel (H5)',
      ersetze('ENV NODE_ENV=production', 'ENV TCMS_CODE_SCHLUESSEL=x NODE_ENV=production'),
      /Geheimnis in ENV/,
    ],
    ['migrate als root', ersetze('USER 70:70\n', ''), /migrate: USER 70:70 fehlt/],
    [
      'Quelle außerhalb des Kontexts',
      ersetze(
        'COPY packages/db/betrieb /opt/tcms/betrieb',
        'COPY packages/db/seeds /opt/tcms/betrieb',
      ),
      /COPY-Quelle packages\/db\/seeds nicht im Kontext/,
    ],
  ];
  for (const [name, text, befund] of faelle) {
    it(`erkennt: ${name}`, () => {
      expect(pruefe(text, KONTEXT).join('\n')).toMatch(befund);
    });
  }

  it('erkennt unzulässige Dateien im Kontext und fehlende Pflichtdateien', () => {
    for (const [extra, befund] of [
      ['.env', /\.env/],
      ['apps/web/src/app/page.tsx', /Demo apps\/web/],
      ['packages/db/seeds/demo.ts', /Seeds/],
      ['packages/service/src/x.test.ts', /Tests/],
      ['packages/service/src/bereiche/x/testwelt.ts', /Testhilfen/],
    ] as const) {
      expect(pruefe(DOCKERFILE, [...KONTEXT, extra]).join('\n')).toMatch(befund);
    }
    const ohne = KONTEXT.filter((p) => p !== 'packages/db/betrieb/migrate.sh');
    expect(pruefe(DOCKERFILE, ohne).join('\n')).toMatch(/migrate\.sh fehlt/);
  });
});

describe('.dockerignore-Semantik (wie Docker/BuildKit)', () => {
  const regeln = leseRegeln(
    ['*', '!apps/api/src', '**/__tests__', '!packages/db/prisma/migrations', '**/.env'].join('\n'),
  );
  const drin = (p: string) => imKontext(p, regeln);

  it('schließt aus, lässt per Ausnahme zu und schließt darin wieder aus', () => {
    expect(drin('README.md')).toBe(false);
    expect(drin('apps/web/src/x.ts')).toBe(false);
    expect(drin('apps/api/src/server.ts')).toBe(true);
    expect(drin('apps/api/src/__tests__/app.test.ts')).toBe(false);
    expect(drin('packages/db/prisma/migrations/a/migration.sql')).toBe(true);
    expect(drin('apps/api/src/.env')).toBe(false);
  });

  it('übersetzt *, ? und ** wie Docker', () => {
    const re = musterRegex;
    expect(re('*.md').test('a.md')).toBe(true);
    expect(re('*.md').test('docs/a.md')).toBe(false);
    expect(re('**/*.md').test('docs/x/a.md')).toBe(true);
    expect(re('**/*.md').test('a.md')).toBe(true);
    expect(re('a?c').test('abc')).toBe(true);
    expect(re('a?c').test('a/c')).toBe(false);
    expect(re('/apps/web/').test('apps/web')).toBe(true);
  });
});
