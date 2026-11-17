// =============================================================================
// Frequenzabweichung einer Kontrolle: Wer hat die offene (bzw. freigegebene)
// Abweichung beantragt? Einzige Regel für die Vier-Augen-Prüfung der
// Operation (`entscheideFrequenzAbweichung`, unter der Sperre der Kontrolle),
// den Arbeitskorb und die Kontrollhistorie (bisher je eine Kopie in
// risiken-kontrollen/planung.ts und lesepfade/arbeitskorb.ts).
//
// Reihenfolge der Stände ist die Version (dann die ID), nie `gueltigAb`:
// `gueltigAb` folgt der Uhr des Dienstkontexts und ist unter der Demo-Uhr nicht
// monoton (Tageszeit auf dem Demo-Tag, Sprung um Mitternacht UTC). Die
// Funktionen sortieren selbst, damit kein Aufrufer eine andere Reihenfolge
// verwenden kann.
// =============================================================================

/** Felder eines Kontrollstands, die die Abweichungsregel braucht. */
export interface AbweichungsStand {
  id: string;
  version: number;
  gueltigAb: Date;
  erstelltVon: string | null;
  abweichungTurnus: string | null;
  abweichungAnlass: boolean | null;
  abweichungBegruendung: string | null;
  abweichungFreigegebenVon: string | null;
}

export interface Antrag {
  von: string | null;
  am: Date | null;
}

/** true, wenn der Stand eine beantragte, noch nicht freigegebene Abweichung trägt. */
export function abweichungOffen(
  s: Pick<AbweichungsStand, 'abweichungTurnus' | 'abweichungFreigegebenVon'>,
): boolean {
  return s.abweichungTurnus != null && !s.abweichungFreigegebenVon;
}

type Abweichung = Pick<
  AbweichungsStand,
  'abweichungTurnus' | 'abweichungAnlass' | 'abweichungBegruendung' | 'abweichungFreigegebenVon'
>;

/** Gleiche Abweichung samt Freigabe (Stand nur fortgeschrieben). */
export function gleicheAbweichung(a: Abweichung, b: Abweichung): boolean {
  return gleicherAntrag(a, b) && a.abweichungFreigegebenVon === b.abweichungFreigegebenVon;
}

function gleicherAntrag(a: Abweichung, b: Abweichung): boolean {
  return (
    a.abweichungTurnus === b.abweichungTurnus &&
    (a.abweichungAnlass ?? false) === (b.abweichungAnlass ?? false) &&
    a.abweichungBegruendung === b.abweichungBegruendung
  );
}

/** Stände bis einschließlich `bis` (nach Version), aufsteigend nach Version und ID. */
function staendeBis<T extends AbweichungsStand>(
  staende: readonly T[],
  bis: Pick<AbweichungsStand, 'version'> | undefined,
): T[] {
  return staende
    .filter((s) => !bis || s.version <= bis.version)
    .sort((a, b) => a.version - b.version || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Frühester Stand der ununterbrochenen Folge vor dem letzten Stand mit `gleich`. */
function beginnDerFolge(
  aufsteigend: readonly AbweichungsStand[],
  gleich: (a: Abweichung, b: Abweichung) => boolean,
): Antrag {
  const letzter = aufsteigend[aufsteigend.length - 1]!;
  let i = aufsteigend.length - 1;
  while (i > 0 && gleich(aufsteigend[i - 1]!, letzter)) i--;
  return { von: aufsteigend[i]!.erstelltVon, am: aufsteigend[i]!.gueltigAb };
}

/**
 * Wer hat die offene Abweichung beantragt? Der früheste Stand der
 * ununterbrochenen Folge mit derselben offenen Abweichung (spätere Stände
 * können durch Design- oder Personenänderungen entstanden sein). `bis` ist der
 * Stand, dessen Abweichung entschieden wird (spätere Versionen zählen nicht);
 * ohne `bis` der letzte Stand der Liste.
 */
export function antragDerAbweichung(
  staende: readonly AbweichungsStand[],
  bis?: Pick<AbweichungsStand, 'version'>,
): Antrag {
  const aufsteigend = staendeBis(staende, bis);
  const letzter = aufsteigend[aufsteigend.length - 1];
  if (!letzter || !abweichungOffen(letzter)) return { von: null, am: null };
  return beginnDerFolge(aufsteigend, gleicheAbweichung);
}

/** Antrag einer offenen oder freigegebenen Abweichung (Anzeige). */
export function antragAnzeige(
  staende: readonly AbweichungsStand[],
  bis?: Pick<AbweichungsStand, 'version'>,
): Antrag {
  const aufsteigend = staendeBis(staende, bis);
  const offen = antragDerAbweichung(aufsteigend);
  if (offen.von) return offen;
  const letzter = aufsteigend[aufsteigend.length - 1];
  if (!letzter || letzter.abweichungTurnus == null || !letzter.abweichungFreigegebenVon) {
    return { von: null, am: null };
  }
  return beginnDerFolge(aufsteigend, gleicherAntrag);
}
