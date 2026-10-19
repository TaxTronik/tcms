// =============================================================================
// RED TEAM RT4-T-08 (Service-Beweis für den Portal-Weg) — Angreifermodell D
// mit einem Mandantenkontakt als Aufrufer.
//
// `DurchfuehrungSchrittEingabeSchema.kommentar` ist `z.string().trim().max(…)`
// ohne Zeichenprüfung. Eine Mitarbeiterin des Mandanten speichert ihre
// Portal-Aufgabe mit einem NUL im Schrittkommentar: Der Vertrag nimmt die
// Eingabe an, PostgreSQL weist sie beim Schreiben ab, und aus dem Service
// kommt kein `DienstFehler`, sondern ein roher Prisma-Fehler – den die App als
// `500 INTERN` mit Stacktrace im Fehler-Log beantwortet (siehe
// apps/api/src/__tests__/redteam/rt4-eingabe-500.db.test.ts).
//
// Der Test ist rot, solange der Service dafür keinen `DienstFehler('UNGUELTIG')`
// wirft.
// =============================================================================

import { DienstFehler } from '@tcms/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { speichereDurchfuehrung } from '../../bereiche/durchfuehrung';
import { akteure, baueFall, type Fall } from '../../bereiche/durchfuehrung/testfall';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('RT4-T-08 Portal-Kommentar mit NUL', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
  });

  it('Mandantenkontakt speichert einen Schrittkommentar mit NUL → UNGUELTIG statt Datenbankfehler', async () => {
    const did = await f.durchfuehrung('k2');
    let fehler: unknown = null;
    try {
      await f.dienst(a.ma, (ctx) =>
        speichereDurchfuehrung(ctx, {
          mandantId: f.mandant,
          durchfuehrungId: did,
          schritte: [
            { erledigt: true, kommentar: 'Saldenliste \u0000 abgerufen' },
            { erledigt: false, kommentar: '' },
          ],
          werte: [],
          ergebnis: null,
          ergebnisKommentar: null,
        }),
      );
    } catch (e) {
      fehler = e;
    }
    const art =
      fehler === null
        ? 'angenommen'
        : fehler instanceof DienstFehler
          ? `DienstFehler ${fehler.code}`
          : `kein DienstFehler (${(fehler as Error).name}) → 500 INTERN`;
    // SICHERE ERWARTUNG: Eingabefehler als UNGUELTIG (400), nie ein roher Datenbankfehler.
    expect(art).toBe('DienstFehler UNGUELTIG');
  });
});
