import 'server-only';
import { leseDatei, prisma, speichereDatei, type GespeicherteDatei, type Tx } from '@tcms/db';
import {
  EREIGNISTYPEN,
  ereignistyp,
  FOLGE_LABEL,
  PORTAL_SONSTIGES,
  statusAm,
  type AnzeigeStatus,
  type EreignisStatus,
  type FolgeArt,
} from '@tcms/domain';
import { naechsteEreignisnummer } from './nummern';
import { tagesende } from './zeit';

// =============================================================================
// Detaildaten für S11 (Ereigniseingang) und P3 (Portal-Meldung): verknüpfte
// Objekte der Folgen, Begründungen und Anlagen aus dem Audit-Log, Nummernkreis
// der Ereignisse und das gemeinsame Anlegen eines Ereignisses.
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

/** Ereignis melden im Portal: gesetzliche Vertreter und Tax-Compliance-Beauftragte (Fachkonzept §13). */
export function darfPortalMelden(n: {
  art: 'KANZLEI' | 'MANDANT';
  mandantRolle: string | null;
}): boolean {
  return (
    n.art === 'MANDANT' &&
    (n.mandantRolle === 'GESETZLICHER_VERTRETER' ||
      n.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER')
  );
}

// ----------------------------------------------------------------------------
// Anlegen
// ----------------------------------------------------------------------------

export { naechsteEreignisnummer };

/** Legt ein Ereignis mit den Katalogfolgen als Vorschläge an (Triage folgt in S11). */
export async function legeEreignisAn(
  tx: Tx,
  a: {
    programmId: string;
    typ: string;
    titel: string;
    beschreibung: string;
    quelle: 'PORTAL' | 'KONTROLLE' | 'STAMMDATEN' | 'RSS' | 'MANUELL';
    gemeldetVon: string;
    ereignisDatum: Date;
    zeitpunkt: Date;
  },
): Promise<{ id: string; nummer: string; folgen: number }> {
  const nummer = await naechsteEreignisnummer(tx, a.zeitpunkt.getUTCFullYear());
  const kat = ereignistyp(a.typ);
  const folgen: { art: FolgeArt; ziel: string | null; text: string }[] = kat
    ? kat.folgen.map((f) => ({ art: f.art, ziel: f.ziel ?? null, text: f.text }))
    : [{ art: 'HINWEIS', ziel: null, text: 'Meldung sichten und Folgen festlegen' }];
  const e = await tx.ereignis.create({
    data: {
      programmId: a.programmId,
      nummer,
      typ: a.typ,
      titel: a.titel,
      beschreibung: a.beschreibung,
      quelle: a.quelle,
      gemeldetVon: a.gemeldetVon,
      gemeldetAm: a.zeitpunkt,
      ereignisDatum: a.ereignisDatum,
      status: 'NEU',
      folgen: { create: folgen },
    },
  });
  return { id: e.id, nummer, folgen: folgen.length };
}

// ----------------------------------------------------------------------------
// Detail
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
  meldung: { aktion: string; at: Date; hash: string; actorName: string } | null;
  verwerfenAntrag: { vonId: string | null; von: string; am: Date; begruendung: string } | null;
  verwerfen: { begruendung: string; von: string; am: Date } | null;
  verlauf: { id: number; at: Date; actorName: string; text: string }[];
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function verlaufText(aktion: string, d: Record<string, unknown>): string {
  switch (aktion) {
    case 'tcms.ereignis.gemeldet':
      return d['quelle'] === 'PORTAL' || !d['quelle']
        ? 'Ereignis gemeldet'
        : `Ereignis erfasst (${s(d['quelle']).toLowerCase()})`;
    case 'tcms.ereignis.erfasst':
      return 'Ereignis manuell erfasst';
    case 'tcms.ereignis.in_triage':
      return 'in Prüfung genommen';
    case 'tcms.ereignis.folge_angelegt':
      return `Folge angelegt: ${s(d['label'])}${d['ziel'] ? ` ${s(d['ziel'])}` : ''}`;
    case 'tcms.ereignis.folge_hinzugefuegt':
      return `Folge vorgeschlagen: ${s(d['label'])}`;
    case 'tcms.ereignis.folge_erledigt':
      return `Folge erledigt: ${s(d['label'])}`;
    case 'tcms.ereignis.folge_verworfen':
      return `Folge verworfen: ${s(d['label'])}`;
    case 'tcms.ereignis.verwerfen_beantragt':
      return 'Verwerfen des Ereignisses beantragt';
    case 'tcms.ereignis.verwerfen_bestaetigt':
      return 'Ereignis verworfen (zweite Person)';
    case 'tcms.ereignis.verwerfen_abgelehnt':
      return 'Antrag auf Verwerfen abgelehnt';
    case 'tcms.ereignis.abgeschlossen':
      return 'Ereignis abgeschlossen – alle Folgen erledigt oder verworfen';
    default:
      return aktion;
  }
}

export async function ladeEreignisDetail(
  programmId: string,
  ereignisId: string,
  stand: Date,
): Promise<EreignisDetail | null> {
  const ende = tagesende(stand);
  const e = await prisma.ereignis.findFirst({
    where: { id: ereignisId, programmId },
    include: { folgen: true },
  });
  if (!e) return null;
  const folgenIds = e.folgen.map((f) => f.id);
  const audits = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { objektTyp: 'Ereignis', objektId: e.id },
        { objektTyp: 'EreignisFolge', objektId: { in: folgenIds } },
      ],
    },
    orderBy: { seq: 'asc' },
  });
  const det = (a: (typeof audits)[number]) => (a.detail ?? {}) as Record<string, unknown>;

  const dIds = e.folgen
    .filter((f) => f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && f.objektId)
    .map((f) => f.objektId!);
  const fIds = e.folgen
    .filter((f) => f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId)
    .map((f) => f.objektId!);
  const [durchf, festst] = await Promise.all([
    dIds.length
      ? prisma.durchfuehrung.findMany({
          where: { id: { in: dIds } },
          include: { kontrolle: { select: { code: true } } },
        })
      : [],
    fIds.length
      ? prisma.feststellung.findMany({
          where: { id: { in: fIds } },
          select: { id: true, nummer: true },
        })
      : [],
  ]);
  const dJe = new Map(durchf.map((d) => [d.id, d]));
  const fJe = new Map(festst.map((f) => [f.id, f]));

  const bisEnde = (a: { at: Date }) => a.at.getTime() <= ende.getTime();
  const folgen: FolgeDetail[] = e.folgen
    .filter((f) => {
      // Später hinzugefügte Folgen gehören nicht zum Stand.
      const neu = audits.find(
        (a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_hinzugefuegt',
      );
      return !neu || bisEnde(neu);
    })
    .map((f) => {
      const verwRoh = audits
        .filter((a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_verworfen')
        .at(-1);
      const angelegtRoh = audits
        .filter((a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_angelegt')
        .at(-1);
      const verw = verwRoh && bisEnde(verwRoh) ? verwRoh : undefined;
      const angelegt = angelegtRoh && bisEnde(angelegtRoh) ? angelegtRoh : undefined;
      // Status zum Stichtag aus den protokollierten Schritten zurückrechnen.
      let status = f.status;
      if (status === 'VERWORFEN' && verwRoh && !verw)
        status = (det(verwRoh)['vorher'] as typeof status) ?? 'VORGESCHLAGEN';
      if (status === 'ERLEDIGT' && f.erledigtAm && f.erledigtAm.getTime() > ende.getTime())
        status = 'ANGELEGT';
      if (status === 'ANGELEGT' && angelegtRoh && !angelegt) status = 'VORGESCHLAGEN';
      if (status === 'ERLEDIGT' && angelegtRoh && !angelegt) status = 'VORGESCHLAGEN';
      const sichtbarObjekt = status !== 'VORGESCHLAGEN';
      const d = sichtbarObjekt && f.objektId ? dJe.get(f.objektId) : undefined;
      return {
        id: f.id,
        art: f.art,
        artLabel: FOLGE_LABEL[f.art],
        ziel: f.ziel,
        text: f.text,
        zustaendig: f.zustaendig,
        frist: f.frist,
        status,
        erledigtAm: status === 'ERLEDIGT' ? f.erledigtAm : null,
        objektId: sichtbarObjekt ? f.objektId : null,
        durchfuehrung: d
          ? {
              id: d.id,
              code: d.kontrolle.code,
              periodeLabel: d.periodeLabel,
              faelligAm: d.faelligAm,
              anzeige: statusAm(
                {
                  status: d.status,
                  periodeBis: d.periodeBis,
                  faelligAm: d.faelligAm,
                  begonnenAm: d.begonnenAm,
                  eingereichtAm: d.eingereichtAm,
                  abgeschlossenAm: d.abgeschlossenAm,
                  entfallenAm: d.entfallenAm,
                },
                stand,
              ),
            }
          : null,
        feststellung: sichtbarObjekt && f.objektId ? (fJe.get(f.objektId) ?? null) : null,
        verwerfen: verw
          ? { begruendung: s(det(verw)['begruendung']), von: verw.actorName, am: verw.at }
          : null,
        angelegt: angelegt ? { von: angelegt.actorName, am: angelegt.at } : null,
      };
    })
    .sort((a, b) => ORDNUNG[a.status] - ORDNUNG[b.status]);

  const meldungRoh = audits.find(
    (a) =>
      a.objektTyp === 'Ereignis' &&
      (a.aktion === 'tcms.ereignis.gemeldet' || a.aktion === 'tcms.ereignis.erfasst'),
  );
  const anlagenRoh = meldungRoh ? det(meldungRoh)['anlagen'] : null;
  const anlagen: Anlage[] = Array.isArray(anlagenRoh)
    ? (anlagenRoh as Record<string, unknown>[]).map((x) => ({
        dateiname: s(x['dateiname']),
        mime: s(x['mime']),
        groesse: Number(x['groesse']) || 0,
        sha256: s(x['sha256']),
      }))
    : [];

  const antrag = audits
    .filter((a) => a.objektTyp === 'Ereignis' && a.aktion === 'tcms.ereignis.verwerfen_beantragt')
    .at(-1);
  const bestaetigt = audits
    .filter((a) => a.objektTyp === 'Ereignis' && a.aktion === 'tcms.ereignis.verwerfen_bestaetigt')
    .at(-1);

  return {
    id: e.id,
    folgen,
    anlagen,
    meldung: meldungRoh
      ? {
          aktion: meldungRoh.aktion,
          at: meldungRoh.at,
          hash: meldungRoh.hash,
          actorName: meldungRoh.actorName,
        }
      : null,
    verwerfenAntrag:
      e.verwerfenBegruendung && e.status !== 'VERWORFEN'
        ? {
            vonId: antrag?.actorId ?? null,
            von: antrag?.actorName ?? '—',
            am: antrag?.at ?? e.gemeldetAm,
            begruendung: e.verwerfenBegruendung,
          }
        : null,
    verwerfen:
      e.status === 'VERWORFEN' && e.verwerfenBegruendung
        ? {
            begruendung: e.verwerfenBegruendung,
            von: bestaetigt?.actorName ?? '—',
            am: bestaetigt?.at ?? e.gemeldetAm,
          }
        : null,
    verlauf: audits
      .filter((a) => a.at.getTime() <= ende.getTime())
      .map((a) => ({
        id: a.seq,
        at: a.at,
        actorName: a.actorName,
        text: verlaufText(a.aktion, det(a)),
      }))
      .reverse(),
  };
}

const ORDNUNG: Record<FolgeDetail['status'], number> = {
  VORGESCHLAGEN: 0,
  ANGELEGT: 1,
  ERLEDIGT: 2,
  VERWORFEN: 3,
};

/** Anlagen eines Ereignisses (für den Download): nur aus dem Meldungs-Audit. */
export async function ladeAnlage(
  ereignisId: string,
  sha256: string,
): Promise<{ anlage: Anlage; speicherpfad: string; programmId: string | null } | null> {
  const meldung = await prisma.auditEvent.findFirst({
    where: {
      objektTyp: 'Ereignis',
      objektId: ereignisId,
      aktion: { in: ['tcms.ereignis.gemeldet', 'tcms.ereignis.erfasst'] },
    },
    orderBy: { seq: 'asc' },
  });
  if (!meldung) return null;
  const liste = ((meldung.detail ?? {}) as Record<string, unknown>)['anlagen'];
  if (!Array.isArray(liste)) return null;
  const x = (liste as Record<string, unknown>[]).find((a) => a['sha256'] === sha256);
  if (!x) return null;
  return {
    anlage: {
      dateiname: s(x['dateiname']),
      mime: s(x['mime']),
      groesse: Number(x['groesse']) || 0,
      sha256: s(x['sha256']),
    },
    speicherpfad: s(x['speicherpfad']),
    programmId: meldung.programmId,
  };
}

// ----------------------------------------------------------------------------
// Ablage der Anlagen (gemeinsame Ablage aus @tcms/db)
// ----------------------------------------------------------------------------

export function legeAnlageAb(inhalt: Buffer): Promise<GespeicherteDatei> {
  return speichereDatei(inhalt);
}

export function leseAnlage(speicherpfad: string): Promise<Buffer> {
  return leseDatei(speicherpfad);
}
