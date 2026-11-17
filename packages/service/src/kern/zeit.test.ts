import { describe, expect, it } from 'vitest';
import { auditGrenze, heuteDatum, leseStand, tagAlsDatum, tagesende } from './zeit';

const HEUTE = tagAlsDatum('2026-10-16');

describe('Stichtag-Helfer (kern/zeit)', () => {
  it('„heute" kommt aus der Uhr, nie aus der Systemzeit', () => {
    const uhr = { jetzt: () => new Date(0), heute: () => '2026-10-16' };
    expect(heuteDatum(uhr).toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });

  it('tagesende: letzte Millisekunde des Kalendertags (Europe/Berlin)', () => {
    expect(tagesende(new Date('2026-10-16T13:45:00Z')).toISOString()).toBe(
      '2026-10-16T21:59:59.999Z', // MESZ
    );
    expect(tagesende(tagAlsDatum('2026-11-16')).toISOString()).toBe('2026-11-16T22:59:59.999Z');
  });

  it('Stichtagsgrenze: ein Zeitpunkt um 00:30 Uhr gehört nicht mehr zum Vortag', () => {
    // 17.11.2026, 00:30 Uhr MEZ und 18.07.2026, 00:30 Uhr MESZ
    const winter = new Date('2026-11-16T23:30:00Z');
    const sommer = new Date('2026-07-17T22:30:00Z');
    expect(winter.getTime()).toBeGreaterThan(tagesende(tagAlsDatum('2026-11-16')).getTime());
    expect(winter.getTime()).toBeLessThanOrEqual(tagesende(tagAlsDatum('2026-11-17')).getTime());
    expect(sommer.getTime()).toBeGreaterThan(tagesende(tagAlsDatum('2026-07-17')).getTime());
    // Historischer Stand des Vortags: Audit-Einträge um 00:30 Uhr liegen nach der Grenze.
    const heute = tagAlsDatum('2026-11-17');
    expect(winter.getTime()).toBeGreaterThan(
      auditGrenze(tagAlsDatum('2026-11-16'), heute).getTime(),
    );
  });

  it('leseStand: nur ein Stand vor heute ist historisch', () => {
    expect(leseStand('2026-03-31', HEUTE)).toEqual({
      stand: tagAlsDatum('2026-03-31'),
      historisch: true,
    });
    expect(leseStand(['2026-03-31', '2026-01-01'], HEUTE).stand.toISOString()).toBe(
      '2026-03-31T00:00:00.000Z',
    );
  });

  it('leseStand: heute, Zukunft, fehlend oder ungültig → aktueller Stand', () => {
    for (const v of ['2026-10-16', '2027-01-01', undefined, null, '', '16.10.2026', 'x', []]) {
      expect(leseStand(v as string | undefined, HEUTE)).toEqual({
        stand: HEUTE,
        historisch: false,
      });
    }
  });

  it('auditGrenze: historisch bis Tagesende, aktuell ohne Grenze', () => {
    expect(auditGrenze(tagAlsDatum('2026-03-31'), HEUTE).toISOString()).toBe(
      '2026-03-31T21:59:59.999Z',
    );
    expect(auditGrenze(HEUTE, HEUTE).getTime()).toBe(8_640_000_000_000_000);
  });
});
