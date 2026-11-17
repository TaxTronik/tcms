import 'server-only';
import { createHash } from 'node:crypto';
import {
  DienstFehler,
  PORTAL_MAX_ANLAGE_BYTES,
  PORTAL_MAX_ANLAGEN,
  type AnlageVerweis,
  type EreignisDetail as DienstDetail,
} from '@tcms/contract';
import {
  darfEreignisMelden,
  imDienst,
  ladeEreignis,
  ladeEreignisAnlage,
  type KontaktRolle,
  type NachweisVerweis,
} from '@tcms/service';
import type { PersonAkteur } from '@tcms/contract';
import {
  EREIGNISTYPEN,
  ereignistyp,
  FOLGE_LABEL,
  PORTAL_SONSTIGES,
  type AnzeigeStatus,
  type EreignisStatus,
  type FolgeArt,
} from '@tcms/domain';
import { MAX_DATEI_BYTES } from '@/components/durchfuehrung/werte';
import { dateinameBereinigt, mimeBereinigt } from './dateien';
import { DEMO_PORTS, demoAblage } from './demo';
import { demoAkteur } from './sitzung';

// =============================================================================
// Demo-Anbindung S11 (Ereigniseingang) und P3 (Portal-Meldung) an
// @tcms/service: Detail-Lader im Dienstkontext der angemeldeten Person,
// Umrechnung der JSON-Antwort in die Anzeigeform, Anzeigekonstanten und die
// lokale Ablage der Demo für Anlagen (im Zielbild: kanzleikonsole).
// =============================================================================

export const FOLGE_STATUS_LABEL: Record<
  'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN',
  string
> = {
  VORGESCHLAGEN: 'vorgeschlagen',
  ANGELEGT: 'angelegt',
  ERLEDIGT: 'erledigt',
  VERWORFEN: 'verworfen',
};

export const FOLGE_STATUS_BADGE: Record<
  'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN',
  string
> = {
  VORGESCHLAGEN: 'badge-gray',
  ANGELEGT: 'badge-brand',
  ERLEDIGT: 'badge-green',
  VERWORFEN: 'badge-gray',
};

/** Portal-Sprache (Sie-Form, ohne interne Begriffe). */
export const PORTAL_STATUS_LABEL: Record<EreignisStatus, string> = {
  NEU: 'eingegangen',
  IN_TRIAGE: 'in Prüfung bei der Kanzlei',
  ERLEDIGT: 'erledigt',
  VERWORFEN: 'geprüft – keine Folgen',
};

export interface TypInfo {
  code: string;
  titel: string;
  icon: string;
  ton: 'brand' | 'violet' | 'amber' | 'red' | 'green';
}

/** Anzeigeinformationen auch für „Sonstiges" (ohne Katalogtyp). */
export function typInfo(code: string): TypInfo {
  const t = ereignistyp(code);
  if (t) return { code: t.code, titel: t.titel, icon: t.icon, ton: t.ton };
  return {
    code: PORTAL_SONSTIGES.code,
    titel: PORTAL_SONSTIGES.titel,
    icon: PORTAL_SONSTIGES.icon,
    ton: PORTAL_SONSTIGES.ton,
  };
}

/** Im Portal meldbare Kacheln in Katalogreihenfolge, zuletzt „Sonstiges". */
export const PORTAL_KACHELN: { code: string; label: string; icon: string; ton: TypInfo['ton'] }[] =
  [
    ...EREIGNISTYPEN.filter((t) => t.portal).map((t) => ({
      code: t.code,
      label: t.portalLabel ?? t.titel,
      icon: t.icon,
      ton: t.ton,
    })),
    {
      code: PORTAL_SONSTIGES.code,
      label: PORTAL_SONSTIGES.titel,
      icon: PORTAL_SONSTIGES.icon,
      ton: PORTAL_SONSTIGES.ton,
    },
  ];

/**
 * Darf die Person melden? Regel aus @tcms/service (GV, TCB); hier nur zur
 * Anzeige und damit die Demo – wie die kanzleikonsole – keine Dateien
 * Unberechtigter annimmt. Die Meldung prüft der Service erneut.
 */
export function darfPortalMelden(a: PersonAkteur, rollen: readonly KontaktRolle[]): boolean {
  return a.art === 'MANDANT' && darfEreignisMelden(a, a.mandantId, rollen);
}

// ----------------------------------------------------------------------------
// Detail (Anzeigeform mit Date und Namen)
// ----------------------------------------------------------------------------

export interface Anlage {
  dateiname: string;
  mime: string;
  groesse: number;
  sha256: string;
}

export interface FolgeDetail {
  id: string;
  art: FolgeArt;
  artLabel: string;
  ziel: string | null;
  text: string;
  zustaendig: string | null;
  frist: Date | null;
  status: 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN';
  erledigtAm: Date | null;
  objektId: string | null;
  durchfuehrung: {
    id: string;
    code: string;
    periodeLabel: string;
    faelligAm: Date;
    anzeige: AnzeigeStatus;
  } | null;
  feststellung: { id: string; nummer: string } | null;
  verwerfen: { begruendung: string; von: string; am: Date } | null;
  angelegt: { von: string; am: Date } | null;
}

export interface EreignisDetail {
  id: string;
  folgen: FolgeDetail[];
  anlagen: Anlage[];
  /** `hash` nur für die Kanzleileitung (sonst null, Dienst). */
  meldung: { aktion: string; at: Date; hash: string | null } | null;
  verwerfenAntrag: {
    vonId: string | null;
    von: string;
    am: Date;
    begruendung: string;
    /** Kennung des Antrags; die Bestätigung nennt sie. */
    antragId: string;
  } | null;
  verwerfen: { begruendung: string; von: string; am: Date } | null;
  verlauf: { id: number; at: Date; actorName: string; text: string }[];
}

const datum = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

/**
 * Detail eines Ereignisses zum Stichtag über den Service-Lader. Ohne Sitzung,
 * ohne Leserecht oder unbekannt: null.
 */
export async function ladeEreignisDetail(
  mandantId: string,
  ereignisId: string,
  standIso: string,
): Promise<EreignisDetail | null> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) return null;
  let d: DienstDetail;
  try {
    d = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      ladeEreignis(ctx, { mandantId, ereignisId, stand: standIso }),
    );
  } catch (e) {
    if (e instanceof DienstFehler && (e.code === 'NICHT_GEFUNDEN' || e.code === 'UNGUELTIG'))
      return null;
    throw e;
  }
  const namen = new Map(d.namen.map((n) => [n.id, n.name]));
  const name = (id: string | null | undefined) => (id && namen.get(id)) || '—';
  return {
    id: d.id,
    folgen: d.folgen.map((f) => ({
      id: f.id,
      art: f.art,
      artLabel: FOLGE_LABEL[f.art],
      ziel: f.ziel,
      text: f.text,
      zustaendig: f.zustaendig,
      frist: f.frist ? datum(f.frist) : null,
      status: f.status,
      erledigtAm: f.erledigtAm ? datum(f.erledigtAm) : null,
      objektId: f.objektId,
      durchfuehrung: f.durchfuehrung
        ? { ...f.durchfuehrung, faelligAm: datum(f.durchfuehrung.faelligAm) }
        : null,
      feststellung: f.feststellung,
      verwerfen: f.verwerfen
        ? {
            begruendung: f.verwerfen.begruendung,
            von: name(f.verwerfen.vonId),
            am: datum(f.verwerfen.am),
          }
        : null,
      angelegt: f.angelegt ? { von: name(f.angelegt.vonId), am: datum(f.angelegt.am) } : null,
    })),
    anlagen: d.anlagen,
    meldung: d.meldung ? { ...d.meldung, at: datum(d.meldung.at) } : null,
    verwerfenAntrag: d.verwerfenAntrag
      ? {
          vonId: d.verwerfenAntrag.vonId,
          von: name(d.verwerfenAntrag.vonId),
          am: datum(d.verwerfenAntrag.am),
          begruendung: d.verwerfenAntrag.begruendung,
          antragId: d.verwerfenAntrag.antragId,
        }
      : null,
    verwerfen: d.verwerfen
      ? {
          begruendung: d.verwerfen.begruendung,
          von: name(d.verwerfen.vonId),
          am: datum(d.verwerfen.am),
        }
      : null,
    verlauf: d.verlauf.map((v) => ({
      id: v.pos,
      at: datum(v.at),
      actorName: name(v.actorId),
      text: v.text,
    })),
  };
}

// ----------------------------------------------------------------------------
// Anlagen (Demo-Ablage; im Zielbild nimmt die kanzleikonsole Dateien an)
// ----------------------------------------------------------------------------

/**
 * Grenzen der Anlagen einer Portal-Meldung: Anzahl und Einzelgröße aus dem
 * Vertrag, die Summe begrenzt das Body-Limit der Server Actions (eine Meldung
 * ist eine Anfrage; next.config.mjs, geprüft in konfiguration.test.ts).
 */
export const ANLAGEN_GRENZEN = {
  anzahl: PORTAL_MAX_ANLAGEN,
  jeDateiBytes: PORTAL_MAX_ANLAGE_BYTES,
  zusammenBytes: MAX_DATEI_BYTES,
} as const;

/** Anlage einer Portal-Meldung: Verweis und Inhalt, vor der Ablage. */
export interface VorbereiteteAnlage {
  verweis: NachweisVerweis;
  inhalt: Buffer;
}

/**
 * Bereitet eine Anlage vor, ohne sie abzulegen: bereinigter Dateiname (eine
 * Regel mit den Nachweisen, `dateinameBereinigt`) und der Verweis, den die
 * inhaltsadressierte Demo-Ablage vergibt (Dokument-ID = Ablagepfad
 * `<2 Hex>/<SHA-256>`). So prüft die Action die Meldung, bevor etwas auf die
 * Platte geschrieben wird; `legeAnlageAb` prüft, dass die Ablage denselben
 * Verweis vergibt.
 */
export function bereiteAnlageVor(
  inhalt: Buffer,
  dateiname: string,
  mime: string,
): VorbereiteteAnlage {
  const sha256 = createHash('sha256').update(inhalt).digest('hex');
  return {
    inhalt,
    verweis: {
      dokumentId: `${sha256.slice(0, 2)}/${sha256}`,
      dateiname: dateinameBereinigt(dateiname, 'Anlage'),
      mime: mimeBereinigt(mime),
      groesse: inhalt.length,
      sha256,
    },
  };
}

/** Demo: legt eine vorbereitete Anlage über den Ablage-Port ab. */
export async function legeAnlageAb(a: VorbereiteteAnlage): Promise<void> {
  const v = await demoAblage.annehmen({
    art: 'DATEI',
    dateiname: a.verweis.dateiname,
    mime: a.verweis.mime,
    inhalt: a.inhalt,
  });
  if (v.dokumentId !== a.verweis.dokumentId || v.sha256 !== a.verweis.sha256)
    throw new Error('[demo] Die Ablage vergibt einen anderen Verweis als vorbereitet.');
}

/**
 * Demo-Download (TS-09): Der Service prüft Rechte und Mandantenzuordnung und
 * liefert den Verweis aus dem Meldungs-Audit; die Ablage prüft beim Lesen den
 * SHA-256 des Inhalts gegen Ablagepfad und Verweis.
 */
export async function ladeAnlageZumDownload(
  akteur: PersonAkteur,
  eingabe: { mandantId: string; ereignisId: string; sha256: string },
): Promise<{ verweis: AnlageVerweis; inhalt: Buffer } | 'NICHT_GEFUNDEN' | 'UNGUELTIG' | 'DEFEKT'> {
  let verweis: AnlageVerweis;
  try {
    verweis = await imDienst(akteur, DEMO_PORTS, (ctx) => ladeEreignisAnlage(ctx, eingabe));
  } catch (e) {
    if (e instanceof DienstFehler && e.code === 'UNGUELTIG') return 'UNGUELTIG';
    if (e instanceof DienstFehler) return 'NICHT_GEFUNDEN';
    throw e;
  }
  try {
    return { verweis, inhalt: await demoAblage.lese(verweis) };
  } catch {
    return 'DEFEKT';
  }
}
