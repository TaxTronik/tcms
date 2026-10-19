// Zustellstatus an Freigaben (Stufe 4): diskriminiert über `status`, streng
// (keine Inhalte der Nachricht, kein Code), Grund nur bei „unzustellbar" und nur
// aus der festen Liste, Zeitpunkt der Meldung außer bei „offen".
import { describe, expect, it } from 'vitest';
import { NACHRICHT_ZWECKE } from './programm-beschreibung';
import {
  FREIGABE_NACHRICHT_ZWECKE,
  FreigabeZustellungSchema,
  NACHRICHT_UNZUSTELLBAR_GRUENDE,
  ZUSTELL_STATUS,
} from './zustellung';

const ZEIT = '2026-10-19T09:00:00.000Z';
const KOPF = { zweck: 'FREIGABE_ANGEFORDERT', erstelltAm: ZEIT } as const;
const GUELTIG = {
  OFFEN: { ...KOPF, status: 'OFFEN' },
  ZUGESTELLT: { ...KOPF, status: 'ZUGESTELLT', am: ZEIT },
  UNZUSTELLBAR: { ...KOPF, status: 'UNZUSTELLBAR', am: ZEIT, grund: 'KEIN_PORTALZUGANG' },
  VERWORFEN: { ...KOPF, zweck: 'FREIGABE_CODE', status: 'VERWORFEN', am: ZEIT },
} as const;

describe('FreigabeZustellungSchema', () => {
  it('nimmt je Status die gültige Form an; Zwecke sind die Freigabe-Zwecke des Postausgangs', () => {
    expect(Object.keys(GUELTIG).sort()).toEqual([...ZUSTELL_STATUS].sort());
    for (const z of Object.values(GUELTIG)) {
      expect(FreigabeZustellungSchema.safeParse(z).success, z.status).toBe(true);
    }
    for (const zweck of FREIGABE_NACHRICHT_ZWECKE) {
      expect(NACHRICHT_ZWECKE).toContain(zweck);
      expect(FreigabeZustellungSchema.safeParse({ ...GUELTIG.OFFEN, zweck }).success).toBe(true);
    }
    for (const grund of NACHRICHT_UNZUSTELLBAR_GRUENDE) {
      expect(FreigabeZustellungSchema.safeParse({ ...GUELTIG.UNZUSTELLBAR, grund }).success).toBe(
        true,
      );
    }
  });

  it('weist Inhalte, Code, falsche Kombinationen und fremde Zwecke ab (fail closed)', () => {
    const falsch: [string, unknown][] = [
      ['unzustellbar ohne Grund', { ...GUELTIG.ZUGESTELLT, status: 'UNZUSTELLBAR' }],
      ['unzustellbar ohne Zeitpunkt', { ...KOPF, status: 'UNZUSTELLBAR', grund: 'SONSTIGES' }],
      ['Grund bei zugestellt', { ...GUELTIG.ZUGESTELLT, grund: 'SONSTIGES' }],
      ['Grund bei offen', { ...GUELTIG.OFFEN, grund: 'SONSTIGES' }],
      ['Zeitpunkt bei offen', { ...GUELTIG.OFFEN, am: ZEIT }],
      ['zugestellt ohne Zeitpunkt', { ...KOPF, status: 'ZUGESTELLT' }],
      ['Freitext-Grund', { ...GUELTIG.UNZUSTELLBAR, grund: 'Postfach voll' }],
      ['unbekannter Status', { ...GUELTIG.OFFEN, status: 'GELESEN' }],
      ['Ereignis-Zweck', { ...GUELTIG.OFFEN, zweck: 'EREIGNIS_GEMELDET' }],
      ['Text der Nachricht', { ...GUELTIG.OFFEN, text: 'Ihr Bestätigungscode: 123456' }],
      ['Code', { ...GUELTIG.UNZUSTELLBAR, code: '123456' }],
      ['Nachricht-ID', { ...GUELTIG.ZUGESTELLT, nachrichtId: 'cknachricht00000000000a' }],
      ['Vorlagendaten', { ...GUELTIG.VERWORFEN, daten: { freigabeId: 'x' } }],
    ];
    for (const [name, z] of falsch) {
      expect(FreigabeZustellungSchema.safeParse(z).success, name).toBe(false);
    }
  });
});
