import { describe, expect, it } from 'vitest';
import {
  betriebsStand,
  ereignisErledigt,
  naechsterFeststellungsschritt,
  statusAm,
  utc,
} from '../index';

const basis = {
  periodeVon: utc(2026, 9, 1),
  periodeBis: utc(2026, 9, 30),
  faelligAm: utc(2026, 10, 10),
};

describe('Abgeleiteter Status einer Durchführung', () => {
  it('geplant → fällig → überfällig nach Datum', () => {
    const d = { ...basis, status: 'GEPLANT' as const };
    expect(statusAm(d, utc(2026, 9, 15))).toBe('GEPLANT');
    expect(statusAm(d, utc(2026, 9, 30))).toBe('FAELLIG');
    expect(statusAm(d, utc(2026, 10, 10))).toBe('FAELLIG');
    expect(statusAm(d, utc(2026, 10, 11))).toBe('UEBERFAELLIG');
  });

  it('eingereicht ist nicht überfällig, auch nach Fälligkeit', () => {
    const d = { ...basis, status: 'ZUR_GEGENZEICHNUNG' as const, eingereichtAm: utc(2026, 10, 9) };
    expect(statusAm(d, utc(2026, 10, 16))).toBe('ZUR_GEGENZEICHNUNG');
  });

  it('zeigt zum historischen Stichtag den damaligen Status', () => {
    const d = {
      ...basis,
      status: 'OHNE_BEFUND' as const,
      begonnenAm: utc(2026, 10, 2),
      eingereichtAm: utc(2026, 10, 5),
      abgeschlossenAm: utc(2026, 10, 8),
    };
    expect(statusAm(d, utc(2026, 10, 3))).toBe('IN_DURCHFUEHRUNG');
    expect(statusAm(d, utc(2026, 10, 6))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(d, utc(2026, 10, 8))).toBe('OHNE_BEFUND');
  });
});

describe('Abgeleiteter Status: Zeitpunkte nach Berliner Kalendertag', () => {
  // 2026-11-17T23:30Z ist der 18.11. um 00:30 Uhr (MEZ), 2026-07-17T22:30Z der 18.07. um 00:30 Uhr (MESZ).
  const nov = {
    periodeVon: utc(2026, 10, 1),
    periodeBis: utc(2026, 10, 31),
    faelligAm: utc(2026, 11, 30),
    zurueckgewiesenAm: null,
  };
  it('eine Gegenzeichnung um 00:30 Uhr zählt zum neuen Tag (Winter)', () => {
    const d = {
      ...nov,
      status: 'OHNE_BEFUND' as const,
      begonnenAm: utc(2026, 11, 2),
      eingereichtAm: utc(2026, 11, 5),
      abgeschlossenAm: new Date('2026-11-17T23:30:00Z'),
    };
    expect(statusAm(d, utc(2026, 11, 17))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(d, utc(2026, 11, 18))).toBe('OHNE_BEFUND');
  });
  it('eine Gegenzeichnung um 00:30 Uhr zählt zum neuen Tag (Sommer)', () => {
    const d = {
      periodeVon: utc(2026, 6, 1),
      periodeBis: utc(2026, 6, 30),
      faelligAm: utc(2026, 7, 31),
      zurueckgewiesenAm: null,
      status: 'MIT_BEFUND' as const,
      eingereichtAm: utc(2026, 7, 5),
      abgeschlossenAm: new Date('2026-07-17T22:30:00Z'),
    };
    expect(statusAm(d, utc(2026, 7, 17))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(d, utc(2026, 7, 18))).toBe('MIT_BEFUND');
  });
  it('23:59 Uhr Berliner Zeit bleibt am selben Tag', () => {
    const d = {
      ...nov,
      status: 'OHNE_BEFUND' as const,
      eingereichtAm: utc(2026, 11, 5),
      abgeschlossenAm: new Date('2026-11-17T22:59:59.999Z'),
    };
    expect(statusAm(d, utc(2026, 11, 17))).toBe('OHNE_BEFUND');
  });
});

describe('Betriebsstand einer Kontrolle', () => {
  it('nimmt die jüngste abgeschlossene oder überfällige Durchführung', () => {
    const aug = {
      periodeVon: utc(2026, 8, 1),
      periodeBis: utc(2026, 8, 31),
      faelligAm: utc(2026, 9, 10),
      status: 'OHNE_BEFUND' as const,
      abgeschlossenAm: utc(2026, 9, 9),
    };
    const sep = { ...basis, status: 'GEPLANT' as const };
    expect(betriebsStand([aug, sep], utc(2026, 10, 5))).toBe('OK');
    expect(betriebsStand([aug, sep], utc(2026, 10, 16))).toBe('UEBERFAELLIG');
    expect(betriebsStand([], utc(2026, 10, 16))).toBe('KEINE');
  });
});

describe('Feststellung', () => {
  it('blockiert Maßnahmen, solange die §-153-Würdigung aussteht', () => {
    const r = naechsterFeststellungsschritt({
      status: 'IN_WUERDIGUNG',
      auswirkung: 'JA',
      p153Entschieden: false,
      massnahmen: 1,
      massnahmenOffen: 1,
      nachkontrolleOhneBefund: false,
    });
    expect(r.blockiert).toContain('§-153');
  });
  it('schließt nur mit Nachkontrolle ohne Befund', () => {
    const f = {
      status: 'NACHKONTROLLE' as const,
      auswirkung: 'NEIN' as const,
      p153Entschieden: false,
      massnahmen: 1,
      massnahmenOffen: 0,
      nachkontrolleOhneBefund: false,
    };
    expect(naechsterFeststellungsschritt(f).blockiert).not.toBeNull();
    expect(
      naechsterFeststellungsschritt({ ...f, nachkontrolleOhneBefund: true }).blockiert,
    ).toBeNull();
  });
});

describe('Ereignis', () => {
  it('ist erst erledigt, wenn jede Folge erledigt oder verworfen ist', () => {
    expect(ereignisErledigt([])).toBe(false);
    expect(ereignisErledigt([{ status: 'ERLEDIGT' }, { status: 'ANGELEGT' }])).toBe(false);
    expect(ereignisErledigt([{ status: 'ERLEDIGT' }, { status: 'VERWORFEN' }])).toBe(true);
  });
});
