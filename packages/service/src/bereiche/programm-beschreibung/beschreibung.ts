// =============================================================================
// CMS-Beschreibung (Fachkonzept S14, §9) als Service: lesen, neue Version,
// Abschnitt speichern, Kanzlei-Review im Vier-Augen-Prinzip, Freigabe beim
// Mandanten mit eingefrorenem Inhalt und SHA-256 (bisher apps/web/src/server/
// actions/beschreibung.ts).
//
// Sicherheit:
//   - Kanzlei-Endpunkte: `kannLesen` bzw. `kannBearbeiten` des Akteurs; die
//     Version muss zum Programm des Mandanten der Anfrage gehören.
//   - TS-05: Jeder Übergang sperrt zuerst die Versionszeile (FOR UPDATE) und
//     ändert dann bedingt; gleichzeitige Übergänge → genau einer, der andere
//     `KONFLIKT`. Neue Versionen sperren die Programmzeile; die Nummer ist je
//     Programm eindeutig.
//   - Review-Abschluss durch eine zweite Person: Keine Person, die Abschnitte
//     der Version geändert hat (ohne Änderung: wer sie angelegt hat), schließt
//     ab; ermittelt unter der Sperre in derselben Transaktion. Der Abschluss
//     nennt den gesehenen Text (SHA-256 der Abschnitte) und gilt nur für ihn.
//   - Nur für ein eingerichtetes Programm (Version 1 angelegt).
//   - Sperrreihenfolge beim Anfordern der Freigabe: neue Version, dann offene
//     Freigaben älterer Versionen und diese Versionen (Freigabe → Version wie
//     beim Freigeben im Portal), dann die Mandantenzeile (`halteRollenFest`).
//   - Freigegebene und abgelöste Versionen sind unveränderlich: Abschnitte
//     ändern sich nur im ENTWURF, der Snapshot entsteht genau einmal beim
//     Anfordern der Freigabe (Status KANZLEI_REVIEW → BEIM_MANDANTEN).
// =============================================================================

import {
  AbschnittSpeichernEingabeSchema,
  BeschreibungFreigabeAnfordernEingabeSchema,
  BeschreibungLesenEingabeSchema,
  BeschreibungVersionAktionEingabeSchema,
  BeschreibungVersionAnlegenEingabeSchema,
  DienstFehler,
  nichtBerechtigt,
  ReviewAbschliessenEingabeSchema,
  ReviewZurueckweisenEingabeSchema,
  type AbschnittSpeichernEingabe,
  type BeschreibungFreigabeAnfordernEingabe,
  type BeschreibungFreigabeAnfordernErgebnis,
  type BeschreibungLesenEingabe,
  type BeschreibungVersionAktionEingabe,
  type BeschreibungVersionAktionErgebnis,
  type BeschreibungVersionView,
  type BeschreibungView,
  type ReviewAbschliessenEingabe,
  type ReviewZurueckweisenEingabe,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import { naechsteVersion, type Abschnitt, type BausteinArt } from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import { ladeKontext } from '../../kern/tcms-kontext';
import { auditGrenze, tagesende } from '../../kern/zeit';
import { zustellungenDerFreigaben } from '../../kern/zustellung';
import type { DienstKontext } from '../../kontext';
import { halteRollenFest } from '../../rollen';
import { gleicheId, kannBearbeiten } from '../../rechte';
import {
  baueBausteine,
  baueSnapshot,
  beschreibungStatusZum,
  geruestAbschnitte,
  normalisiereAbschnitte,
  pruefeSnapshot,
  snapshotHash,
  type BeschreibungStatusWert,
} from './bausteine';
import { brauchtCodeSchluessel, codeAblaufAb, codeHash, codeStatus, erzeugeCode } from './code';
import {
  aktiveKontakte,
  eingerichtetesProgramm,
  empfaengerZumStichtag,
  fachlichUngueltig,
  iso,
  isoTagVon,
  kanzleiZugriff,
  konfliktBeiEindeutigkeit,
  pruefeEingabe,
  sperreVersion,
} from './gemeinsam';
import { legeNachrichtAn } from './nachrichten';
import { codeNachrichtText } from './texte';

const AKTION_ABSCHNITT = 'tcms.beschreibung.abschnitt_geaendert';
const AKTION_ZURUECK = 'tcms.beschreibung.review_zurueckgewiesen';

function versionsZahl(n: string): [number, number] {
  const [a, b] = n.split('.').map((x) => Number.parseInt(x, 10));
  return [a ?? 0, b ?? 0];
}

/**
 * Bearbeitende einer Version aus den Textänderungen laut Audit (in der Reihenfolge
 * der ersten Änderung); ohne Änderung die Person, die die Version angelegt hat.
 * `letzte`: jüngste Änderung (Anzeige). Rein; die Einträge liefert der Aufrufer.
 */
function bearbeitendeAus(
  v: { erstelltVon: string | null },
  aenderungen: readonly { actorId: string | null }[],
): { alle: string[]; letzte: string | null } {
  const alle: string[] = [];
  for (const a of aenderungen)
    if (a.actorId && !alle.some((x) => gleicheId(x, a.actorId))) alle.push(a.actorId);
  if (alle.length === 0)
    return { alle: v.erstelltVon ? [v.erstelltVon] : [], letzte: v.erstelltVon };
  return { alle, letzte: aenderungen.at(-1)?.actorId ?? null };
}

/**
 * Bearbeitende einer Version (Vier-Augen der Kanzlei-Review). Nur unter der Sperre der
 * Version aufrufen, wenn das Ergebnis eine Entscheidung trägt.
 */
async function bearbeitendeVon(
  tx: Tx,
  v: { id: string; erstelltVon: string | null },
): Promise<{ alle: string[]; letzte: string | null }> {
  const aenderungen = await tx.auditEvent.findMany({
    where: { objektTyp: 'BeschreibungVersion', objektId: v.id, aktion: AKTION_ABSCHNITT },
    orderBy: { pos: 'asc' },
    select: { actorId: true },
  });
  return bearbeitendeAus(v, aenderungen);
}

/** SHA-256 der Abschnitte (kanonisches JSON, wie der Snapshot): gesehener Text der Review. */
export function abschnitteSha256(abschnitte: readonly Abschnitt[]): string {
  return snapshotHash(abschnitte);
}

const ergebnis = (
  v: { id: string; nummer: string },
  status: BeschreibungStatusWert,
): BeschreibungVersionAktionErgebnis => ({ versionId: v.id, nummer: v.nummer, status });

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * Versionen (zum Stichtag), Beschreibungs-Freigaben, Zurückweisungen und die
 * lebenden Bausteine. `berufstraegerId`/`bearbeitungId`: Zuständigkeit für
 * den Baustein VERANTWORTUNG (nur Anzeige).
 */
export async function ladeBeschreibung(
  ctx: DienstKontext,
  eingabe: BeschreibungLesenEingabe,
): Promise<BeschreibungView> {
  const e = pruefeEingabe(BeschreibungLesenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, false);
  const k = await ladeKontext(ctx, { mandantId, ...(e.stand ? { stand: e.stand } : {}) });
  const gesetzlicheVertreter = k.kontaktRollen
    .filter((r) => r.rolle === 'GESETZLICHER_VERTRETER')
    .map((r) => r.kontaktId);
  const darfBearbeiten = !k.historisch && kannBearbeiten(ctx.akteur, mandantId);
  const basis = {
    stand: isoTagVon(k.stand),
    historisch: k.historisch,
    gesetzlicheVertreter,
    darfBearbeiten,
  };
  if (!k.programm) {
    return {
      ...basis,
      programmId: null,
      versionen: [],
      freigaben: [],
      zurueckweisungen: [],
      bausteine: null,
      namen: [],
    };
  }
  const programmId = k.programm.id;
  const tx = ctx.tx;
  const [versionen, freigaben] = await Promise.all([
    tx.beschreibungVersion.findMany({
      where: { programmId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    tx.freigabe.findMany({
      where: { programmId, art: 'BESCHREIBUNG' },
      orderBy: [{ angefordertAm: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const ids = versionen.map((v) => v.id);
  const audit = ids.length
    ? await tx.auditEvent.findMany({
        where: {
          objektTyp: 'BeschreibungVersion',
          objektId: { in: ids },
          aktion: { in: [AKTION_ABSCHNITT, AKTION_ZURUECK] },
        },
        orderBy: { pos: 'asc' },
        select: { at: true, aktion: true, actorId: true, objektId: true, detail: true },
      })
    : [];
  const ende = tagesende(k.stand);
  const grenze = auditGrenze(k.stand, k.heute);
  const bis = (d: Date | null) => (d && d.getTime() <= ende.getTime() ? d : null);
  const sichtbar = versionen.filter((v) => v.createdAt.getTime() <= ende.getTime());
  // Textänderungen je Version bis zum Stichtag (Bearbeitende) und danach (Kennzeichen).
  const bisGrenze = new Map<string, { actorId: string | null }[]>();
  const spaeterGeaendert = new Set<string>();
  for (const a of audit) {
    if (a.aktion !== AKTION_ABSCHNITT) continue;
    if (a.at.getTime() > grenze.getTime()) spaeterGeaendert.add(a.objektId);
    else bisGrenze.set(a.objektId, [...(bisGrenze.get(a.objektId) ?? []), a]);
  }

  const versionView = (v: (typeof versionen)[number]): BeschreibungVersionView => {
    const h = k.historisch;
    // Eingefrorener Inhalt erst ab der Anforderung der Freigabe (zum Stichtag).
    const eingefroren = !h || bis(v.freigabeAngefordertAm) != null;
    const snapshot = eingefroren
      ? ((v.snapshot as unknown as BeschreibungVersionView['snapshot']) ?? null)
      : null;
    const abschnitte = normalisiereAbschnitte(v.abschnitte);
    const b = bearbeitendeAus(v, bisGrenze.get(v.id) ?? []);
    return {
      id: v.id,
      nummer: v.nummer,
      status: v.status,
      anzeige: beschreibungStatusZum(v, sichtbar, freigaben, ende, h),
      abschnitte,
      abschnitteSpaeterGeaendert: h && spaeterGeaendert.has(v.id),
      createdAt: v.createdAt.toISOString(),
      erstelltVon: v.erstelltVon,
      reviewAngefordertVon: !h || bis(v.reviewAngefordertAm) ? v.reviewAngefordertVon : null,
      reviewAngefordertAm: iso(h ? bis(v.reviewAngefordertAm) : v.reviewAngefordertAm),
      reviewVon: !h || bis(v.reviewAm) ? v.reviewVon : null,
      reviewAm: iso(h ? bis(v.reviewAm) : v.reviewAm),
      freigabeAngefordertAm: iso(h ? bis(v.freigabeAngefordertAm) : v.freigabeAngefordertAm),
      freigegebenVon: !h || bis(v.freigegebenAm) ? v.freigegebenVon : null,
      freigegebenAm: iso(h ? bis(v.freigegebenAm) : v.freigegebenAm),
      snapshot,
      snapshotSha256: eingefroren ? v.snapshotSha256 : null,
      snapshotGeprueft: eingefroren ? pruefeSnapshot(v.snapshot, v.snapshotSha256) : null,
      letzteBearbeitung: b.letzte,
      bearbeitende: b.alle,
      abschnitteSha256: h ? null : abschnitteSha256(abschnitte),
    };
  };

  const jetzt = new Date();
  // Zustellstatus je Freigabe: betrieblicher Zustand, nur im aktuellen Stand.
  const zustellungen = await zustellungenDerFreigaben(tx, mandantId, freigaben, k);
  // Empfänger zum Stichtag (eine spätere Neuadressierung zählt dort noch nicht).
  const empfaenger = await empfaengerZumStichtag(tx, freigaben, grenze, k.historisch);
  const freigabenView = freigaben
    .filter((f) => f.angefordertAm.getTime() <= ende.getTime())
    .map((f) => {
      const spaeter = f.erledigtAm != null && f.erledigtAm.getTime() > ende.getTime();
      return {
        id: f.id,
        refId: f.refId,
        status: spaeter ? ('OFFEN' as const) : f.status,
        angefordertVon: f.angefordertVon,
        angefordertAm: f.angefordertAm.toISOString(),
        empfaengerId: empfaenger.get(f.id) ?? f.empfaengerId,
        codeStatus: k.historisch ? ('KEIN' as const) : codeStatus(f, jetzt, ctx.codes),
        codeAblauf: k.historisch ? null : iso(f.codeAblauf),
        anmerkung: spaeter ? null : f.anmerkung,
        erledigtAm: spaeter ? null : iso(f.erledigtAm),
        zustellung: zustellungen.get(f.id) ?? null,
      };
    });
  const nummerJe = new Map(versionen.map((v) => [v.id, v.nummer]));
  const zurueckweisungen = audit
    .filter((a) => a.aktion === AKTION_ZURUECK && a.at.getTime() <= grenze.getTime())
    .map((a) => {
      const d = (a.detail ?? {}) as Record<string, unknown>;
      return {
        versionId: a.objektId,
        nummer: nummerJe.get(a.objektId) ?? '',
        at: a.at.toISOString(),
        actorId: a.actorId,
        begruendung: typeof d['begruendung'] === 'string' ? d['begruendung'] : '',
      };
    });

  const extra = [e.berufstraegerId, e.bearbeitungId].filter(
    (x): x is string => !!x && !k.namen.has(x),
  );
  const zusatz = extra.length ? await ctx.personen.namen(extra) : new Map<string, string>();
  const name = (id: string | null | undefined) =>
    (id && (k.namen.get(id) ?? zusatz.get(id))) || '—';
  const person = (id: string | undefined) => (id ? { id, name: name(id) } : null);
  const bausteine = baueBausteine(k, {
    name,
    verantwortung: {
      berufstraeger: person(e.berufstraegerId),
      bearbeitung: person(e.bearbeitungId),
    },
  });
  const namen = [...k.namen, ...zusatz].map(([id, n]) => ({ id, name: n }));

  return {
    ...basis,
    programmId,
    versionen: sichtbar.map(versionView),
    freigaben: freigabenView,
    zurueckweisungen,
    bausteine,
    namen,
  };
}

// ---------------------------------------------------------------------------
// Neue Version
// ---------------------------------------------------------------------------

export async function legeBeschreibungsversionAn(
  ctx: DienstKontext,
  eingabe: { mandantId: string },
): Promise<{ versionId: string; nummer: string; basis: string | null }> {
  const e = pruefeEingabe(BeschreibungVersionAnlegenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, true);
  // TS-05: Programmzeile sperren – zwei gleichzeitige Anlagen sehen nacheinander den Stand.
  // Nur für ein eingerichtetes Programm (nicht für den Entwurf des Assistenten).
  const programmId = await eingerichtetesProgramm(ctx.tx, mandantId, true);
  const versionen = await ctx.tx.beschreibungVersion.findMany({
    where: { programmId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const offen = versionen.find((x) => x.status === 'ENTWURF' || x.status === 'KANZLEI_REVIEW');
  if (offen) {
    throw new DienstFehler(
      'KONFLIKT',
      `Version ${offen.nummer} ist noch in Bearbeitung (${offen.status === 'ENTWURF' ? 'Entwurf' : 'Kanzlei-Review'}).`,
    );
  }
  const hoechste = versionen
    .map((x) => x.nummer)
    .sort((a, b) => {
      const [a1, a2] = versionsZahl(a);
      const [b1, b2] = versionsZahl(b);
      return a1 - b1 || a2 - b2;
    })
    .at(-1);
  const basis = versionen.at(-1) ?? null;
  const nummer = naechsteVersion(hoechste ?? null);
  const abschnitte = basis ? normalisiereAbschnitte(basis.abschnitte) : geruestAbschnitte();
  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const v = await konfliktBeiEindeutigkeit('Diese Version wurde inzwischen angelegt.', () =>
      tx.beschreibungVersion.create({
        data: {
          programmId,
          nummer,
          status: 'ENTWURF',
          abschnitte: abschnitte as unknown as Prisma.InputJsonValue,
          createdAt: zeitpunkt,
          erstelltVon: ctx.akteur.id,
        },
        select: { id: true },
      }),
    );
    return {
      wert: { versionId: v.id, nummer, basis: basis?.nummer ?? null },
      protokoll: {
        aktion: 'tcms.beschreibung.version_angelegt',
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId,
        detail: { nummer, basis: basis?.nummer ?? null },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Abschnitt im Entwurf speichern
// ---------------------------------------------------------------------------

export async function speichereBeschreibungsabschnitt(
  ctx: DienstKontext,
  eingabe: AbschnittSpeichernEingabe,
): Promise<{ versionId: string; nummer: string; geaendert: boolean }> {
  const e = pruefeEingabe(AbschnittSpeichernEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, true);
  const v = await sperreVersion(ctx.tx, mandantId, e.versionId);
  if (v.status !== 'ENTWURF') {
    throw new DienstFehler(
      'KONFLIKT',
      'Nur Entwürfe sind bearbeitbar. Änderungen an dieser Version entstehen als neue Version.',
    );
  }
  const bloecke: Abschnitt['bloecke'] = e.bloecke.map((b) =>
    b.typ === 'text' ? { typ: 'text', text: b.text.replace(/\r\n/g, '\n').trimEnd() } : b,
  );
  const arten = (bl: Abschnitt['bloecke']) =>
    bl.filter((b) => b.typ === 'baustein').map((b) => (b as { art: BausteinArt }).art);
  if (new Set(arten(bloecke)).size !== arten(bloecke).length) {
    fachlichUngueltig('Jeder Baustein darf je Abschnitt nur einmal vorkommen.', 'bloecke', [
      'Baustein doppelt.',
    ]);
  }
  const abschnitte = normalisiereAbschnitte(v.abschnitte);
  const idx = abschnitte.findIndex((a) => a.key === e.key);
  const alt = abschnitte[idx]!;
  if (JSON.stringify(bloecke) === JSON.stringify(alt.bloecke)) {
    return { versionId: v.id, nummer: v.nummer, geaendert: false };
  }
  const zeichen = (bl: Abschnitt['bloecke']) =>
    bl.reduce((s, b) => s + (b.typ === 'text' ? b.text.trim().length : 0), 0);
  abschnitte[idx] = { key: alt.key, bloecke };
  return mitAudit(ctx, async (tx) => {
    const r = await tx.beschreibungVersion.updateMany({
      where: { id: v.id, status: 'ENTWURF' },
      data: { abschnitte: abschnitte as unknown as Prisma.InputJsonValue },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', 'Die Version ist kein Entwurf mehr.');
    return {
      wert: { versionId: v.id, nummer: v.nummer, geaendert: true },
      protokoll: {
        aktion: AKTION_ABSCHNITT,
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId: v.programmId,
        detail: {
          nummer: v.nummer,
          abschnitt: alt.key,
          zeichenVorher: zeichen(alt.bloecke),
          zeichenNachher: zeichen(bloecke),
          bausteineVorher: arten(alt.bloecke),
          bausteineNachher: arten(bloecke),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Kanzlei-Review
// ---------------------------------------------------------------------------

export async function gibBeschreibungZurReview(
  ctx: DienstKontext,
  eingabe: BeschreibungVersionAktionEingabe,
): Promise<BeschreibungVersionAktionErgebnis> {
  const e = pruefeEingabe(BeschreibungVersionAktionEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, true);
  const v = await sperreVersion(ctx.tx, mandantId, e.versionId);
  if (v.status !== 'ENTWURF')
    throw new DienstFehler('KONFLIKT', 'Nur ein Entwurf kann zur Kanzlei-Review gegeben werden.');
  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const r = await tx.beschreibungVersion.updateMany({
      where: { id: v.id, status: 'ENTWURF' },
      data: {
        status: 'KANZLEI_REVIEW',
        reviewAngefordertVon: ctx.akteur.id,
        reviewAngefordertAm: zeitpunkt,
        reviewVon: null,
        reviewAm: null,
      },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', 'Die Version ist kein Entwurf mehr.');
    return {
      wert: ergebnis(v, 'KANZLEI_REVIEW'),
      protokoll: {
        aktion: 'tcms.beschreibung.review_angefordert',
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId: v.programmId,
        detail: { nummer: v.nummer },
      },
    };
  });
}

export async function schliesseBeschreibungsreviewAb(
  ctx: DienstKontext,
  eingabe: ReviewAbschliessenEingabe,
): Promise<BeschreibungVersionAktionErgebnis> {
  const e = pruefeEingabe(ReviewAbschliessenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, true);
  const v = await sperreVersion(ctx.tx, mandantId, e.versionId);
  if (v.status !== 'KANZLEI_REVIEW' || v.reviewVon)
    throw new DienstFehler('KONFLIKT', 'Für diese Version ist keine Kanzlei-Review offen.');
  // Vier-Augen: alle Bearbeitenden unter der Sperre der Version ermitteln. Ohne
  // ermittelbare Bearbeitung kein Abschluss (fail closed).
  const b = await bearbeitendeVon(ctx.tx, v);
  if (b.alle.length === 0 || b.alle.some((id) => gleicheId(id, ctx.akteur.id))) {
    throw nichtBerechtigt(
      'VIER_AUGEN',
      'Die Review schließt eine zweite Person ab – nicht, wer den Text dieser Version bearbeitet hat.',
    );
  }
  // TS-05: Der Abschluss gilt dem gesehenen Text (unter der Sperre verglichen).
  const sha256 = abschnitteSha256(normalisiereAbschnitte(v.abschnitte));
  if (sha256 !== e.abschnitteSha256) {
    throw new DienstFehler(
      'KONFLIKT',
      'Der Text dieser Version hat sich seit dem Laden geändert. Bitte neu laden und erneut prüfen.',
    );
  }
  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const r = await tx.beschreibungVersion.updateMany({
      where: { id: v.id, status: 'KANZLEI_REVIEW', reviewVon: null },
      data: { reviewVon: ctx.akteur.id, reviewAm: zeitpunkt },
    });
    if (r.count !== 1)
      throw new DienstFehler('KONFLIKT', 'Die Review wurde inzwischen bereits abgeschlossen.');
    return {
      wert: ergebnis(v, 'KANZLEI_REVIEW'),
      protokoll: {
        aktion: 'tcms.beschreibung.review_abgeschlossen',
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId: v.programmId,
        detail: {
          nummer: v.nummer,
          abschnitteSha256: sha256,
          bearbeitende: b.alle,
          letzteBearbeitung: b.letzte,
        },
      },
    };
  });
}

export async function weiseBeschreibungsreviewZurueck(
  ctx: DienstKontext,
  eingabe: ReviewZurueckweisenEingabe,
): Promise<BeschreibungVersionAktionErgebnis> {
  const e = pruefeEingabe(ReviewZurueckweisenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, true);
  const v = await sperreVersion(ctx.tx, mandantId, e.versionId);
  if (v.status !== 'KANZLEI_REVIEW')
    throw new DienstFehler('KONFLIKT', 'Für diese Version ist keine Kanzlei-Review offen.');
  return mitAudit(ctx, async (tx) => {
    const r = await tx.beschreibungVersion.updateMany({
      where: { id: v.id, status: 'KANZLEI_REVIEW' },
      data: {
        status: 'ENTWURF',
        reviewAngefordertVon: null,
        reviewAngefordertAm: null,
        reviewVon: null,
        reviewAm: null,
      },
    });
    if (r.count !== 1)
      throw new DienstFehler('KONFLIKT', 'Die Version ist nicht mehr in der Kanzlei-Review.');
    return {
      wert: ergebnis(v, 'ENTWURF'),
      protokoll: {
        aktion: AKTION_ZURUECK,
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId: v.programmId,
        detail: { nummer: v.nummer, begruendung: e.begruendung },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Freigabe beim Mandanten anfordern (Snapshot + Bestätigungscode)
// ---------------------------------------------------------------------------

export async function fordereBeschreibungsfreigabeAn(
  ctx: DienstKontext,
  eingabe: BeschreibungFreigabeAnfordernEingabe,
): Promise<BeschreibungFreigabeAnfordernErgebnis> {
  const e = pruefeEingabe(BeschreibungFreigabeAnfordernEingabeSchema, eingabe);
  const schluessel = brauchtCodeSchluessel(ctx.codes);
  const mandantId = e.mandantId.toLowerCase();
  const empfaengerId = e.empfaengerId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, true);
  // Nur ein eingerichtetes Programm wird eingefroren und vorgelegt (der Status kehrt
  // nie nach ENTWURF zurück, eine Sperre der Programmzeile ist dafür nicht nötig).
  await eingerichtetesProgramm(ctx.tx, mandantId, false);
  const v = await sperreVersion(ctx.tx, mandantId, e.versionId);
  if (v.status !== 'KANZLEI_REVIEW' || !v.reviewVon) {
    throw new DienstFehler(
      'KONFLIKT',
      'Die Freigabe kann erst nach abgeschlossener Kanzlei-Review angefordert werden.',
    );
  }
  // Ältere Version beim Mandanten: zuerst ihre offene Freigabe, dann die Version sperren
  // (Freigabe → Version wie `erteileFreigabe`) und unter der Sperre neu lesen. Gibt die GV
  // gleichzeitig frei, wartet diese Anfrage und sieht danach den neuen Stand (Befunde 19/58).
  await ctx.tx.$queryRaw`
    SELECT f.id FROM "Freigabe" f
    WHERE f."programmId" = ${v.programmId} AND f.art = 'BESCHREIBUNG'
      AND f.status = 'OFFEN' AND f."refId" <> ${v.id}
    ORDER BY f.id FOR UPDATE`;
  await ctx.tx.$queryRaw`
    SELECT b.id FROM "BeschreibungVersion" b
    WHERE b."programmId" = ${v.programmId} AND b.status = 'BEIM_MANDANTEN' AND b.id <> ${v.id}
    ORDER BY b.id FOR UPDATE`;
  const aeltere = await ctx.tx.beschreibungVersion.findMany({
    where: { programmId: v.programmId, status: 'BEIM_MANDANTEN', id: { not: v.id } },
    select: { id: true, nummer: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  // TS-06: Empfänger über die ID, nur eine aktive gesetzliche Vertretung dieses Mandanten;
  // geprüft unter derselben Sperre wie die Rollenpflege (TS-05, RT4-T-06).
  await halteRollenFest(ctx.tx, mandantId);
  const kontakte = await aktiveKontakte(ctx.tx, mandantId);
  if (!kontakte.some((x) => x.kontaktId === empfaengerId && x.rolle === 'GESETZLICHER_VERTRETER')) {
    fachlichUngueltig('Empfänger ungültig.', 'empfaengerId', [
      'Die Freigabe erteilt nur eine gesetzliche Vertretung des Mandanten.',
    ]);
  }
  // Eingefroren wird der aktuelle Stand (kein Stichtag, TS-07). Namen: Eingabe der
  // kanzleikonsole vor dem Personenverzeichnis; beides nur Anzeige.
  const k = await ladeKontext(ctx, { mandantId });
  const eingabeNamen = new Map(e.namen.map((n) => [n.id.toLowerCase(), n.name]));
  const name = (id: string | null | undefined) =>
    (id && (eingabeNamen.get(id.toLowerCase()) ?? k.namen.get(id))) || '—';
  const verantwortung = {
    berufstraeger: e.verantwortung.berufstraeger
      ? {
          id: e.verantwortung.berufstraeger.id.toLowerCase(),
          name: e.verantwortung.berufstraeger.name,
        }
      : null,
    bearbeitung: e.verantwortung.bearbeitung
      ? { id: e.verantwortung.bearbeitung.id.toLowerCase(), name: e.verantwortung.bearbeitung.name }
      : null,
  };
  const satz = baueBausteine(k, { name, verantwortung });
  const titel = `CMS-Beschreibung v${v.nummer}`;

  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const { snapshot, sha256 } = baueSnapshot(
      { nummer: v.nummer, abschnitte: normalisiereAbschnitte(v.abschnitte) },
      k,
      satz,
      zeitpunkt,
    );
    const r = await tx.beschreibungVersion.updateMany({
      where: { id: v.id, status: 'KANZLEI_REVIEW', reviewVon: { not: null } },
      data: {
        status: 'BEIM_MANDANTEN',
        freigabeAngefordertAm: zeitpunkt,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotSha256: sha256,
      },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', 'Die Version hat ihren Status geändert.');

    // Eine noch offene Anforderung einer älteren Version (oben gesperrt) wird zurückgezogen;
    // protokolliert und gemeldet wird nur, was sich tatsächlich geändert hat.
    const protokoll: Protokoll[] = [];
    const zurueckgezogen: string[] = [];
    for (const a of aeltere) {
      const u = await tx.beschreibungVersion.updateMany({
        where: { id: a.id, status: 'BEIM_MANDANTEN' },
        data: { status: 'ABGELOEST' },
      });
      if (u.count !== 1) continue;
      zurueckgezogen.push(a.nummer);
      await tx.freigabe.updateMany({
        where: { programmId: v.programmId, art: 'BESCHREIBUNG', refId: a.id, status: 'OFFEN' },
        data: {
          status: 'ABGELEHNT',
          anmerkung: `Zurückgezogen: ersetzt durch Anforderung v${v.nummer}`,
          erledigtAm: zeitpunkt,
          codeHash: null,
          codeSchluesselId: null,
          codeAblauf: null,
        },
      });
      protokoll.push({
        aktion: 'tcms.beschreibung.freigabe_zurueckgezogen',
        objektTyp: 'BeschreibungVersion',
        objektId: a.id,
        programmId: v.programmId,
        detail: { nummer: a.nummer, ersetztDurch: v.nummer },
      });
    }

    const freigabe = await tx.freigabe.create({
      data: {
        programmId: v.programmId,
        art: 'BESCHREIBUNG',
        refId: v.id,
        titel,
        angefordertVon: ctx.akteur.id,
        angefordertAm: zeitpunkt,
        empfaengerId,
        status: 'OFFEN',
      },
      select: { id: true },
    });
    // Code: echte Zeit (Sicherheitsfrist), Hash an genau diese Freigabe gebunden.
    const code = erzeugeCode();
    const codeAblauf = codeAblaufAb(new Date());
    await tx.freigabe.update({
      where: { id: freigabe.id },
      data: { ...codeHash(schluessel, freigabe.id, code), codeAblauf },
    });
    await legeNachrichtAn(tx, {
      mandantId,
      empfaengerId,
      zweck: 'FREIGABE_CODE',
      daten: {
        freigabeId: freigabe.id,
        art: 'BESCHREIBUNG',
        titel,
        version: v.nummer,
        code,
        gueltigBis: codeAblauf.toISOString(),
        sha256,
      },
      ...codeNachrichtText({ mandant: mandant.name, titel, code, codeAblauf, sha256 }),
    });
    protokoll.push({
      aktion: 'tcms.beschreibung.freigabe_angefordert',
      objektTyp: 'BeschreibungVersion',
      objektId: v.id,
      programmId: v.programmId,
      detail: {
        nummer: v.nummer,
        freigabeId: freigabe.id,
        empfaengerId,
        snapshotSha256: sha256,
        codeAblauf: codeAblauf.toISOString(),
      },
    });
    return {
      wert: {
        versionId: v.id,
        nummer: v.nummer,
        freigabeId: freigabe.id,
        snapshotSha256: sha256,
        codeAblauf: codeAblauf.toISOString(),
        zurueckgezogen,
      },
      protokoll,
    };
  });
}
