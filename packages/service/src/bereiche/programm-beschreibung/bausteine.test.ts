// Eingefrorener Inhalt (rein): SHA-256 über kanonisches JSON, Manipulation und
// fehlende Teile werden erkannt; Abschnitte werden streng gelesen.
import { describe, expect, it } from 'vitest';
import { ABSCHNITTE } from '@tcms/domain';
import type { FeststellungSicht, TcmsKontext } from '../../kern/tcms-kontext';
import {
  baueBausteine,
  baueSnapshot,
  normalisiereAbschnitte,
  pruefeSnapshot,
  snapshotHash,
} from './bausteine';

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

describe('Baustein FESTSTELLUNGEN (RT-01)', () => {
  const erfasstAm = new Date('2026-10-01T09:00:00Z');
  const lesbar = (id: string, vertraulich: boolean): FeststellungSicht => ({
    maskiert: false,
    id,
    nummer: `F-${id}`,
    titel: `Titel ${id}`,
    sachverhalt: 'Sachverhalt',
    quelle: 'HINWEIS',
    quelleText: 'Hinweis',
    klasse: 'STEUERLICHER_FEHLER',
    schwere: 'HOCH',
    auswirkung: 'JA',
    status: 'IN_WUERDIGUNG',
    vertraulich,
    beteiligte: [],
    p153Entscheidung: null,
    p153Offen: true,
    massnahmenOffen: 0,
    massnahmen: 0,
    aeltesteFrist: null,
    erfasstAm,
    risikoCodes: [],
  });
  const k = {
    programm: null,
    profil: null,
    kontaktRollen: [],
    teilbereich: null,
    appetit: 'MITTEL',
    ziele: [],
    risiken: [],
    kontrollen: [],
    laenderStand: null,
    fernverkaeufeLfd: 0,
    fernverkaeufeVorjahr: 0,
    schwelle: { label: '—' },
    laender: [],
    stand: new Date('2026-10-19T00:00:00Z'),
    feststellungen: [
      lesbar('offen', false),
      lesbar('vertraulich-beteiligt', true),
      {
        maskiert: true,
        id: 'maskiert',
        nummer: 'F-maskiert',
        vertraulich: true,
        status: 'IN_WUERDIGUNG',
        erfasstAm,
      },
    ],
  } as unknown as TcmsKontext;

  it('enthält nie vertrauliche Feststellungen – weder maskierte noch für Beteiligte lesbare', () => {
    const b = baueBausteine(k, {
      name: () => '—',
      verantwortung: { berufstraeger: null, bearbeitung: null },
    });
    expect(b.FESTSTELLUNGEN.feststellungen.map((f) => f.nummer)).toEqual(['F-offen']);
  });
});
