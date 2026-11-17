#!/usr/bin/env node
// =============================================================================
// Statische Prüfung von Dockerfile und Build-Kontext (ADR 0001 §8, RT-04,
// Betriebsschnittstelle Stufe 2); ohne Docker-Daemon, in CI vor dem Build.
//
//   node scripts/pruefe-dockerfile.mjs
//
// Regeln: Basisimages nur über ARG mit Digest (dieselben wie die
// kanzleikonsole; je Basis genau eine globale Deklaration vor dem ersten FROM),
// keine Parser-Direktive (`# syntax=`, `# escape=`, `# check=`), kein ADD,
// kein Heredoc, kein `latest`; `--from=` (COPY, RUN --mount) nur aus einem
// zuvor definierten Stage, nie aus einem Image; Ziele `api` und `migrate`;
// api als 10001:10001 (genau ein USER) mit Healthcheck-Kommando, Exec-Form
// (genau ein CMD, kein ENTRYPOINT), Port 3200, ohne Paketmanager, Werkzeuge
// oder Downloads; migrate als 70:70 mit dem Läufer als einzigem ENTRYPOINT,
// ohne Node, Prisma, Werkzeuge oder Downloads (auch im Stage
// migrate-dateien); keine RUN-Optionen in ausgelieferten Stages; keine
// Geheimnisse in ENV/ARG/LABEL. Der Kontext nach .dockerignore enthält jede
// COPY-Quelle, aber keine .env, keine Tests, keine Seeds, keine Demo-Quellen
// (apps/web) und keine Doku. Die Werkzeugregeln sind eine Heuristik über den
// Anweisungstext; sie ersetzen das Review nicht.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kontextDateien, WURZEL } from './docker-kontext.mjs';

export const BASIS = {
  NODE_IMAGE:
    'node:24-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2',
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

/** Anweisungen, die BuildKit kennt; alles andere (etwa Heredoc-Zeilen) ist ein Befund. */
const BEKANNT = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
]);
/** Stages, deren Dateien ausgeliefert werden. */
const AUSGELIEFERT = ['api', 'migrate', 'migrate-dateien'];
/** Download- und Paketwerkzeuge, auch mit Pfad aufgerufen (/usr/bin/curl). */
const DOWNLOAD = /(^|[\s;&|(`/])(apk|apt-get|apt|curl|wget|git|pip3?|nc)(\s|$)/;
/** Build-Werkzeuge als Befehl; Pfade wie /usr/local/bin/npm (beim Entfernen) zählen nicht. */
const WERKZEUG =
  /(^|[\s;&|(`])(pnpm|npm|npx|yarn|corepack|tsx|esbuild)(\s|$)|prisma\s+(generate|migrate|db)\b/;
/**
 * Die einzigen Stellen, die Werkzeuge nennen dürfen, jeweils wörtlich: die
 * Prüfschleife der Laufzeit-Invarianten (api) und die Prüfung auf fehlendes
 * Node (migrate). Jede andere Nennung, auch in derselben Anweisung, bleibt ein
 * Befund (früher galt jede Anweisung mit dem Präfix `RUN set -eu;` als frei).
 */
const PRUEFSCHLEIFE_API =
  'for p in tsx esbuild prisma typescript vitest @tcms .bin; do test ! -e "node_modules/$p"; done;';
const OHNE_NODE_MIGRATE = 'test -z "$(command -v node || true)"';

/** Anweisungen mit Fortsetzungszeilen zusammengefasst, ohne Kommentare. */
function anweisungen(text) {
  const liste = [];
  let aktuell = '';
  let zeile0 = 0;
  text.split('\n').forEach((z, i) => {
    if (aktuell === '' && /^\s*#/.test(z)) return;
    if (aktuell === '') zeile0 = i + 1;
    // Wie BuildKit: Escape-Zeichen am Zeilenende, danach höchstens Leerraum.
    // Nur `\` – eine Parser-Direktive `# escape=` ist ein Befund.
    const fortsetzung = /\\[ \t]*$/.exec(z);
    if (fortsetzung) aktuell += `${z.slice(0, fortsetzung.index)} `;
    else {
      aktuell += z;
      if (aktuell.trim() !== '') liste.push({ zeile: zeile0, text: aktuell.trim() });
      aktuell = '';
    }
  });
  if (aktuell.trim() !== '') liste.push({ zeile: zeile0, text: aktuell.trim() });
  return liste;
}

/** Optionen `--name=wert` direkt nach dem Befehl (COPY, RUN). */
function optionen(text) {
  const m = /^\S+((?:\s+--\S+)*)/.exec(text);
  return (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
}

export function pruefeDockerfile(text, kontext) {
  const befunde = [];
  const a = anweisungen(text);
  // Parser-Direktiven stehen vor allem anderen: `escape` änderte die
  // Fortsetzungszeilen (das Skript läse andere Anweisungen als Docker),
  // `syntax` lüde ungepinnten Frontend-Code, `check` schaltete Prüfungen ab.
  for (const z of text.split('\n')) {
    if (!/^\s*#\s*[A-Za-z][A-Za-z0-9]*\s*=/.test(z)) break;
    befunde.push(`keine Parser-Direktive (${z.trim().slice(0, 40)})`);
  }
  if (befunde.length === 0 && /^\s*#\s*(syntax|escape|check)\s*=/im.test(text)) {
    befunde.push('keine # syntax=/escape=/check=-Zeile (Parser-Direktive)');
  }

  const stages = new Map();
  let stage = null;
  const argDekl = [];
  for (const x of a) {
    const [befehl] = x.text.split(/\s+/, 1);
    const B = befehl.toUpperCase();
    if (!BEKANNT.has(B)) {
      befunde.push(`Zeile ${x.zeile}: unbekannte Anweisung ${befehl.slice(0, 20)}`);
      continue;
    }
    if (B === 'ARG') {
      for (const teil of x.text.slice(3).trim().split(/\s+/)) {
        argDekl.push({ name: teil.split('=', 1)[0], text: teil, global: stage === null });
      }
    }
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
    if (/<<-?\s*["']?[A-Za-z_]/.test(x.text)) befunde.push(`Zeile ${x.zeile}: Heredoc`);
    if (
      /^(ENV|ARG|LABEL)\s/i.test(x.text) &&
      /(PASSWORD|PASSWORT|TOKEN|SECRET|PRIVATE|SCHLUESSEL)/i.test(x.text)
    ) {
      befunde.push(`Zeile ${x.zeile}: Geheimnis in ${B}`);
    }
    // Quellen anderer Stages (COPY --from, RUN --mount=…,from=): nur ein zuvor
    // definierter Stage, nie ein Image – das wäre eine Basis an FROM vorbei.
    const quellen = [];
    for (const o of B === 'COPY' || B === 'RUN' ? optionen(x.text) : []) {
      const von = /^--from=(.*)$/.exec(o);
      if (von) quellen.push(von[1]);
      const mount = /^--mount=(.*)$/.exec(o);
      for (const kv of mount ? mount[1].split(',') : []) {
        const f = /^from=(.*)$/.exec(kv);
        if (f) quellen.push(f[1]);
      }
    }
    for (const q of quellen) {
      if (!stages.has(q) || q === stage?.name) {
        befunde.push(`Zeile ${x.zeile}: Quelle ${q} ist kein vorheriger Stage`);
      }
    }
    stage?.anweisungen.push({ ...x, befehl: B, quellen });
  }
  for (const [name, wert] of Object.entries(BASIS)) {
    // Genau eine Deklaration im ganzen Dockerfile, global vor dem ersten FROM
    // und wörtlich gepinnt: Eine zweite globale ARG überschriebe den Wert.
    const d = argDekl.filter((x) => x.name === name);
    if (d.length !== 1 || !d[0].global || d[0].text !== `${name}=${wert}`) {
      befunde.push(`ARG ${name} nicht wie gepinnt (genau eine globale Deklaration)`);
    }
  }
  const stageAnw = (name) => stages.get(name)?.anweisungen ?? null;
  const texte = (name) => stageAnw(name)?.map((x) => x.text) ?? null;
  const anzahl = (name, befehl) => stageAnw(name).filter((x) => x.befehl === befehl).length;

  for (const name of AUSGELIEFERT) {
    for (const x of stageAnw(name) ?? []) {
      if (x.befehl === 'RUN' && optionen(x.text).length > 0) {
        befunde.push(`${name}: RUN mit Optionen (--mount, --network …) im ausgelieferten Stage`);
      }
    }
  }

  const api = texte('api');
  if (!api) befunde.push('Ziel api fehlt');
  else {
    if (stages.get('api').basis !== '${NODE_IMAGE}') befunde.push('api: Basis nicht Node');
    if (!api.includes('USER 10001:10001')) befunde.push('api: USER 10001:10001 fehlt');
    else if (anzahl('api', 'USER') !== 1) befunde.push('api: genau ein USER (10001:10001)');
    if (anzahl('api', 'CMD') !== 1) befunde.push('api: genau ein CMD');
    if (anzahl('api', 'ENTRYPOINT') !== 0) befunde.push('api: kein ENTRYPOINT');
    if (!api.some((t) => /^CMD \["node",/.test(t)))
      befunde.push('api: CMD nicht in Exec-Form mit node');
    if (
      anzahl('api', 'HEALTHCHECK') !== 1 ||
      !api.some((t) => /^HEALTHCHECK .*CMD \["node", "\/app\/healthcheck\.mjs"\]$/.test(t))
    ) {
      befunde.push('api: HEALTHCHECK mit node /app/healthcheck.mjs fehlt');
    }
    if (!api.includes('EXPOSE 3200')) befunde.push('api: EXPOSE 3200 fehlt');
    if (!api.some((t) => /rm -rf \/usr\/local\/lib\/node_modules\/npm/.test(t))) {
      befunde.push('api: npm/Corepack werden nicht entfernt');
    }
    if (!api.some((t) => /^COPY --from=bau /.test(t))) befunde.push('api: COPY --from=bau fehlt');
    for (const x of stageAnw('api')) {
      if (x.befehl === 'COPY' && x.quellen.length === 0) befunde.push('api: COPY aus dem Kontext');
      if (x.quellen.some((q) => q !== 'bau')) befunde.push('api: Quelle außer bau');
    }
    if (
      api.some((t) => {
        const rest = t.replace(PRUEFSCHLEIFE_API, '');
        return DOWNLOAD.test(rest) || WERKZEUG.test(rest);
      })
    ) {
      befunde.push('api: Werkzeug oder Download im Laufzeit-Stage');
    }
    const user = api.indexOf('USER 10001:10001');
    const cmd = api.findIndex((t) => t.startsWith('CMD '));
    if (user > -1 && cmd > -1 && cmd < user) befunde.push('api: CMD vor USER');
  }
  const migrate = texte('migrate');
  if (!migrate) befunde.push('Ziel migrate fehlt');
  else {
    if (!migrate.includes('USER 70:70')) befunde.push('migrate: USER 70:70 fehlt');
    else if (anzahl('migrate', 'USER') !== 1) befunde.push('migrate: genau ein USER (70:70)');
    if (
      anzahl('migrate', 'ENTRYPOINT') !== 1 ||
      !migrate.includes('ENTRYPOINT ["/opt/tcms/betrieb/migrate.sh"]')
    ) {
      befunde.push('migrate: ENTRYPOINT migrate.sh fehlt');
    }
    if (anzahl('migrate', 'CMD') !== 1 || !migrate.includes('CMD []')) {
      befunde.push('migrate: genau ein CMD []');
    }
    if (stages.get('migrate')?.basis !== '${POSTGRES_IMAGE}')
      befunde.push('migrate: Basis nicht PostgreSQL');
    for (const x of stageAnw('migrate')) {
      if (x.befehl === 'COPY' && x.quellen.length === 0) {
        befunde.push('migrate: COPY aus dem Kontext');
      }
      if (x.quellen.some((q) => q !== 'migrate-dateien')) {
        befunde.push('migrate: Quelle außer migrate-dateien');
      }
    }
    if (
      migrate.some((t) => {
        const rest = t.replace(OHNE_NODE_MIGRATE, '');
        return /\bnode\b|(^|[\s;&|(`])prisma(\s|$)/.test(rest) || WERKZEUG.test(rest);
      })
    ) {
      befunde.push('migrate: Node oder Prisma im Stage');
    }
  }
  for (const name of ['migrate', 'migrate-dateien']) {
    if (texte(name)?.some((t) => DOWNLOAD.test(t))) {
      befunde.push(`${name}: Werkzeug oder Download im Stage`);
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
    if (!/^COPY\s/i.test(x.text) || optionen(x.text).some((o) => o.startsWith('--from='))) {
      continue;
    }
    const teile = x.text.split(/\s+/).slice(1 + optionen(x.text).length);
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
