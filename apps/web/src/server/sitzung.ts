import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { prisma } from '@tcms/db';

// =============================================================================
// Sitzung (Stufe 1): signiertes Cookie mit Personen-ID und Ablauf.
// Die Anmeldung erfolgt über die Entwicklungs-Personenauswahl; vor einem
// Produktivbetrieb wird sie durch OIDC bzw. die kanzleikonsole ersetzt.
// =============================================================================

const COOKIE = 'tcms_sitzung';
const DAUER_MS = 12 * 60 * 60 * 1000;

function geheimnis(): string {
  const s = process.env['SESSION_SECRET'];
  if (!s || s.length < 24) {
    throw new Error(
      '[auth] SESSION_SECRET fehlt oder ist kürzer als 24 Zeichen. Siehe .env.example.',
    );
  }
  return s;
}

function signiere(wert: string): string {
  return createHmac('sha256', geheimnis()).update(wert).digest('base64url');
}

export function devLoginErlaubt(): boolean {
  if (process.env['TCMS_DEV_LOGIN'] === '1') return true;
  return process.env['NODE_ENV'] !== 'production';
}

export async function setzeSitzung(personId: string): Promise<void> {
  const ablauf = Date.now() + DAUER_MS;
  const nutzlast = `${personId}.${ablauf}`;
  const jar = await cookies();
  jar.set(COOKIE, `${nutzlast}.${signiere(nutzlast)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: DAUER_MS / 1000,
  });
}

export async function beendeSitzung(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

function pruefeCookie(wert: string | undefined): string | null {
  if (!wert) return null;
  const teile = wert.split('.');
  if (teile.length !== 3) return null;
  const [id, ablauf, sig] = teile as [string, string, string];
  const erwartet = Buffer.from(signiere(`${id}.${ablauf}`));
  const geliefert = Buffer.from(sig);
  if (erwartet.length !== geliefert.length || !timingSafeEqual(erwartet, geliefert)) return null;
  if (Number(ablauf) < Date.now()) return null;
  return id;
}

export interface Nutzer {
  id: string;
  name: string;
  kuerzel: string;
  email: string;
  art: 'KANZLEI' | 'MANDANT';
  kanzleiRolle: 'BERUFSTRAEGER' | 'BEARBEITUNG' | null;
  istAdmin: boolean;
  mandantId: string | null;
  mandantRolle: 'GESETZLICHER_VERTRETER' | 'TAX_COMPLIANCE_BEAUFTRAGTER' | 'MITARBEITER' | null;
  funktion: string | null;
}

export const aktuellerNutzer = cache(async (): Promise<Nutzer | null> => {
  const jar = await cookies();
  const id = pruefeCookie(jar.get(COOKIE)?.value);
  if (!id) return null;
  const p = await prisma.person.findUnique({ where: { id } });
  if (!p || !p.aktiv) return null;
  return {
    id: p.id,
    name: p.name,
    kuerzel: p.kuerzel,
    email: p.email,
    art: p.art,
    kanzleiRolle: p.kanzleiRolle,
    istAdmin: p.istAdmin,
    mandantId: p.mandantId,
    mandantRolle: p.mandantRolle,
    funktion: p.funktion,
  };
});

export async function brauchtKanzlei(): Promise<Nutzer> {
  const n = await aktuellerNutzer();
  if (!n) redirect('/anmelden');
  if (n.art !== 'KANZLEI') redirect('/portal/tcms');
  return n;
}

export async function brauchtPortal(): Promise<Nutzer & { mandantId: string }> {
  const n = await aktuellerNutzer();
  if (!n) redirect('/anmelden');
  if (n.art !== 'MANDANT' || !n.mandantId) redirect('/staff/tcms');
  return n as Nutzer & { mandantId: string };
}
