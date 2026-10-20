// =============================================================================
// Kontrollen aus dem Katalog anlegen (gemeinsamer Kern der Bereiche
// programm-beschreibung – Version 1 im Einrichtungsassistenten – und
// risiken-kontrollen – Risikoaufnahme aus dem Profilvorschlag): Vorbelegung
// der Zuständigkeiten, erster Kontrollstand, geplante Durchführungen und der
// zu einem Zeitpunkt gültige Stand. Reine Funktionen ohne I/O; vorher je
// Bereich kopiert (Vorlage `baueProgramm` im Seed).
//
// Personen sind IDs der kanzleikonsole. Berufsträger:in, Hauptbearbeitung und
// Vertretung der Kanzlei kommen als ausdrückliche Eingabe (ADR 0001 §5); sie
// dienen nur der Vorbelegung, nie Rechten.
// =============================================================================

import type { Prisma } from '@tcms/db';
import { addTage, type KatalogKontrolle, type Periode } from '@tcms/domain';
import type { MandantRolle } from '../rechte';

/** Personen für die Vorbelegung der Zuständigkeiten neuer Kontrollen. */
export interface VorbelegungsRollen {
  /** Zuständige:r Berufsträger:in bzw. Hauptbearbeitung; `null`, wenn die kanzleikonsole sie nicht nennt. */
  bt: string | null;
  hb: string | null;
  /** Vertretung der Kanzleiseite (nicht Berufsträger:in, nicht Hauptbearbeitung). */
  kanzleiVertretung: string | null;
  tcb: string | null;
  mandantVertretung: string | null;
  gv: string | null;
}

/** Zuständigkeit eines ersten Kontrollstands. */
export interface VorbelegteZustaendigkeit {
  partei: 'KANZLEI' | 'MANDANT';
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
}

/**
 * Mandantenseite der Vorbelegung aus aktiven Kontaktrollen in fester
 * Reihenfolge: gesetzliche Vertretung = erste GV; TCB = erste TCB, sonst erste
 * Mitarbeiter:in, sonst GV; Vertretung = erste andere Mitarbeiter:in, sonst
 * erste andere GV.
 */
export function mandantSeiteVorbelegen(
  kontakte: readonly { id: string; rolle: MandantRolle | null | undefined }[],
): Pick<VorbelegungsRollen, 'gv' | 'tcb' | 'mandantVertretung'> {
  const erste = (rolle: MandantRolle, ohne?: string | null) =>
    kontakte.find((k) => k.rolle === rolle && k.id !== ohne)?.id ?? null;
  const gv = erste('GESETZLICHER_VERTRETER');
  const tcb = erste('TAX_COMPLIANCE_BEAUFTRAGTER') ?? erste('MITARBEITER') ?? gv;
  const mandantVertretung =
    erste('MITARBEITER', tcb) ?? erste('GESETZLICHER_VERTRETER', tcb) ?? null;
  return { gv, tcb, mandantVertretung };
}

/**
 * Startbelegung wie im Seed: Kanzleikontrollen Hauptbearbeitung, Mandantenkontrollen TCB,
 * Gegenzeichnung Berufsträger:in. Unbekannte Personen bleiben `null` (offen, die Prüfung des
 * Assistenten meldet sie); zwei unbekannte gelten nie als dieselbe Person.
 */
export function standardKontrollZustaendigkeit(
  kat: KatalogKontrolle,
  r: VorbelegungsRollen,
): VorbelegteZustaendigkeit {
  const mandantSeite = kat.partei === 'MANDANT';
  const durchfuehrend =
    kat.code === 'K-EC-20' || kat.code === 'K-EC-24' ? r.bt : mandantSeite ? r.tcb : r.hb;
  const vertretung = mandantSeite ? r.mandantVertretung : r.kanzleiVertretung;
  const gegenzeichnungMandant = kat.code === 'K-EC-23' && r.mandantVertretung != null;
  const gegenzeichner = gegenzeichnungMandant
    ? r.mandantVertretung
    : durchfuehrend !== null && durchfuehrend === r.bt
      ? r.kanzleiVertretung
      : r.bt;
  return {
    partei: kat.partei,
    durchfuehrendId: durchfuehrend,
    vertretungId: vertretung,
    gegenzeichnerId: gegenzeichner,
    gegenzeichnungMandant,
  };
}

/** Erster Kontrollstand (Version 1) aus dem Katalog mit der gewählten Zuständigkeit. */
export function kontrollStandDaten(
  kat: KatalogKontrolle,
  z: VorbelegteZustaendigkeit,
  von: string,
  zeitpunkt: Date,
) {
  return {
    version: 1,
    titel: kat.titel,
    ziel: kat.ziel,
    art: kat.art,
    ausfuehrung: kat.ausfuehrung,
    vorlageTurnus: kat.frequenz.turnus,
    vorlageAnlass: kat.frequenz.anlass,
    partei: z.partei,
    schluessel: kat.schluessel,
    durchfuehrendId: z.durchfuehrendId,
    vertretungId: z.vertretungId,
    gegenzeichnerId: z.gegenzeichnerId,
    gegenzeichnungMandant: z.gegenzeichnungMandant,
    nachweis: kat.nachweis,
    mindestNachweise: kat.mindestNachweise,
    schritte: kat.schritte as unknown as Prisma.InputJsonValue,
    kennzahlen: kat.kennzahlen as unknown as Prisma.InputJsonValue,
    toleranzEur: kat.toleranzEur,
    faelligNachTagen: kat.faelligNachTagen,
    design: 'NICHT_BEURTEILT' as const,
    gueltigAb: zeitpunkt,
    erstelltVon: von,
    createdAt: zeitpunkt,
  };
}

/** Geplante Durchführung einer Periode (fällig `faelligNachTagen` nach Periodenende). */
export function geplanteDurchfuehrung(
  kontrolleId: string,
  standId: string,
  faelligNachTagen: number,
  p: Periode,
  zeitpunkt: Date,
): Prisma.DurchfuehrungCreateManyInput {
  return {
    kontrolleId,
    kontrolleStandId: standId,
    periodeLabel: p.label,
    periodeVon: p.von,
    periodeBis: p.bis,
    faelligAm: addTage(p.bis, faelligNachTagen),
    status: 'GEPLANT',
    createdAt: zeitpunkt,
  };
}

/** Zum Zeitpunkt gültiger Stand (jüngster mit `gueltigAb ≤ t < gueltigBis`). */
export function gueltigerStand<T extends { gueltigAb: Date; gueltigBis: Date | null }>(
  liste: readonly T[],
  zeitpunkt: Date,
): T | undefined {
  const t = zeitpunkt.getTime();
  return liste
    .filter(
      (s) => s.gueltigAb.getTime() <= t && (s.gueltigBis == null || s.gueltigBis.getTime() > t),
    )
    .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
}
