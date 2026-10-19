// =============================================================================
// CMS-Beschreibung: lebende Bausteine aus dem Tax-CMS-Kontext, eingefrorener
// Inhalt (Snapshot) mit SHA-256 über kanonisches JSON, Status zum Stichtag
// (Fachkonzept S14, §9, §15; bisher apps/web/src/server/beschreibung-daten.ts).
// Reine Funktionen ohne I/O.
//
// Personen erscheinen als Name (für den eingefrorenen Inhalt) und als ID (für
// die kanzleikonsole). Namen kommen aus dem Personenverzeichnis bzw. als
// ausdrückliche Eingabe der kanzleikonsole und dienen nur der Anzeige.
// =============================================================================

import {
  BeschreibungAbschnittSchema,
  type BausteinSatzDaten,
  type BeschreibungAbschnitt,
  type BeschreibungSnapshot,
} from '@tcms/contract';
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
import type { TcmsKontext } from '../../kern/tcms-kontext';

// Übersetzungsprüfung: Abschnitte des Vertrags = Abschnitte der Domain.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ABSCHNITT_GLEICH: Gleich<BeschreibungAbschnitt, Abschnitt> = true;
void ABSCHNITT_GLEICH;

export type BeschreibungStatusWert =
  | 'ENTWURF'
  | 'KANZLEI_REVIEW'
  | 'BEIM_MANDANTEN'
  | 'FREIGEGEBEN'
  | 'ABGELOEST';

export interface BausteinOptionen {
  /** Anzeigename zu einer Personen-ID; unbekannt → „—". */
  name: (id: string | null | undefined) => string;
  /** Zuständigkeit der Kanzlei (Eingabe der kanzleikonsole, nur Anzeige). */
  verantwortung: {
    berufstraeger: { id: string; name: string } | null;
    bearbeitung: { id: string; name: string } | null;
  };
}

const tag = (d: Date | null | undefined) => (d ? isoDatum(d) : null);

/** Füllt alle lebenden Bausteine aus dem Tax-CMS-Kontext. */
export function baueBausteine(k: TcmsKontext, o: BausteinOptionen): BausteinSatzDaten {
  const name = (id: string | null | undefined) => (id ? o.name(id) : '—');
  const betrieb = !!k.programm?.wirksamAb && k.programm.wirksamAb.getTime() <= k.stand.getTime();
  const p1 = k.profil?.p1;
  const kanaele = p1
    ? [
        ...(p1.eigenerShop ? [`eigener Shop${p1.shopSystem ? ` (${p1.shopSystem})` : ''}`] : []),
        ...p1.marktplaetze,
      ]
    : [];
  const rang = { KRITISCH: 4, HOCH: 3, MITTEL: 2, GERING: 1 } as const;
  const kontakt = (rolle: string, label: string) =>
    k.kontaktRollen
      .filter((r) => r.rolle === rolle)
      .map((r) => ({ rolle: label, name: name(r.kontaktId), personId: r.kontaktId }));
  const kanzlei = (label: string, p: { id: string; name: string } | null) => ({
    rolle: label,
    name: p?.name ?? '—',
    personId: p?.id ?? null,
  });

  return {
    TEILBEREICH: k.teilbereich
      ? {
          name: k.teilbereich.name,
          abgrenzung: k.teilbereich.abgrenzung,
          einschluesse: [...k.teilbereich.einschluesse],
          ausschluesse: [...k.teilbereich.ausschluesse],
          zielLaender: [...(k.profil?.p3.laender ?? [])],
          kanaele,
        }
      : null,
    ZIELE: {
      appetit: k.appetit,
      ziele: k.ziele.map((z) => ({
        text: z.text,
        wesentlichkeitEur: z.wesentlichkeitEur,
        risikoappetit: z.risikoappetit,
        freigabe: z.freigabe,
        freigegebenAm: tag(z.freigegebenAm),
        freigegebenVon: z.freigegebenVon ? name(z.freigegebenVon) : null,
        freigegebenVonId: z.freigegebenVon,
      })),
    },
    RISIKOINVENTAR: {
      appetit: k.appetit,
      sicht: betrieb ? 'BETRIEB' : 'DESIGN',
      risiken: [...k.risiken]
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
      kontrollen: k.kontrollen.map((x) => ({
        code: x.code,
        titel: x.titel,
        art: x.art,
        frequenz: frequenzLabel(x.frequenz),
        partei: x.partei,
        schluessel: x.schluessel,
        design: x.design,
        designVon: x.designVon ? name(x.designVon) : null,
        designVonId: x.designVon,
        designAm: tag(x.designAm),
        risikoCodes: [...x.risikoCodes],
      })),
    },
    VERANTWORTUNG: {
      rollen: [
        ...kontakt('GESETZLICHER_VERTRETER', 'Gesetzliche Vertretung'),
        ...kontakt('TAX_COMPLIANCE_BEAUFTRAGTER', 'Tax-Compliance-Beauftragte:r'),
        kanzlei('Berufsträger:in (Kanzlei)', o.verantwortung.berufstraeger),
        kanzlei('Bearbeitung (Kanzlei)', o.verantwortung.bearbeitung),
      ],
      kontrollen: k.kontrollen.map((x) => {
        const gegen = x.gegenzeichnungMandant ? x.vertretungId : x.gegenzeichnerId;
        return {
          code: x.code,
          titel: x.titel,
          partei: x.partei,
          durchfuehrend: name(x.durchfuehrendId),
          vertretung: name(x.vertretungId),
          gegenzeichnung: x.gegenzeichnungMandant ? `${name(gegen)} (Mandant)` : name(gegen),
          durchfuehrendId: x.durchfuehrendId,
          vertretungId: x.vertretungId,
          gegenzeichnungId: gegen,
        };
      }),
    },
    LAENDER: {
      stand: tag(k.laenderStand),
      summeLfd: k.fernverkaeufeLfd,
      summeVorjahr: k.fernverkaeufeVorjahr,
      schwelle: k.schwelle.label,
      laender: k.laender.map((l) => ({
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
      feststellungen: k.feststellungen
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

/** SHA-256 (hex) eines eingefrorenen Inhalts über kanonisches JSON. */
export function snapshotHash(snapshot: unknown): string {
  return sha256(kanonisch(snapshot));
}

/**
 * Erzeugt den eingefrorenen Inhalt (JSON-flach, nur die genutzten Bausteine)
 * und seinen SHA-256 über kanonisches JSON.
 */
export function baueSnapshot(
  version: { nummer: string; abschnitte: Abschnitt[] },
  k: Pick<TcmsKontext, 'mandant' | 'stand'>,
  satz: BausteinSatzDaten,
  erzeugtAm: Date,
): { snapshot: BeschreibungSnapshot; sha256: string } {
  const genutzt = new Set<BausteinArt>();
  for (const a of version.abschnitte)
    for (const b of a.bloecke) if (b.typ === 'baustein') genutzt.add(b.art);
  const bausteine: Partial<BausteinSatzDaten> = {};
  for (const art of genutzt) (bausteine as Record<string, unknown>)[art] = satz[art];
  const roh: BeschreibungSnapshot = {
    nummer: version.nummer,
    mandant: k.mandant.name,
    eingefroren: true,
    stand: isoDatum(k.stand),
    erzeugtAm: erzeugtAm.toISOString(),
    abschnitte: version.abschnitte,
    bausteine,
  };
  // JSON-Rundreise: genau die Form, die JSONB speichert und zurückgibt.
  const snapshot = JSON.parse(JSON.stringify(roh)) as BeschreibungSnapshot;
  return { snapshot, sha256: snapshotHash(snapshot) };
}

/** Prüft, ob ein gespeicherter Snapshot zum gespeicherten Hash passt (null = nichts zu prüfen). */
export function pruefeSnapshot(snapshot: unknown, hash: string | null): boolean | null {
  if (snapshot == null && hash == null) return null;
  if (snapshot == null || hash == null) return false;
  return snapshotHash(snapshot) === hash;
}

/** Vollständige Abschnittsliste in der Reihenfolge der Gliederung; Ungültiges fällt weg. */
export function normalisiereAbschnitte(roh: unknown): Abschnitt[] {
  const je = new Map<string, Abschnitt['bloecke']>();
  if (Array.isArray(roh)) {
    for (const a of roh) {
      const p = BeschreibungAbschnittSchema.safeParse(a);
      if (p.success && !je.has(p.data.key)) je.set(p.data.key, p.data.bloecke);
    }
  }
  return ABSCHNITTE.map((v) => {
    const bloecke = je.get(v.key);
    return { key: v.key, bloecke: bloecke?.length ? bloecke : [{ typ: 'text', text: '' }] };
  });
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

interface VersionZeit {
  id: string;
  status: BeschreibungStatusWert;
  createdAt: Date;
  reviewAngefordertAm: Date | null;
  freigabeAngefordertAm: Date | null;
  freigegebenAm: Date | null;
}

/**
 * Status einer Version zum Stichtag, aus den Zeitstempeln abgeleitet. Für den
 * aktuellen Stand entspricht er dem gespeicherten Status.
 */
export function beschreibungStatusZum(
  v: VersionZeit,
  alle: readonly VersionZeit[],
  freigaben: readonly { refId: string; status: string; erledigtAm: Date | null }[],
  ende: Date,
  historisch: boolean,
): BeschreibungStatusWert {
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
