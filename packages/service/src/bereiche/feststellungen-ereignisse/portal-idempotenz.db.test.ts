// =============================================================================
// Idempotente Portal-Meldung (tcms-s10) gegen PostgreSQL (DB_TESTS=1,
// DATABASE_URL = tcms_app): Dieselbe Person meldet beim selben Mandanten mit
// demselben Schlüssel innerhalb von 24 h genau ein Ereignis – auch bei zwei
// gleichzeitigen Anfragen. Wiederholung → dieselbe Antwort ohne neues
// Ereignis, Nachricht oder Audit; anderer Inhalt → 409 IDEMPOTENZ_ABWEICHUNG.
// Der Schlüssel gilt nur für die Person, die ihn verwendet hat.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant, schreibeAuditFolge } from '@tcms/db';
import { dbAbgewiesen, regel } from '@tcms/db/testhilfe';
import { sperreRollenZumAendern } from '../../rollen';
import { IDEMPOTENZ_FENSTER_MS, MAX_MELDUNGEN_JE_STUNDE, meldeEreignis } from './portal';
import {
  akteure,
  aufwaermen,
  baueWelt,
  fehlerVon,
  gleichzeitig,
  im,
  inTenant,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Portal-Meldung mit Idempotenzschlüssel (Service, PostgreSQL)', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;
  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    await aufwaermen(w);
  });

  const sha256 = 'c'.repeat(64);
  const meldung = (schluessel: string | undefined, x: Record<string, unknown> = {}) => {
    return {
      mandantId: w.mandant,
      typ: 'T-02',
      titel: 'Neues Lager in Polen',
      beschreibung: 'Ab November lagern wir Ware in Posen.',
      datum: '2026-10-12',
      anlagen: [
        {
          dokumentId: `${sha256.slice(0, 2)}/${sha256}`,
          dateiname: 'Mietvertrag Lager.pdf',
          mime: 'application/pdf',
          groesse: 2048,
          sha256,
        },
      ],
      zusageAenderungen: true,
      benachrichtigen: { id: w.p.hb, name: 'Leon Brandt' },
      ...(schluessel ? { idempotenzSchluessel: schluessel } : {}),
      ...x,
    };
  };
  const melde = (a: (typeof A)['gv'], eingabe: unknown) =>
    im(a, (ctx) => meldeEreignis(ctx, eingabe as never));
  /** Ereignisse, Meldungs-Audits und Nachrichten zu einem Titel (Zählung der Seiteneffekte). */
  const spuren = (titel: string) =>
    inTenant(w, async (tx) => {
      const ereignisse = await tx.ereignis.findMany({
        where: { titel },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const ids = ereignisse.map((e) => e.id);
      return {
        ereignisse: ids.length,
        audits: await tx.auditEvent.count({
          where: { objektId: { in: ids }, aktion: 'tcms.ereignis.gemeldet' },
        }),
        nachrichten: await tx.nachricht.count({
          where: { zweck: 'EREIGNIS_GEMELDET', daten: { path: ['titel'], equals: titel } },
        }),
        schluessel: await tx.portalMeldungIdempotenz.count({ where: { ereignisId: { in: ids } } }),
      };
    });

  it('Wiederholung mit gleichem Inhalt: dieselbe Antwort, kein zweites Ereignis, Audit oder Nachricht', async () => {
    const titel = `Lager Wiederholung ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const erst = await melde(A.gv, meldung(k, { titel }));
    // Wiederholung; die Schreibweise des Schlüssels zählt nicht.
    const nochmal = await melde(A.gv, meldung(k.toUpperCase(), { titel }));
    expect(nochmal).toEqual(erst);
    expect(await spuren(titel)).toEqual({
      ereignisse: 1,
      audits: 1,
      nachrichten: 1,
      schluessel: 1,
    });
    const audit = await inTenant(w, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { objektId: erst.id, aktion: 'tcms.ereignis.gemeldet' },
      }),
    );
    expect(audit.detail).toMatchObject({ idempotenzSchluessel: k });
  });

  it('anderer Inhalt mit gleichem Schlüssel: 409 IDEMPOTENZ_ABWEICHUNG, nichts angelegt', async () => {
    const titel = `Lager Abweichung ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    await melde(A.gv, meldung(k, { titel }));
    for (const anders of [
      { titel: `${titel} (geändert)` },
      { beschreibung: 'Ab Dezember lagern wir Ware in Posen.' },
      { datum: '2026-10-13' },
      { anlagen: [] },
      { zusageAenderungen: false },
      { benachrichtigen: null },
    ]) {
      const f = await fehlerVon(melde(A.gv, meldung(k, { titel, ...anders })));
      expect([f.code, f.konflikt], JSON.stringify(anders)).toEqual([
        'KONFLIKT',
        'IDEMPOTENZ_ABWEICHUNG',
      ]);
    }
    expect(await spuren(titel)).toMatchObject({ ereignisse: 1, audits: 1, schluessel: 1 });
    expect(await spuren(`${titel} (geändert)`)).toMatchObject({ ereignisse: 0 });
  });

  it('zwei gleichzeitige Anfragen mit gleichem Schlüssel: ein Ereignis, beide dieselbe Antwort', async () => {
    for (let lauf = 0; lauf < 3; lauf++) {
      const titel = `Lager parallel ${randomBytes(3).toString('hex')}`;
      const k = randomUUID();
      const r = await gleichzeitig(
        () => melde(A.gv, meldung(k, { titel })),
        () => melde(A.gv, meldung(k, { titel })),
      );
      expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
      const [a, b] = r.map((x) => (x as PromiseFulfilledResult<{ id: string }>).value);
      expect(b).toEqual(a);
      expect(await spuren(titel)).toEqual({
        ereignisse: 1,
        audits: 1,
        nachrichten: 1,
        schluessel: 1,
      });
    }
  });

  it('gleichzeitig mit anderem Inhalt: genau ein Ereignis, die andere Anfrage 409 mit Grund', async () => {
    const titel = `Lager parallel anders ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const r = await gleichzeitig(
      () => melde(A.gv, meldung(k, { titel })),
      () => melde(A.gv, meldung(k, { titel, zusageAenderungen: false })),
    );
    const ok = r.filter((x) => x.status === 'fulfilled');
    const nein = r.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect([ok.length, nein.length]).toEqual([1, 1]);
    expect(nein[0]!.reason).toMatchObject({ code: 'KONFLIKT', konflikt: 'IDEMPOTENZ_ABWEICHUNG' });
    expect(await spuren(titel)).toMatchObject({ ereignisse: 1, audits: 1 });
  });

  it('der Schlüssel gilt nur für die eigene Person (kein Zugriff auf fremde Meldungen)', async () => {
    const titel = `Lager zwei Personen ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const gv = await melde(A.gv, meldung(k, { titel }));
    // Derselbe Schlüssel einer anderen meldeberechtigten Person: eigene, neue Meldung –
    // nie die Antwort (ID, Nummer) der anderen.
    const tcb = await melde(A.tcb, meldung(k, { titel }));
    expect(tcb.id).not.toBe(gv.id);
    expect(await spuren(titel)).toMatchObject({ ereignisse: 2, audits: 2, schluessel: 2 });
  });

  it('Rechte vor dem Schlüssel: eine Person ohne Melderecht erhält auch mit fremdem Schlüssel nichts', async () => {
    const titel = `Lager ohne Recht ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    await melde(A.gv, meldung(k, { titel }));
    expect(await fehlerVon(melde(A.ma, meldung(k, { titel })))).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      grund: 'PORTAL_ROLLE',
    });
    expect((await fehlerVon(melde(A.ohneRolle, meldung(k, { titel })))).code).toBe(
      'NICHT_GEFUNDEN',
    );
    expect((await fehlerVon(melde(A.gvFremd, meldung(k, { titel })))).code).toBe('NICHT_GEFUNDEN');
  });

  it('nach 24 h ist der Schlüssel verbraucht: neue Meldung, die alte Bindung wird ersetzt', async () => {
    const titel = `Lager abgelaufen ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const alt = await melde(A.gv, meldung(undefined, { titel }));
    // Bindung, wie sie vor über 24 h entstanden wäre (die App-Rolle darf anlegen).
    await inTenant(w, (tx) =>
      tx.portalMeldungIdempotenz.create({
        data: {
          mandantId: w.mandant,
          personId: w.p.gv,
          schluessel: k,
          inhaltSha256: 'e'.repeat(64),
          ereignisId: alt.id,
          createdAt: new Date(Date.now() - IDEMPOTENZ_FENSTER_MS - 60_000),
        },
      }),
    );
    const neu = await melde(A.gv, meldung(k, { titel, zusageAenderungen: false }));
    expect(neu.id).not.toBe(alt.id);
    const bindung = await inTenant(w, (tx) =>
      tx.portalMeldungIdempotenz.findMany({
        where: { schluessel: k },
        select: { ereignisId: true },
      }),
    );
    expect(bindung).toEqual([{ ereignisId: neu.id }]);
    // Innerhalb von 24 h gilt die neue Bindung.
    expect(await melde(A.gv, meldung(k, { titel, zusageAenderungen: false }))).toEqual(neu);
  });

  it('ohne Schlüssel bleibt jede Meldung eine neue (unverändert)', async () => {
    const titel = `Lager ohne Schlüssel ${randomBytes(3).toString('hex')}`;
    await melde(A.gv, meldung(undefined, { titel }));
    await melde(A.gv, meldung(undefined, { titel }));
    expect(await spuren(titel)).toMatchObject({ ereignisse: 2, audits: 2, schluessel: 0 });
  });

  it('die Datenbank: eindeutig je Tenant, Mandant, Person und Schlüssel; Bindung unveränderlich; RLS', async () => {
    const titel = `Lager Datenbank ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const e = await melde(A.gv, meldung(k, { titel }));
    const zweites = await melde(A.gv, meldung(undefined, { titel }));
    const zeile = {
      mandantId: w.mandant,
      personId: w.p.gv,
      schluessel: k,
      inhaltSha256: 'a'.repeat(64),
      ereignisId: zweites.id,
    };
    await dbAbgewiesen(
      inTenant(w, (tx) => tx.portalMeldungIdempotenz.create({ data: zeile })),
      regel.eindeutig('PortalMeldungIdempotenz_schluessel_key'),
    );
    // Ein Ereignis hat höchstens einen Schlüssel.
    await dbAbgewiesen(
      inTenant(w, (tx) =>
        tx.portalMeldungIdempotenz.create({
          data: { ...zeile, schluessel: randomUUID(), ereignisId: e.id },
        }),
      ),
      regel.eindeutig('PortalMeldungIdempotenz_ereignis_key'),
    );
    await dbAbgewiesen(
      inTenant(w, (tx) =>
        tx.portalMeldungIdempotenz.create({
          data: { ...zeile, schluessel: randomUUID(), inhaltSha256: 'A'.repeat(64) },
        }),
      ),
      regel.check('PortalMeldungIdempotenz', 'PortalMeldungIdempotenz_inhaltSha256_check'),
    );
    // Kein UPDATE für die App-Rolle: Bindung und Inhalt eines Schlüssels sind fest.
    await dbAbgewiesen(
      inTenant(w, (tx) =>
        tx.portalMeldungIdempotenz.updateMany({
          where: { schluessel: k },
          data: { ereignisId: zweites.id },
        }),
      ),
      regel.keinRecht('PortalMeldungIdempotenz'),
    );
    // Fremde Tenants: Fremdschlüssel und RLS prüft rls.db.test.ts für jede Tabelle.
    // RLS: Tenant B sieht die Bindungen von A nicht.
    expect(await inTenant(w, (tx) => tx.portalMeldungIdempotenz.count(), w.tenantB)).toBe(0);
  });

  it('der Anzeigename von `benachrichtigen` geht nicht in den Inhalt ein (ohne Wirkung)', async () => {
    const titel = `Lager Name ${randomBytes(3).toString('hex')}`;
    const k = randomUUID();
    const erst = await melde(A.gv, meldung(k, { titel }));
    // Dieselbe Person anders aufgelöst bzw. ohne Namen: dieselbe Meldung.
    const umbenannt = meldung(k, { titel, benachrichtigen: { id: w.p.hb, name: 'L. Brandt' } });
    expect(await melde(A.gv, umbenannt)).toEqual(erst);
    expect(await melde(A.gv, meldung(k, { titel, benachrichtigen: { id: w.p.hb } }))).toEqual(erst);
    // Eine andere Person bleibt eine Abweichung.
    const andere = meldung(k, { titel, benachrichtigen: { id: w.p.zbt, name: 'Leon Brandt' } });
    expect((await fehlerVon(melde(A.gv, andere))).konflikt).toBe('IDEMPOTENZ_ABWEICHUNG');
  });

  it('abgelaufene Schlüssel der Person werden beim nächsten Melden geräumt', async () => {
    const titel = `Lager Räumen ${randomBytes(3).toString('hex')}`;
    const alt = await melde(A.gv, meldung(undefined, { titel }));
    const k = randomUUID();
    await inTenant(w, (tx) =>
      tx.portalMeldungIdempotenz.create({
        data: {
          mandantId: w.mandant,
          personId: w.p.gv,
          schluessel: k,
          inhaltSha256: 'f'.repeat(64),
          ereignisId: alt.id,
          createdAt: new Date(Date.now() - IDEMPOTENZ_FENSTER_MS - 60_000),
        },
      }),
    );
    await melde(A.gv, meldung(undefined, { titel }));
    expect(
      await inTenant(w, (tx) => tx.portalMeldungIdempotenz.count({ where: { schluessel: k } })),
    ).toBe(0);
  });
});

/** Wartet, bis eine Sitzung dieser Datenbank auf eine Sperre wartet. */
async function bisWartend(tenant: string): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const [z] = await mitTenant(
      tenant,
      (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((z?.n ?? 0) >= 1) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Kein Lauf wartet auf die Sperre');
}

describe.skipIf(!AKTIV)('Portal-Meldung: Mengenbegrenzung und Rollen unter der Sperre', () => {
  const meldung = (w: Welt, x: Record<string, unknown> = {}) => ({
    mandantId: w.mandant,
    typ: 'T-02',
    titel: `Neues Lager ${randomBytes(3).toString('hex')}`,
    beschreibung: 'Ab November lagern wir Ware in Posen.',
    datum: '2026-10-12',
    anlagen: [],
    zusageAenderungen: true,
    ...x,
  });

  it(`höchstens ${MAX_MELDUNGEN_JE_STUNDE} Meldungen je Person und Stunde: darüber 409 ZU_VIELE_MELDUNGEN, nichts angelegt`, async () => {
    const w = await baueWelt();
    const A = akteure(w);
    const mitSchluessel = meldung(w, { idempotenzSchluessel: randomUUID() });
    const erst = await im(A.gv, (ctx) => meldeEreignis(ctx, mitSchluessel as never));
    // Weitere Meldungen der Person in der letzten Stunde (Audit, echte Zeit).
    await inTenant(w, (tx) =>
      schreibeAuditFolge(
        tx,
        Array.from({ length: MAX_MELDUNGEN_JE_STUNDE - 1 }, () => ({
          actorId: w.p.gv,
          actorName: 'GV',
          aktion: 'tcms.ereignis.gemeldet',
          objektTyp: 'Ereignis',
          objektId: erst.id,
          programmId: w.programm,
          detail: {},
        })),
      ),
    );
    const vorher = await inTenant(w, (tx) => tx.ereignis.count());
    const x = await fehlerVon(im(A.gv, (ctx) => meldeEreignis(ctx, meldung(w) as never)));
    expect([x.code, x.konflikt]).toEqual(['KONFLIKT', 'ZU_VIELE_MELDUNGEN']);
    expect(await inTenant(w, (tx) => tx.ereignis.count())).toBe(vorher);
    // Die Wiederholung mit Schlüssel legt nichts an und zählt nicht.
    expect(await im(A.gv, (ctx) => meldeEreignis(ctx, mitSchluessel as never))).toEqual(erst);
    // Die Grenze gilt je Person: die TCB meldet weiter.
    await expect(
      im(A.tcb, (ctx) => meldeEreignis(ctx, meldung(w) as never)),
    ).resolves.toMatchObject({ nummer: expect.any(String) });
  });

  it('Rollen erst unter halteRollenFest: eine gleichzeitig entzogene Rolle meldet nicht mehr (RT4-T-05)', async () => {
    const w = await baueWelt();
    const A = akteure(w);
    const zweite = erzeugeClient(process.env['DATABASE_URL']);
    try {
      let loslassen!: () => void;
      const schranke = new Promise<void>((r) => (loslassen = r));
      let entzogen!: () => void;
      const istEntzogen = new Promise<void>((r) => (entzogen = r));
      // Rollenpflege: Mandantenzeile gesperrt, Rolle der GV deaktiviert, noch nicht festgeschrieben.
      const pflege = mitTenant(
        w.tenant,
        async (tx) => {
          await sperreRollenZumAendern(tx, w.mandant);
          await tx.mandantKontaktRolle.updateMany({
            where: { mandantId: w.mandant, kontaktId: w.p.gv },
            data: { aktiv: false },
          });
          entzogen();
          await schranke;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await istEntzogen;
      const titel = `Lager Rollenentzug ${randomBytes(3).toString('hex')}`;
      // Die Vorprüfung sieht noch die festgeschriebene Rolle; die Meldung wartet an der Mandantenzeile.
      const melden = fehlerVon(
        im(A.gv, (ctx) => meldeEreignis(ctx, meldung(w, { titel }) as never)),
      );
      await bisWartend(w.tenant);
      loslassen();
      await pflege;
      expect((await melden).code).toBe('NICHT_GEFUNDEN');
      expect(await inTenant(w, (tx) => tx.ereignis.count({ where: { titel } }))).toBe(0);
    } finally {
      await zweite.$disconnect();
    }
  });
});
