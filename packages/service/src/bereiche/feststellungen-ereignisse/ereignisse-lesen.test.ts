// =============================================================================
// Verlauf eines Ereignisses (rein): Jede Audit-Aktion, die der Dienst auf
// Ereignisse oder ihre Folgen schreibt – auch aus anderen Bereichen
// (Profiländerung, Neubewertung) –, hat einen lesbaren Text. Nie erscheint ein
// technischer Aktionsname oder eine leere Bezeichnung.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EREIGNIS_VERLAUF_AKTIONEN, verlaufText } from './ereignisse-lesen';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function quelldateien(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const pfad = join(dir, name);
    if (statSync(pfad).isDirectory()) return name === '__tests__' ? [] : quelldateien(pfad);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [pfad] : [];
  });
}

/** Alle geschriebenen Aktionen `tcms.ereignis.*` im Laufzeitcode des Dienstes. */
function geschriebeneAktionen(): Set<string> {
  const aktionen = new Set<string>();
  for (const datei of quelldateien(SRC)) {
    const text = readFileSync(datei, 'utf8');
    for (const m of text.matchAll(/aktion:\s*'(tcms\.ereignis\.[a-z_]+)'/g)) aktionen.add(m[1]!);
  }
  return aktionen;
}

describe('Verlauf eines Ereignisses', () => {
  it('kennt jede Aktion, die der Dienst auf Ereignisse und Folgen schreibt', () => {
    const geschrieben = geschriebeneAktionen();
    // Plausibilität: die Schreiber anderer Bereiche sind dabei.
    for (const a of ['tcms.ereignis.angelegt', 'tcms.ereignis.erledigt', 'tcms.ereignis.gemeldet'])
      expect(geschrieben).toContain(a);
    for (const a of geschrieben) {
      expect(EREIGNIS_VERLAUF_AKTIONEN, a).toContain(a);
      const t = verlaufText(a, {});
      expect(t, a).toBeTruthy();
      expect(t, a).not.toContain('tcms.');
    }
  });

  it('nennt die Folge auch ohne `label` (Neubewertung) und den Anlass der Profiländerung', () => {
    expect(
      verlaufText('tcms.ereignis.folge_erledigt', {
        folge: 'RISIKO_NEU_BEWERTEN',
        ziel: 'EC-UST-02',
        durch: 'Neubewertung',
      }),
    ).toBe('Folge erledigt: Risiko neu bewerten EC-UST-02 (durch Neubewertung)');
    expect(verlaufText('tcms.ereignis.angelegt', { quelle: 'Profiländerung' })).toMatch(
      /Geschäftsprofils/,
    );
    expect(verlaufText('tcms.ereignis.unbekannt', {})).toBeNull();
  });
});
