import { describe, expect, it } from 'vitest';
import { bewertePhasen, pruflast, utc, type PhasenFakten } from '../index';

const voll: PhasenFakten = {
  teilbereichAbgegrenzt: true,
  profilErfasst: true,
  zieleGesamt: 3,
  zieleFreigegeben: 3,
  vorschlaegeOffen: 0,
  risikenAktiv: 22,
  risikenOhneBewertung: 0,
  risikenNichtFreigegeben: 0,
  risikenUeberAppetitOhneKontrolle: 0,
  kontrollenOhnePflichtattribute: 0,
  beschreibungFreigegeben: true,
  beschreibungVersion: '1.0',
  angemessenheitStichtag: utc(2026, 6, 30),
  wirksamAb: utc(2026, 7, 1),
  wirksamBis: utc(2026, 12, 31),
  durchfuehrungenImZeitraum: 58,
  heute: utc(2026, 10, 16),
};

describe('Phasen', () => {
  it('Talwind steht im Wirksamkeitszeitraum (Phase 6)', () => {
    const r = bewertePhasen(voll);
    expect(r.aktiv).toBe(6);
    expect(r.phasen[5]!.bedingungen.filter((b) => b.erfuellt)).toHaveLength(2);
  });
  it('nach Zeitraumende Prüfung & Regelbetrieb', () => {
    expect(bewertePhasen({ ...voll, heute: utc(2027, 1, 2) }).aktiv).toBe(7);
  });
  it('fehlende Designbeurteilung hält in Phase 3', () => {
    expect(bewertePhasen({ ...voll, risikenUeberAppetitOhneKontrolle: 2 }).aktiv).toBe(3);
  });
  it('ohne freigegebene Beschreibung Phase 4', () => {
    expect(bewertePhasen({ ...voll, beschreibungFreigegeben: false }).aktiv).toBe(4);
  });
});

describe('Prüflast', () => {
  it('zählt je Governance-Typ und Auslösungen getrennt', () => {
    const d = (m: number, gt: 'FP' | 'FF' | 'IN', aus = false, ent = false) => ({
      faelligAm: utc(2026, m, 10),
      gt,
      ausserplanmaessig: aus,
      entfallen: ent,
    });
    const last = pruflast(
      [
        d(11, 'FP'),
        d(11, 'FP'),
        d(11, 'FF'),
        d(11, 'FF', true),
        d(11, 'IN', false, true),
        d(12, 'FP'),
      ],
      '2026-11',
    );
    expect(last).toEqual({ monat: '2026-11', FP: 2, FF: 1, IN: 0, ausloesungen: 1, gesamt: 4 });
  });
});
