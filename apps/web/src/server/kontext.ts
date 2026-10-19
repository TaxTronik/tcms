import 'server-only';
import { cache } from 'react';
import { DienstFehler } from '@tcms/contract';
import { KLASSE_RANG, strengere, type Klasse } from '@tcms/domain';
import {
  imDienst,
  ladeKontext as ladeKernKontext,
  type TcmsKontext as KernKontext,
} from '@tcms/service';
import { DEMO_PORTS, demoPersonen, zustaendigkeit, type DemoPerson } from './demo';
import { demoAkteur } from './sitzung';

// =============================================================================
// Dünne Hülle der Demo um den Tax-CMS-Kontext aus @tcms/service
// (kern/tcms-kontext.ts). Der Service lädt im Dienstkontext der angemeldeten
// Person und prüft selbst die Rechte (TS-03); die Demo ergänzt nur, was im
// Zielbild die kanzleikonsole beisteuert: Personenangaben aus dem
// Demo-Verzeichnis und die Zuständigkeit des Mandanten (Anzeige).
// =============================================================================

export type {
  BeschreibungView,
  DurchfuehrungView,
  EreignisView,
  FeststellungMaskiert,
  FeststellungSicht,
  FeststellungView,
  KennzahlDef,
  KontrolleView,
  LandView,
  RisikoView,
  Schritt,
} from '@tcms/service';

export interface PersonKurz {
  id: string;
  name: string;
  kuerzel: string;
  art: 'KANZLEI' | 'MANDANT';
  funktion: string | null;
  email: string;
  telefon: string | null;
  kanzleiRolle: 'BERUFSTRAEGER' | 'BEARBEITUNG' | null;
  mandantRolle: 'GESETZLICHER_VERTRETER' | 'TAX_COMPLIANCE_BEAUFTRAGTER' | 'MITARBEITER' | null;
}

/** Kontext der Demo: Service-Kontext plus Verzeichnisangaben der kanzleikonsole. */
export interface TcmsKontext extends Omit<KernKontext, 'mandant'> {
  mandant: KernKontext['mandant'] & {
    /** Zuständigkeit aus dem Demo-Verzeichnis (nur Anzeige; Rechte über den Akteur). */
    berufstraegerId: string;
    bearbeitungId: string;
  };
  personen: Map<string, PersonKurz>;
  mandantPersonen: PersonKurz[];
}

/**
 * Anzeigedaten einer Person aus dem Demo-Verzeichnis (im Zielbild löst die
 * kanzleikonsole Namen auf). Die Rolle beim Mandanten kommt aus
 * MandantKontaktRolle, nicht aus dem Verzeichnis.
 */
export function personKurz(
  x: DemoPerson,
  mandantRolle: PersonKurz['mandantRolle'] = null,
): PersonKurz {
  return {
    id: x.id,
    name: x.name,
    kuerzel: x.kuerzel,
    art: x.art,
    funktion: x.funktion,
    email: x.email,
    telefon: x.telefon,
    kanzleiRolle:
      x.art === 'KANZLEI' ? (x.istBerufstraeger ? 'BERUFSTRAEGER' : 'BEARBEITUNG') : null,
    mandantRolle,
  };
}

/** Alle Personen des Verzeichnisses; Mandantenkontakte mit ihrer Rolle laut Verzeichnis. */
export function allePersonen(): Map<string, PersonKurz> {
  return new Map(demoPersonen.alle().map((x) => [x.id, personKurz(x, x.rolle)]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ergänzt den Service-Kontext um Personen und Zuständigkeit aus dem Demo-Verzeichnis. */
function mitVerzeichnis(k: KernKontext): TcmsKontext {
  const personen = allePersonen();
  // Mandantenpersonen: aktive Rollen aus MandantKontaktRolle (erste Rolle je Kontakt),
  // Anzeige aus dem Verzeichnis.
  const mandantPersonen: PersonKurz[] = [];
  for (const r of k.kontaktRollen) {
    const x = demoPersonen.person(r.kontaktId);
    if (x && !mandantPersonen.some((m) => m.id === x.id)) {
      mandantPersonen.push(personKurz(x, r.rolle));
      personen.set(x.id, personKurz(x, r.rolle));
    }
  }
  const zust = zustaendigkeit(k.mandant.id);
  return {
    ...k,
    mandant: {
      ...k.mandant,
      berufstraegerId: zust.berufstraegerId ?? '',
      bearbeitungId: zust.bearbeitungId ?? '',
    },
    personen,
    mandantPersonen,
  };
}

/**
 * Tax-CMS-Kontext eines Mandanten für die angemeldete Person (je Request
 * zwischengespeichert). `historisch` bleibt für bestehende Aufrufer in der
 * Signatur; der Service leitet es selbst aus dem Stand ab (Stand vor heute).
 * Ohne Sitzung, ohne Leserecht oder bei unbekanntem Mandanten: null.
 */
export const ladeKontext = cache(
  async (
    mandantId: string,
    standIso: string,
    _historisch: boolean,
  ): Promise<TcmsKontext | null> => {
    if (!UUID.test(mandantId)) return null;
    const akteur = await demoAkteur(mandantId);
    if (!akteur) return null;
    try {
      const kern = await imDienst(akteur, DEMO_PORTS, (ctx) =>
        ladeKernKontext(ctx, { mandantId, stand: standIso }),
      );
      return mitVerzeichnis(kern);
    } catch (e) {
      if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return null;
      throw e;
    }
  },
);

export function personName(
  ctx: Pick<TcmsKontext, 'personen'>,
  id: string | null | undefined,
): string {
  if (!id) return '—';
  return ctx.personen.get(id)?.name ?? '—';
}

export function personKurzname(
  ctx: Pick<TcmsKontext, 'personen'>,
  id: string | null | undefined,
): string {
  if (!id) return '—';
  const n = ctx.personen.get(id)?.name ?? '—';
  return n.replace(/^StB\s+/, '');
}

export function klasseRang(k: Klasse): number {
  return KLASSE_RANG[k];
}

export { strengere };
