// =============================================================================
// Postausgang: offene Nachrichten aus der Zeit vor RT4-T-03, deren
// Vorlagendaten die heutige Regel verletzen (Titel mit Richtungszeichen oder
// Zeilenumbruch). Der Abruf liefert sie nicht aus, sondern verwirft sie
// (`DATEN_UNGUELTIG`, Audit ohne Inhalte); alle übrigen Nachrichten bleiben
// lieferbar – eine einzelne Altzeile blockiert den Abruf nicht.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { ladeOffeneNachrichten, legeNachrichtAn } from './nachrichten';
import { baueWelt, imSystem, inWelt, system } from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const RLO = '\u202e';

describe.skipIf(!AKTIV)('Postausgang: Altbestand mit unzulässigen Vorlagendaten', () => {
  it('wird verworfen statt ausgeliefert; die übrigen Nachrichten bleiben lieferbar', async () => {
    const w = await baueWelt();
    const [alt, gut] = await inWelt(w, async (tx) => {
      // Altbestand: direkt geschrieben, wie es vor RT4-T-03 möglich war.
      const a = await tx.nachricht.create({
        data: {
          mandantId: w.mandantA,
          empfaengerId: w.hb,
          empfaengerArt: 'KANZLEI',
          zweck: 'EREIGNIS_GEMELDET',
          betreff: 'Neues Ereignis',
          text: 'Rückfalltext',
          daten: {
            ereignisId: 'ckereignis000000000000b',
            nummer: '2026-E-0002',
            titel: `Lager in Polen${RLO}fdp.exe\r\nBcc: angreifer@example.invalid`,
            typ: 'Sonstiges',
            gemeldetVonId: w.gv,
          },
        },
      });
      const b = await legeNachrichtAn(tx, {
        mandantId: w.mandantA,
        empfaengerId: w.hb,
        zweck: 'EREIGNIS_GEMELDET',
        daten: {
          ereignisId: 'ckereignis000000000000c',
          nummer: '2026-E-0003',
          titel: 'Neuer Marktplatz',
          typ: 'Sonstiges',
          gemeldetVonId: w.gv,
        },
        betreff: 'Neues Ereignis',
        text: 'Rückfalltext',
      });
      return [a.id, b];
    });

    const r = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(r.nachrichten.map((n) => n.id)).toEqual([gut]);

    const zeile = await inWelt(w, (tx) => tx.nachricht.findUniqueOrThrow({ where: { id: alt } }));
    expect(zeile.verworfenAm).not.toBeNull();
    expect(zeile.text).toBe('');
    const audit = await inWelt(w, (tx) =>
      tx.auditEvent.findMany({ where: { aktion: 'tcms.nachricht.verworfen', objektId: alt } }),
    );
    expect(audit.map((a) => a.detail)).toEqual([
      {
        zweck: 'EREIGNIS_GEMELDET',
        empfaengerId: w.hb,
        grund: 'DATEN_UNGUELTIG',
        systemakteur: true,
      },
    ]);
    // Kein Inhalt im Audit.
    expect(JSON.stringify(audit)).not.toContain('Polen');

    // Der nächste Abruf liefert weiter nur die gültige Nachricht, ohne zweites Verwerfen.
    const nochmal = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, {}));
    expect(nochmal.nachrichten.map((n) => n.id)).toEqual([gut]);
    expect(
      await inWelt(w, (tx) =>
        tx.auditEvent.count({ where: { aktion: 'tcms.nachricht.verworfen', objektId: alt } }),
      ),
    ).toBe(1);
  });
});
