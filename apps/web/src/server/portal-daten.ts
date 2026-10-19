import 'server-only';
import type { PortalUebersichtAntwort } from '@tcms/contract';
import type { AnzeigeStatus } from '@tcms/domain';
import { imDienst, ladePortalUebersicht } from '@tcms/service';
import { DEMO_PORTS, demoPersonen, zustaendigkeit, type MandantAkteur } from './demo';
import type { PersonKurz } from './kontext';
import { personKurz } from './kontext';

// =============================================================================
// Portal P1 der Demo: Übersicht aus @tcms/service (`ladePortalUebersicht`,
// mandantenbezogen ohne Kanzlei-Interna; Rechte und Filter im Service). Die
// Demo ergänzt Namen und das Kanzleiteam aus ihrem Verzeichnis (im Zielbild
// die kanzleikonsole) und wandelt ISO-Strings in Datumswerte.
// =============================================================================

export const PHASE_EINFACH: Record<number, string> = {
  1: 'Wir richten das Compliance-Programm für Ihren Onlinehandel gemeinsam ein.',
  2: 'Ihre Kanzlei analysiert die steuerlichen Risiken Ihres Onlinehandels.',
  3: 'Die Kontrollen werden geplant und die Zuständigkeiten festgelegt.',
  4: 'Die Beschreibung Ihres Compliance-Programms wird erstellt und Ihnen zur Freigabe vorgelegt.',
  5: 'Das Compliance-Programm ist zu einem Stichtag dokumentiert.',
  6: 'Die Kontrollen laufen; jeder Monat wird mit Nachweisen dokumentiert.',
  7: 'Das Programm läuft im Regelbetrieb und wird jährlich überprüft.',
};

export interface PortalAufgabe {
  d: {
    id: string;
    code: string;
    titel: string;
    periodeLabel: string;
    faelligAm: Date;
    anzeige: AnzeigeStatus;
    status: string;
    nachweise: number;
    mindestNachweise: number;
  };
  art: 'DURCHFUEHREN' | 'BESTAETIGEN';
  eigene: boolean;
  zustaendig: string;
  nachweis: string;
  ziel: string;
}

export type MonatsSegment = NonNullable<PortalUebersichtAntwort['programm']>['monate'][number];

export interface PortalStart {
  heute: Date;
  mandant: { id: string; name: string };
  rechte: PortalUebersichtAntwort['rechte'];
  programm: {
    aktivePhase: number;
    wirksamAb: Date | null;
    wirksamBis: Date | null;
    zeitraum: { monat: number; monate: number } | null;
    monate: MonatsSegment[];
  } | null;
  aufgaben: PortalAufgabe[];
  meldungen: {
    id: string;
    nummer: string;
    typ: string;
    titel: string;
    status: string;
    gemeldetAm: Date;
    gemeldetVon: string | null;
  }[];
  team: { person: PersonKurz; rolle: string }[];
}

const name = (id: string | null) => (id ? (demoPersonen.person(id)?.name ?? '—') : '—');
const datumOder = (iso: string | null) => (iso ? new Date(iso) : null);

/** Kanzleiteam des Mandanten (Berufsträger:in und Bearbeitung) aus dem Demo-Verzeichnis. */
export function kanzleiTeam(mandantId: string): { person: PersonKurz; rolle: string }[] {
  const z = zustaendigkeit(mandantId);
  const bt = demoPersonen.person(z.berufstraegerId);
  const hb = demoPersonen.person(z.bearbeitungId);
  const t: { person: PersonKurz; rolle: string }[] = [];
  if (bt)
    t.push({ person: personKurz(bt), rolle: bt.funktion?.split(',')[0] ?? 'Berufsträger:in' });
  if (hb && hb.id !== bt?.id)
    t.push({ person: personKurz(hb), rolle: hb.funktion ?? 'Bearbeitung' });
  return t;
}

/** Portal-Startseite für den angemeldeten Mandantenkontakt (eigener Mandant). */
export async function ladePortalStart(akteur: MandantAkteur): Promise<PortalStart> {
  const u = await imDienst(akteur, DEMO_PORTS, (ctx) =>
    ladePortalUebersicht(ctx, { mandantId: akteur.mandantId }),
  );
  return {
    heute: new Date(`${u.heute}T00:00:00Z`),
    mandant: u.mandant,
    rechte: u.rechte,
    programm: u.programm
      ? {
          ...u.programm,
          wirksamAb: datumOder(u.programm.wirksamAb),
          wirksamBis: datumOder(u.programm.wirksamBis),
        }
      : null,
    aufgaben: u.aufgaben.map((a) => ({
      d: {
        id: a.durchfuehrungId,
        code: a.code,
        titel: a.titel,
        periodeLabel: a.periodeLabel,
        faelligAm: new Date(a.faelligAm),
        anzeige: a.anzeige,
        status: a.status,
        nachweise: a.nachweise,
        mindestNachweise: a.mindestNachweise,
      },
      art: a.art,
      eigene: a.eigene,
      zustaendig: name(a.zustaendigId),
      nachweis: a.nachweis,
      ziel: a.ziel,
    })),
    meldungen: u.meldungen.map((m) => ({ ...m, gemeldetAm: new Date(m.gemeldetAm) })),
    team: kanzleiTeam(u.mandant.id),
  };
}

/** Anzeigename einer Person aus dem Demo-Verzeichnis. */
export const personAnzeige = name;
