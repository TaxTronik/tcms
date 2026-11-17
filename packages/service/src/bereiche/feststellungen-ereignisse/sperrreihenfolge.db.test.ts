// =============================================================================
// Sperrreihenfolge des Bereichs gegen PostgreSQL (DB_TESTS=1, TS-05): Programm
// → Ereignis → Risiken (nach ID) → Kontrollen → Folgen/neue Zeilen →
// Nummernkreise. Jeder Test hält in einer zweiten Verbindung die Zeile, die
// eine Gegenoperation zuerst sperrt (Neubewertung: Risiko; Profiländerung:
// Programm; Gegenzeichnung: Durchführung), startet die Operation des Bereichs
// und prüft, während sie wartet, dass sie die spätere Sperre noch NICHT hält.
// Hielte sie sie (umgekehrte Reihenfolge), entstünde mit der Gegenoperation
// ein Zyklus (Verklemmung → abgebrochene Transaktion).
// =============================================================================

import type { Akteur } from '@tcms/contract';
import { erzeugeClient, mitTenant, sperrSchluessel, type Tx } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { erfasseEreignis, erledigeFolge, legeEreignisAn, legeFolgenAn } from './ereignisse';
import { erfasseFeststellung } from './feststellungen';
import { akteure, aufwaermen, baueWelt, im, inTenant, type Welt } from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Sperrreihenfolge (Feststellungen, Ereignisse)', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    await aufwaermen(w);
  });

  /** Wartet, bis eine Sitzung dieser Datenbank auf eine Sperre wartet. */
  async function bisWartend(): Promise<void> {
    for (let i = 0; i < 250; i += 1) {
      const [z] = await mitTenant(
        w.tenant,
        (tx) => tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((z?.n ?? 0) >= 1) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Kein Lauf wartet auf die Sperre');
  }

  /** Ist die Zeile bzw. der Advisory-Lock frei? (eigene Transaktion, ohne zu warten) */
  async function frei(pruefe: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    try {
      await mitTenant(w.tenant, pruefe, { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
  const zeileFrei = (tabelle: 'EreignisFolge' | 'Kontrolle', id: string) =>
    frei((tx) =>
      tabelle === 'EreignisFolge'
        ? tx.$queryRaw`SELECT id FROM "EreignisFolge" WHERE id = ${id} FOR UPDATE NOWAIT`
        : tx.$queryRaw`SELECT id FROM "Kontrolle" WHERE id = ${id} FOR UPDATE NOWAIT`,
    );
  const nummernkreisFrei = (bereich: string) =>
    frei(async (tx) => {
      const [z] = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_catalog.pg_try_advisory_xact_lock(${sperrSchluessel(bereich, w.tenant)}::bigint) AS ok`;
      if (!z?.ok) throw new Error('Nummernkreis gesperrt');
    });

  /**
   * Hält in einer zweiten Verbindung `halte` (z. B. Risiko FOR UPDATE), startet
   * `lauf`, prüft im Wartezustand `pruefe` und lässt dann los.
   */
  async function waehrendGehalten(
    halte: (tx: Tx) => Promise<unknown>,
    lauf: () => Promise<unknown>,
    pruefe: () => Promise<void>,
  ): Promise<void> {
    const zweite = erzeugeClient(process.env['DATABASE_URL']);
    try {
      let loslassen!: () => void;
      const schranke = new Promise<void>((r) => (loslassen = r));
      let gehalten!: () => void;
      const haelt = new Promise<void>((r) => (gehalten = r));
      const halter = mitTenant(
        w.tenant,
        async (tx) => {
          await halte(tx);
          gehalten();
          await schranke;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await haelt;
      const ergebnis = lauf().then(
        () => null,
        (e: unknown) => e,
      );
      try {
        await bisWartend();
        await pruefe();
      } finally {
        loslassen();
        await halter;
      }
      expect(await ergebnis).toBeNull();
    } finally {
      await zweite.$disconnect();
    }
  }

  const neuesEreignis = () =>
    inTenant(w, (tx) =>
      legeEreignisAn(tx, {
        programmId: w.programm,
        typ: 'SONST',
        titel: 'Ereignis für Sperrtests',
        beschreibung: 'Folgen werden im Test angelegt.',
        quelle: 'MANUELL',
        gemeldetVon: w.p.hb,
        ereignisDatum: new Date('2026-10-01T00:00:00Z'),
        zeitpunkt: new Date('2026-10-02T09:00:00Z'),
      }),
    );
  const folgeAn = (
    ereignisId: string,
    art: 'RISIKO_NEU_BEWERTEN' | 'KONTROLLE_AUSSERPLANMAESSIG',
    ziel: string,
  ) =>
    inTenant(w, (tx) =>
      tx.ereignisFolge.create({ data: { ereignisId, art, ziel, text: 'Vorschlag' } }),
    );

  it('Folge erledigen: Risiko vor der Folge (Neubewertung hält das Risiko und ändert dieselbe Folge)', async () => {
    const e = await neuesEreignis();
    const f = await folgeAn(e.id, 'RISIKO_NEU_BEWERTEN', 'EC-UST-02');
    await im(A.hb, (ctx) =>
      legeFolgenAn(ctx, { mandantId: w.mandant, ereignisId: e.id, folgen: [{ folgeId: f.id }] }),
    );
    await waehrendGehalten(
      (tx) => tx.$queryRaw`SELECT id FROM "Risiko" WHERE id = ${w.risiko} FOR UPDATE`,
      () =>
        im(A.hb, (ctx) =>
          erledigeFolge(ctx, { mandantId: w.mandant, ereignisId: e.id, folgeId: f.id }),
        ),
      async () => {
        expect(await zeileFrei('EreignisFolge', f.id), 'Folge vor dem Risiko gesperrt').toBe(true);
      },
    );
  });

  it('Folgen anlegen: Risiken vor Kontrollen, unabhängig von der Reihenfolge der Eingabe', async () => {
    const e = await neuesEreignis();
    // Katalogreihenfolge wie T-05: erst die Kontrolle, dann das Risiko, das sie abdeckt.
    const k = await folgeAn(e.id, 'KONTROLLE_AUSSERPLANMAESSIG', 'K-EC-02');
    const r = await folgeAn(e.id, 'RISIKO_NEU_BEWERTEN', 'EC-UST-02');
    await waehrendGehalten(
      (tx) => tx.$queryRaw`SELECT id FROM "Risiko" WHERE id = ${w.risiko} FOR UPDATE`,
      () =>
        im(A.hb, (ctx) =>
          legeFolgenAn(ctx, {
            mandantId: w.mandant,
            ereignisId: e.id,
            folgen: [{ folgeId: k.id, frist: '2026-11-30' }, { folgeId: r.id }],
          }),
        ),
      async () => {
        expect(await zeileFrei('Kontrolle', w.kontrolle), 'Kontrolle vor dem Risiko').toBe(true);
      },
    );
  });

  it('Feststellung erfassen: Durchführung vor dem Nummernkreis (Gegenzeichnung hält die Durchführung)', async () => {
    await waehrendGehalten(
      (tx) => tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${w.durchfuehrung} FOR UPDATE`,
      () =>
        im(A.hb, (ctx) =>
          erfasseFeststellung(ctx, {
            mandantId: w.mandant,
            titel: 'Befund aus der Kontrolle',
            sachverhalt: 'Abweichung bei der Abstimmung des Clearingkontos.',
            quelle: 'KONTROLLE',
            quelleText: 'Kontrolle K-EC-02',
            durchfuehrungId: w.durchfuehrung,
            klasse: 'DURCHFUEHRUNGSMANGEL',
            schwere: 'MITTEL',
            auswirkung: 'UNKLAR',
          }),
        ),
      async () => {
        expect(
          await nummernkreisFrei(`nummer.feststellung|${w.programm}`),
          'Nummernkreis vor der Durchführung gesperrt',
        ).toBe(true);
      },
    );
  });

  it('Feststellungsnummern je Programm: der Nummernkreis eines Programms hält andere nicht auf', async () => {
    const zweite = erzeugeClient(process.env['DATABASE_URL']);
    try {
      let loslassen!: () => void;
      const schranke = new Promise<void>((r) => (loslassen = r));
      let gehalten!: () => void;
      const haelt = new Promise<void>((r) => (gehalten = r));
      const halter = mitTenant(
        w.tenant,
        async (tx) => {
          const s = sperrSchluessel(`nummer.feststellung|${w.programmFremd}`, w.tenant);
          await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(${s}::bigint)`;
          gehalten();
          await schranke;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await haelt;
      try {
        await expect(
          im(A.hb, (ctx) =>
            erfasseFeststellung(ctx, {
              mandantId: w.mandant,
              titel: 'Hinweis der Buchhaltung',
              sachverhalt: 'Restsaldo auf dem Clearingkonto seit August.',
              quelle: 'HINWEIS',
              quelleText: 'Buchhaltung',
              klasse: 'HINWEIS',
              schwere: 'GERING',
              auswirkung: 'UNKLAR',
            }),
          ),
        ).resolves.toMatchObject({ nummer: expect.stringMatching(/^F-2026-\d{3}$/) });
      } finally {
        loslassen();
        await halter;
      }
    } finally {
      await zweite.$disconnect();
    }
  });

  it('Ereignis erfassen: Programm vor dem Nummernkreis (Profiländerung hält das Programm und zieht danach Nummern)', async () => {
    await waehrendGehalten(
      (tx) => tx.$queryRaw`SELECT id FROM "TcmsProgramm" WHERE id = ${w.programm} FOR UPDATE`,
      () =>
        im(A.hb, (ctx) =>
          erfasseEreignis(ctx, {
            mandantId: w.mandant,
            typ: 'T-05',
            quelle: 'MANUELL',
            titel: 'USt-Sonderprüfung angekündigt',
            beschreibung: 'Prüfungsanordnung für Q2 2026 liegt vor.',
            datum: '2026-10-10',
          }),
        ),
      async () => {
        expect(
          await nummernkreisFrei(`nummer.ereignis|${w.programm}`),
          'Nummernkreis vor dem Programm gesperrt',
        ).toBe(true);
      },
    );
  });

  it('Ereignisnummern je Programm: Meldungen anderer Mandanten verschieben die Folge nicht', async () => {
    const erfasse = (mandantId: string, a: Akteur = A.hb) =>
      im(a, (ctx) =>
        erfasseEreignis(ctx, {
          mandantId,
          typ: 'T-05',
          quelle: 'MANUELL',
          titel: 'USt-Sonderprüfung angekündigt',
          beschreibung: 'Prüfungsanordnung für Q2 2026 liegt vor.',
          datum: '2026-10-10',
        }),
      );
    const nr = (n: string) => Number(n.slice('2026-T-'.length));
    const erst = await erfasse(w.mandant);
    // fremdBezug: Admin-BT mit Bezug zum anderen Mandanten desselben Tenants.
    for (let i = 0; i < 3; i++) await erfasse(w.fremd, A.fremdBezug);
    const dann = await erfasse(w.mandant);
    expect(nr(dann.nummer)).toBe(nr(erst.nummer) + 1);
  });
});
