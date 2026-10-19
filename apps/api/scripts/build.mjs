#!/usr/bin/env node
// =============================================================================
// Build des Dienstes (ADR 0001 §8, RT-04): bündelt `src/server.ts` mit allen
// Workspace-Paketen (@tcms/*) zu `dist/server.mjs` (ESM, Node 24). Drittpakete
// bleiben extern und kommen zur Laufzeit aus dem per `pnpm deploy --prod`
// erzeugten node_modules (Versionen und Integrität aus dem Lockfile, sichtbar
// für Scanner); `dist/externe.json` listet sie für `scripts/laufzeit.mjs`.
//
//   TCMS_VERSION=1.2.3 node scripts/build.mjs
//
// `TCMS_VERSION` (Image-Tag) landet als Version von `/v1/health` im Bundle;
// ohne Variable gilt die Version aus package.json. esbuild läuft nur hier,
// nie zur Laufzeit.
// =============================================================================

import { builtinModules } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const API = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(API, 'dist');
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;

function fehler(meldung) {
  process.stderr.write(`build: ${meldung}\n`);
  process.exit(1);
}

const paket = JSON.parse(readFileSync(join(API, 'package.json'), 'utf8'));
const version = process.env.TCMS_VERSION || paket.version;
if (!VERSION.test(version)) fehler('TCMS_VERSION ist keine Version der Form X.Y.Z[-vorab]');

const eingebaut = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const externe = new Set();

/** Workspace-Pakete und relative Importe bündeln, alles andere extern lassen. */
const workspaceBuendeln = {
  name: 'workspace-buendeln',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@tcms/')) return undefined;
      if (eingebaut.has(args.path)) return { path: args.path, external: true };
      const teile = args.path.split('/');
      externe.add(args.path.startsWith('@') ? teile.slice(0, 2).join('/') : teile[0]);
      return { path: args.path, external: true };
    });
  },
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const ergebnis = await build({
  absWorkingDir: API,
  entryPoints: { server: 'src/server.ts' },
  outdir: DIST,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Stack-Traces auf die TS-Quellen, ohne Quelltext im Image.
  sourcemap: 'linked',
  sourcesContent: false,
  legalComments: 'none',
  define: { __TCMS_VERSION__: JSON.stringify(version) },
  plugins: [workspaceBuendeln],
  logLevel: 'warning',
});
if (ergebnis.errors.length > 0) fehler('esbuild meldet Fehler');
writeFileSync(join(DIST, 'externe.json'), `${JSON.stringify([...externe].sort(), null, 2)}\n`);
process.stdout.write(
  `build: dist/server.mjs ${version} (extern: ${[...externe].sort().join(', ')})\n`,
);
