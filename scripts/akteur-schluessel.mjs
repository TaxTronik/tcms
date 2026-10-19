#!/usr/bin/env node
// =============================================================================
// Erzeugt ein Ed25519-Schlüsselpaar für die Akteursbestätigung (ADR 0001 §3.2).
//
//   pnpm akteur:schluessel [--kid <kid>]
//
// Ausgabe: kid, Eintrag für TCMS_ACTOR_PUBLIC_KEYS (Tax-CMS) und privater
// Schlüssel (PKCS8-DER, base64) für die kanzleikonsole. Schreibt nichts auf die
// Platte; der private Schlüssel erscheint nur in dieser Ausgabe.
// =============================================================================

import { createHash, generateKeyPairSync } from 'node:crypto';

// Gleiches Muster wie AkteurHeaderSchema.kid in packages/contract.
const KID = /^[A-Za-z0-9._-]{1,64}$/;

const args = process.argv.slice(2).filter((a) => a !== '--');
let kid;
if (args.length === 2 && args[0] === '--kid') {
  kid = args[1];
} else if (args.length !== 0) {
  process.stderr.write('Aufruf: pnpm akteur:schluessel [--kid <kid>]\n');
  process.exit(2);
}
if (kid !== undefined && !KID.test(kid)) {
  process.stderr.write('kid: 1–64 Zeichen aus A–Z a–z 0–9 . _ -\n');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
// Standard-kid: Datum und Fingerabdruck des öffentlichen Schlüssels.
kid ??= `kk-${new Date().toISOString().slice(0, 10)}-${createHash('sha256')
  .update(spki)
  .digest('base64url')
  .slice(0, 8)}`;

process.stdout.write(
  [
    '# Neues Ed25519-Schlüsselpaar für die Akteursbestätigung (nichts wurde gespeichert).',
    `kid: ${kid}`,
    '',
    '# Tax-CMS: an TCMS_ACTOR_PUBLIC_KEYS anhängen (kommagetrennt):',
    `${kid}=${spki.toString('base64')}`,
    '',
    '# kanzleikonsole: privater Schlüssel (PKCS8-DER, base64). Nur im Secret-Speicher ablegen,',
    '# nie einchecken, nie loggen:',
    pkcs8.toString('base64'),
    '',
  ].join('\n'),
);
