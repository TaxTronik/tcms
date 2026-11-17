import { describe, expect, it } from 'vitest';
import { endgueltigZum, gueltigerKontrollStand, zustaendigkeitsStand } from './zustaendigkeit';

const t = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const v1 = { id: 'v1', gueltigAb: t('2026-01-01'), gueltigBis: new Date('2026-11-17T09:00:00Z') };
const v2 = { id: 'v2', gueltigAb: new Date('2026-11-17T09:00:00Z'), gueltigBis: null };
const staende = [v1, v2];
const HEUTE = t('2026-11-17');

const d = (status: string, extra: Record<string, Date | null> = {}) => ({
  status: status as 'GEPLANT',
  periodeBis: t('2026-09-30'),
  faelligAm: t('2026-10-30'),
  kontrolleStandId: 'v1',
  zurueckgewiesenAm: null,
  ...extra,
});

describe('Zuständigkeit einer Durchführung (eine Regel für alle Lesepfade)', () => {
  it('offene Durchführung: aktuell gültiger (offener) Stand, auch begonnen und eingereicht', () => {
    for (const s of ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN', 'ZUR_GEGENZEICHNUNG']) {
      expect(zustaendigkeitsStand(d(s), v1, staende, HEUTE, HEUTE).id, s).toBe('v2');
    }
  });

  it('abgeschlossen oder entfallen: eigener Stand der Durchführung', () => {
    for (const s of ['OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN']) {
      expect(zustaendigkeitsStand(d(s), v1, staende, HEUTE, HEUTE).id, s).toBe('v1');
    }
  });

  it('aktueller Stand mit einer Uhr vor der echten Zeit: der offene Stand gilt (wie das Audit)', () => {
    const demoHeute = t('2026-10-16');
    expect(gueltigerKontrollStand(staende, demoHeute, demoHeute)?.id).toBe('v2');
  });

  it('historischer Stichtag: Stand zum Ende des Stichtags; Abschluss erst ab seinem Zeitpunkt', () => {
    const stichtag = t('2026-10-01');
    expect(gueltigerKontrollStand(staende, stichtag, HEUTE)?.id).toBe('v1');
    const spaeterAbgeschlossen = d('OHNE_BEFUND', { abgeschlossenAm: t('2026-11-10') });
    expect(endgueltigZum(spaeterAbgeschlossen, stichtag, HEUTE)).toBe(false);
    expect(endgueltigZum(spaeterAbgeschlossen, HEUTE, HEUTE)).toBe(true);
  });

  it('ohne gültigen Stand: eigener Stand', () => {
    expect(zustaendigkeitsStand(d('GEPLANT'), v1, [], HEUTE, HEUTE).id).toBe('v1');
  });
});
