// =============================================================================
// Lader Risiken, Kontrollen, Profil gegen PostgreSQL (DB_TESTS=1, DATABASE_URL
// = tcms_app): positive Fälle mit berechneten Werten und JSON-Form; TS-03
// (fremder Mandant, fremder Tenant, Mandantenkontakt, fremde Objekt-ID →
// NICHT_GEFUNDEN ohne Unterschied); Eingaben strikt.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  KontrolleDetailSchema,
  KontrollenListeSchema,
  ProfilDatenSchema,
  RisikenListeSchema,
  RisikoDetailSchema,
} from '@tcms/contract';
import type { DienstKontext } from '../../../kontext';
import { ladeKontrolle, ladeKontrollen, ladeProfil, ladeRisiken, ladeRisiko } from '../lesen';
import {
  akteureVon,
  fehlerVon,
  kanzlei,
  kontakt,
  legeProgrammAn,
  rufe,
  type Programm,
} from './fixture';

const AKTIV = process.env['DB_TESTS'] === '1';

/** Das Ergebnis ist reines JSON (keine Date/Map/Set, keine undefined-Felder). */
function istJson(x: unknown) {
  expect(JSON.parse(JSON.stringify(x))).toEqual(x);
}

describe.skipIf(!AKTIV)('Lader risiken-kontrollen', () => {
  let a: Programm;
  let b: Programm;
  let c: Programm;
  const tenant = randomUUID();
  const tenantFremd = randomUUID();

  beforeAll(async () => {
    a = await legeProgrammAn(tenant);
    b = await legeProgrammAn(tenant);
    c = await legeProgrammAn(tenantFremd);
  }, 120_000);

  it('Risikoinventar: berechnete Brutto-/Nettowerte, Hinweise, JSON', async () => {
    const { bt } = akteureVon(a);
    const l = await rufe(bt, (ctx) => ladeRisiken(ctx, { mandantId: a.mandantId }));
    expect(RisikenListeSchema.parse(l)).toEqual(l);
    istJson(l);
    expect(l.programmId).toBe(a.programmId);
    expect(l.historisch).toBe(false);
    expect(l.risiken).toHaveLength(a.risiken.size);
    const r = l.risiken[0]!;
    expect(r.bewertung.brutto.klasse).toBeTruthy();
    expect(r.bewertung.modell).toBe('ec-1.0');
    expect(l.vorschlaegeOffen).toBe(0);
    // Namen nur über das Personenverzeichnis (hier: Testverzeichnis).
    expect(l.namen[a.personen.tcb]).toBe(`Person ${a.personen.tcb.slice(0, 4)}`);
  });

  it('Risikodetail: Stände, Kontrollen, Audit-Spur; historischer Stand', async () => {
    const { bt } = akteureVon(a);
    const risikoId = [...a.risiken.values()][0]!;
    const d = await rufe(bt, (ctx) => ladeRisiko(ctx, { mandantId: a.mandantId, risikoId }));
    expect(RisikoDetailSchema.parse(d)).toEqual(d);
    istJson(d);
    expect(d.risiko.id).toBe(risikoId);
    expect(d.staende).toHaveLength(1);
    expect(d.kontrollen.length).toBeGreaterThan(0);
    const alt = await rufe(bt, (ctx) =>
      ladeRisiko(ctx, { mandantId: a.mandantId, risikoId, stand: '2026-06-30' }),
    );
    expect(alt.historisch).toBe(true);
    expect(alt.stand).toBe('2026-06-30');
  });

  it('Kontrollmatrix und Kontrolldetail: berechnete Frequenz, Durchführungen', async () => {
    const { hb } = akteureVon(a);
    const l = await rufe(hb, (ctx) => ladeKontrollen(ctx, { mandantId: a.mandantId }));
    expect(KontrollenListeSchema.parse(l)).toEqual(l);
    istJson(l);
    expect(l.kontrollen).toHaveLength(a.kontrollen.size);
    const k = l.kontrollen.find((x) => x.risikoIds.length > 0)!;
    expect(k.ableitung.effektiv).toEqual(k.frequenz);
    const d = await rufe(hb, (ctx) =>
      ladeKontrolle(ctx, { mandantId: a.mandantId, kontrolleId: k.id }),
    );
    expect(KontrolleDetailSchema.parse(d)).toEqual(d);
    istJson(d);
    expect(d.staende[0]!.aenderungen).toEqual(['Kontrolle angelegt']);
    expect(d.durchfuehrungen.length).toBeGreaterThan(0);
  });

  it('Profil: Stände, Vorschläge mit Entscheidung', async () => {
    const { bt } = akteureVon(a);
    const p = await rufe(bt, (ctx) => ladeProfil(ctx, { mandantId: a.mandantId }));
    expect(ProfilDatenSchema.parse(p)).toEqual(p);
    istJson(p);
    expect(p.staende).toHaveLength(1);
    expect(p.vorschlaege.find((v) => v.code === a.offenerVorschlag)?.entscheidung).toBe('OFFEN');
    expect(p.vorschlaege.filter((v) => v.entscheidung === 'UEBERNOMMEN')).toHaveLength(
      a.risiken.size,
    );
  });

  it('TS-03: ohne Bezug, Mandantenkontakt, fremder Tenant, unbekannt → gleiches NICHT_GEFUNDEN', async () => {
    const risikoA = [...a.risiken.values()][0]!;
    const kontrolleA = [...a.kontrollen.values()][0]!;
    const fremde = [
      // Bezug auf einen anderen Mandanten desselben Tenants (auch als Admin).
      kanzlei(tenant, a.personen.bt, b.mandantId, { admin: true, bt: true, zustaendig: true }),
      // Ohne Mandantenbezug.
      kanzlei(tenant, a.personen.bt, null, { admin: true, bt: true }),
      // Mandantenkontakt mit aktiver Rolle: Staff-Sichten nicht.
      kontakt(tenant, a.personen.gv, a.mandantId),
      // Anderer Tenant, Bezug auf die Mandanten-ID von A: RLS verbirgt A.
      kanzlei(tenantFremd, c.personen.bt, a.mandantId, { admin: true, bt: true, zustaendig: true }),
    ];
    for (const akteur of fremde) {
      const laeufe: ((ctx: DienstKontext) => Promise<unknown>)[] = [
        (ctx: Parameters<typeof ladeRisiken>[0]) => ladeRisiken(ctx, { mandantId: a.mandantId }),
        (ctx: Parameters<typeof ladeRisiken>[0]) =>
          ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: risikoA }),
        (ctx: Parameters<typeof ladeRisiken>[0]) => ladeKontrollen(ctx, { mandantId: a.mandantId }),
        (ctx: Parameters<typeof ladeRisiken>[0]) =>
          ladeKontrolle(ctx, { mandantId: a.mandantId, kontrolleId: kontrolleA }),
        (ctx: Parameters<typeof ladeRisiken>[0]) => ladeProfil(ctx, { mandantId: a.mandantId }),
      ];
      for (const lauf of laeufe) {
        const f = await fehlerVon(rufe(akteur, lauf));
        expect(f.code).toBe('NICHT_GEFUNDEN');
        expect(f.message).toBe('NICHT_GEFUNDEN');
        expect(f.felder).toBeUndefined();
      }
    }
    // Unbekannter Mandant mit bestätigtem Bezug: dieselbe Antwort.
    const unbekannt = randomUUID();
    const u = await fehlerVon(
      rufe(kanzlei(tenant, a.personen.bt, unbekannt, { admin: true }), (ctx) =>
        ladeRisiken(ctx, { mandantId: unbekannt }),
      ),
    );
    expect(u.code).toBe('NICHT_GEFUNDEN');
    expect(u.message).toBe('NICHT_GEFUNDEN');
  });

  it('Objekt-ID eines anderen Mandanten bzw. Tenants → NICHT_GEFUNDEN', async () => {
    const { bt } = akteureVon(a);
    for (const risikoId of [[...b.risiken.values()][0]!, [...c.risiken.values()][0]!, 'xyz']) {
      const f = await fehlerVon(
        rufe(bt, (ctx) => ladeRisiko(ctx, { mandantId: a.mandantId, risikoId })),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
    for (const kontrolleId of [[...b.kontrollen.values()][0]!, [...c.kontrollen.values()][0]!]) {
      const f = await fehlerVon(
        rufe(bt, (ctx) => ladeKontrolle(ctx, { mandantId: a.mandantId, kontrolleId })),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
  });

  it('Eingaben strikt: UNGUELTIG mit Feldern', async () => {
    const { bt } = akteureVon(a);
    for (const eingabe of [
      { mandantId: 'kein-uuid' },
      { mandantId: a.mandantId, stand: '2026-02-30' },
      { mandantId: a.mandantId, tenantId: randomUUID() },
      { mandantId: a.mandantId, risikoId: 'a/b' },
      null,
    ]) {
      const f = await fehlerVon(rufe(bt, (ctx) => ladeRisiken(ctx, eingabe as never)));
      expect(f.code).toBe('UNGUELTIG');
      expect(Object.keys(f.felder ?? {}).length).toBeGreaterThan(0);
    }
  });
});
