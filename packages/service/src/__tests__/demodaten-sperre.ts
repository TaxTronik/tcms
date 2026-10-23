// =============================================================================
// Nur für Tests: Testdateien, die die gemeinsamen Demodaten (DEMO_TENANT_ID)
// lesen und vorübergehend ändern, laufen nie gleichzeitig. Vitest führt
// Testdateien parallel aus; ohne diese Sperre sieht eine Datei zwischen zwei
// Ladevorgängen die Zwischenstände einer anderen. Beispiel: Die kurz
// beantragte Übersteuerung aus `mandantenuebergreifend.db.test.ts` erschien im
// Vergleich von `tcms-kontext.db.test.ts` einmal als BEANTRAGT und einmal als
// AUFGEHOBEN. Tests mit eigenem Zufalls-Tenant brauchen die Sperre nicht.
// =============================================================================

import { erzeugeClient, mitTenant, sperrSchluessel } from '@tcms/db';
import { DEMO_TENANT_ID } from '@tcms/db/demo';

/** Höchstdauer, die eine Datei auf die Demodaten wartet und sie hält. */
export const DEMODATEN_FRIST_MS = 10 * 60_000;

/**
 * Wartet, bis keine andere Testdatei die Demodaten hält, und hält sie bis zum
 * Aufruf der zurückgegebenen Funktion (in `afterAll`, nach dem Zurücksetzen
 * eigener Änderungen). Die Sperre ist transaktionsgebunden auf einer eigenen
 * Verbindung; endet der Testprozess vorher, gibt PostgreSQL sie frei.
 *
 * Gewartet wird durch Abfragen statt blockierend: Mehrere Tests zählen die
 * Sitzungen mit `wait_event_type = 'Lock'` der ganzen Datenbank
 * (`rollen-sperre.db.test.ts`, `testwelt.ts`) und hielten eine hier wartende
 * Datei sonst für ihre eigene Operation.
 */
export async function sperreDemodaten(): Promise<() => Promise<void>> {
  const client = erzeugeClient(process.env['DATABASE_URL']);
  let freigeben = (): void => undefined;
  const freigabe = new Promise<void>((r) => {
    freigeben = r;
  });
  let gehalten = (): void => undefined;
  const gesperrt = new Promise<void>((r) => {
    gehalten = r;
  });
  const lauf = mitTenant(
    DEMO_TENANT_ID,
    async (tx) => {
      const schluessel = sperrSchluessel('demodaten-tests', DEMO_TENANT_ID);
      for (;;) {
        const [z] = await tx.$queryRaw<{ frei: boolean }[]>`
          SELECT pg_catalog.pg_try_advisory_xact_lock(${schluessel}::bigint) AS frei`;
        if (z?.frei) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      gehalten();
      await freigabe;
    },
    { client, timeoutMs: DEMODATEN_FRIST_MS, maxWaitMs: 60_000 },
  );
  await Promise.race([gesperrt, lauf]);
  return async () => {
    freigeben();
    try {
      await lauf;
    } finally {
      await client.$disconnect();
    }
  };
}
