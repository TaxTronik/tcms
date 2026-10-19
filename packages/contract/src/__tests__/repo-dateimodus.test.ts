// =============================================================================
// Dateimodi im Git-Index: Jede versionierte Datei ist eine normale Datei
// (100644). Ausführbar (100755) sind genau die Skripte der Positivliste, die
// direkt gestartet werden; alles andere startet über `node …` oder `sh …`.
// Symlinks (120000) und Submodule (160000) gibt es nicht – sie verweisen aus
// dem Baum heraus bzw. auf fremde Stände, und der Vertragsexport bricht bei
// ihnen ohnehin ab (scripts/vertrag-export.mjs, RT2-K-01). Ein überflüssiges
// Ausführungsrecht macht aus jeder Datei einen möglichen Einstiegspunkt
// (Build-Kontext, Image, Arbeitsbaum); `chmod -R u=rwX,go=rX` im Dockerfile
// übernimmt es sonst in die Images.
//
// Geprüft wird der Index (`git ls-files -s`), nicht der Arbeitsbaum: Unter
// Windows oder mit `core.fileMode=false` sagt dieser nichts über den Modus.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { blobInhalte, indexEintraege } from './repo-git';

/** Ausführbare Dateien mit Begründung (wird direkt gestartet). */
const AUSFUEHRBAR: Record<string, string> = {
  'packages/db/betrieb/migrate.sh':
    'ENTRYPOINT des Images tcms-migrate (Dockerfile setzt dort zusätzlich 0755).',
  'scripts/pruefe-lieferkette.sh':
    'Lieferketten-Prüfung vor jeder Installation, lokal auch direkt aufgerufen (AGENTS.md).',
  'scripts/simuliere-image.sh':
    'Laufzeit-Simulation des Images, laut README direkt als scripts/simuliere-image.sh gestartet.',
};

/** Befunde eines Index: jede Abweichung von der Positivliste. */
export function modusBefunde(
  eintraege: readonly { modus: string; pfad: string }[],
  ausfuehrbar: Readonly<Record<string, string>> = AUSFUEHRBAR,
): string[] {
  const befunde: string[] = [];
  const gesehen = new Set<string>();
  for (const e of eintraege) {
    const erwartet = Object.hasOwn(ausfuehrbar, e.pfad) ? '100755' : '100644';
    if (Object.hasOwn(ausfuehrbar, e.pfad)) gesehen.add(e.pfad);
    if (e.modus !== erwartet) befunde.push(`${e.pfad}: ${e.modus}, erwartet ${erwartet}`);
  }
  for (const pfad of Object.keys(ausfuehrbar)) {
    if (!gesehen.has(pfad)) befunde.push(`${pfad}: in der Positivliste, aber nicht versioniert`);
  }
  return befunde;
}

describe('modusBefunde (Prüfer)', () => {
  const liste = { 'a.sh': 'Testskript' };

  it('lässt normale Dateien und die Positivliste zu', () => {
    expect(
      modusBefunde(
        [
          { modus: '100644', pfad: 'b.ts' },
          { modus: '100755', pfad: 'a.sh' },
        ],
        liste,
      ),
    ).toEqual([]);
  });

  it('meldet ausführbare Dateien außerhalb der Liste, Symlinks und Submodule', () => {
    expect(
      modusBefunde(
        [
          { modus: '100755', pfad: 'a.sh' },
          { modus: '100755', pfad: 'b.ts' },
          { modus: '120000', pfad: 'c' },
          { modus: '160000', pfad: 'd' },
        ],
        liste,
      ),
    ).toEqual([
      'b.ts: 100755, erwartet 100644',
      'c: 120000, erwartet 100644',
      'd: 160000, erwartet 100644',
    ]);
  });

  it('meldet ein Skript der Liste ohne Ausführungsrecht oder ohne Datei', () => {
    expect(modusBefunde([{ modus: '100644', pfad: 'a.sh' }], liste)).toEqual([
      'a.sh: 100644, erwartet 100755',
    ]);
    expect(modusBefunde([], liste)).toEqual(['a.sh: in der Positivliste, aber nicht versioniert']);
  });
});

describe('Repository: Dateimodi', () => {
  const eintraege = indexEintraege();

  it('nur die Skripte der Positivliste sind ausführbar, alles andere 100644', () => {
    expect(eintraege.length).toBeGreaterThan(300);
    expect(modusBefunde(eintraege)).toEqual([]);
  });

  it('jedes ausführbare Skript beginnt mit einer Shebang-Zeile und ist begründet', () => {
    const skripte = eintraege.filter((e) => Object.hasOwn(AUSFUEHRBAR, e.pfad));
    const inhalte = blobInhalte(skripte.map((e) => e.objekt));
    for (const e of skripte) {
      expect(inhalte.get(e.objekt)!.subarray(0, 2).toString('utf8'), e.pfad).toBe('#!');
      expect(AUSFUEHRBAR[e.pfad]!.trim().length, e.pfad).toBeGreaterThanOrEqual(30);
    }
  });
});
