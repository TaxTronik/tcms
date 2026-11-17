// =============================================================================
// Vertrag „risiken-kontrollen“: Inventar freigeben mit gesehenem Stand
// (Befund 20) und Übersteuerung aufheben (Befund 4) – Eingaben strikt,
// Begründung ≥ 30 Zeichen; Antworten mit Aufhebung und Kennzeichen „überholt“;
// Registereinträge.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { ENDPUNKTE } from '../endpunkte';
import {
  RisikenFreigabeSchrittBodySchema,
  RisikenFreigebenBodySchema,
  RisikenFreigebenSchema,
  UebersteuerungAufgehobenSchema,
  UebersteuerungAufhebenBodySchema,
  UebersteuerungAufhebenSchema,
  UebersteuerungEintragSchema,
} from './risiken-kontrollen';

const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';
const MANDANT = '0b5f0c1e-8f9a-4a39-9d0e-6d3c3c1f2a10';

describe('Inventar freigeben mit gesehenem Stand (Befund 20)', () => {
  it('je Risiko risikoId und standId, ohne Dubletten; Einreichen bleibt bei risikoIds', () => {
    const ok = {
      risiken: [
        { risikoId: 'r1', standId: 's1' },
        { risikoId: 'r2', standId: 's2' },
      ],
    };
    expect(RisikenFreigebenBodySchema.safeParse(ok).success).toBe(true);
    expect(RisikenFreigebenSchema.safeParse({ mandantId: MANDANT, ...ok }).success).toBe(true);
    for (const body of [
      { risikoIds: ['r1'] },
      { risiken: [] },
      { risiken: [{ risikoId: 'r1' }] },
      { risiken: [{ risikoId: 'r1', standId: '../s' }] },
      { risiken: [{ risikoId: 'r1', standId: 's1', klasse: 'GERING' }] },
      {
        risiken: [
          { risikoId: 'r1', standId: 's1' },
          { risikoId: 'r1', standId: 's2' },
        ],
      },
      { ...ok, risikoIds: ['r1'] },
    ]) {
      expect(RisikenFreigebenBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(ENDPUNKTE.risikenFreigeben.bodySchema).toBe(RisikenFreigebenBodySchema);
    expect(ENDPUNKTE.risikenFreigabeEinreichen.bodySchema).toBe(RisikenFreigabeSchrittBodySchema);
  });
});

describe('Übersteuerung aufheben', () => {
  it('Eingabe: nur Begründung (≥ 30 Zeichen), Mandant und Objekt-ID', () => {
    expect(UebersteuerungAufhebenBodySchema.safeParse({ begruendung: BEGRUENDUNG }).success).toBe(
      true,
    );
    expect(
      UebersteuerungAufhebenSchema.safeParse({
        mandantId: MANDANT,
        uebersteuerungId: 'cuid_123',
        begruendung: BEGRUENDUNG,
      }).success,
    ).toBe(true);
    for (const body of [
      {},
      { begruendung: 'zu kurz' },
      { begruendung: `${BEGRUENDUNG}\u0000` },
      { begruendung: BEGRUENDUNG, klasse: 'GERING' },
      { begruendung: BEGRUENDUNG, status: 'AUFGEHOBEN' },
    ]) {
      expect(UebersteuerungAufhebenBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    for (const eingabe of [
      { mandantId: 'kein-uuid', uebersteuerungId: 'x', begruendung: BEGRUENDUNG },
      { mandantId: MANDANT, uebersteuerungId: '../x', begruendung: BEGRUENDUNG },
      { mandantId: MANDANT, begruendung: BEGRUENDUNG },
    ]) {
      expect(UebersteuerungAufhebenSchema.safeParse(eingabe).success).toBe(false);
    }
  });

  it('Antwort: Status nur AUFGEHOBEN, strikt', () => {
    const ok = { uebersteuerungId: 'u1', risikoId: 'r1', status: 'AUFGEHOBEN' };
    expect(UebersteuerungAufgehobenSchema.safeParse(ok).success).toBe(true);
    expect(UebersteuerungAufgehobenSchema.safeParse({ ...ok, status: 'FREIGEGEBEN' }).success).toBe(
      false,
    );
    expect(UebersteuerungAufgehobenSchema.safeParse({ ...ok, begruendung: 'x' }).success).toBe(
      false,
    );
  });

  it('Eintrag: Aufhebung und „überholt“ sind Pflichtfelder', () => {
    const eintrag = {
      id: 'u1',
      sicht: 'DESIGN',
      klasse: 'MITTEL',
      berechnet: 'HOCH',
      begruendung: BEGRUENDUNG,
      status: 'AUFGEHOBEN',
      beantragtVon: MANDANT,
      beantragtAm: '2026-11-17T08:00:00.000Z',
      entschiedenVon: MANDANT,
      entschiedenAm: '2026-11-17T09:00:00.000Z',
      aufgehobenVon: MANDANT,
      aufgehobenAm: '2026-11-17T10:00:00.000Z',
      ueberholt: false,
    };
    expect(UebersteuerungEintragSchema.safeParse(eintrag).success).toBe(true);
    const { ueberholt: _u, ...ohne } = eintrag;
    expect(UebersteuerungEintragSchema.safeParse(ohne).success).toBe(false);
    expect(UebersteuerungEintragSchema.safeParse({ ...eintrag, ueberholt: 'ja' }).success).toBe(
      false,
    );
  });

  it('Registereintrag: POST unter dem Mandanten, nur Kanzlei, Body-Schema', () => {
    const e = ENDPUNKTE.uebersteuerungAufheben;
    expect([e.methode, e.pfad]).toEqual([
      'POST',
      '/v1/mandanten/:mandantId/uebersteuerungen/:uebersteuerungId/aufheben',
    ]);
    expect(e.akteure).toEqual(['KANZLEI']);
    expect(e.bodySchema).toBe(UebersteuerungAufhebenBodySchema);
    expect(e.konflikte).toEqual([]);
  });
});
