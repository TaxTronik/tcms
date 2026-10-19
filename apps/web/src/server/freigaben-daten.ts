import 'server-only';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { fmtDatum } from '@tcms/domain';
import { sha256 } from '@tcms/domain/audit';
import type { Snapshot } from '@/components/beschreibung/typen';
import { db, demoPersonen } from './demo';
import { normalisiereAbschnitte } from './beschreibung-daten';
import type { Abschnitt } from '@tcms/domain';

// =============================================================================
// Freigaben und Kenntnisnahmen (Fachkonzept §10 P4, §13): E-Mail-Code für
// Freigaben der gesetzlichen Vertretung, Postausgang der Entwicklungsumgebung.
// Der Klartext-Code steht nur in der Nachricht, gespeichert wird sein SHA-256.
// =============================================================================

export const CODE_ARTEN = ['ZIELE', 'BESCHREIBUNG', 'RISIKOAKZEPTANZ', 'AUFKLAERUNG'] as const;
export type CodeArt = (typeof CODE_ARTEN)[number];
export const CODE_GUELTIG_TAGE = 7;
export const MAX_FEHLVERSUCHE = 5;

export function brauchtCode(art: string): art is CodeArt {
  return (CODE_ARTEN as readonly string[]).includes(art);
}

export const FREIGABE_ART_LABEL: Record<string, string> = {
  ZIELE: 'Compliance-Ziele · Freigabe',
  BESCHREIBUNG: 'CMS-Beschreibung · Freigabe',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz · Freigabe',
  AUFKLAERUNG: 'Risikoaufklärung · Bestätigung',
  KENNTNISNAHME: 'Kenntnisnahme',
};

/**
 * Neuer 6-stelliger Code mit Hash und Ablauf (+7 Tage ab Zeitpunkt). Der
 * Zeitpunkt ist echte Zeit (Sicherheitsfrist, keine Demo-Uhr); Fehlversuche
 * werden über Audit-Zeitstempel (ebenfalls echte Zeit) seit Ausstellung gezählt.
 */
export function erzeugeCode(zeitpunkt: Date): { code: string; codeHash: string; codeAblauf: Date } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return {
    code,
    codeHash: sha256(code),
    codeAblauf: new Date(zeitpunkt.getTime() + CODE_GUELTIG_TAGE * 86_400_000),
  };
}

export function codePasst(code: string, codeHash: string): boolean {
  const a = Buffer.from(sha256(code), 'hex');
  const b = Buffer.from(codeHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adresse(p: { name: string; email: string }): string {
  return `${p.name} <${p.email}>`;
}

/** Text der Bestätigungsnachricht (Entwicklungs-Postausgang statt Mailversand). */
export function codeNachricht(o: {
  empfaenger: string;
  mandant: string;
  titel: string;
  code: string;
  codeAblauf: Date;
  sha256?: string | null;
}): { betreff: string; text: string } {
  return {
    betreff: `Freigabe angefordert: ${o.titel}`,
    text: [
      `Guten Tag ${o.empfaenger},`,
      '',
      `Ihre Kanzlei bittet Sie um Freigabe: ${o.titel} (${o.mandant}).`,
      '',
      `Ihr Bestätigungscode: ${o.code}`,
      `Der Code ist bis ${fmtDatum(o.codeAblauf)} gültig und nur für diese Freigabe verwendbar. Sie finden die Anforderung im Mandantenportal unter „Freigaben & Kenntnisnahmen“.`,
      ...(o.sha256 ? ['', `SHA-256 des vorgelegten Inhalts: ${o.sha256}`] : []),
    ].join('\n'),
  };
}

export interface FreigabeEintrag {
  id: string;
  art: string;
  refId: string;
  titel: string;
  inhalt: string | null;
  status: 'OFFEN' | 'FREIGEGEBEN' | 'ABGELEHNT';
  angefordertVon: string;
  angefordertAm: Date;
  empfaengerId: string;
  empfaengerName: string;
  codeAblauf: Date | null;
  hatCode: boolean;
  anmerkung: string | null;
  erledigtAm: Date | null;
  version: {
    id: string;
    nummer: string;
    status: string;
    abschnitte: Abschnitt[];
    snapshot: Snapshot | null;
    snapshotSha256: string | null;
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
}

/** Alle Freigaben und Kenntnisnahmen eines Mandanten (Portal). */
export async function ladeFreigaben(mandantId: string): Promise<FreigabenUebersicht> {
  const programme = await db.tcmsProgramm.findMany({
    where: { mandantId },
    select: { id: true },
  });
  const ids = programme.map((p) => p.id);
  if (!ids.length) return { eintraege: [], fruehere: [] };
  const [freigaben, versionen] = await Promise.all([
    db.freigabe.findMany({
      where: { programmId: { in: ids } },
      orderBy: { angefordertAm: 'desc' },
    }),
    db.beschreibungVersion.findMany({
      where: { programmId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const name = new Map(demoPersonen.alle().map((p) => [p.id, p.name]));
  const versionJe = new Map(versionen.map((v) => [v.id, v]));
  const eintraege: FreigabeEintrag[] = freigaben.map((f) => {
    const v = f.art === 'BESCHREIBUNG' ? versionJe.get(f.refId) : undefined;
    return {
      id: f.id,
      art: f.art,
      refId: f.refId,
      titel: f.titel,
      inhalt: f.inhalt,
      status: f.status,
      angefordertVon: name.get(f.angefordertVon) ?? '—',
      angefordertAm: f.angefordertAm,
      empfaengerId: f.empfaengerId,
      empfaengerName: name.get(f.empfaengerId) ?? '—',
      codeAblauf: f.codeAblauf,
      hatCode: !!f.codeHash,
      anmerkung: f.anmerkung,
      erledigtAm: f.erledigtAm,
      version: v
        ? {
            id: v.id,
            nummer: v.nummer,
            status: v.status,
            abschnitte: normalisiereAbschnitte(v.abschnitte),
            snapshot: (v.snapshot as unknown as Snapshot | null) ?? null,
            snapshotSha256: v.snapshotSha256,
            freigegebenVon: v.freigegebenVon ? (name.get(v.freigegebenVon) ?? '—') : null,
            freigegebenAm: v.freigegebenAm,
          }
        : null,
    };
  });
  const mitDatensatz = new Set(
    freigaben
      .filter((f) => f.art === 'BESCHREIBUNG' && f.status === 'FREIGEGEBEN')
      .map((f) => f.refId),
  );
  const fruehere = versionen
    .filter((v) => v.freigegebenAm && v.freigegebenVon && !mitDatensatz.has(v.id))
    .map((v) => ({
      id: v.id,
      nummer: v.nummer,
      status: v.status,
      freigegebenVon: name.get(v.freigegebenVon!) ?? '—',
      freigegebenAm: v.freigegebenAm!,
      snapshotSha256: v.snapshotSha256,
    }))
    .reverse();
  return { eintraege, fruehere };
}

/** Letzte Nachrichten des Entwicklungs-Postausgangs an eine Person. */
export async function ladePostausgang(nutzer: { name: string; email: string }, anzahl = 3) {
  // Exakt die Adresse der Person (bzw. der reine Name aus Altbeständen) – kein Präfixvergleich.
  return db.nachricht.findMany({
    where: { an: { in: [adresse(nutzer), nutzer.name] } },
    orderBy: { createdAt: 'desc' },
    take: anzahl,
  });
}
