// RT-01: Vertrauliche Feststellungen für Nicht-Beteiligte sind in allen
// Antworten eine eigene, strikte Variante (`maskiert: true`). Der Dienst prüft
// seine Antwort vor dem Senden gegen diese Schemas (fail closed): Ein
// zusätzliches Inhaltsfeld an einer maskierten Feststellung wird abgewiesen.
import { describe, expect, it } from 'vitest';
import { DurchfuehrungDetailSchema } from './durchfuehrung';
import { KontextAntwortSchema } from './lesepfade';
import { KontrollDurchfuehrungSchema } from './risiken-kontrollen';

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

const kontextFeststellung = KontextAntwortSchema.shape.feststellungen.element;
const durchfuehrungFeststellung = DurchfuehrungDetailSchema.shape.feststellungen.element;
const kontrollFeststellung = KontrollDurchfuehrungSchema.shape.feststellung;

/** Inhalte einer Feststellung, die eine maskierte Sicht nie tragen darf. */
const INHALT: Record<string, unknown> = {
  titel: 'Selbstanzeige',
  sachverhalt: 'x',
  quelleText: 'x',
  klasse: 'STEUERLICHER_FEHLER',
  schwere: 'HOCH',
  auswirkung: 'JA',
  p153Entscheidung: 'UEBERGABE',
  p153Offen: true,
  massnahmenOffen: 1,
  massnahmen: 1,
  aeltesteFrist: '2026-11-30T00:00:00.000Z',
  risikoCodes: ['EC-UST-02'],
  beteiligte: ['22222222-2222-4222-8222-222222222222'],
};

describe('Vertrag: maskierte vertrauliche Feststellungen', () => {
  const kontextMaskiert = {
    maskiert: true,
    id: 'f1',
    nummer: 'F-2026-001',
    vertraulich: true,
    status: 'IN_WUERDIGUNG',
    erfasstAm: '2026-10-01T09:00:00.000Z',
  };

  it('Kontext: nur Nummer, Status und Erfassung; jedes Inhaltsfeld wird abgewiesen', () => {
    expect(ok(kontextFeststellung, kontextMaskiert)).toBe(true);
    for (const [feld, wert] of Object.entries(INHALT)) {
      expect(ok(kontextFeststellung, { ...kontextMaskiert, [feld]: wert }), feld).toBe(false);
    }
    // Maskiert heißt immer vertraulich.
    expect(ok(kontextFeststellung, { ...kontextMaskiert, vertraulich: false })).toBe(false);
    // Ohne Diskriminator keine Sicht.
    const { maskiert: _m, ...ohne } = kontextMaskiert;
    expect(ok(kontextFeststellung, ohne)).toBe(false);
  });

  it('Durchführung: maskiert ohne Titel und Schwere', () => {
    const m = { maskiert: true, id: 'f1', nummer: 'F-1', status: 'ERFASST', vertraulich: true };
    expect(ok(durchfuehrungFeststellung, m)).toBe(true);
    for (const [feld, wert] of Object.entries({ titel: 'x', schwere: 'HOCH' })) {
      expect(ok(durchfuehrungFeststellung, { ...m, [feld]: wert }), feld).toBe(false);
    }
    expect(ok(durchfuehrungFeststellung, { ...m, vertraulich: false })).toBe(false);
  });

  it('Kontrolle: maskiert ohne §-153-Kennzeichen', () => {
    const m = { maskiert: true, id: 'f1', nummer: 'F-1' };
    expect(ok(kontrollFeststellung, m)).toBe(true);
    expect(ok(kontrollFeststellung, { ...m, p153Offen: false })).toBe(false);
    expect(ok(kontrollFeststellung, { maskiert: false, id: 'f1', nummer: 'F-1' })).toBe(false);
    expect(
      ok(kontrollFeststellung, { maskiert: false, id: 'f1', nummer: 'F-1', p153Offen: true }),
    ).toBe(true);
  });
});
