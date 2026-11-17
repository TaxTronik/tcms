import { describe, expect, it } from 'vitest';
import {
  betriebsStand,
  ereignisErledigt,
  naechsterFeststellungsschritt,
  p153Abschliessend,
  p153Offen,
  statusAm,
  utc,
} from '../index';

const basis = {
  periodeVon: utc(2026, 9, 1),
  periodeBis: utc(2026, 9, 30),
  faelligAm: utc(2026, 10, 10),
  zurueckgewiesenAm: null,
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

describe('Abgeleiteter Status nach Zurückweisung', () => {
  // fällig 10.10., eingereicht 05.10., zurückgewiesen 12.10.
  const zurueck = {
    ...basis,
    status: 'ZURUECKGEWIESEN' as const,
    begonnenAm: utc(2026, 10, 2),
    eingereichtAm: new Date('2026-10-05T09:00:00Z'),
    zurueckgewiesenAm: new Date('2026-10-12T09:00:00Z'),
  };
  it('zwischen Einreichung und Zurückweisung: zur Gegenzeichnung', () => {
    expect(statusAm(zurueck, utc(2026, 10, 3))).toBe('IN_DURCHFUEHRUNG');
    expect(statusAm(zurueck, utc(2026, 10, 7))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(zurueck, utc(2026, 10, 11))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(zurueck, utc(2026, 10, 12))).toBe('UEBERFAELLIG');
  });
  it('vor der Fälligkeit zurückgewiesen: zurückgewiesen ab dem Tag der Zurückweisung', () => {
    const d = { ...zurueck, zurueckgewiesenAm: new Date('2026-10-08T09:00:00Z') };
    expect(statusAm(d, utc(2026, 10, 7))).toBe('ZUR_GEGENZEICHNUNG');
    expect(statusAm(d, utc(2026, 10, 8))).toBe('ZURUECKGEWIESEN');
    expect(statusAm(d, utc(2026, 10, 11))).toBe('UEBERFAELLIG');
  });
  it('ohne gespeicherte Zurückweisung (Altbestand): zurückgewiesen ab der Einreichung', () => {
    const d = { ...zurueck, zurueckgewiesenAm: null };
    expect(statusAm(d, utc(2026, 10, 7))).toBe('ZURUECKGEWIESEN');
  });
  it('erneut eingereicht: zurückgewiesen bis zur erneuten Einreichung', () => {
    const d = {
      ...zurueck,
      status: 'ZUR_GEGENZEICHNUNG' as const,
      eingereichtAm: new Date('2026-10-14T09:00:00Z'),
    };
    expect(statusAm(d, utc(2026, 10, 12))).toBe('UEBERFAELLIG');
    expect(statusAm(d, utc(2026, 10, 14))).toBe('ZUR_GEGENZEICHNUNG');
    const frueh = { ...d, faelligAm: utc(2026, 10, 31) };
    expect(statusAm(frueh, utc(2026, 10, 13))).toBe('ZURUECKGEWIESEN');
  });
  it('Betriebsstand überspringt die eingereichte Durchführung bis zur Zurückweisung', () => {
    const aug = {
      id: 'a',
      angelegtAm: utc(2026, 7, 1),
      nachtragZuId: null,
      periodeVon: utc(2026, 8, 1),
      periodeBis: utc(2026, 8, 31),
      faelligAm: utc(2026, 9, 10),
      zurueckgewiesenAm: null,
      status: 'OHNE_BEFUND' as const,
      abgeschlossenAm: utc(2026, 9, 9),
    };
    const sep = { ...zurueck, id: 's', nachtragZuId: null, angelegtAm: utc(2026, 7, 1) };
    expect(betriebsStand([aug, sep], utc(2026, 10, 11))).toBe('OK');
    expect(betriebsStand([aug, sep], utc(2026, 10, 12))).toBe('UEBERFAELLIG');
  });
});

describe('Betriebsstand einer Kontrolle', () => {
  it('nimmt die jüngste abgeschlossene oder überfällige Durchführung', () => {
    const aug = {
      id: 'a',
      angelegtAm: utc(2026, 7, 1),
      nachtragZuId: null,
      periodeVon: utc(2026, 8, 1),
      periodeBis: utc(2026, 8, 31),
      faelligAm: utc(2026, 9, 10),
      zurueckgewiesenAm: null,
      status: 'OHNE_BEFUND' as const,
      abgeschlossenAm: utc(2026, 9, 9),
    };
    const sep = {
      ...basis,
      id: 's',
      nachtragZuId: null,
      angelegtAm: utc(2026, 7, 1),
      status: 'GEPLANT' as const,
    };
    expect(betriebsStand([aug, sep], utc(2026, 10, 5))).toBe('OK');
    expect(betriebsStand([aug, sep], utc(2026, 10, 16))).toBe('UEBERFAELLIG');
    expect(betriebsStand([], utc(2026, 10, 16))).toBe('KEINE');
  });

  // September ohne Befund abgeschlossen, danach Nachtrag derselben Periode.
  const original = {
    ...basis,
    id: 'z-original',
    nachtragZuId: null,
    angelegtAm: new Date('2026-08-01T08:00:00Z'),
    status: 'OHNE_BEFUND' as const,
    eingereichtAm: utc(2026, 10, 5),
    abgeschlossenAm: utc(2026, 10, 8),
  };
  const nachtrag = {
    ...basis,
    id: 'a-nachtrag',
    nachtragZuId: 'z-original',
    angelegtAm: new Date('2026-10-20T08:00:00Z'),
    faelligAm: utc(2026, 11, 3),
    status: 'MIT_BEFUND' as const,
    eingereichtAm: utc(2026, 10, 25),
    abgeschlossenAm: utc(2026, 10, 27),
  };

  it('ein Nachtrag mit Befund geht vor sein Original – unabhängig von der Eingabereihenfolge', () => {
    expect(betriebsStand([original, nachtrag], utc(2026, 10, 28))).toBe('MIT_BEFUND');
    expect(betriebsStand([nachtrag, original], utc(2026, 10, 28))).toBe('MIT_BEFUND');
    // Vor dem Abschluss des Nachtrags gilt das Original.
    expect(betriebsStand([original, nachtrag], utc(2026, 10, 21))).toBe('OK');
  });

  it('ein überfälliger Nachtrag wirkt wie jede überfällige Durchführung', () => {
    const offen = {
      ...nachtrag,
      status: 'IN_DURCHFUEHRUNG' as const,
      eingereichtAm: null,
      abgeschlossenAm: null,
    };
    expect(betriebsStand([original, offen], utc(2026, 11, 4))).toBe('UEBERFAELLIG');
    expect(betriebsStand([offen, original], utc(2026, 11, 4))).toBe('UEBERFAELLIG');
  });

  it('der Nachtrag geht vor, auch wenn sein Anlagezeitpunkt älter erscheint (andere Uhr)', () => {
    const frueh = { ...nachtrag, angelegtAm: new Date('2026-07-01T08:00:00Z') };
    expect(betriebsStand([original, frueh], utc(2026, 10, 28))).toBe('MIT_BEFUND');
    expect(betriebsStand([frueh, original], utc(2026, 10, 28))).toBe('MIT_BEFUND');
  });

  it('Nachtrag zum Nachtrag: die letzte Korrektur zählt', () => {
    const zweiter = {
      ...nachtrag,
      id: '0-zweiter',
      nachtragZuId: nachtrag.id,
      angelegtAm: new Date('2026-07-01T08:00:00Z'),
      status: 'OHNE_BEFUND' as const,
    };
    for (const xs of [
      [original, nachtrag, zweiter],
      [zweiter, nachtrag, original],
      [nachtrag, zweiter, original],
    ]) {
      expect(betriebsStand(xs, utc(2026, 10, 28))).toBe('OK');
    }
  });

  it('gleiche Periode ohne Nachtrag, gleicher Anlagezeitpunkt: die ID entscheidet, nicht die Reihenfolge', () => {
    const a = { ...original, id: 'a' };
    const b = { ...nachtrag, id: 'b', nachtragZuId: null, angelegtAm: original.angelegtAm };
    expect(betriebsStand([a, b], utc(2026, 10, 28))).toBe('MIT_BEFUND');
    expect(betriebsStand([b, a], utc(2026, 10, 28))).toBe('MIT_BEFUND');
    // Später angelegt geht vor (außerplanmäßige Durchführung derselben Periode).
    const spaeter = { ...a, angelegtAm: new Date('2026-09-02T08:00:00Z') };
    expect(betriebsStand([spaeter, b], utc(2026, 10, 28))).toBe('OK');
    expect(betriebsStand([b, spaeter], utc(2026, 10, 28))).toBe('OK');
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

describe('§-153-Würdigung offen (eine Regel für alle Lesepfade)', () => {
  const ende = utc(2026, 10, 31);
  const f = {
    auswirkung: 'JA' as const,
    status: 'IN_WUERDIGUNG' as const,
    p153Entscheidung: null as string | null,
    p153EntschiedenAm: null as Date | null,
  };

  it('„weitere Klärung" ist nicht abschließend: die Würdigung bleibt offen', () => {
    expect(p153Abschliessend('WEITERE_KLAERUNG')).toBe(false);
    expect(p153Abschliessend(null)).toBe(false);
    expect(p153Abschliessend('KEINE_PFLICHT')).toBe(true);
    const klaerung = {
      ...f,
      p153Entscheidung: 'WEITERE_KLAERUNG',
      p153EntschiedenAm: utc(2026, 10, 1),
    };
    expect(p153Offen(klaerung, ende)).toBe(true);
  });

  it('abschließende Entscheidung bis zum Stichtag schließt, danach nicht', () => {
    const entschieden = {
      ...f,
      p153Entscheidung: 'BERICHTIGUNG',
      p153EntschiedenAm: utc(2026, 10, 1),
    };
    expect(p153Offen(entschieden, ende)).toBe(false);
    expect(p153Offen(entschieden, utc(2026, 9, 30))).toBe(true);
  });

  it('ohne Steuerwirkung oder verworfen nie offen', () => {
    expect(p153Offen(f, ende)).toBe(true);
    expect(p153Offen({ ...f, auswirkung: 'NEIN' }, ende)).toBe(false);
    expect(p153Offen({ ...f, auswirkung: 'UNKLAR' }, ende)).toBe(true);
    expect(p153Offen({ ...f, status: 'VERWORFEN' }, ende)).toBe(false);
  });
});
