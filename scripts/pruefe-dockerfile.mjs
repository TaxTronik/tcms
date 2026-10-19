#!/usr/bin/env node
// =============================================================================
// Statische Prüfung von Dockerfile und Build-Kontext (ADR 0001 §8, RT-04,
// Betriebsschnittstelle Stufe 2); ohne Docker-Daemon, in CI vor dem Build.
//
//   node scripts/pruefe-dockerfile.mjs
//
// Regeln: Basisimages nur über ARG mit Digest (dieselben wie die
// kanzleikonsole), keine `# syntax=`-Zeile, kein ADD, kein `latest`; Ziele
// `api` und `migrate`; api als 10001:10001 mit Healthcheck-Kommando,
// Exec-Form, Port 3200, ohne Paketmanager; migrate als 70:70 mit dem Läufer
// als ENTRYPOINT; keine Geheimnisse in ENV/ARG/LABEL. Der Kontext nach
// .dockerignore enthält jede COPY-Quelle, aber keine .env, keine Tests, keine
// Seeds, keine Demo-Quellen (apps/web) und keine Doku.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kontextDateien, WURZEL } from './docker-kontext.mjs';

export const BASIS = {
  NODE_IMAGE:
    'node:24-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436',
  POSTGRES_IMAGE:
    'postgres:18-alpine@sha256:96d56f7f57c6aacd1fcb908bc83b345ec5f83231ee486dd66a1baadce274db88',
};

/** Pflichtdateien im Kontext (der Build braucht sie). */
const PFLICHT = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps/api/package.json',
  'apps/api/src/server.ts',
  'apps/api/healthcheck.mjs',
  'apps/api/scripts/build.mjs',
  'apps/api/scripts/laufzeit.mjs',
  'packages/db/prisma/schema.prisma',
  'packages/db/prisma/init/rollen.psql',
  'packages/db/betrieb/migrate.sh',
];
/** Was nie im Kontext liegen darf. */
const VERBOTEN = [
  [/(^|\/)\.env($|\.)/, '.env'],
  [/(^|\/)__tests__\//, 'Tests'],
  [/\.test\.[cm]?[jt]sx?$/, 'Tests'],
  [
    /(^|\/)(testwelt|testfall|testhilfen|testprogramm)\.ts$|\.(testhilfe|testapp)\.ts$/,
    'Testhilfen',
  ],
  [/^packages\/db\/seeds\//, 'Seeds'],
  [/^apps\/web\/(?!package\.json$)/, 'Demo apps/web'],
  [/^docs\//, 'Doku'],
  [/^\.git\//, 'Git'],
  [/^\.forgejo\//, 'CI'],
];

/** Anweisungen mit Fortsetzungszeilen zusammengefasst, ohne Kommentare. */
function anweisungen(text) {
  const liste = [];
  let aktuell = '';
  let zeile0 = 0;
  text.split('\n').forEach((z, i) => {
    if (aktuell === '' && /^\s*#/.test(z)) return;
    if (aktuell === '') zeile0 = i + 1;
    if (z.endsWith('\\')) aktuell += `${z.slice(0, -1)} `;
    else {
      aktuell += z;
      if (aktuell.trim() !== '') liste.push({ zeile: zeile0, text: aktuell.trim() });
      aktuell = '';
    }
  });
  return liste;
}

export function pruefeDockerfile(text, kontext) {
  const befunde = [];
  const a = anweisungen(text);
  if (/^#\s*syntax\s*=/im.test(text))
    befunde.push('keine # syntax=-Zeile (ungepinnter Frontend-Code)');
  for (const [name, wert] of Object.entries(BASIS)) {
    if (!a.some((x) => x.text === `ARG ${name}=${wert}`))
      befunde.push(`ARG ${name} nicht wie gepinnt`);
  }
  const stages = new Map();
  let stage = null;
  for (const x of a) {
    const [befehl] = x.text.split(/\s+/, 1);
    const B = befehl.toUpperCase();
    if (B === 'FROM') {
      const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(x.text);
      if (!m) {
        befunde.push(`Zeile ${x.zeile}: FROM nicht lesbar`);
        continue;
      }
      const basis = m[1];
      if (!/^\$\{(NODE_IMAGE|POSTGRES_IMAGE)\}$/.test(basis) && !stages.has(basis)) {
        befunde.push(`Zeile ${x.zeile}: Basis ${basis} nicht über gepinnte ARG`);
      }
      stage = { name: m[2] ?? `stage${stages.size}`, basis, anweisungen: [] };
      stages.set(stage.name, stage);
      continue;
    }
    if (B === 'ADD') befunde.push(`Zeile ${x.zeile}: ADD nicht erlaubt (COPY verwenden)`);
    if (/:latest\b/.test(x.text)) befunde.push(`Zeile ${x.zeile}: latest`);
    if (
      /^(ENV|ARG|LABEL)\s/i.test(x.text) &&
      /(PASSWORD|PASSWORT|TOKEN|SECRET|PRIVATE|SCHLUESSEL)/i.test(x.text)
    ) {
      befunde.push(`Zeile ${x.zeile}: Geheimnis in ${B}`);
    }
    stage?.anweisungen.push(x);
  }
  const ziel = (name) => stages.get(name)?.anweisungen.map((x) => x.text) ?? null;

  const api = ziel('api');
  if (!api) befunde.push('Ziel api fehlt');
  else {
    if (!api.includes('USER 10001:10001')) befunde.push('api: USER 10001:10001 fehlt');
    if (!api.some((t) => /^CMD \["node",/.test(t)))
      befunde.push('api: CMD nicht in Exec-Form mit node');
    if (!api.some((t) => /^HEALTHCHECK .*CMD \["node", "\/app\/healthcheck\.mjs"\]$/.test(t))) {
      befunde.push('api: HEALTHCHECK mit node /app/healthcheck.mjs fehlt');
    }
    if (!api.includes('EXPOSE 3200')) befunde.push('api: EXPOSE 3200 fehlt');
    if (!api.some((t) => /rm -rf \/usr\/local\/lib\/node_modules\/npm/.test(t))) {
      befunde.push('api: npm/Corepack werden nicht entfernt');
    }
    if (!api.some((t) => /^COPY --from=bau /.test(t))) befunde.push('api: COPY --from=bau fehlt');
    if (api.some((t) => /^COPY (?!--from=)/.test(t))) befunde.push('api: COPY aus dem Kontext');
    if (
      api.some(
        (t) =>
          /(apk add|curl|wget|pnpm|tsx|esbuild|prisma generate)/.test(t) &&
          !/^RUN set -eu;/.test(t),
      )
    ) {
      befunde.push('api: Werkzeug oder Download im Laufzeit-Stage');
    }
    const user = api.indexOf('USER 10001:10001');
    const cmd = api.findIndex((t) => t.startsWith('CMD '));
    if (user > -1 && cmd > -1 && cmd < user) befunde.push('api: CMD vor USER');
  }
  const migrate = ziel('migrate');
  if (!migrate) befunde.push('Ziel migrate fehlt');
  else {
    if (!migrate.includes('USER 70:70')) befunde.push('migrate: USER 70:70 fehlt');
    if (!migrate.includes('ENTRYPOINT ["/opt/tcms/betrieb/migrate.sh"]')) {
      befunde.push('migrate: ENTRYPOINT migrate.sh fehlt');
    }
    if (stages.get('migrate')?.basis !== '${POSTGRES_IMAGE}')
      befunde.push('migrate: Basis nicht PostgreSQL');
    if (migrate.some((t) => /node|prisma|pnpm/.test(t) && !/command -v node/.test(t))) {
      befunde.push('migrate: Node oder Prisma im Stage');
    }
  }

  // Kontext
  const menge = new Set(kontext);
  const imKontext = (p) =>
    menge.has(p) || kontext.some((d) => d.startsWith(`${p.replace(/\/$/, '')}/`));
  for (const p of PFLICHT) if (!menge.has(p)) befunde.push(`Kontext: ${p} fehlt`);
  for (const p of kontext) {
    for (const [muster, was] of VERBOTEN)
      if (muster.test(p)) befunde.push(`Kontext enthält ${was}: ${p}`);
  }
  for (const x of a) {
    const m = /^COPY\s+(?!--from=)((?:--\S+\s+)*)(.+)$/i.exec(x.text);
    if (!m) continue;
    const teile = m[2].split(/\s+/);
    for (const quelle of teile.slice(0, -1)) {
      if (quelle === '.') continue;
      if (!imKontext(quelle))
        befunde.push(`Zeile ${x.zeile}: COPY-Quelle ${quelle} nicht im Kontext`);
    }
  }
  return befunde;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const befunde = pruefeDockerfile(
    readFileSync(join(WURZEL, 'Dockerfile'), 'utf8'),
    kontextDateien(),
  );
  if (befunde.length > 0) {
    process.stderr.write(
      `pruefe-dockerfile: ${befunde.length} Befunde\n- ${befunde.join('\n- ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('pruefe-dockerfile: Dockerfile und Build-Kontext in Ordnung\n');
}
