// =============================================================================
// RED TEAM RT4-T-08 — Angreifermodell D (Eingaben), API mit PostgreSQL.
//
// ADR 0001 §7: ungültige Eingaben → `400 UNGUELTIG` (zod, mit `felder`).
// Freitexte, die nur `z.string().max(…)` prüfen, nehmen NUL (U+0000) und
// einzelne Surrogate an. PostgreSQL weist beide beim Speichern ab (JSONB:
// „unsupported Unicode escape sequence“ bzw. „invalid input syntax for type
// json“; TEXT: NUL nicht speicherbar). Der Fehler erreicht die App als
// unbehandelter Prisma-Fehler: `500 INTERN` und eine Fehler-Logzeile mit
// Stacktrace je Anfrage – für eine Eingabe, die der Vertrag als gültig
// angenommen hat. Betroffen ist u. a. der Abschnitt einer CMS-Beschreibung
// (Kanzlei); derselbe Weg besteht für Kommentare einer Portal-Aufgabe
// (Mandantenkontakt), siehe Service-Beweis rt4-eingabe-nul.db.test.ts.
//
// Der Test ist rot, solange die App für diese Eingaben 500 statt 400 liefert.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import { json } from '../hilfen';
import {
  akteure,
  legeMandantenAn,
  neueApiWelt,
  ok,
  richteEinUeberHttp,
  senden,
} from '../../routen/programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);

describe.skipIf(!AKTIV)('RT4-T-08 vertragsgültige Freitexte führen zu 500 INTERN', () => {
  let versionId = '';

  beforeAll(async () => {
    await legeMandantenAn(w);
    await richteEinUeberHttp(w);
    const v = await ok(
      await senden(w, 'POST', `/v1/mandanten/${w.A}/beschreibung/versionen`, a.bt()),
      201,
    );
    versionId = String(v['versionId']);
  });

  it.each([
    ['NUL', 'Kultur der Steuerehrlichkeit \u0000 Ende'],
    ['einzelnes Surrogat', 'Kultur der Steuerehrlichkeit \ud800 Ende'],
  ])('Abschnitt mit %s → 400 statt 500', async (_art, text) => {
    const fehlerVorher = w.t.log.filter((z) => z['status'] === 500).length;
    const r = await senden(
      w,
      'POST',
      `/v1/mandanten/${w.A}/beschreibung/versionen/${versionId}/abschnitte`,
      a.hb(),
      { key: 'kultur', bloecke: [{ typ: 'text', text }] },
    );
    const body = await json(r);
    const fehlerNachher = w.t.log.filter((z) => z['status'] === 500).length;
    // SICHERE ERWARTUNG: Eingabefehler als 400 UNGUELTIG, keine 500-Fehlerzeile.
    expect(
      { status: r.status, code: (body['fehler'] as { code?: string } | undefined)?.code },
      'vertragsgültige Eingabe endet als 500 INTERN',
    ).toEqual({ status: 400, code: 'UNGUELTIG' });
    expect(fehlerNachher - fehlerVorher).toBe(0);
  });
});
