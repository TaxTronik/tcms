import 'server-only';
import { prisma } from '@tcms/db';
import type { Geschaeftsprofil } from '@tcms/domain';
import type { PersonKurz, TcmsKontext } from './kontext';
import type { Umfeld } from './programm-aufbau';

// =============================================================================
// Zusatzdaten für Einrichtungsassistent (S3) und Profil-Tab: Entwurf,
// Personen-Umfeld, Profilhistorie und Risikoentscheidungen.
// =============================================================================

export interface SetupProgramm {
  id: string;
  status: 'ENTWURF' | 'AKTIV';
  version1Am: Date | null;
  setupEntwurf: unknown;
  createdAt: Date;
}

/** Jüngstes Programm des Mandanten (wie `ladeKontext`), inklusive Entwurfsstand. */
export async function ladeSetupProgramm(mandantId: string): Promise<SetupProgramm | null> {
  return prisma.tcmsProgramm.findFirst({
    where: { mandantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, version1Am: true, setupEntwurf: true, createdAt: true },
  });
}

function kurz(x: {
  id: string;
  name: string;
  kuerzel: string;
  art: 'KANZLEI' | 'MANDANT';
  funktion: string | null;
  email: string;
  telefon: string | null;
  kanzleiRolle: PersonKurz['kanzleiRolle'];
  mandantRolle: PersonKurz['mandantRolle'];
}): PersonKurz {
  return {
    id: x.id,
    name: x.name,
    kuerzel: x.kuerzel,
    art: x.art,
    funktion: x.funktion,
    email: x.email,
    telefon: x.telefon,
    kanzleiRolle: x.kanzleiRolle,
    mandantRolle: x.mandantRolle,
  };
}

/** Personen-Umfeld eines Mandanten (aktive Kanzlei- und Mandantenpersonen). */
export async function ladeUmfeld(mandantId: string, heute: Date): Promise<Umfeld | null> {
  const mandant = await prisma.mandant.findUnique({
    where: { id: mandantId },
    include: { personen: { where: { aktiv: true }, orderBy: { name: 'asc' } } },
  });
  if (!mandant) return null;
  const kanzlei = await prisma.person.findMany({
    where: { art: 'KANZLEI', aktiv: true },
    orderBy: { name: 'asc' },
  });
  return {
    mandant: {
      id: mandant.id,
      name: mandant.name,
      berufstraegerId: mandant.berufstraegerId,
      bearbeitungId: mandant.bearbeitungId,
    },
    kanzlei: kanzlei.map(kurz).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    mandantPersonen: mandant.personen.map(kurz).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    heute,
  };
}

/** Umfeld aus dem bereits geladenen Kontext (Seiten). */
export function umfeldAusKontext(ctx: TcmsKontext): Umfeld {
  const kanzlei = [...ctx.personen.values()]
    .filter((p) => p.art === 'KANZLEI')
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return {
    mandant: {
      id: ctx.mandant.id,
      name: ctx.mandant.name,
      berufstraegerId: ctx.mandant.berufstraegerId,
      bearbeitungId: ctx.mandant.bearbeitungId,
    },
    kanzlei,
    mandantPersonen: [...ctx.mandantPersonen].sort((a, b) => a.name.localeCompare(b.name, 'de')),
    heute: ctx.heute,
  };
}

export interface ProfilStandView {
  id: string;
  antworten: Geschaeftsprofil;
  gueltigAb: Date;
  gueltigBis: Date | null;
  erstelltVon: string | null;
  createdAt: Date;
}

export interface RisikoEntscheidungView {
  id: string;
  code: string;
  kern: boolean;
  entscheidung: 'VORGESCHLAGEN' | 'UEBERNOMMEN' | 'ABGELEHNT';
  vorschlagsgrund: string | null;
  ablehnungsgrund: string | null;
  inaktivAb: Date | null;
  neuBewerten: boolean;
  createdAt: Date;
}

/** Alle Profilstände (aufsteigend) und alle Risikoentscheidungen eines Programms. */
export async function ladeProfilDaten(
  programmId: string,
): Promise<{ staende: ProfilStandView[]; risiken: RisikoEntscheidungView[] }> {
  const [staende, risiken] = await Promise.all([
    prisma.profilStand.findMany({
      where: { programmId },
      orderBy: [{ gueltigAb: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.risiko.findMany({
      where: { programmId },
      select: {
        id: true,
        code: true,
        kern: true,
        entscheidung: true,
        vorschlagsgrund: true,
        ablehnungsgrund: true,
        inaktivAb: true,
        neuBewerten: true,
        createdAt: true,
      },
      orderBy: { code: 'asc' },
    }),
  ]);
  return {
    staende: staende.map((s) => ({
      id: s.id,
      antworten: s.antworten as unknown as Geschaeftsprofil,
      gueltigAb: s.gueltigAb,
      gueltigBis: s.gueltigBis,
      erstelltVon: s.erstelltVon,
      createdAt: s.createdAt,
    })),
    risiken,
  };
}
