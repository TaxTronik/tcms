// =============================================================================
// Audit-Kette: Texte nur wohlgeformt (Befunde 12 und 99, Prüfung 17.11.2026).
//
// Ein einzelnes Surrogat in `actorName` (oder einem anderen Textfeld) hasht als
// JSON-Escape `\udXXX`, der Treiber schreibt aber U+FFFD in die TEXT-Spalte:
// Der gespeicherte Eintrag passte nie mehr zu seinem Hash, und `tcms_app` kann
// ihn nicht korrigieren. `schreibeAuditFolge` weist solche Einträge deshalb vor
// Sperre, Hash und INSERT ab. Ohne Datenbank: Die Transaktion ist eine
// Attrappe, die jeden Zugriff festhält.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { schreibeAuditFolge, type AuditInput } from '../audit';
import type { Tx } from '../tenant';

/** Fehler der Attrappe: Die Prüfung muss vor jedem Zugriff abweisen. */
class TransaktionBeruehrt extends Error {}

function attrappe() {
  const zugriffe: string[] = [];
  const tx = new Proxy(
    {},
    {
      get(_ziel, name) {
        zugriffe.push(String(name));
        throw new TransaktionBeruehrt();
      },
    },
  ) as Tx;
  return { tx, zugriffe };
}

const EINGABE: AuditInput = {
  actorId: 'bbbbbbbb-0000-4000-8000-000000000001',
  actorName: 'StB Dr. Anna Roth',
  aktion: 'tcms.test.x',
  objektTyp: 'X',
  objektId: '1',
  programmId: null,
};

async function fehlerVon(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

describe('schreibeAuditFolge: nur wohlgeformte Texte in der Kette', () => {
  it.each([
    ['actorName mit hohem Surrogat am Ende', { actorName: `System: ${'x'.repeat(191)}\ud83d` }],
    ['actorName mit tiefem Surrogat', { actorName: 'Anna \ude00 Roth' }],
    ['objektId mit Surrogat', { objektId: 'a\ud800' }],
    ['programmId mit Surrogat', { programmId: '\udfff' }],
  ])('weist vor jedem Datenbankzugriff ab: %s', async (_fall, over) => {
    const { tx, zugriffe } = attrappe();
    const fehler = await fehlerVon(schreibeAuditFolge(tx, [EINGABE, { ...EINGABE, ...over }]));
    expect(fehler).toBeInstanceOf(Error);
    expect(fehler).not.toBeInstanceOf(TransaktionBeruehrt);
    expect(zugriffe).toEqual([]);
  });

  it('Gegenprobe: wohlgeformte Texte (auch Emoji-Paare) erreichen die Transaktion', async () => {
    const { tx, zugriffe } = attrappe();
    const fehler = await fehlerVon(
      schreibeAuditFolge(tx, [{ ...EINGABE, actorName: `Zustellung \u{1f4ec}` }]),
    );
    expect(fehler).toBeInstanceOf(TransaktionBeruehrt);
    expect(zugriffe.length).toBeGreaterThan(0);
  });
});
