import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { PersonAkteur } from '@tcms/contract';
import { ladeKontaktRollen, type KontaktRolle } from '@tcms/service';
import {
  akteurFuer,
  demoPerson,
  handelnde,
  lies,
  type DemoPerson,
  type Handelnde,
  type KanzleiAkteur,
  type MandantAkteur,
} from './demo';
import { COOKIE, DAUER_MS, demoLoginErlaubt, erzeugeCookie, pruefeCookie } from './sitzung-regeln';

export { demoLoginErlaubt, pruefeSessionSecret } from './sitzung-regeln';

// =============================================================================
// Demo-Sitzung: signiertes Cookie mit Personen-ID und Ablauf. Die Anmeldung
// erfolgt über die Personenauswahl der Demo; daraus entsteht je Anfrage ein
// Akteur wie aus der Akteursbestätigung der kanzleikonsole (ADR 0001 §3, §5).
// Der Dienst (apps/api) kennt keine Anmeldung.
//
// TS-01: Mit NODE_ENV=production ist die Demo-Anmeldung immer verweigert –
//        unabhängig von jedem Schalter –, und bestehende Cookies gelten nicht.
// TS-02: Bekannte Platzhalter für SESSION_SECRET werden abgewiesen.
// =============================================================================

export async function setzeSitzung(personId: string): Promise<void> {
  if (!demoLoginErlaubt())
    throw new Error('Die Demo-Anmeldung ist in dieser Umgebung deaktiviert.');
  const jar = await cookies();
  jar.set(COOKIE, erzeugeCookie(personId), {
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

/** Angemeldete Demo-Person (je Anfrage zwischengespeichert). */
export const aktuellePerson = cache(async (): Promise<DemoPerson | null> => {
  if (!demoLoginErlaubt()) return null;
  const jar = await cookies();
  return demoPerson(pruefeCookie(jar.get(COOKIE)?.value));
});

/**
 * Akteur der angemeldeten Person für einen Mandanten, wie ihn die kanzleikonsole
 * bestätigen würde (ADR 0001 §3.2): Kanzleiperson mit `cli` für genau diesen
 * Mandanten (nur bekannte Demo-Mandanten), Mandantenkontakt unverändert mit
 * seinem eigenen Mandanten. Ohne Sitzung null. Rechte prüft der Service.
 */
export async function demoAkteur(mandantId: string | null): Promise<PersonAkteur | null> {
  const p = await aktuellePerson();
  return p ? akteurFuer(p, mandantId) : null;
}

/** Kanzleiperson ohne Mandantenbezug (Portfolio, Arbeitskorb, Administration). */
export async function brauchtKanzlei(): Promise<KanzleiAkteur> {
  const p = await aktuellePerson();
  if (!p) redirect('/anmelden');
  if (p.art !== 'KANZLEI') redirect('/portal/tcms');
  return akteurFuer(p, null) as KanzleiAkteur;
}

/** Kanzleiperson mit Bezug auf einen Mandanten (wie `cli` der Akteursbestätigung). */
export async function brauchtKanzleiFuer(mandantId: string): Promise<KanzleiAkteur> {
  const p = await aktuellePerson();
  if (!p) redirect('/anmelden');
  if (p.art !== 'KANZLEI') redirect('/portal/tcms');
  return akteurFuer(p, mandantId) as KanzleiAkteur;
}

/** Aktive Rollen eines Mandantenkontakts aus MandantKontaktRolle (je Anfrage). */
const rollenVon = cache(async (personId: string): Promise<KontaktRolle[]> => {
  const p = demoPerson(personId);
  if (!p || p.art !== 'MANDANT') return [];
  const akteur = akteurFuer(p, null);
  return lies((tx) => ladeKontaktRollen(tx, akteur));
});

export interface PortalAkteur {
  akteur: MandantAkteur;
  rollen: KontaktRolle[];
  /** Akteur mit Rollen für die gemeinsamen Durchführungs-Handlungen. */
  handelnde: Handelnde;
}

/**
 * Mandantenkontakt mit seinen aktiven Rollen. Ohne aktive Rolle kein Zugriff
 * aufs Portal (ADR 0001 §5) – zurück zur Anmeldung.
 */
export async function brauchtPortal(): Promise<PortalAkteur> {
  const p = await aktuellePerson();
  if (!p) redirect('/anmelden');
  if (p.art !== 'MANDANT') redirect('/staff/tcms');
  const akteur = akteurFuer(p, null) as MandantAkteur;
  const rollen = await rollenVon(p.id);
  if (rollen.length === 0) redirect('/anmelden?fehler=rolle');
  return { akteur, rollen, handelnde: handelnde(akteur, rollen) };
}
