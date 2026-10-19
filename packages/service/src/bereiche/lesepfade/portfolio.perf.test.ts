// =============================================================================
// Laufzeit von Portfolio und Arbeitskorb bei vielen Mandanten (nur mit
// PERF_TESTS=1 gegen eine eigene, frisch geseedete Wegwerf-Datenbank; der
// Test klont das Talwind-Programm im Demo-Tenant `PERF_MANDANTEN`-mal und
// verändert die Datenbank dauerhaft).
//
//   bash tcms-mkdb.sh <perf-db> <arbeitsbaum>
//   PERF_TESTS=1 DATABASE_URL=postgresql://tcms_app:…/<perf-db> \
//     pnpm --filter @tcms/service exec vitest run src/bereiche/lesepfade/portfolio.perf.test.ts
//
// Die Grenze (25 s) liegt unter dem Transaktions- und Anfragezeitlimit des
// Dienstes (30 s); gemessene Werte stehen im Bericht.
// =============================================================================

import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { mitTenant } from '@tcms/db';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { ladeArbeitskorb } from './arbeitskorb';
import { ladePortfolio } from './portfolio';
import { im, kanzlei } from './testhilfen';

const AKTIV = process.env['PERF_TESTS'] === '1';
const ANZAHL = Number(process.env['PERF_MANDANTEN'] ?? 500);

const TABELLEN = [
  'TcmsProgramm',
  'Teilbereich',
  'ComplianceZiel',
  'ProfilStand',
  'Risiko',
  'RisikoStand',
  'Uebersteuerung',
  'Kontrolle',
  'KontrolleStand',
  'RisikoKontrolle',
  'Durchfuehrung',
  'Nachweis',
  'Feststellung',
  'FeststellungRisiko',
  'Massnahme',
  'Ereignis',
  'EreignisFolge',
  'LandStand',
  'BeschreibungVersion',
];

/** Feste SQL ohne Eingaben: klont das Programm von `quelle` für n = von..bis (nur Testdaten). */
function klonSql(quelle: string, von: number, bis: number): string {
  if (!/^[0-9a-f-]{36}$/.test(quelle)) throw new Error('quelle');
  return `DO $$
DECLARE
  quelle uuid := '${quelle}';
  p text; n int; neu uuid; t text; cols text; sel text; filter text;
  tabellen text[] := ARRAY['${TABELLEN.join("','")}'];
BEGIN
  SELECT id INTO p FROM "TcmsProgramm" WHERE "mandantId" = quelle;
  FOR n IN ${von}..${bis} LOOP
    neu := gen_random_uuid();
    INSERT INTO "Mandant"(id, name, rechtsform, aktiv)
      SELECT neu, name || ' P' || n, rechtsform, true FROM "Mandant" WHERE id = quelle;
    INSERT INTO "MandantKontaktRolle"(id, "mandantId", "kontaktId", rolle, funktion, aktiv)
      SELECT id || '_p' || n, neu, "kontaktId", rolle, funktion, aktiv
      FROM "MandantKontaktRolle" WHERE "mandantId" = quelle;
    FOREACH t IN ARRAY tabellen LOOP
      SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
             string_agg(CASE
               WHEN column_name = 'mandantId' THEN quote_literal(neu) || '::uuid'
               WHEN t = 'Ereignis' AND column_name = 'nummer'
                 THEN '"nummer" || ' || quote_literal('-p' || n)
               WHEN column_name = 'wiedervorlageNr' THEN '"wiedervorlageNr" + ' || (n * 100000)
               WHEN data_type = 'text' AND (column_name = 'id'
                    OR (column_name LIKE '%Id' AND column_name <> 'paketId'))
                 THEN quote_ident(column_name) || ' || ' || quote_literal('_p' || n)
               ELSE quote_ident(column_name) END, ', ' ORDER BY ordinal_position)
        INTO cols, sel
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t;
      filter := CASE t
        WHEN 'TcmsProgramm' THEN 'id = $1'
        WHEN 'ComplianceZiel' THEN '"teilbereichId" IN (SELECT id FROM "Teilbereich" WHERE "programmId" = $1)'
        WHEN 'RisikoStand' THEN '"risikoId" IN (SELECT id FROM "Risiko" WHERE "programmId" = $1)'
        WHEN 'Uebersteuerung' THEN '"risikoId" IN (SELECT id FROM "Risiko" WHERE "programmId" = $1)'
        WHEN 'RisikoKontrolle' THEN '"risikoId" IN (SELECT id FROM "Risiko" WHERE "programmId" = $1)'
        WHEN 'KontrolleStand' THEN '"kontrolleId" IN (SELECT id FROM "Kontrolle" WHERE "programmId" = $1)'
        WHEN 'Durchfuehrung' THEN '"kontrolleId" IN (SELECT id FROM "Kontrolle" WHERE "programmId" = $1)'
        WHEN 'Nachweis' THEN '"durchfuehrungId" IN (SELECT d.id FROM "Durchfuehrung" d JOIN "Kontrolle" k ON k.id = d."kontrolleId" WHERE k."programmId" = $1)'
        WHEN 'FeststellungRisiko' THEN '"feststellungId" IN (SELECT id FROM "Feststellung" WHERE "programmId" = $1)'
        WHEN 'Massnahme' THEN '"feststellungId" IN (SELECT id FROM "Feststellung" WHERE "programmId" = $1)'
        WHEN 'EreignisFolge' THEN '"ereignisId" IN (SELECT id FROM "Ereignis" WHERE "programmId" = $1)'
        ELSE '"programmId" = $1' END;
      EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I WHERE %s', t, cols, sel, t, filter) USING p;
    END LOOP;
  END LOOP;
END $$;`;
}

describe.skipIf(!AKTIV)(`Portfolio und Arbeitskorb mit ${ANZAHL} Mandanten`, () => {
  it(
    'bleibt unter 25 s je Anfrage',
    async () => {
      const vorhanden = await mitTenant(DEMO_TENANT_ID, (tx) => tx.mandant.count());
      for (let von = vorhanden + 1; von <= ANZAHL; von += 25) {
        const bis = Math.min(ANZAHL, von + 24);
        await mitTenant(
          DEMO_TENANT_ID,
          (tx) => tx.$executeRawUnsafe(klonSql(DEMO_IDS.talwind, von, bis)),
          {
            timeoutMs: 600_000,
          },
        );
      }
      const ids = await mitTenant(DEMO_TENANT_ID, (tx) =>
        tx.mandant.findMany({ select: { id: true } }),
      );
      const zahlen = await mitTenant(DEMO_TENANT_ID, async (tx) => ({
        programme: await tx.tcmsProgramm.count(),
        durchfuehrungen: await tx.durchfuehrung.count(),
        feststellungen: await tx.feststellung.count(),
        nachweise: await tx.nachweis.count(),
      }));
      const liste = {
        mandantIds: ids.map((m) => m.id),
        hb: ids.map((m) => m.id),
      };
      const anna = kanzlei(DEMO_IDS.anna, null, { admin: true, bt: true });
      const messe = async <T>(fn: () => Promise<T>) => {
        const heap = process.memoryUsage().heapUsed;
        const t0 = performance.now();
        const wert = await fn();
        return {
          wert,
          ms: Math.round(performance.now() - t0),
          heapMb: Math.round((process.memoryUsage().heapUsed - heap) / 1e6),
        };
      };
      const p = await messe(() => im(anna, (ctx) => ladePortfolio(ctx, liste)));
      const k = await messe(() => im(anna, (ctx) => ladeArbeitskorb(ctx, liste)));
      console.log(
        JSON.stringify({
          mandanten: ids.length,
          ...zahlen,
          portfolio: { ms: p.ms, heapMb: p.heapMb, zeilen: p.wert.zeilen.length },
          arbeitskorb: {
            ms: k.ms,
            heapMb: k.heapMb,
            antwortKb: Math.round(JSON.stringify(k.wert).length / 1024),
          },
          portfolioKb: Math.round(JSON.stringify(p.wert).length / 1024),
        }),
      );
      expect(p.wert.zeilen).toHaveLength(ids.length);
      expect(p.ms).toBeLessThan(25_000);
      expect(k.ms).toBeLessThan(25_000);
    },
    20 * 60_000,
  );
});
