import { describe, expect, it } from 'vitest';
import {
  lagerOhneRegistrierung,
  leeresProfil,
  schlageRisikenVor,
  type Geschaeftsprofil,
} from '../index';

function talwind(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon', 'eBay'] };
  p.p2 = {
    eigenversandDE: true,
    lager: [
      { land: 'DE', seit: '2020-01', art: 'FBA' },
      { land: 'PL', seit: '2025-03', art: 'PAN-EU' },
      { land: 'CZ', seit: '2026-08', art: 'PAN-EU' },
    ],
  };
  p.p3 = {
    laender: ['DE', 'AT', 'BE', 'CZ', 'ES', 'FR', 'IT', 'NL', 'PL'],
    b2bAnteilProzent: 7,
    b2bEU: true,
    b2bInland: false,
  };
  p.p4 = {
    warengruppen: [{ name: 'Outdoor-Ausrüstung', abweichenderSatz: false }],
    gebrauchtware: false,
  };
  p.p5 = { drittlandImport: true, laender: ['CN', 'VN'], zollabwicklung: 'Spediteur' };
  p.p7 = { gutscheine: true, abos: false, bundles: false };
  p.p9 = { ossSeit: '2021-07', ioss: false, lokaleUstNr: ['PL'], dauerfrist: true };
  p.p11 = { vorhanden: true, anbieter: ['Amazon EU', 'Google Ireland'] };
  return p;
}

describe('Risikovorschlag aus dem Geschäftsprofil', () => {
  it('schlägt für Talwind 22 Risiken vor (alle außer Differenzbesteuerung)', () => {
    const v = schlageRisikenVor(talwind());
    expect(v).toHaveLength(22);
    expect(v.map((x) => x.code)).not.toContain('EC-UST-14');
  });

  it('nennt den Grund aus dem Profil', () => {
    const v = schlageRisikenVor(talwind());
    expect(v.find((x) => x.code === 'EC-UST-05')?.grund).toBe('weil Lager PL seit 03/2025 (P2)');
    expect(v.find((x) => x.code === 'EC-UST-03')?.grund).toBe('weil OSS seit 07/2021 (P9)');
    expect(v.find((x) => x.code === 'EC-UST-09')?.kern).toBe(true);
  });

  it('schlägt für ein reines Inlandsprofil nur Kernrisiken vor', () => {
    const v = schlageRisikenVor(leeresProfil());
    expect(v.every((x) => x.kern)).toBe(true);
    expect(v).toHaveLength(8);
  });

  it('erkennt Lager ohne lokale Registrierung', () => {
    expect(lagerOhneRegistrierung(talwind()).map((l) => l.land)).toEqual(['CZ']);
  });
});
