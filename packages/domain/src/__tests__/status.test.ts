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
