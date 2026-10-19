#!/usr/bin/env node
// =============================================================================
// Laufzeitbaum des Images `tcms-api` fertigstellen und prüfen (ADR 0001 §8,
// RT-04, Betriebsschnittstelle Stufe 2).
//
//   node scripts/laufzeit.mjs <deploy-verzeichnis> --prisma-client <dir> --bundle <dist>
//
// Erwartet einen mit `pnpm --filter @tcms/api deploy --prod --no-optional`
// erzeugten Baum. Schritte:
//   1. erzeugten Prisma-Client (`.prisma/client`, aus dem Build-Schritt) nach
//      node_modules/.prisma/client kopieren (zur Laufzeit gibt es keine
//      Prisma-CLI, die ihn erzeugen könnte);
//   2. die kopierten Workspace-Pakete node_modules/@tcms entfernen – sie sind
//      im Bundle enthalten und brächten Seeds, Demo und Quelltexte mit;
//   3. prüfen (fail closed): keine Werkzeuge (tsx, esbuild, Prisma-CLI und
//      -Engines, TypeScript, Vitest/Vite, Prettier, dotenv, Next), keine
//      Workspace-Kopien (Seeds, Demo), keine .env, jede externe Abhängigkeit des Bundles vorhanden, Prisma-Client
//      vorhanden.
// Gibt nur Paketnamen und Pfade aus, nie Dateiinhalte.
// =============================================================================

import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Pakete, die nie im Laufzeitbaum liegen dürfen (Werkzeuge, RT-04). */
export const VERBOTEN = [
  'tsx',
  'esbuild',
  '@esbuild',
  'prisma',
  '@prisma/engines',
  '@prisma/studio-core',
  '@prisma/dev',
  '@prisma/fetch-engine',
  '@prisma/config',
  'typescript',
  'vitest',
  '@vitest',
  'vite',
  'prettier',
  'dotenv',
  'next',
  '@tcms',
];

function fehler(meldung) {
  process.stderr.write(`laufzeit: ${meldung}\n`);
  process.exit(1);
}

function argumente(argv) {
  const werte = { ziel: null, prismaClient: null, bundle: null };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === '--prisma-client') werte.prismaClient = resolve(rest.shift() ?? '');
    else if (a === '--bundle') werte.bundle = resolve(rest.shift() ?? '');
    else if (!a.startsWith('--') && werte.ziel === null) werte.ziel = resolve(a);
    else fehler(`unbekanntes Argument ${a}`);
  }
  if (!werte.ziel || !werte.prismaClient || !werte.bundle) {
    fehler('Aufruf: laufzeit.mjs <deploy-verzeichnis> --prisma-client <dir> --bundle <dist>');
  }
  return werte;
}

/** Alle Pfade unter `wurzel` (ohne Symlinks zu folgen). */
function alleEintraege(wurzel) {
  const liste = [];
  const besuche = (dir) => {
    for (const name of readdirSync(dir)) {
      const pfad = join(dir, name);
      liste.push(pfad);
      const info = lstatSync(pfad);
      if (info.isDirectory()) besuche(pfad);
    }
  };
  besuche(wurzel);
  return liste;
}

export function pruefeLaufzeitbaum(nodeModules, externe) {
  const befunde = [];
  for (const paket of VERBOTEN) {
    if (existsSync(join(nodeModules, paket))) befunde.push(`verbotenes Paket: ${paket}`);
  }
  const bin = join(nodeModules, '.bin');
  if (existsSync(bin)) {
    for (const name of readdirSync(bin)) befunde.push(`ausführbares Werkzeug: .bin/${name}`);
  }
  for (const paket of externe) {
    if (!existsSync(join(nodeModules, paket, 'package.json'))) {
      befunde.push(`externe Abhängigkeit fehlt: ${paket}`);
    }
  }
  for (const datei of ['default.js', 'index.js', 'package.json']) {
    if (!existsSync(join(nodeModules, '.prisma', 'client', datei))) {
      befunde.push(`Prisma-Client fehlt: .prisma/client/${datei}`);
    }
  }
  // Seeds und Demo kämen nur mit @tcms/db bzw. apps/web (oben verboten).
  for (const pfad of alleEintraege(nodeModules)) {
    const rel = relative(nodeModules, pfad);
    const name = rel.split('/').at(-1) ?? '';
    if (name === '.env' || name.startsWith('.env.')) befunde.push(`Umgebungsdatei: ${rel}`);
  }
  return befunde;
}

// Nur als Programm ausführen, nicht beim Import (Tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = argumente(process.argv.slice(2));
  const nodeModules = join(args.ziel, 'node_modules');
  if (!existsSync(nodeModules)) fehler('node_modules fehlt im Deploy-Verzeichnis');
  if (!existsSync(join(args.prismaClient, 'default.js'))) fehler('erzeugter Prisma-Client fehlt');
  const externe = JSON.parse(readFileSync(join(args.bundle, 'externe.json'), 'utf8'));
  if (!existsSync(join(args.bundle, 'server.mjs'))) fehler('Bundle fehlt (pnpm build)');

  rmSync(join(nodeModules, '.prisma'), { recursive: true, force: true });
  cpSync(args.prismaClient, join(nodeModules, '.prisma', 'client'), { recursive: true });
  rmSync(join(nodeModules, '@tcms'), { recursive: true, force: true });
  // Leeres .bin (keine Programme der Produktionsabhängigkeiten) entfernen.
  const bin = join(nodeModules, '.bin');
  if (existsSync(bin) && readdirSync(bin).length === 0) rmSync(bin, { recursive: true });

  const befunde = pruefeLaufzeitbaum(nodeModules, externe);
  if (befunde.length > 0) fehler(`Laufzeitbaum unzulässig:\n- ${befunde.join('\n- ')}`);
  process.stdout.write(
    `laufzeit: Baum geprüft (${externe.length} externe Pakete, keine Werkzeuge)\n`,
  );
}
