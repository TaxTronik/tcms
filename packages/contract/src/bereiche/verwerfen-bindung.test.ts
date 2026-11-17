// =============================================================================
// Vertrag (rein): Bestätigungen eines Verwerfen-Antrags nennen den gesehenen
// Antrag, neue Länderstände den gesehenen Stand; der Ketten-Hash im
// Ereignisdetail darf fehlen (nur die Kanzleileitung erhält ihn);
// `benachrichtigen.name` der Portal-Meldung ist optional.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  EreignisDetailSchema,
  EreignisVerwerfenBestaetigenBodySchema,
  FeststellungVerwerfenBestaetigenBodySchema,
  LandHinzufuegenBodySchema,
  LandStaendeBodySchema,
  PortalMeldungBodySchema,
} from './feststellungen-ereignisse';

const ANTRAG = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

describe('Bestätigung des Verwerfens: gebunden an den gesehenen Antrag', () => {
  it('Feststellung: Kennung des Antrags und gesehene Auswirkung sind Pflicht', () => {
    expect(
      FeststellungVerwerfenBestaetigenBodySchema.safeParse({ antragId: ANTRAG, auswirkung: 'JA' })
        .success,
    ).toBe(true);
    for (const falsch of [
      {},
      { antragId: ANTRAG },
      { auswirkung: 'NEIN' },
      { antragId: 'kein-antrag', auswirkung: 'NEIN' },
      { antragId: ANTRAG, auswirkung: 'VIELLEICHT' },
      { antragId: ANTRAG, auswirkung: 'NEIN', begruendung: 'zusätzlich' },
    ]) {
      expect(
        FeststellungVerwerfenBestaetigenBodySchema.safeParse(falsch).success,
        JSON.stringify(falsch),
      ).toBe(false);
    }
  });

  it('Ereignis: Kennung des Antrags ist Pflicht (UUID)', () => {
    expect(EreignisVerwerfenBestaetigenBodySchema.safeParse({ antragId: ANTRAG }).success).toBe(
      true,
    );
    for (const falsch of [{}, { antragId: '' }, { antragId: ANTRAG, x: 1 }]) {
      expect(EreignisVerwerfenBestaetigenBodySchema.safeParse(falsch).success).toBe(false);
    }
  });
});

describe('Länderstände: nur auf dem gesehenen Stand', () => {
  const land = {
    land: 'FR',
    fernverkaeufeLfdEur: 1200,
    fernverkaeufeVorjahrEur: 800,
    lagerSeit: null,
    oss: true,
    lokaleUstNr: false,
    zmRelevant: false,
    steuersaetzeGeprueftAm: null,
  };

  it('neue Stände verlangen `gesehenerStandId`; das Hinzufügen eines Landes nicht', () => {
    const stand = 'clxyz0000000000000000001';
    expect(
      LandStaendeBodySchema.safeParse({
        datenstand: '2026-10-10',
        laender: [{ ...land, gesehenerStandId: stand }],
      }).success,
    ).toBe(true);
    expect(
      LandStaendeBodySchema.safeParse({ datenstand: '2026-10-10', laender: [land] }).success,
    ).toBe(false);
    expect(
      LandStaendeBodySchema.safeParse({
        datenstand: '2026-10-10',
        laender: [{ ...land, gesehenerStandId: '../x' }],
      }).success,
    ).toBe(false);
    expect(LandHinzufuegenBodySchema.safeParse({ datenstand: '2026-10-10', land }).success).toBe(
      true,
    );
    expect(
      LandHinzufuegenBodySchema.safeParse({
        datenstand: '2026-10-10',
        land: { ...land, gesehenerStandId: stand },
      }).success,
    ).toBe(false);
  });
});

describe('Portal-Meldung: `benachrichtigen` adressiert nur über die ID', () => {
  const meldung = {
    typ: 'T-02',
    titel: 'Neues Lager in Polen',
    beschreibung: 'Ab November lagern wir Ware in Posen.',
    datum: '2026-10-12',
    anlagen: [],
    zusageAenderungen: true,
  };

  it('Name optional, ID Pflicht', () => {
    for (const benachrichtigen of [{ id: ANTRAG }, { id: ANTRAG, name: 'Leon Brandt' }, null]) {
      expect(PortalMeldungBodySchema.safeParse({ ...meldung, benachrichtigen }).success).toBe(true);
    }
    for (const benachrichtigen of [{ name: 'Leon Brandt' }, { id: ANTRAG, name: '' }]) {
      expect(PortalMeldungBodySchema.safeParse({ ...meldung, benachrichtigen }).success).toBe(
        false,
      );
    }
  });
});

describe('Ereignisdetail: Ketten-Hash nur für die Kanzleileitung', () => {
  it('`meldung.hash` darf null sein, nicht fehlen', () => {
    const meldung = EreignisDetailSchema.shape.meldung;
    const at = '2026-10-16T10:00:00.000Z';
    expect(meldung.safeParse({ aktion: 'tcms.ereignis.gemeldet', at, hash: null }).success).toBe(
      true,
    );
    expect(
      meldung.safeParse({ aktion: 'tcms.ereignis.gemeldet', at, hash: 'a'.repeat(64) }).success,
    ).toBe(true);
    expect(meldung.safeParse({ aktion: 'tcms.ereignis.gemeldet', at }).success).toBe(false);
  });
});
