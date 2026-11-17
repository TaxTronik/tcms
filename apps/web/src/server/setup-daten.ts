import 'server-only';
import { DienstFehler, type EinrichtungPersonen, type EinrichtungView } from '@tcms/contract';
import { imDienst, ladeEinrichtung as ladeEinrichtungDienst } from '@tcms/service';
import { db, DEMO_PORTS, demoPersonen, zustaendigkeit } from './demo';
import type { TcmsKontext } from './kontext';
import type { Umfeld } from './programm-aufbau';
import { demoAkteur } from './sitzung';

// =============================================================================
// Zusatzdaten für Einrichtungsassistent (S3) und Profil-Tab. Der Assistent
// liest über den Service-Lader (`ladeEinrichtung`); die Demo liefert wie die
// kanzleikonsole die Personen der Kanzlei (Zuständigkeit aus dem
// Demo-Verzeichnis). Profilhistorie und Risikoentscheidungen liest der Profil-Tab
// über den Service (profil-daten.ts); hier liest nur `ladeSetupProgramm` direkt
// (Demo-Tenant, RLS, nur lesend).
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
