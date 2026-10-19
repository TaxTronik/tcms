import 'server-only';
import { DienstFehler, NACHRICHT_ZWECKE, type PortalFreigabenView } from '@tcms/contract';
import type { Abschnitt } from '@tcms/domain';
import {
  FREIGABE_CODE_ARTEN,
  freigabeBrauchtCode,
  imDienst,
  ladePortalFreigaben,
  nachrichtAdresse,
} from '@tcms/service';
import type { BausteinSatz, Snapshot } from '@/components/beschreibung/typen';
import { db, DEMO_PORTS, demoPersonen } from './demo';
import { demoAkteur } from './sitzung';

// =============================================================================
// Freigaben und Kenntnisnahmen im Portal (Fachkonzept §10 P4, §13): liest über
// den Service-Lader `ladePortalFreigaben` (Sichtbarkeit, Rechte-Flags und
// Codezustand berechnet der Service) und ergänzt Namen aus dem
// Demo-Verzeichnis. Codes erzeugt und prüft nur der Service; die Demo zeigt
// sie ausschließlich im Entwicklungs-Postausgang (Demo-Login).
// =============================================================================

export const CODE_ARTEN = FREIGABE_CODE_ARTEN;
export type CodeArt = (typeof CODE_ARTEN)[number];

export function brauchtCode(art: string): art is CodeArt {
  return freigabeBrauchtCode(art);
}

export const FREIGABE_ART_LABEL: Record<string, string> = {
  ZIELE: 'Compliance-Ziele · Freigabe',
  BESCHREIBUNG: 'CMS-Beschreibung · Freigabe',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz · Freigabe',
  AUFKLAERUNG: 'Risikoaufklärung · Bestätigung',
  KENNTNISNAHME: 'Kenntnisnahme',
};

export interface FreigabeEintrag {
  id: string;
  art: string;
  refId?: string;
  titel: string;
  inhalt: string | null;
  status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT';
  angefordertVon: string;
  angefordertAm: Date;
  empfaengerId: string;
  empfaengerName: string;
  /** Nur für die adressierte Person. */
  codeAblauf: Date | null;
  hatCode: boolean;
  codeGesperrt: boolean;
  verbleibendeVersuche: number | null;
  darfFreigeben: boolean;
  darfKenntnisnehmen: boolean;
  anmerkung: string | null;
  erledigtAm: Date | null;
  version: {
    id: string;
    nummer: string;
    status: string;
    abschnitte: Abschnitt[];
    snapshot: Snapshot | null;
    snapshotSha256: string | null;
    snapshotGeprueft: boolean | null;
    freigegebenVon: string | null;
    freigegebenAm: Date | null;
  } | null;
}

export interface FreigabenUebersicht {
  eintraege: FreigabeEintrag[];
  /** Freigegebene Beschreibungsversionen ohne eigenen Freigabe-Datensatz (Altbestand). */
  fruehere: {
    id: string;
    nummer: string;
    status: string;
    freigegebenVon: string;
    freigegebenAm: Date;
    snapshotSha256: string | null;
  }[];
  /** Lebende Bausteine für offene Beschreibungen ohne Snapshot. */
  live: { stand: string; satz: BausteinSatz } | null;
  istGv: boolean;
  lesen: boolean;
}

const datum = (s: string | null) => (s ? new Date(s) : null);
const name = (id: string | null) => (id ? (demoPersonen.person(id)?.name ?? '—') : '—');

function abbilden(v: PortalFreigabenView): FreigabenUebersicht {
  return {
    eintraege: v.freigaben.map((f) => ({
      id: f.id,
      art: f.art,
      titel: f.titel,
      inhalt: f.inhalt,
      status: f.status,
      angefordertVon: name(f.angefordertVon),
      angefordertAm: new Date(f.angefordertAm),
      empfaengerId: f.empfaengerId,
      empfaengerName: name(f.empfaengerId),
      codeAblauf: datum(f.code?.ablauf ?? null),
      hatCode: f.code?.status === 'AKTIV' || f.code?.status === 'ABGELAUFEN',
      codeGesperrt: f.code?.status === 'GESPERRT',
      verbleibendeVersuche: f.code?.verbleibendeVersuche ?? null,
      darfFreigeben: f.darfFreigeben,
      darfKenntnisnehmen: f.darfKenntnisnehmen,
      anmerkung: f.anmerkung,
      erledigtAm: datum(f.erledigtAm),
      version: f.version
        ? {
            ...f.version,
            snapshot: (f.version.snapshot as Snapshot | null) ?? null,
            freigegebenVon: f.version.freigegebenVon ? name(f.version.freigegebenVon) : null,
            freigegebenAm: datum(f.version.freigegebenAm),
          }
        : null,
    })),
    fruehere: v.fruehere.map((x) => ({
      ...x,
      freigegebenVon: name(x.freigegebenVon),
      freigegebenAm: new Date(x.freigegebenAm),
    })),
    live: v.live ? { stand: v.live.stand, satz: v.live.bausteine as BausteinSatz } : null,
    istGv: v.istGesetzlicherVertreter,
    lesen: v.kannPortalLesen,
  };
}

/** Freigaben und Kenntnisnahmen des eigenen Mandanten für die angemeldete Kontaktperson. */
export async function ladeFreigaben(mandantId: string): Promise<FreigabenUebersicht> {
  const akteur = await demoAkteur(mandantId);
  const leer: FreigabenUebersicht = {
    eintraege: [],
    fruehere: [],
    live: null,
    istGv: false,
    lesen: false,
  };
  if (!akteur) return leer;
  try {
    return abbilden(
      await imDienst(akteur, DEMO_PORTS, (ctx) => ladePortalFreigaben(ctx, { mandantId })),
    );
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return leer;
    throw e;
  }
}

/**
 * Letzte Nachrichten des Entwicklungs-Postausgangs an eine Person (nur Demo mit
 * Demo-Login). Adressiert über die ID (TS-06); ältere Demo-Zeilen tragen noch
 * Name bzw. Adresse.
 */
export async function ladePostausgang(
  nutzer: { id: string; name: string; email: string },
  anzahl = 3,
) {
  return db.nachricht.findMany({
    where: {
      an: {
        in: [
          ...NACHRICHT_ZWECKE.map((z) => nachrichtAdresse(z, nutzer.id)),
          `${nutzer.name} <${nutzer.email}>`,
          nutzer.name,
        ],
      },
    },
    orderBy: { createdAt: 'desc' },
    take: anzahl,
  });
}
