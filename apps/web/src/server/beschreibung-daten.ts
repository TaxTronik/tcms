import 'server-only';
import { DienstFehler, type BeschreibungView } from '@tcms/contract';
import type { Abschnitt } from '@tcms/domain';
import { imDienst, ladeBeschreibung } from '@tcms/service';
import type { BausteinSatz, Snapshot } from '@/components/beschreibung/typen';
import { DEMO_PORTS, zustaendigkeit } from './demo';
import { demoAkteur } from './sitzung';

// =============================================================================
// CMS-Beschreibung der Demo: liest über den Service-Lader `ladeBeschreibung`
// (Status zum Stichtag, letzte Bearbeitung, Snapshot-Prüfung, lebende
// Bausteine berechnet der Service) und bildet die Antwort für die Seiten ab
// (ISO-Strings → Date). Die Zuständigkeit für den Baustein VERANTWORTUNG
// übergibt die Demo wie die kanzleikonsole.
// =============================================================================

export { normalisiereAbschnitte } from '@tcms/service';

export type BeschreibungStatus =
  | 'ENTWURF'
  | 'KANZLEI_REVIEW'
  | 'BEIM_MANDANTEN'
  | 'FREIGEGEBEN'
  | 'ABGELOEST';

export interface VersionRoh {
  id: string;
  nummer: string;
  status: BeschreibungStatus;
  /** Status zum Stichtag (Service). */
  anzeige: BeschreibungStatus;
  abschnitte: Abschnitt[];
  createdAt: Date;
  erstelltVon: string | null;
  reviewAngefordertVon: string | null;
  reviewAngefordertAm: Date | null;
  reviewVon: string | null;
  reviewAm: Date | null;
  freigabeAngefordertAm: Date | null;
  freigegebenVon: string | null;
  freigegebenAm: Date | null;
  snapshot: Snapshot | null;
  snapshotSha256: string | null;
  /** SHA-256 des Snapshots geprüft (null: nichts zu prüfen). */
  snapshotGeprueft: boolean | null;
  /** Letzte bearbeitende Person (Vier-Augen der Review). */
  letzteBearbeitung: string | null;
}

export interface FreigabeRoh {
  id: string;
  refId: string;
  status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT';
  angefordertVon: string;
  angefordertAm: Date;
  empfaengerId: string;
  codeAblauf: Date | null;
  hatCode: boolean;
  anmerkung: string | null;
  erledigtAm: Date | null;
}

export interface BeschreibungsDaten {
  versionen: VersionRoh[];
  freigaben: FreigabeRoh[];
  zurueckweisungen: { versionId: string; nummer: string; at: Date; actorId: string | null }[];
  bausteine: BausteinSatz | null;
  gesetzlicheVertreter: string[];
}

const datum = (s: string | null) => (s ? new Date(s) : null);

function abbilden(v: BeschreibungView): BeschreibungsDaten {
  return {
    versionen: v.versionen.map((x) => ({
      ...x,
      createdAt: new Date(x.createdAt),
      reviewAngefordertAm: datum(x.reviewAngefordertAm),
      reviewAm: datum(x.reviewAm),
      freigabeAngefordertAm: datum(x.freigabeAngefordertAm),
      freigegebenAm: datum(x.freigegebenAm),
      snapshot: (x.snapshot as Snapshot | null) ?? null,
    })),
    freigaben: v.freigaben.map((f) => ({
      id: f.id,
      refId: f.refId,
      status: f.status,
      angefordertVon: f.angefordertVon,
      angefordertAm: new Date(f.angefordertAm),
      empfaengerId: f.empfaengerId,
      codeAblauf: datum(f.codeAblauf),
      hatCode: f.codeStatus === 'AKTIV' || f.codeStatus === 'ABGELAUFEN',
      anmerkung: f.anmerkung,
      erledigtAm: datum(f.erledigtAm),
    })),
    zurueckweisungen: v.zurueckweisungen.map((z) => ({
      versionId: z.versionId,
      nummer: z.nummer,
      at: new Date(z.at),
      actorId: z.actorId,
    })),
    bausteine: (v.bausteine as BausteinSatz | null) ?? null,
    gesetzlicheVertreter: v.gesetzlicheVertreter,
  };
}

/** Versionen, Freigaben und lebende Bausteine zum Stichtag; null ohne Zugriff. */
export async function ladeBeschreibungsDaten(
  mandantId: string,
  standIso: string,
): Promise<BeschreibungsDaten | null> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return null;
  const z = zustaendigkeit(mandantId);
  try {
    const v = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeBeschreibung(ctx, {
        mandantId,
        stand: standIso,
        ...(z.berufstraegerId ? { berufstraegerId: z.berufstraegerId } : {}),
        ...(z.bearbeitungId ? { bearbeitungId: z.bearbeitungId } : {}),
      }),
    );
    return abbilden(v);
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return null;
    throw e;
  }
}
