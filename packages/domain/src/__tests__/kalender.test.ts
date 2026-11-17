import { describe, expect, it } from 'vitest';
import {
  fmtDatum,
  fmtDatumKurz,
  fmtDatumZeit,
  isoDatum,
  kalenderjahr,
  kalendertag,
  kalendertagVon,
  monatSchluessel,
  nachTag,
  tageZwischen,
  tagesbeginn,
  tagesende,
  utc,
} from '../index';

const z = (iso: string) => new Date(iso);

describe('Kalendertag (Europe/Berlin) eines Zeitpunkts', () => {
  it('23:30 UTC im Winter ist in Berlin schon der nächste Tag (00:30 MEZ)', () => {
    expect(kalendertag(z('2026-11-16T23:30:00Z'))).toBe('2026-11-17');
    expect(kalendertag(z('2026-11-16T22:59:59.999Z'))).toBe('2026-11-16');
    expect(kalendertag(z('2026-11-16T23:00:00Z'))).toBe('2026-11-17');
  });

  it('22:30 UTC im Sommer ist in Berlin schon der nächste Tag (00:30 MESZ)', () => {
    expect(kalendertag(z('2026-07-17T22:30:00Z'))).toBe('2026-07-18');
    expect(kalendertag(z('2026-07-17T21:59:59.999Z'))).toBe('2026-07-17');
    expect(kalendertag(z('2026-07-17T23:30:00Z'))).toBe('2026-07-18');
  });

  it('Kalendertage (UTC-Mitternacht) bleiben derselbe Tag', () => {
    for (const d of [utc(2026, 1, 1), utc(2026, 3, 29), utc(2026, 10, 25), utc(2026, 12, 31)]) {
      expect(kalendertagVon(d).getTime()).toBe(d.getTime());
      expect(isoDatum(d)).toBe(d.toISOString().slice(0, 10));
    }
  });

  it('Jahreswechsel: 31.12. 23:30 UTC gehört zum neuen Jahr', () => {
    expect(kalenderjahr(z('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(kalenderjahr(z('2026-12-31T22:59:59Z'))).toBe(2026);
    expect(kalenderjahr(utc(2027, 1, 1))).toBe(2027);
  });

  it('Formatierung nennt den Berliner Kalendertag, passend zu fmtDatumZeit', () => {
    const d = z('2026-11-17T23:30:00Z');
    expect(fmtDatum(d)).toBe('18.11.2026');
    expect(fmtDatumKurz(d)).toBe('18.11.');
    expect(isoDatum(d)).toBe('2026-11-18');
    expect(fmtDatumZeit(d).startsWith('18.11.2026')).toBe(true);
    expect(isoDatum(z('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(monatSchluessel(z('2026-11-30T23:30:00Z'))).toBe('2026-12');
  });

  it('nachTag und tageZwischen vergleichen Berliner Kalendertage', () => {
    const nacht = z('2026-11-17T23:30:00Z'); // 18.11., 00:30 Uhr
    expect(nachTag(nacht, utc(2026, 11, 17))).toBe(true);
    expect(nachTag(nacht, utc(2026, 11, 18))).toBe(false);
    expect(tageZwischen(utc(2026, 11, 17), nacht)).toBe(1);
    expect(tageZwischen(nacht, utc(2026, 11, 18))).toBe(0);
  });
});

describe('Tagesgrenzen (Europe/Berlin)', () => {
  it('Tagesbeginn und -ende im Winter (MEZ) und Sommer (MESZ)', () => {
    expect(tagesbeginn(utc(2026, 11, 17)).toISOString()).toBe('2026-11-16T23:00:00.000Z');
    expect(tagesende(utc(2026, 11, 17)).toISOString()).toBe('2026-11-17T22:59:59.999Z');
    expect(tagesbeginn(utc(2026, 7, 17)).toISOString()).toBe('2026-07-16T22:00:00.000Z');
    expect(tagesende(utc(2026, 7, 17)).toISOString()).toBe('2026-07-17T21:59:59.999Z');
  });

  it('Tage der Zeitumstellung haben 23 bzw. 25 Stunden', () => {
    // 29.03.2026: 02:00 → 03:00 Uhr; 25.10.2026: 03:00 → 02:00 Uhr.
    const maerz =
      tagesende(utc(2026, 3, 29)).getTime() + 1 - tagesbeginn(utc(2026, 3, 29)).getTime();
    const okt =
      tagesende(utc(2026, 10, 25)).getTime() + 1 - tagesbeginn(utc(2026, 10, 25)).getTime();
    expect(maerz).toBe(23 * 3_600_000);
    expect(okt).toBe(25 * 3_600_000);
  });

  it('ein Zeitpunkt 00:30 Uhr Berliner Zeit liegt nach dem Ende des Vortags', () => {
    const nacht = z('2026-11-16T23:30:00Z'); // 17.11., 00:30 Uhr
    expect(nacht.getTime()).toBeGreaterThan(tagesende(utc(2026, 11, 16)).getTime());
    expect(nacht.getTime()).toBeLessThanOrEqual(tagesende(utc(2026, 11, 17)).getTime());
    // Tagesende eines Zeitpunkts ist das Ende seines Berliner Tags.
    expect(tagesende(nacht).toISOString()).toBe('2026-11-17T22:59:59.999Z');
  });

  it('ungültige Daten bleiben ungültig', () => {
    expect(Number.isNaN(tagesende(new Date(Number.NaN)).getTime())).toBe(true);
    expect(Number.isNaN(kalendertagVon(new Date(Number.NaN)).getTime())).toBe(true);
  });
});
