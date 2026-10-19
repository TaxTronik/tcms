import 'server-only';
import {
  ABSCHNITTE,
  FESTSTELLUNG_STATUS_LABEL,
  frequenzLabel,
  isoDatum,
  LAND_NAME,
  type Abschnitt,
  type BausteinArt,
} from '@tcms/domain';
import { kanonisch, sha256 } from '@tcms/domain/audit';
import type { BausteinSatz, Snapshot } from '@/components/beschreibung/typen';
import { db } from './demo';
import { personName, type TcmsKontext } from './kontext';

// =============================================================================
// CMS-Beschreibung: lebende Bausteine aus dem Kontext, Snapshot mit SHA-256,
// Status zum Stichtag und Verlauf (Fachkonzept S14, §9, §15).
// =============================================================================

export type BeschreibungStatus =
  | 'ENTWURF'
  | 'KANZLEI_REVIEW'
  | 'BEIM_MANDANTEN'
  | 'FREIGEGEBEN'
  | 'ABGELOEST';

const tag = (d: Date | null | undefined) => (d ? isoDatum(d) : null);

/** Füllt alle lebenden Bausteine aus dem Tax-CMS-Kontext. */
export function baueBausteine(ctx: TcmsKontext): BausteinSatz {
  const name = (id: string | null | undefined) => (id ? personName(ctx, id) : '—');
  const betrieb =
    !!ctx.programm?.wirksamAb && ctx.programm.wirksamAb.getTime() <= ctx.stand.getTime();
  const p1 = ctx.profil?.p1;
  const kanaele = p1
    ? [
        ...(p1.eigenerShop ? [`eigener Shop${p1.shopSystem ? ` (${p1.shopSystem})` : ''}`] : []),
        ...p1.marktplaetze,
      ]
    : [];
  const rang = { KRITISCH: 4, HOCH: 3, MITTEL: 2, GERING: 1 } as const;

  return {
    TEILBEREICH: ctx.teilbereich
      ? {
          name: ctx.teilbereich.name,
          abgrenzung: ctx.teilbereich.abgrenzung,
          einschluesse: [...ctx.teilbereich.einschluesse],
          ausschluesse: [...ctx.teilbereich.ausschluesse],
          zielLaender: [...(ctx.profil?.p3.laender ?? [])],
          kanaele,
        }
      : null,
    ZIELE: {
      appetit: ctx.appetit,
      ziele: ctx.ziele.map((z) => ({
        text: z.text,
        wesentlichkeitEur: z.wesentlichkeitEur,
        risikoappetit: z.risikoappetit,
        freigabe: z.freigabe,
        freigegebenAm: tag(z.freigegebenAm),
        freigegebenVon: z.freigegebenVon ? name(z.freigegebenVon) : null,
      })),
    },
    RISIKOINVENTAR: {
      appetit: ctx.appetit,
      sicht: betrieb ? 'BETRIEB' : 'DESIGN',
      risiken: [...ctx.risiken]
        .sort(
          (a, b) =>
            rang[b.bewertung.brutto.klasse] - rang[a.bewertung.brutto.klasse] ||
            a.code.localeCompare(b.code),
        )
        .map((r) => ({
          code: r.code,
          titel: r.titel,
          gt: r.gt,
          brutto: r.bewertung.brutto.klasse,
          netto: r.netto,
          ueberAppetit: r.ueberAppetit,
          kontrollen: r.kontrollIds.length,
        })),
    },
    KONTROLLMATRIX: {
      kontrollen: ctx.kontrollen.map((k) => ({
        code: k.code,
        titel: k.titel,
        art: k.art,
        frequenz: frequenzLabel(k.frequenz),
        partei: k.partei,
        schluessel: k.schluessel,
        design: k.design,
        designVon: k.designVon ? name(k.designVon) : null,
        designAm: tag(k.designAm),
        risikoCodes: [...k.risikoCodes],
      })),
    },
    VERANTWORTUNG: {
      rollen: [
        ...ctx.mandantPersonen
          .filter((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER')
          .map((p) => ({ rolle: 'Gesetzliche Vertretung', name: p.name })),
        ...ctx.mandantPersonen
          .filter((p) => p.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER')
          .map((p) => ({ rolle: 'Tax-Compliance-Beauftragte:r', name: p.name })),
        { rolle: 'Berufsträger:in (Kanzlei)', name: name(ctx.mandant.berufstraegerId) },
        { rolle: 'Bearbeitung (Kanzlei)', name: name(ctx.mandant.bearbeitungId) },
      ],
      kontrollen: ctx.kontrollen.map((k) => ({
        code: k.code,
        titel: k.titel,
        partei: k.partei,
        durchfuehrend: name(k.durchfuehrendId),
        vertretung: name(k.vertretungId),
        gegenzeichnung: k.gegenzeichnungMandant
          ? `${name(k.vertretungId)} (Mandant)`
          : name(k.gegenzeichnerId),
      })),
    },
    LAENDER: {
      stand: tag(ctx.laenderStand),
      summeLfd: ctx.fernverkaeufeLfd,
      summeVorjahr: ctx.fernverkaeufeVorjahr,
      schwelle: ctx.schwelle.label,
      laender: ctx.laender.map((l) => ({
        land: l.land,
        name: LAND_NAME[l.land] ?? l.land,
        fernverkaeufeLfdEur: l.fernverkaeufeLfdEur,
        lagerSeit: l.lagerSeit,
        oss: l.oss,
        lokaleUstNr: l.lokaleUstNr,
        registrierung: l.registrierung,
      })),
    },
    FESTSTELLUNGEN: {
      // Vertrauliche Feststellungen und §-153-Details gehören nicht in die Beschreibung.
      feststellungen: ctx.feststellungen
        .filter((f) => !f.vertraulich && f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN')
        .map((f) => ({
          nummer: f.nummer,
          titel: f.titel,
          schwere: f.schwere,
          status: FESTSTELLUNG_STATUS_LABEL[f.status],
          massnahmenOffen: f.massnahmenOffen,
        })),
    },
  };
}

/** Erzeugt den eingefrorenen Inhalt (JSON-flach) und seinen SHA-256 über kanonisches JSON. */
export function baueSnapshot(
  version: { nummer: string; abschnitte: Abschnitt[] },
  ctx: TcmsKontext,
  erzeugtAm: Date,
): { snapshot: Snapshot; sha256: string } {
  const genutzt = new Set<BausteinArt>();
  for (const a of version.abschnitte)
    for (const b of a.bloecke) if (b.typ === 'baustein') genutzt.add(b.art);
  const satz = baueBausteine(ctx);
  const bausteine: Partial<BausteinSatz> = {};
  for (const art of genutzt) (bausteine as Record<string, unknown>)[art] = satz[art];
  const roh: Snapshot = {
    nummer: version.nummer,
    mandant: ctx.mandant.name,
    eingefroren: true,
    stand: isoDatum(ctx.stand),
    erzeugtAm: erzeugtAm.toISOString(),
    abschnitte: version.abschnitte,
    bausteine,
  };
  const snapshot = JSON.parse(JSON.stringify(roh)) as Snapshot;
  return { snapshot, sha256: sha256(kanonisch(snapshot)) };
}

/** Prüft, ob der gespeicherte Snapshot zum gespeicherten Hash passt (null = nichts zu prüfen). */
export function pruefeSnapshot(snapshot: unknown, hash: string | null): boolean | null {
  if (!snapshot || !hash) return null;
  return sha256(kanonisch(snapshot)) === hash;
}

/** Vollständige Abschnittsliste in der Reihenfolge der Gliederung. */
export function normalisiereAbschnitte(roh: unknown): Abschnitt[] {
  const liste = Array.isArray(roh) ? (roh as Abschnitt[]) : [];
  const je = new Map(liste.map((a) => [a.key, a]));
  return ABSCHNITTE.map((v) => ({
    key: v.key,
    bloecke: je.get(v.key)?.bloecke ?? [{ typ: 'text', text: '' }],
  }));
}

/** Gerüst einer ersten Version: Gliederung mit leeren Texten und den Standardbausteinen. */
export function geruestAbschnitte(): Abschnitt[] {
  const standard: Partial<Record<Abschnitt['key'], BausteinArt>> = {
    teilbereich: 'TEILBEREICH',
    ziele: 'ZIELE',
    risiken: 'RISIKOINVENTAR',
    programm: 'KONTROLLMATRIX',
    organisation: 'VERANTWORTUNG',
    ueberwachung: 'FESTSTELLUNGEN',
    anhang: 'LAENDER',
  };
  return ABSCHNITTE.map((v) => {
    const art = standard[v.key];
    return {
      key: v.key,
      bloecke: art
        ? [
            { typ: 'text' as const, text: '' },
            { typ: 'baustein' as const, art },
          ]
        : [{ typ: 'text' as const, text: '' }],
    };
  });
}

export interface VersionRoh {
  id: string;
  nummer: string;
  status: BeschreibungStatus;
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

export interface VerlaufEintrag {
  at: Date;
  aktion: string;
  actorId: string | null;
  actorName: string;
  objektId: string;
  detail: Record<string, unknown>;
}

export interface BeschreibungsDaten {
  versionen: VersionRoh[];
  freigaben: FreigabeRoh[];
  verlauf: VerlaufEintrag[];
}

/** Lädt alle Versionen inkl. Snapshot, die Beschreibungs-Freigaben und den Audit-Verlauf. */
export async function ladeBeschreibungsDaten(programmId: string): Promise<BeschreibungsDaten> {
  const [versionen, freigaben] = await Promise.all([
    db.beschreibungVersion.findMany({ where: { programmId }, orderBy: { createdAt: 'asc' } }),
    db.freigabe.findMany({
      where: { programmId, art: 'BESCHREIBUNG' },
      orderBy: { angefordertAm: 'asc' },
    }),
  ]);
  const ids = versionen.map((v) => v.id);
  const audit = ids.length
    ? await db.auditEvent.findMany({
        where: { objektTyp: 'BeschreibungVersion', objektId: { in: ids } },
        orderBy: { seq: 'asc' },
      })
    : [];
  return {
    versionen: versionen.map((v) => ({
      id: v.id,
      nummer: v.nummer,
      status: v.status,
      abschnitte: normalisiereAbschnitte(v.abschnitte),
      createdAt: v.createdAt,
      erstelltVon: v.erstelltVon,
      reviewAngefordertVon: v.reviewAngefordertVon,
      reviewAngefordertAm: v.reviewAngefordertAm,
      reviewVon: v.reviewVon,
      reviewAm: v.reviewAm,
      freigabeAngefordertAm: v.freigabeAngefordertAm,
      freigegebenVon: v.freigegebenVon,
      freigegebenAm: v.freigegebenAm,
      snapshot: (v.snapshot as unknown as Snapshot | null) ?? null,
      snapshotSha256: v.snapshotSha256,
    })),
    freigaben: freigaben.map((f) => ({
      id: f.id,
      refId: f.refId,
      status: f.status,
      angefordertVon: f.angefordertVon,
      angefordertAm: f.angefordertAm,
      empfaengerId: f.empfaengerId,
      codeAblauf: f.codeAblauf,
      hatCode: !!f.codeHash,
      anmerkung: f.anmerkung,
      erledigtAm: f.erledigtAm,
    })),
    verlauf: audit.map((a) => ({
      at: a.at,
      aktion: a.aktion,
      actorId: a.actorId,
      actorName: a.actorName,
      objektId: a.objektId,
      detail: (a.detail as Record<string, unknown>) ?? {},
    })),
  };
}

/** Letzte bearbeitende Person einer Version: letzte Textänderung, sonst Ersteller:in. */
export function letzteBearbeitung(
  v: Pick<VersionRoh, 'id' | 'erstelltVon'>,
  verlauf: VerlaufEintrag[],
): string | null {
  const letzte = [...verlauf]
    .reverse()
    .find((e) => e.objektId === v.id && e.aktion === 'tcms.beschreibung.abschnitt_geaendert');
  return letzte?.actorId ?? v.erstelltVon;
}

/**
 * Status einer Version zum Stichtag, aus den Zeitstempeln abgeleitet. Für den
 * aktuellen Stand entspricht er dem gespeicherten Status.
 */
export function statusZum(
  v: VersionRoh,
  alle: VersionRoh[],
  freigaben: FreigabeRoh[],
  ende: Date,
  historisch: boolean,
): BeschreibungStatus {
  if (!historisch) return v.status;
  const bis = (d: Date | null) => !!d && d.getTime() <= ende.getTime();
  if (bis(v.freigegebenAm)) {
    const neuere = alle.some(
      (x) => x.createdAt.getTime() > v.createdAt.getTime() && bis(x.freigegebenAm),
    );
    return neuere ? 'ABGELOEST' : 'FREIGEGEBEN';
  }
  const zurueckgezogen = freigaben.some(
    (f) => f.refId === v.id && f.status === 'ABGELEHNT' && bis(f.erledigtAm),
  );
  if (zurueckgezogen) return 'ABGELOEST';
  if (bis(v.freigabeAngefordertAm)) return 'BEIM_MANDANTEN';
  if (bis(v.reviewAngefordertAm)) return 'KANZLEI_REVIEW';
  return 'ENTWURF';
}
