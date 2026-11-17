// =============================================================================
// Zuständigkeit einer Durchführung (eine Regel für Operationen, Rechte-
// Kennzeichen, Portal, Kontext und Arbeitskorb).
//
// Jede Durchführung ist an den Kontrollstand ihrer Planung gebunden
// (`kontrolleStandId`): Daraus kommen Inhalt und Maßstab der Durchführung –
// Schritte, Kennzahlen, Toleranz, Mindestnachweise, Titel. Die Zuständigkeit
// (Partei, durchführende Person, Vertretung, Gegenzeichnung, Gegenzeichnung
// beim Mandanten) offener Durchführungen kommt dagegen aus dem gültigen
// Kontrollstand der Kontrolle: Ein Zuständigkeitswechsel
// (`verantwortlicheAendern` und jeder andere neue Kontrollstand) wirkt sofort
// auf alle offenen Durchführungen – auch begonnene und eingereichte –, die
// abgelöste Person verliert ihre Rechte, die neue erhält sie. Abgeschlossene
// und entfallene Durchführungen behalten die Zuständigkeit ihres eigenen
// Stands (wer damals zuständig war).
//
// „Gültig" wie beim Audit (`auditGrenze`): Kontrollstände tragen echte Zeit;
// im aktuellen Stand gilt der offene (jüngste) Stand, in einem historischen
// der zum Ende des Stichtags gültige. Ebenso „abgeschlossen": aktuell nach dem
// gespeicherten Status, historisch nach dem Status zum Stichtag (`statusAm`).
//
// Entscheidung gegen das Umhängen geplanter Durchführungen auf den neuen
// Stand: Umhängen träfe nur unberührte Durchführungen (begonnene und
// eingereichte behielten die alte Zuständigkeit), bände Schritte und
// Kennzahlen an einen anderen Stand als den geplanten und bräuchte in jeder
// Operation mit neuem Kontrollstand eine Sperre über alle Durchführungen der
// Kontrolle. Eine reine Leseregel trifft alle Lesepfade gleich.
// =============================================================================

import { statusAm, type DurchfuehrungZeit } from '@tcms/domain';
import type { KontrollZustaendigkeit } from '../rechte';
import { gueltigerStand } from './kontroll-vorlage';
import { auditGrenze } from './zeit';

interface Stand {
  id: string;
  gueltigAb: Date;
  gueltigBis: Date | null;
}

const ENDGUELTIG = new Set(['OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN']);

/**
 * Durchführung zum Stichtag abgeschlossen oder entfallen: aktuell nach dem
 * gespeicherten Status, historisch nach dem Status zum Stichtag.
 */
export function endgueltigZum(d: DurchfuehrungZeit, stichtag: Date, heute: Date): boolean {
  if (stichtag.getTime() >= heute.getTime()) return ENDGUELTIG.has(d.status);
  return ENDGUELTIG.has(statusAm(d, stichtag));
}

/** Gültiger Kontrollstand zum Stichtag (aktuell: der offene, sonst zum Ende des Stichtags). */
export function gueltigerKontrollStand<S extends Stand>(
  staende: readonly S[],
  stichtag: Date,
  heute: Date,
): S | undefined {
  return gueltigerStand(staende, auditGrenze(stichtag, heute));
}

/**
 * Kontrollstand, aus dem die Zuständigkeit einer Durchführung zum Stichtag
 * (Kalendertag, `heute` laut Uhr) kommt: offen → der gültige Stand der
 * Kontrolle; abgeschlossen/entfallen bzw. ohne gültigen Stand → der eigene
 * Stand der Durchführung.
 */
export function zustaendigkeitsStand<S extends Stand>(
  d: DurchfuehrungZeit,
  eigener: S,
  staende: readonly S[],
  stichtag: Date,
  heute: Date,
): S {
  if (endgueltigZum(d, stichtag, heute)) return eigener;
  return gueltigerKontrollStand(staende, stichtag, heute) ?? eigener;
}

/** Zuständigkeit aus einem Kontrollstand. */
export function zustaendigkeitAus(ks: KontrollZustaendigkeit): KontrollZustaendigkeit {
  return {
    durchfuehrendId: ks.durchfuehrendId,
    vertretungId: ks.vertretungId,
    gegenzeichnerId: ks.gegenzeichnerId,
    gegenzeichnungMandant: ks.gegenzeichnungMandant,
    partei: ks.partei,
  };
}
