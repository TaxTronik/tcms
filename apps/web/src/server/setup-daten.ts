import 'server-only';
import { DienstFehler, type EinrichtungPersonen, type EinrichtungView } from '@tcms/contract';
import type { Geschaeftsprofil } from '@tcms/domain';
import { imDienst, ladeEinrichtung as ladeEinrichtungDienst } from '@tcms/service';
import { db, DEMO_PORTS, demoPersonen, zustaendigkeit } from './demo';
import { personKurz, type PersonKurz, type TcmsKontext } from './kontext';
import type { Umfeld } from './programm-aufbau';
import { demoAkteur } from './sitzung';

// =============================================================================
// Zusatzdaten für Einrichtungsassistent (S3) und Profil-Tab. Der Assistent
// liest über den Service-Lader (`ladeEinrichtung`); die Demo liefert wie die
// kanzleikonsole die Personen der Kanzlei (Zuständigkeit aus dem
// Demo-Verzeichnis). Profilhistorie und Umfeld für den Profil-Tab bleiben hier,
// bis der Bereich risiken-kontrollen sie übernimmt.
// =============================================================================

/** Kanzleipersonen des Demo-Verzeichnisses, nach Name sortiert (Vorschlagsreihenfolge). */
function kanzleiPersonen() {
  return demoPersonen
    .alle()
    .filter((p) => p.art === 'KANZLEI')
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** Personen für den Assistenten, wie sie die kanzleikonsole übergibt (nur Vorbelegung). */
export function einrichtungsPersonen(mandantId: string): EinrichtungPersonen {
  const z = zustaendigkeit(mandantId);
  return {
    berufstraegerId: z.berufstraegerId,
    bearbeitungId: z.bearbeitungId,
    kanzlei: kanzleiPersonen().map((p) => p.id),
  };
}

/** Entwurf, Plan und Prüfpunkte des Assistenten über den Service (null: kein Zugriff). */
export async function ladeEinrichtung(mandantId: string): Promise<EinrichtungView | null> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur || !UUID.test(mandantId)) return null;
  const p = einrichtungsPersonen(mandantId);
  const vertretung = kanzleiPersonen().find(
    (x) => x.id !== p.berufstraegerId && x.id !== p.bearbeitungId,
  );
  try {
    return await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeEinrichtungDienst(ctx, {
        mandantId,
        ...(p.berufstraegerId ? { berufstraegerId: p.berufstraegerId } : {}),
        ...(p.bearbeitungId ? { bearbeitungId: p.bearbeitungId } : {}),
        ...(vertretung ? { vertretungId: vertretung.id } : {}),
      }),
    );
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return null;
    throw e;
  }
}

export interface SetupProgramm {
  id: string;
  status: 'ENTWURF' | 'AKTIV';
  version1Am: Date | null;
  setupEntwurf: unknown;
  createdAt: Date;
}

/** Jüngstes Programm des Mandanten (wie `ladeKontext`), inklusive Entwurfsstand. */
export async function ladeSetupProgramm(mandantId: string): Promise<SetupProgramm | null> {
  if (!UUID.test(mandantId)) return null;
  return db.tcmsProgramm.findFirst({
    where: { mandantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, version1Am: true, setupEntwurf: true, createdAt: true },
  });
}

/**
 * Personen-Umfeld eines Mandanten: Kanzleipersonen aus dem Demo-Verzeichnis,
 * Mandantenpersonen mit aktiver Rolle aus MandantKontaktRolle (ADR 0001 §5).
 */
export async function ladeUmfeld(mandantId: string, heute: Date): Promise<Umfeld | null> {
  if (!UUID.test(mandantId)) return null;
  const mandant = await db.mandant.findUnique({ where: { id: mandantId } });
  if (!mandant) return null;
  const kontakte = await db.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true },
    orderBy: { createdAt: 'asc' },
  });
  const kanzlei = demoPersonen
    .alle()
    .filter((p) => p.art === 'KANZLEI')
    .map((p) => personKurz(p));
  const mandantPersonen: PersonKurz[] = [];
  for (const k of kontakte) {
    const p = demoPersonen.person(k.kontaktId);
    if (p && !mandantPersonen.some((m) => m.id === p.id))
      mandantPersonen.push(personKurz(p, k.rolle));
  }
  const zust = zustaendigkeit(mandant.id);
  return {
    mandant: {
      id: mandant.id,
      name: mandant.name,
      berufstraegerId: zust.berufstraegerId ?? '',
      bearbeitungId: zust.bearbeitungId ?? '',
    },
    kanzlei: kanzlei.sort((a, b) => a.name.localeCompare(b.name, 'de')),
    mandantPersonen: mandantPersonen.sort((a, b) => a.name.localeCompare(b.name, 'de')),
    heute,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    db.profilStand.findMany({
      where: { programmId },
      orderBy: [{ gueltigAb: 'asc' }, { createdAt: 'asc' }],
    }),
    db.risiko.findMany({
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
