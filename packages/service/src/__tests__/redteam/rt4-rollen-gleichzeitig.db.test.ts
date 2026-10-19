// =============================================================================
// RED TEAM RT4-T-05 und RT4-T-06 — Angreifermodell C (Gleichzeitigkeit um
// Freigaben), zwei Verbindungen mit Startschranke.
//
// Rollen der Mandantenseite stehen in `MandantKontaktRolle`; ihre Pflege
// (`setzeKontaktRollen`) sperrt die Mandantenzeile und den Kontakt. Die
// Freigabe-Operationen nehmen keine dieser Sperren und prüfen Rollen nur auf
// einem Stand, der vor ihrer Zeilensperre gelesen wurde (TS-05 verlangt
// Prüfung und Änderung auf demselben, gesperrten Stand).
//
// RT4-T-05 (TOCTOU Rollenentzug): `erteileFreigabe` lädt die Rollen der
// Person (`portalZugriff`) und wartet danach auf die Zeilensperre der Freigabe.
// Entzieht die Kanzlei in diesem Fenster die Rolle als gesetzliche Vertretung
// (Commit), erteilt die Person die Freigabe trotzdem – mit den vorher
// gelesenen Rollen. Eine dritte Verbindung hält die Freigabe-Zeile, damit das
// Fenster deterministisch ist (im Betrieb genügt jede andere Operation auf
// derselben Freigabe oder schlicht die Laufzeit).
//
// RT4-T-06 (Write Skew „letzte GV“): `setzeKontaktRollen` weist das Entfernen
// der letzten aktiven GV ab, solange offene Freigaben an sie adressiert sind.
// `adressiereFreigabeNeu` prüft nur, dass der Empfänger aktive GV ist. Laufen
// beide gleichzeitig, sieht jede den Stand vor der anderen: Danach ist eine
// offene Freigabe an einen Kontakt ohne Rolle adressiert und der Mandant hat
// keine GV mehr – genau der Zustand, den die Regel ausschließen soll (die
// Freigabe lässt sich weder erteilen noch an eine GV neu adressieren).
//
// Beide Tests sind rot, solange der jeweilige Zustand entsteht.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mitTenant } from '@tcms/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@tcms/db';
import { setzeKontaktRollen } from '../../bereiche/lesepfade/kontakte';
import {
  adressiereFreigabeNeu,
  erteileFreigabe,
  fordereFreigabeCodeAn,
} from '../../bereiche/programm-beschreibung/freigaben';
import { richteEin } from '../../bereiche/programm-beschreibung/testprogramm';
import {
  baueWelt,
  btA,
  btFuer,
  gleichzeitig,
  im,
  inWelt,
  kontakt,
  neuerMandant,
  zweiteVerbindung,
  type Welt,
} from '../../bereiche/programm-beschreibung/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

/** Wartet, bis mindestens `n` Sitzungen der Datenbank auf eine Sperre warten. */
async function bisGesperrt(w: Welt, n: number): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const [z] = await mitTenant(
      w.tenantId,
      (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((z?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Kein Lauf wartet auf die Sperre');
}

describe.skipIf(!AKTIV)('RT4-T-05/06 Rollen und Freigaben gleichzeitig', () => {
  let w: Welt;
  let programmA = '';
  let zweite: PrismaClient;

  beforeAll(async () => {
    w = await baueWelt();
    programmA = await richteEin(w);
    zweite = zweiteVerbindung();
  });
  afterAll(async () => {
    await zweite?.$disconnect();
  });

  it('RT4-T-05: eine eben entzogene gesetzliche Vertretung erteilt die Freigabe noch', async () => {
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programmA,
          art: 'RISIKOAKZEPTANZ',
          refId: randomUUID(),
          titel: 'Risikoakzeptanz EC-UST-01',
          inhalt: 'Inhalt zur Freigabe',
          angefordertVon: w.bt,
          empfaengerId: w.gv,
        },
      }),
    );
    const gv = kontakt(w, w.gv, w.mandantA);
    await im(gv, (ctx) => fordereFreigabeCodeAn(ctx, { mandantId: w.mandantA, freigabeId: f.id }));
    const { code } = await inWelt(w, (tx) =>
      tx.nachricht.findFirstOrThrow({
        where: { zweck: 'FREIGABE_CODE', daten: { path: ['freigabeId'], equals: f.id } },
        select: { code: true },
      }),
    );

    // Dritte Verbindung hält die Freigabe-Zeile (Startschranke).
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(
      w.tenantId,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Freigabe" WHERE id = ${f.id} FOR UPDATE`;
        gehalten();
        await schranke;
      },
      { timeoutMs: 30_000 },
    );
    await haelt;

    // Die GV gibt frei; ihre Rollen sind gelesen, sie wartet auf die Zeilensperre.
    const erteilt = im(
      gv,
      (ctx) => erteileFreigabe(ctx, { mandantId: w.mandantA, freigabeId: f.id, code: code! }),
      zweite,
    ).then(
      (r) => r,
      (e: unknown) => e,
    );
    await bisGesperrt(w, 1);

    // Die Kanzlei entzieht ihr in diesem Fenster die Rolle (gv2 bleibt GV).
    const entzug = await im(btA(w), (ctx) =>
      setzeKontaktRollen(ctx, {
        mandantId: w.mandantA,
        kontaktId: w.gv,
        rollen: [],
        funktion: null,
      }),
    );
    expect(entzug.geaendert).toBe(true);
    const aktiv = await inWelt(w, (tx) =>
      tx.mandantKontaktRolle.count({
        where: { mandantId: w.mandantA, kontaktId: w.gv, aktiv: true },
      }),
    );
    expect(aktiv, 'Rolle ist vor dem Freigeben entzogen (Commit)').toBe(0);

    loslassen();
    await halter;
    await erteilt;
    const status = await inWelt(
      w,
      async (tx) => (await tx.freigabe.findUniqueOrThrow({ where: { id: f.id } })).status,
    );
    // SICHERE ERWARTUNG: Ohne aktive Rolle als GV wird keine Freigabe erteilt.
    expect(status, 'Freigabe durch eine Person ohne aktive GV-Rolle erteilt').toBe('OFFEN');
  });

  it('RT4-T-06: gleichzeitiges Entfernen der letzten GV und Neuadressieren an sie', async () => {
    const { mandantId, gv } = await neuerMandant(w);
    const programm = await richteEin(w, mandantId, gv);
    // Ausgangslage: keine offene Freigabe an die einzige GV, eine offene ZIELE-Freigabe
    // an einen anderen Empfänger (z. B. eine ausgeschiedene Vertretung).
    await inWelt(w, (tx) =>
      tx.freigabe.updateMany({ where: { programmId: programm }, data: { status: 'ABGELEHNT' } }),
    );
    const f = await inWelt(w, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programm,
          art: 'ZIELE',
          refId: randomUUID(),
          titel: 'Compliance-Ziele',
          angefordertVon: w.bt,
          empfaengerId: randomUUID(),
        },
      }),
    );
    const bt = btFuer(w, mandantId);
    const [c1, c2] = [zweiteVerbindung(), zweiteVerbindung()];
    const ergebnisse = await gleichzeitig<unknown>(w, [
      () =>
        im(
          bt,
          (ctx) =>
            setzeKontaktRollen(ctx, { mandantId, kontaktId: gv, rollen: [], funktion: null }),
          c1,
        ),
      () =>
        im(
          bt,
          (ctx) => adressiereFreigabeNeu(ctx, { mandantId, freigabeId: f.id, empfaengerId: gv }),
          c2,
        ),
    ]).finally(() => Promise.all([c1.$disconnect(), c2.$disconnect()]));
    const [offenAnGv, aktiveGv] = await inWelt(w, async (tx) => [
      await tx.freigabe.count({
        where: { programmId: programm, status: 'OFFEN', empfaengerId: gv },
      }),
      await tx.mandantKontaktRolle.count({
        where: { mandantId, rolle: 'GESETZLICHER_VERTRETER', aktiv: true },
      }),
    ]);
    // SICHERE ERWARTUNG: Nie eine offene Freigabe an die entfernte letzte GV.
    expect(
      { offenAnGv: offenAnGv > 0 && aktiveGv === 0, ergebnisse: ergebnisse.map((e) => e.status) },
      'offene Freigabe an einen Kontakt ohne Rolle, Mandant ohne GV',
    ).toMatchObject({ offenAnGv: false });
  }, 30_000);
});
