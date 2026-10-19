// =============================================================================
// Kennzeichen `rechte.bearbeiten` in Risikoinventar und Kontrollmatrix
// (DB_TESTS=1): Für jede Person entspricht das Kennzeichen dem tatsächlichen
// Ergebnis einer Schreiboperation des Bereichs (erlaubt ⇔ Erfolg, sonst 403
// BEARBEITEN). Im historischen Stand ist es immer `false`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import { designBeurteilen } from '../kontrollen';
import { ladeKontrollen, ladeRisiken } from '../lesen';
import { risikoBewertungBestaetigen } from '../risiken';
import {
  akteureVon,
  BEGRUENDUNG,
  fehlerVon,
  kanzlei,
  legeProgrammAn,
  rufe,
  type Programm,
} from './fixture';

const AKTIV = process.env['DB_TESTS'] === '1';

/** Erfolg → true; 403 mit Grund BEARBEITEN → false; alles andere lässt den Test scheitern. */
async function ergebnis(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch (e) {
    const f = await fehlerVon(Promise.reject(e));
    expect(f).toMatchObject({ code: 'NICHT_BERECHTIGT', grund: 'BEARBEITEN' });
    return false;
  }
}

describe.skipIf(!AKTIV)('rechte.bearbeiten = Ergebnis der Schreiboperation', () => {
  let a: Programm;
  let personen: [string, Akteur][];

  beforeAll(async () => {
    a = await legeProgrammAn(randomUUID());
    const x = akteureVon(a);
    personen = [
      ['zuständige BT', x.bt],
      ['Hauptbearbeitung', x.hb],
      ['Admin', x.admin],
      ['Leser ohne Zuständigkeit', x.leser],
      ['BT ohne Zuständigkeit', kanzlei(a.tenantId, randomUUID(), a.mandantId, { bt: true })],
    ];
  }, 120_000);

  it('Risikoinventar: Kennzeichen wie „Bewertung bestätigen"', async () => {
    const gesehen: boolean[] = [];
    for (const [wer, akteur] of personen) {
      const l = await rufe(akteur, (ctx) => ladeRisiken(ctx, { mandantId: a.mandantId }));
      const r = l.risiken[0]!;
      const tatsaechlich = await ergebnis(
        rufe(akteur, (ctx) =>
          risikoBewertungBestaetigen(ctx, {
            mandantId: a.mandantId,
            risikoId: r.id,
            standId: r.standId,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(l.rechte.bearbeiten, wer).toBe(tatsaechlich);
      gesehen.push(tatsaechlich);
    }
    // Beide Ausgänge kommen vor (sonst prüfte der Test nichts).
    expect(new Set(gesehen)).toEqual(new Set([true, false]));
  });

  it('Kontrollmatrix: Kennzeichen wie „Design beurteilen"', async () => {
    const gesehen: boolean[] = [];
    for (const [wer, akteur] of personen) {
      const l = await rufe(akteur, (ctx) => ladeKontrollen(ctx, { mandantId: a.mandantId }));
      const k = l.kontrollen[0]!;
      const tatsaechlich = await ergebnis(
        rufe(akteur, (ctx) =>
          designBeurteilen(ctx, {
            mandantId: a.mandantId,
            kontrolleId: k.id,
            standId: k.standId,
            design: 'ANGEMESSEN',
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(l.rechte.bearbeiten, wer).toBe(tatsaechlich);
      gesehen.push(tatsaechlich);
    }
    expect(new Set(gesehen)).toEqual(new Set([true, false]));
  });

  it('historischer Stand: nie bearbeiten (Regel 6)', async () => {
    const { bt } = akteureVon(a);
    const r = await rufe(bt, (ctx) =>
      ladeRisiken(ctx, { mandantId: a.mandantId, stand: '2026-06-30' }),
    );
    const k = await rufe(bt, (ctx) =>
      ladeKontrollen(ctx, { mandantId: a.mandantId, stand: '2026-06-30' }),
    );
    expect(r.historisch && k.historisch).toBe(true);
    expect(r.rechte).toEqual({ bearbeiten: false });
    expect(k.rechte).toEqual({ bearbeiten: false });
  });
});
