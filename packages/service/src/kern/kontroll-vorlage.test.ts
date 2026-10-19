// Kontrollvorlagen (ohne DB): Vorbelegung der Zuständigkeiten neuer Kontrollen
// aus dem Katalog – gemeinsame Quelle für Version 1 und die Risikoaufnahme.
import { describe, expect, it } from 'vitest';
import { KATALOG_KONTROLLEN } from '@tcms/domain';
import {
  gueltigerStand,
  mandantSeiteVorbelegen,
  standardKontrollZustaendigkeit,
  type VorbelegungsRollen,
} from './kontroll-vorlage';

const ROLLEN: VorbelegungsRollen = {
  bt: 'bt',
  hb: 'hb',
  kanzleiVertretung: 'vertretung',
  tcb: 'tcb',
  mandantVertretung: 'ma',
  gv: 'gv',
};

describe('Kontrollvorlagen', () => {
  it('Mandantenseite: GV, TCB (sonst Mitarbeiter:in, sonst GV) und eine andere Vertretung', () => {
    expect(
      mandantSeiteVorbelegen([
        { id: 'g', rolle: 'GESETZLICHER_VERTRETER' },
        { id: 'm1', rolle: 'MITARBEITER' },
        { id: 't', rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER' },
        { id: 'm2', rolle: 'MITARBEITER' },
      ]),
    ).toEqual({ gv: 'g', tcb: 't', mandantVertretung: 'm1' });
    // Ohne TCB übernimmt die erste Mitarbeiter:in; Vertretung ist nie dieselbe Person.
    expect(
      mandantSeiteVorbelegen([
        { id: 'm1', rolle: 'MITARBEITER' },
        { id: 'g', rolle: 'GESETZLICHER_VERTRETER' },
      ]),
    ).toEqual({ gv: 'g', tcb: 'm1', mandantVertretung: 'g' });
    // Nur eine GV: sie ist TCB, eine Vertretung gibt es nicht.
    expect(mandantSeiteVorbelegen([{ id: 'g', rolle: 'GESETZLICHER_VERTRETER' }])).toEqual({
      gv: 'g',
      tcb: 'g',
      mandantVertretung: null,
    });
    expect(mandantSeiteVorbelegen([])).toEqual({ gv: null, tcb: null, mandantVertretung: null });
  });

  it('Vier-Augen in der Vorbelegung: Gegenzeichnung nie durch die durchführende Person', () => {
    for (const kat of KATALOG_KONTROLLEN) {
      const z = standardKontrollZustaendigkeit(kat, ROLLEN);
      expect(z.partei, kat.code).toBe(kat.partei);
      expect(z.durchfuehrendId, kat.code).not.toBeNull();
      expect(z.gegenzeichnerId, kat.code).not.toBe(z.durchfuehrendId);
      expect(z.vertretungId, kat.code).not.toBe(z.durchfuehrendId);
    }
    // Berufsträger:in führt durch (K-EC-20) → Gegenzeichnung durch die Kanzlei-Vertretung.
    const k20 = KATALOG_KONTROLLEN.find((k) => k.code === 'K-EC-20');
    if (k20) {
      expect(standardKontrollZustaendigkeit(k20, ROLLEN)).toMatchObject({
        durchfuehrendId: 'bt',
        gegenzeichnerId: 'vertretung',
      });
    }
  });

  it('gültiger Stand zu einem Zeitpunkt: jüngster mit gueltigAb ≤ t < gueltigBis', () => {
    const t = (s: string) => new Date(`${s}T00:00:00Z`);
    const staende = [
      { id: 1, gueltigAb: t('2026-01-01'), gueltigBis: t('2026-06-01') },
      { id: 2, gueltigAb: t('2026-06-01'), gueltigBis: null },
    ];
    expect(gueltigerStand(staende, t('2026-05-31'))?.id).toBe(1);
    expect(gueltigerStand(staende, t('2026-06-01'))?.id).toBe(2);
    expect(gueltigerStand(staende, t('2025-12-31'))).toBeUndefined();
  });
});
