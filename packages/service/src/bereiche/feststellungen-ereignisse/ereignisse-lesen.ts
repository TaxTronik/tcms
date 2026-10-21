// =============================================================================
// Ereigniseingang (S11): Lader für Liste und Detail zu einem Stichtag sowie
// die Auflösung einer Anlage für den Download (bisher
// apps/web/src/server/ereignisse-daten.ts).
//
// Anlagen (ADR 0001 §6, TS-09): Das Tax-CMS kennt nur den Verweis
// `{ dokumentId, dateiname, mime, groesse, sha256 }` aus dem Audit-Eintrag der
// Meldung. Detail und Liste geben die `dokumentId` nicht heraus; nur
// `ladeEreignisAnlage` löst sie nach Rechteprüfung für den Download auf, und
// der Aufrufer prüft den SHA-256 des Inhalts gegen den Verweis. Umgekehrt
// beantwortet `ladeEreignisAnlagenJeDokument` für eine Dokument-ID der
// kanzleikonsole, welche Ereignisse dieses Mandanten sie referenzieren
// (Abgleich „ungeklärter Anlagen“, tcms-s11).
// =============================================================================

import {
  DienstFehler,
  EreignisAnlageLesenSchema,
  EreignisAnlagenJeDokumentEingabeSchema,
  EreignisLesenSchema,
  EreignisseLesenSchema,
  type Anlage,
  type AnlageVerweis,
  type EreignisAnlageLesen,
  type EreignisAnlagenJeDokument,
  type EreignisAnlagenJeDokumentEingabe,
  type EreignisDetail,
  type EreignisLesen,
  type EreignisListe,
  type EreignisListenEintrag,
  type EreignisseLesen,
  type FolgeDetail,
  type VerlaufEintrag,
} from '@tcms/contract';
import { statusAm } from '@tcms/domain';
import { auditGrenze, heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { ereignisRecht, type EreignisSchritt } from './ereignisse';
import {
  isoTag,
  isoTagOderNull,
  isoZeit,
  isoZeitOderNull,
  namenListe,
  programmVon,
  pruefe,
  pruefeKanzleiZugriff,
  pruefeMandant,
  text,
} from './gemeinsam';

const AKTION_GEMELDET = 'tcms.ereignis.gemeldet';
const AKTION_ERFASST = 'tcms.ereignis.erfasst';
/** Audit-Aktionen, deren Detail die Anlagen einer Meldung trägt (einzige Quelle der Anlagen). */
const MELDUNG_AKTIONEN = [AKTION_GEMELDET, AKTION_ERFASST];

function stichtag(ctx: DienstKontext, stand: string | undefined) {
  const heute = heuteDatum(ctx.uhr);
  const s = leseStand(stand, heute);
  return { ...s, heute, ende: tagesende(s.stand) };
}

type EreignisRoh = {
  id: string;
  nummer: string;
  typ: string;
  titel: string;
  beschreibung: string;
  quelle: EreignisListenEintrag['quelle'];
  gemeldetVon: string | null;
  gemeldetAm: Date;
  ereignisDatum: Date;
  status: EreignisListenEintrag['status'];
  verwerfenBegruendung: string | null;
  triagiertVon: string | null;
  triagiertAm: Date | null;
};

function grunddaten(e: EreignisRoh, ende: Date): Omit<EreignisListenEintrag, 'folgen'> {
  return {
    id: e.id,
    nummer: e.nummer,
    typ: e.typ,
    titel: e.titel,
    beschreibung: e.beschreibung,
    quelle: e.quelle,
    gemeldetVon: e.gemeldetVon,
    gemeldetAm: isoZeit(e.gemeldetAm),
    ereignisDatum: isoTag(e.ereignisDatum),
    // Status zum Stichtag wie im Tax-CMS-Kontext: erst triagiert nach dem Stand → neu.
    status: e.triagiertAm && e.triagiertAm.getTime() > ende.getTime() ? 'NEU' : e.status,
    verwerfenBeantragt: !!e.verwerfenBegruendung && e.status !== 'VERWORFEN',
    triagiertVon: e.triagiertVon,
    triagiertAm: isoZeitOderNull(e.triagiertAm),
  };
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export async function ladeEreignisse(
  ctx: DienstKontext,
  eingabe: EreignisseLesen,
): Promise<EreignisListe> {
  const x = pruefe(EreignisseLesenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  await pruefeMandant(ctx.tx, mandantId);
  const { stand, historisch, ende } = stichtag(ctx, x.stand);
  const kopf = { stand: isoTag(stand), historisch };
  const programm = await programmVon(ctx.tx, mandantId);
  if (!programm) return { ...kopf, programmId: null, ereignisse: [], namen: [] };
  const roh = await ctx.tx.ereignis.findMany({
    where: { programmId: programm.id },
    include: { folgen: { orderBy: { id: 'asc' } } },
    orderBy: [{ gemeldetAm: 'desc' }, { id: 'desc' }],
  });
  const ereignisse = roh
    .filter((e) => e.gemeldetAm.getTime() <= ende.getTime())
    .map((e) => ({
      ...grunddaten(e, ende),
      folgen: e.folgen.map((f) => ({
        id: f.id,
        art: f.art,
        ziel: f.ziel,
        status: f.status,
        objektId: f.objektId,
      })),
    }));
  return {
    ...kopf,
    programmId: programm.id,
    ereignisse,
    namen: await namenListe(
      ctx,
      ereignisse.flatMap((e) => [e.gemeldetVon, e.triagiertVon]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function verlaufText(aktion: string, d: Record<string, unknown>): string {
  switch (aktion) {
    case 'tcms.ereignis.gemeldet':
      return d['quelle'] === 'PORTAL' || !d['quelle']
        ? 'Ereignis gemeldet'
        : `Ereignis erfasst (${text(d['quelle']).toLowerCase()})`;
    case 'tcms.ereignis.erfasst':
      return 'Ereignis manuell erfasst';
    case 'tcms.ereignis.in_triage':
      return 'in Prüfung genommen';
    case 'tcms.ereignis.folge_angelegt':
      return `Folge angelegt: ${text(d['label'])}${d['ziel'] ? ` ${text(d['ziel'])}` : ''}`;
    case 'tcms.ereignis.folge_hinzugefuegt':
      return `Folge vorgeschlagen: ${text(d['label'])}`;
    case 'tcms.ereignis.folge_erledigt':
      return `Folge erledigt: ${text(d['label'])}`;
    case 'tcms.ereignis.folge_verworfen':
      return `Folge verworfen: ${text(d['label'])}`;
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

const ORDNUNG: Record<FolgeDetail['status'], number> = {
  VORGESCHLAGEN: 0,
  ANGELEGT: 1,
  ERLEDIGT: 2,
  VERWORFEN: 3,
};

/** Anlagen aus dem Detail des Meldungs-Audits (nur bekannte Felder, streng). */
function anlagenAus(detail: Record<string, unknown>): AnlageVerweis[] {
  const liste = detail['anlagen'];
  if (!Array.isArray(liste)) return [];
  return liste.flatMap((roh): AnlageVerweis[] => {
    if (typeof roh !== 'object' || roh === null) return [];
    const x = roh as Record<string, unknown>;
    const v = {
      dokumentId: text(x['dokumentId']),
      dateiname: text(x['dateiname']),
      mime: text(x['mime']),
      groesse: typeof x['groesse'] === 'number' ? x['groesse'] : 0,
      sha256: text(x['sha256']),
    };
    return /^[0-9a-f]{64}$/.test(v.sha256) && v.dokumentId ? [v] : [];
  });
}

/**
 * Detail eines Ereignisses zum Stichtag: Folgen mit verknüpften Objekten,
 * Anlagen (ohne Dokument-ID), Meldungs-Audit, Verwerfen-Antrag, Verlauf.
 */
export async function ladeEreignis(
  ctx: DienstKontext,
  eingabe: EreignisLesen,
): Promise<EreignisDetail> {
  const x = pruefe(EreignisLesenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const { stand, historisch, heute, ende } = stichtag(ctx, x.stand);
  const tx = ctx.tx;
  const e = await tx.ereignis.findFirst({
    where: { id: x.ereignisId, programm: { mandantId } },
    include: { folgen: { orderBy: { id: 'asc' } } },
  });
  if (!e || e.gemeldetAm.getTime() > ende.getTime()) throw new DienstFehler('NICHT_GEFUNDEN');

  const folgenIds = e.folgen.map((f) => f.id);
  const audits = await tx.auditEvent.findMany({
    where: {
      OR: [
        { objektTyp: 'Ereignis', objektId: e.id },
        { objektTyp: 'EreignisFolge', objektId: { in: folgenIds } },
      ],
      programmId: e.programmId,
    },
    orderBy: { pos: 'asc' },
    select: {
      pos: true,
      at: true,
      actorId: true,
      aktion: true,
      objektTyp: true,
      objektId: true,
      detail: true,
      hash: true,
    },
  });
  const det = (a: (typeof audits)[number]) => (a.detail ?? {}) as Record<string, unknown>;

  const dIds = e.folgen
    .filter((f) => f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && f.objektId)
    .map((f) => f.objektId!);
  const fIds = e.folgen
    .filter((f) => f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId)
    .map((f) => f.objektId!);
  const durchf = dIds.length
    ? await tx.durchfuehrung.findMany({
        where: { id: { in: dIds }, kontrolle: { programmId: e.programmId } },
        include: { kontrolle: { select: { code: true } } },
        orderBy: { id: 'asc' },
      })
    : [];
  const festst = fIds.length
    ? await tx.feststellung.findMany({
        where: { id: { in: fIds }, programmId: e.programmId },
        select: { id: true, nummer: true },
        orderBy: { id: 'asc' },
      })
    : [];
  const dJe = new Map(durchf.map((d) => [d.id, d]));
  const fJe = new Map(festst.map((f) => [f.id, f]));

  // Audit-Zeitstempel sind echte Zeit (auditGrenze, kern/zeit.ts).
  const auditEnde = auditGrenze(stand, heute);
  const bisEnde = (a: { at: Date }) => a.at.getTime() <= auditEnde.getTime();
  const folgen: FolgeDetail[] = e.folgen
    .filter((f) => {
      // Später hinzugefügte Folgen gehören nicht zum Stand.
      const neu = audits.find(
        (a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_hinzugefuegt',
      );
      return !neu || bisEnde(neu);
    })
    .map((f): FolgeDetail => {
      const verwRoh = audits
        .filter((a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_verworfen')
        .at(-1);
      const angelegtRoh = audits
        .filter((a) => a.objektId === f.id && a.aktion === 'tcms.ereignis.folge_angelegt')
        .at(-1);
      const verw = verwRoh && bisEnde(verwRoh) ? verwRoh : undefined;
      const angelegt = angelegtRoh && bisEnde(angelegtRoh) ? angelegtRoh : undefined;
      // Status zum Stichtag aus den protokollierten Schritten zurückrechnen.
      let status: FolgeDetail['status'] = f.status;
      if (status === 'VERWORFEN' && verwRoh && !verw) {
        const vorher = det(verwRoh)['vorher'];
        status = vorher === 'ANGELEGT' ? 'ANGELEGT' : 'VORGESCHLAGEN';
      }
      if (status === 'ERLEDIGT' && f.erledigtAm && f.erledigtAm.getTime() > ende.getTime())
        status = 'ANGELEGT';
      if (status === 'ANGELEGT' && angelegtRoh && !angelegt) status = 'VORGESCHLAGEN';
      if (status === 'ERLEDIGT' && angelegtRoh && !angelegt) status = 'VORGESCHLAGEN';
      const sichtbarObjekt = status !== 'VORGESCHLAGEN';
      const d = sichtbarObjekt && f.objektId ? dJe.get(f.objektId) : undefined;
      return {
        id: f.id,
        art: f.art,
        ziel: f.ziel,
        text: f.text,
        zustaendig: f.zustaendig,
        frist: isoTagOderNull(f.frist),
        status,
        erledigtAm: status === 'ERLEDIGT' ? isoZeitOderNull(f.erledigtAm) : null,
        objektId: sichtbarObjekt ? f.objektId : null,
        durchfuehrung: d
          ? {
              id: d.id,
              code: d.kontrolle.code,
              periodeLabel: d.periodeLabel,
              faelligAm: isoTag(d.faelligAm),
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
          ? {
              begruendung: text(det(verw)['begruendung']),
              vonId: verw.actorId,
              am: isoZeit(verw.at),
            }
          : null,
        angelegt: angelegt ? { vonId: angelegt.actorId, am: isoZeit(angelegt.at) } : null,
      };
    })
    .sort((a, b) => ORDNUNG[a.status] - ORDNUNG[b.status]);

  const meldungRoh = audits.find(
    (a) => a.objektTyp === 'Ereignis' && MELDUNG_AKTIONEN.includes(a.aktion),
  );
  const anlagen: Anlage[] = meldungRoh
    ? anlagenAus(det(meldungRoh)).map(({ dokumentId: _d, ...a }) => a)
    : [];
  const antrag = audits
    .filter((a) => a.objektTyp === 'Ereignis' && a.aktion === 'tcms.ereignis.verwerfen_beantragt')
    .at(-1);
  const bestaetigt = audits
    .filter((a) => a.objektTyp === 'Ereignis' && a.aktion === 'tcms.ereignis.verwerfen_bestaetigt')
    .at(-1);
  const verlauf: VerlaufEintrag[] = audits
    .filter(bisEnde)
    .map((a) => ({
      pos: a.pos,
      at: isoZeit(a.at),
      actorId: a.actorId,
      text: verlaufText(a.aktion, det(a)),
    }))
    .reverse();
  const basis = grunddaten(e, ende);
  const verwerfenAntrag =
    e.verwerfenBegruendung && e.status !== 'VERWORFEN'
      ? {
          vonId: e.verwerfenBeantragtVon,
          am: isoZeit(antrag?.at ?? e.gemeldetAm),
          begruendung: e.verwerfenBegruendung,
        }
      : null;
  const verwerfen =
    e.status === 'VERWORFEN' && e.verwerfenBegruendung
      ? {
          vonId: bestaetigt?.actorId ?? null,
          am: isoZeit(bestaetigt?.at ?? e.gemeldetAm),
          begruendung: e.verwerfenBegruendung,
        }
      : null;
  // Rechte-Kennzeichen auf dem aktuellen Stand der Zeile, mit derselben
  // Vorbedingung wie die Operationen (`hindernisEreignis`); im historischen
  // Stand schreibgeschützt (Regel 6: weder erlaubt noch ein 403-Grund).
  const recht = (schritt: EreignisSchritt) =>
    historisch
      ? { erlaubt: false, verweigerung: null }
      : ereignisRecht(schritt, ctx.akteur, mandantId, e);
  return {
    ...basis,
    stand: isoTag(stand),
    historisch,
    rechte: {
      abschliessen: recht('abschliessen'),
      verwerfen: {
        beantragen: recht('verwerfenBeantragen'),
        bestaetigen: recht('verwerfenBestaetigen'),
      },
    },
    folgen,
    anlagen,
    meldung: meldungRoh
      ? { aktion: meldungRoh.aktion, at: isoZeit(meldungRoh.at), hash: meldungRoh.hash }
      : null,
    verwerfenAntrag,
    verwerfen,
    verlauf,
    namen: await namenListe(ctx, [
      basis.gemeldetVon,
      basis.triagiertVon,
      verwerfenAntrag?.vonId,
      verwerfen?.vonId,
      ...folgen.flatMap((f) => [f.zustaendig, f.verwerfen?.vonId, f.angelegt?.vonId]),
      ...verlauf.map((v) => v.actorId),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Anlage für den Download auflösen (TS-09)
// ---------------------------------------------------------------------------

/**
 * Liefert den Verweis einer Anlage zur Meldung eines Ereignisses dieses
 * Mandanten – nur aus dem Meldungs-Audit (keine frei wählbaren Dokument-IDs).
 * Der Aufrufer (kanzleikonsole bzw. Demo) liefert die Datei aus und prüft
 * dabei den SHA-256 des Inhalts gegen `sha256`.
 */
export async function ladeEreignisAnlage(
  ctx: DienstKontext,
  eingabe: EreignisAnlageLesen,
): Promise<AnlageVerweis> {
  const x = pruefe(EreignisAnlageLesenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  const e = await ctx.tx.ereignis.findFirst({
    where: { id: x.ereignisId, programm: { mandantId } },
    select: { id: true, programmId: true },
  });
  if (!e) throw new DienstFehler('NICHT_GEFUNDEN');
  const meldung = await ctx.tx.auditEvent.findFirst({
    where: {
      objektTyp: 'Ereignis',
      objektId: e.id,
      programmId: e.programmId,
      aktion: { in: MELDUNG_AKTIONEN },
    },
    orderBy: { pos: 'asc' },
    select: { detail: true },
  });
  const anlage = meldung
    ? anlagenAus((meldung.detail ?? {}) as Record<string, unknown>).find(
        (a) => a.sha256 === x.sha256,
      )
    : undefined;
  if (!anlage) throw new DienstFehler('NICHT_GEFUNDEN');
  return anlage;
}

// ---------------------------------------------------------------------------
// Ereignis-Anlagen je Dokument (Abgleich der kanzleikonsole, tcms-s11)
// ---------------------------------------------------------------------------

/**
 * Ereignisse dieses Mandanten, deren Meldung die Dokument-ID als Anlage nennt
 * (Gegenstück zu `ladeNachweiseJeDokument`, ADR 0001 §6). Die kanzleikonsole
 * gibt eine „ungeklärte Anlage“ (Portal-Meldung mit unklarem Ausgang) nur
 * frei, wenn die Liste leer ist.
 *
 * - Nur Kanzleipersonen mit Leserecht (`pruefeKanzleiZugriff`); Kontakte,
 *   fremde und unbekannte Mandanten → NICHT_GEFUNDEN.
 * - Die Zugehörigkeit prüft die Abfrage selbst (Meldungs-Audit → Ereignis
 *   desselben Programms → Programm des Mandanten; RLS trennt nur Tenants):
 *   Eine Dokument-ID eines anderen Mandanten ergibt dieselbe leere Liste wie
 *   eine unbekannte (kein Orakel).
 * - Vergleich ohne Groß-/Kleinschreibung: Die Meldung speichert die ID so, wie
 *   die kanzleikonsole sie schickte; eine anders geschriebene UUID ist dasselbe
 *   Dokument. Ein falsches „nicht referenziert“ gäbe ein gebundenes Dokument
 *   frei, ein zu weiter Treffer hält es nur fest (fail closed).
 * - Was eine Anlage ist, entscheidet dieselbe Regel wie Detail und Download
 *   (`anlagenAus`); die SQL-Bedingung grenzt nur vor (Obermenge).
 * - Ausgabe (RT-01): ID, Nummer und Status des Ereignisses, SHA-256 der Anlage,
 *   `entfernt`. Ereignisse sind nicht vertraulich (ADR 0001 §10.2); dieselben
 *   Angaben sieht jede Kanzleiperson mit Leserecht in Liste und Detail, die
 *   Dokument-ID jeder Anlage über `ladeEreignisAnlage`. Feststellungen aus dem
 *   Ereignis gehen nicht ein – auch keine Nummer.
 */
export async function ladeEreignisAnlagenJeDokument(
  ctx: DienstKontext,
  eingabe: EreignisAnlagenJeDokumentEingabe,
): Promise<EreignisAnlagenJeDokument> {
  const x = pruefe(EreignisAnlagenJeDokumentEingabeSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  // Kanonisch klein (Vertrag); der Vergleich unten verlangt das.
  const dokumentId = x.dokumentId.toLowerCase();
  pruefeKanzleiZugriff(ctx, mandantId);
  await pruefeMandant(ctx.tx, mandantId);
  const zeilen = await ctx.tx.$queryRaw<
    {
      ereignisId: string;
      nummer: string;
      status: EreignisListenEintrag['status'];
      detail: unknown;
    }[]
  >`
    SELECT e.id AS "ereignisId", e.nummer, e.status::text AS status, a.detail
    FROM "AuditEvent" a
    JOIN "Ereignis" e
      ON e.tenant_id = a.tenant_id AND e.id = a."objektId" AND e."programmId" = a."programmId"
    JOIN "TcmsProgramm" p ON p.tenant_id = e.tenant_id AND p.id = e."programmId"
    WHERE p."mandantId" = ${mandantId}::uuid
      AND a."objektTyp" = 'Ereignis'
      AND a.aktion IN (${AKTION_GEMELDET}, ${AKTION_ERFASST})
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.detail -> 'anlagen') = 'array'
            THEN a.detail -> 'anlagen' ELSE '[]'::jsonb END
        ) AS el(anlage)
        WHERE lower(el.anlage ->> 'dokumentId') = ${dokumentId}
      )
    ORDER BY e.nummer, e.id, a.pos`;
  const gesehen = new Set<string>();
  const anlagen: EreignisAnlagenJeDokument['anlagen'] = [];
  for (const z of zeilen) {
    const detail = (z.detail ?? {}) as Record<string, unknown>;
    for (const a of anlagenAus(detail)) {
      if (a.dokumentId.toLowerCase() !== dokumentId) continue;
      const schluessel = `${z.ereignisId}|${a.sha256}`;
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
      anlagen.push({
        ereignisId: z.ereignisId,
        nummer: z.nummer,
        status: z.status,
        sha256: a.sha256,
        entfernt: false,
      });
    }
  }
  return { dokumentId, anlagen };
}
