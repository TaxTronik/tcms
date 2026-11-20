import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoUhr, istDemo } from './zeit';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Demo-Uhr nach dem Berliner Kalender', () => {
  it('verwendet bei einem unmöglichen Demo-Tag das echte Berliner Datum', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-03-01T23:15:00Z'));
    vi.stubEnv('TCMS_DEMO_TODAY', '2026-02-29');
    expect(istDemo()).toBe(false);
    expect(demoUhr.heute()).toBe('2026-03-02');
    expect(demoUhr.jetzt().toISOString()).toBe('2026-03-01T23:15:00.000Z');
  });

  it.each([
    // Reale und simulierte Zeitumstellungen in beiden Richtungen.
    ['2026-03-29T10:34:56.789Z', '2026-01-15', '2026-01-15T11:34:56.789Z'],
    ['2026-10-25T11:34:56.789Z', '2026-07-15', '2026-07-15T10:34:56.789Z'],
    ['2026-01-15T11:34:56.789Z', '2026-03-29', '2026-03-29T10:34:56.789Z'],
    ['2026-07-15T10:34:56.789Z', '2026-10-25', '2026-10-25T11:34:56.789Z'],
    // Fehlende bzw. doppelte 02:30 am Demo-Tag.
    ['2026-01-15T01:30:00Z', '2026-03-29', '2026-03-29T01:30:00.000Z'],
    ['2026-01-15T01:30:00Z', '2026-10-25', '2026-10-25T00:30:00.000Z'],
    ['2026-10-25T01:30:00Z', '2026-10-25', '2026-10-25T01:30:00.000Z'],
    // Mitternacht und Schaltjahr.
    ['2026-11-18T23:03:00Z', '2024-02-29', '2024-02-28T23:03:00.000Z'],
  ])('überträgt %s auf %s', (echt, tag, erwartet) => {
    vi.useFakeTimers().setSystemTime(new Date(echt));
    vi.stubEnv('TCMS_DEMO_TODAY', tag);
    expect(istDemo()).toBe(true);
    expect(demoUhr.heute()).toBe(tag);
    expect(demoUhr.jetzt().toISOString()).toBe(erwartet);
  });
});
