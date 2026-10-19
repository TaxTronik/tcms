// Eingefrorener Inhalt (rein): SHA-256 über kanonisches JSON, Manipulation und
// fehlende Teile werden erkannt; Abschnitte werden streng gelesen.
import { describe, expect, it } from 'vitest';
import { ABSCHNITTE } from '@tcms/domain';
import { baueSnapshot, normalisiereAbschnitte, pruefeSnapshot, snapshotHash } from './bausteine';

const satz = {
  TEILBEREICH: null,
  ZIELE: { appetit: 'MITTEL', ziele: [] },
  RISIKOINVENTAR: { appetit: 'MITTEL', sicht: 'DESIGN', risiken: [] },
  KONTROLLMATRIX: { kontrollen: [] },
  VERANTWORTUNG: { rollen: [], kontrollen: [] },
  LAENDER: { stand: null, summeLfd: 0, summeVorjahr: 0, schwelle: '—', laender: [] },
  FESTSTELLUNGEN: { feststellungen: [] },
} as const;

describe('Snapshot', () => {
  const k = {
    mandant: { id: 'm', name: 'Test GmbH', rechtsform: 'KapG', datevNr: null },
    stand: new Date('2026-10-19T00:00:00Z'),
  };
  const abschnitte = normalisiereAbschnitte([
    {
      key: 'ziele',
      bloecke: [
        { typ: 'text', text: 'Ziele' },
        { typ: 'baustein', art: 'ZIELE' },
      ],
    },
  ]);

  it('friert nur genutzte Bausteine ein; Hash über kanonisches JSON (Schlüsselreihenfolge egal)', () => {
    const { snapshot, sha256 } = baueSnapshot(
      { nummer: '1.0', abschnitte },
      k,
      structuredClone(satz) as never,
      new Date('2026-10-19T10:00:00Z'),
    );
    expect(Object.keys(snapshot.bausteine ?? {})).toEqual(['ZIELE']);
    expect(pruefeSnapshot(snapshot, sha256)).toBe(true);
    const umsortiert = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(snapshotHash(umsortiert)).toBe(sha256);
    expect(pruefeSnapshot({ ...snapshot, nummer: '1.1' }, sha256)).toBe(false);
    expect(pruefeSnapshot(snapshot, null)).toBe(false);
    expect(pruefeSnapshot(null, sha256)).toBe(false);
    expect(pruefeSnapshot(null, null)).toBeNull();
  });

  it('liest Abschnitte streng: Unbekanntes und Ungültiges fällt auf leeren Text zurück', () => {
    const n = normalisiereAbschnitte([
      { key: 'kultur', bloecke: [{ typ: 'baustein', art: 'BOESE' }] },
      { key: '__proto__', bloecke: [] },
      { key: 'ziele', bloecke: [{ typ: 'text', text: 'ok' }], extra: 1 },
      'kein Objekt',
    ]);
    expect(n.map((a) => a.key)).toEqual(ABSCHNITTE.map((a) => a.key));
    expect(n.find((a) => a.key === 'kultur')?.bloecke).toEqual([{ typ: 'text', text: '' }]);
    expect(n.find((a) => a.key === 'ziele')?.bloecke).toEqual([{ typ: 'text', text: '' }]);
  });
});
