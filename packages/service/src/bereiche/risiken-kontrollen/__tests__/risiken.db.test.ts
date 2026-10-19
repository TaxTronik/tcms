// =============================================================================
// Fachoperationen Risiken gegen PostgreSQL (DB_TESTS=1, DATABASE_URL =
// tcms_app). Je Operation: positiver Fall mit Audit; Rechte negativ (fremder
// Mandant, Rolle fehlt, Mandantenkontakt, fremder Tenant, fremde Objekt-ID);
// Vier-Augen; TS-05 mit zwei Verbindungen (genau eine Änderung wirkt, keine
// Gabelung); Regel 2 (keine Klassen als Eingabe); TS-07 (kein Stichtag).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant, type PrismaClient } from '@tcms/db';
import type { DienstKontext } from '../../../kontext';
import { ladeRisiken, ladeRisiko } from '../lesen';
import {
  risikenFreigeben,
  risikenZurFreigabe,
  risikoakzeptanzAnfordern,
  risikoBewertungBestaetigen,
  risikoNeuBewerten,
  risikoZurueckweisen,
  uebersteuerungBeantragen,
  uebersteuerungEntscheiden,
} from '../risiken';
import {
  akteureVon,
  BEGRUENDUNG,
  fehlerVon,
  gleichzeitig,
  kanzlei,
  kontakt,
  legeProgrammAn,
  rufe,
  type Programm,
} from './fixture';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Risiken: Fachoperationen', () => {
  const tenant = randomUUID();
  const tenantFremd = randomUUID();
  let a: Programm;
  let b: Programm;
  let c: Programm;
  let zweite: PrismaClient;
  let akt: ReturnType<typeof akteureVon>;

  beforeAll(async () => {
    zweite = erzeugeClient(process.env['DATABASE_URL']);
    a = await legeProgrammAn(tenant);
    b = await legeProgrammAn(tenant);
    c = await legeProgrammAn(tenantFremd);
    akt = akteureVon(a);
  }, 120_000);

  afterAll(async () => {
    await zweite?.$disconnect();
  });

  const lies = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(tenant, fn);
  const risiko = (code?: string) => (code ? a.risiken.get(code)! : [...a.risiken.values()][0]!);
  const offenerStand = (risikoId: string) =>
    lies((tx) => tx.risikoStand.findFirstOrThrow({ where: { risikoId, gueltigBis: null } }));
  const audit = (objektId: string, aktion: string) =>
    lies((tx) => tx.auditEvent.findMany({ where: { objektId, aktion } }));

  /** Negative Rechtefälle, die für jede schreibende Operation gelten. */
  async function rechteNegativ(
    lauf: (ctx: DienstKontext, mandantId: string) => Promise<unknown>,
  ): Promise<void> {
    // Rolle fehlt: Bezug, aber weder Admin, BT noch Hauptbearbeitung.
    const ohne = await fehlerVon(rufe(akt.leser, (ctx) => lauf(ctx, a.mandantId)));
    expect(ohne.code).toBe('NICHT_BERECHTIGT');
    for (const akteur of [
      // Fremder Mandant: Bezug auf B, Anfrage auf A.
      kanzlei(tenant, a.personen.bt, b.mandantId, { admin: true, bt: true, zustaendig: true }),
      // Mandantenkontakt mit aktiver Rolle.
      kontakt(tenant, a.personen.gv, a.mandantId),
      // Fremder Tenant mit Bezug auf die Mandanten-ID von A.
      kanzlei(tenantFremd, c.personen.bt, a.mandantId, { admin: true, bt: true, zustaendig: true }),
    ]) {
      const f = await fehlerVon(rufe(akteur, (ctx) => lauf(ctx, a.mandantId)));
      expect(f.code).toBe('NICHT_GEFUNDEN');
      expect(f.message).toBe('NICHT_GEFUNDEN');
    }
  }

  // ---------------------------------------------------------------------------
  describe('neu bewerten / bestätigen', () => {
    it('legt einen neuen Stand an, schließt den alten, setzt BEWERTET, protokolliert', async () => {
      const id = risiko();
      const alt = await offenerStand(id);
      const s = alt.s === 'H' ? 'N' : 'H';
      const r = await rufe(akt.hb, (ctx) =>
        risikoNeuBewerten(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          standId: alt.id,
          s,
          w: alt.w,
          r: alt.r as 1 | 2 | 3,
          gt: alt.gt,
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(r.geaendert).toBe(true);
      expect(r.version).toBe(alt.version + 1);
      expect(r.freigabe).toEqual({ vorher: 'FREIGEGEBEN', nachher: 'BEWERTET' });
      const staende = await lies((tx) =>
        tx.risikoStand.findMany({ where: { risikoId: id }, orderBy: { version: 'asc' } }),
      );
      expect(staende.filter((x) => x.gueltigBis === null)).toHaveLength(1);
      expect(staende.find((x) => x.id === alt.id)?.gueltigBis).not.toBeNull();
      expect(await audit(id, 'tcms.risiko.neu_bewertet')).toHaveLength(1);
      // Unverändert bestätigen: eigener Audit-Eintrag, Werte bleiben.
      const b2 = await rufe(akt.hb, (ctx) =>
        risikoBewertungBestaetigen(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          standId: r.standId,
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(b2.geaendert).toBe(false);
      expect(await audit(id, 'tcms.risiko.bewertung_bestaetigt')).toHaveLength(1);
    });

    it('Rechte negativ', async () => {
      const id = risiko();
      const st = await offenerStand(id);
      await rechteNegativ((ctx, mandantId) =>
        risikoBewertungBestaetigen(ctx, {
          mandantId,
          risikoId: id,
          standId: st.id,
          begruendung: BEGRUENDUNG,
        }),
      );
    });

    it('Risiko eines anderen Mandanten bzw. Tenants → NICHT_GEFUNDEN', async () => {
      for (const x of [b, c]) {
        const id = [...x.risiken.values()][0]!;
        const f = await fehlerVon(
          rufe(akt.bt, (ctx) =>
            risikoBewertungBestaetigen(ctx, {
              mandantId: a.mandantId,
              risikoId: id,
              standId: id,
              begruendung: BEGRUENDUNG,
            }),
          ),
        );
        expect(f.code).toBe('NICHT_GEFUNDEN');
      }
    });

    it('Regel 2 und TS-07: keine Klassen, kein Stichtag, Begründung ≥ 30', async () => {
      const id = risiko();
      const st = await offenerStand(id);
      const basis = {
        mandantId: a.mandantId,
        risikoId: id,
        standId: st.id,
        s: st.s,
        w: st.w,
        r: st.r,
        gt: st.gt,
        begruendung: BEGRUENDUNG,
      };
      for (const eingabe of [
        { ...basis, brutto: 'GERING' },
        { ...basis, nettoDesign: 'GERING' },
        { ...basis, stand: '2026-01-01' },
        { ...basis, begruendung: 'zu kurz' },
        { ...basis, r: 4 },
      ]) {
        const f = await fehlerVon(rufe(akt.bt, (ctx) => risikoNeuBewerten(ctx, eingabe as never)));
        expect(f.code).toBe('UNGUELTIG');
      }
    });

    it('TS-05: zwei gleichzeitige Neubewertungen desselben Stands → genau eine, keine Gabelung', async () => {
      const id = risiko();
      const st = await offenerStand(id);
      const lauf = (s: 'N' | 'M' | 'H', client?: PrismaClient) =>
        rufe(
          akt.hb,
          (ctx) =>
            risikoNeuBewerten(ctx, {
              mandantId: a.mandantId,
              risikoId: id,
              standId: st.id,
              s,
              w: st.w,
              r: st.r as 1 | 2 | 3,
              gt: st.gt,
              begruendung: BEGRUENDUNG,
            }),
          client,
        );
      const e = await gleichzeitig(
        () => lauf('N'),
        () => lauf('M', zweite),
      );
      expect(e).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      const staende = await lies((tx) => tx.risikoStand.findMany({ where: { risikoId: id } }));
      expect(staende.filter((x) => x.gueltigBis === null)).toHaveLength(1);
      expect(new Set(staende.map((x) => x.version)).size).toBe(staende.length);
      expect(staende.filter((x) => x.version === st.version + 1)).toHaveLength(1);
    });

    it('veralteter Stand → KONFLIKT', async () => {
      const id = risiko();
      const st = await offenerStand(id);
      await rufe(akt.hb, (ctx) =>
        risikoBewertungBestaetigen(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          standId: st.id,
          begruendung: BEGRUENDUNG,
        }),
      );
      const f = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          risikoBewertungBestaetigen(ctx, {
            mandantId: a.mandantId,
            risikoId: id,
            standId: st.id,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(f.code).toBe('KONFLIKT');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Übersteuerung', () => {
    /** Risiko, dessen berechnete Nettoklasse (Design) nicht KRITISCH ist. */
    async function ziel() {
      const d = await rufe(akt.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: risiko([...a.risiken.keys()][1]) }),
      );
      const berechnet = d.risiko.bewertung.nettoDesign.klasse;
      const klasse = berechnet === 'KRITISCH' ? 'HOCH' : 'KRITISCH';
      return { id: d.risiko.id, berechnet, klasse } as const;
    }

    it('beantragen, Vier-Augen, freigeben; berechneter Wert bleibt sichtbar', async () => {
      const z = await ziel();
      const antrag = await rufe(akt.hb, (ctx) =>
        uebersteuerungBeantragen(ctx, {
          mandantId: a.mandantId,
          risikoId: z.id,
          sicht: 'DESIGN',
          klasse: z.klasse,
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(antrag.berechnet).toBe(z.berechnet);
      // Zweiter offener Antrag derselben Sicht → KONFLIKT.
      const doppelt = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          uebersteuerungBeantragen(ctx, {
            mandantId: a.mandantId,
            risikoId: z.id,
            sicht: 'DESIGN',
            klasse: z.klasse,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(doppelt.code).toBe('KONFLIKT');
      // Vier-Augen: die beantragende Person entscheidet nicht.
      const selbst = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          uebersteuerungEntscheiden(ctx, {
            mandantId: a.mandantId,
            uebersteuerungId: antrag.uebersteuerungId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect(selbst.code).toBe('NICHT_BERECHTIGT');
      // Dieselbe Person in anderer Schreibweise (Großbuchstaben) ist keine zweite Person.
      const gross = kanzlei(tenant, a.personen.hb.toUpperCase(), a.mandantId, { hb: true });
      expect(
        (
          await fehlerVon(
            rufe(gross, (ctx) =>
              uebersteuerungEntscheiden(ctx, {
                mandantId: a.mandantId,
                uebersteuerungId: antrag.uebersteuerungId,
                entscheidung: 'FREIGEBEN',
              }),
            ),
          )
        ).code,
      ).toBe('NICHT_BERECHTIGT');
      const ok = await rufe(akt.bt, (ctx) =>
        uebersteuerungEntscheiden(ctx, {
          mandantId: a.mandantId,
          uebersteuerungId: antrag.uebersteuerungId,
          entscheidung: 'FREIGEBEN',
        }),
      );
      expect(ok.status).toBe('FREIGEGEBEN');
      const d = await rufe(akt.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: z.id }),
      );
      expect(d.risiko.bewertung.nettoDesign.klasse).toBe(z.berechnet);
      expect(d.risiko.bewertung.wirksamDesign).toBe(z.klasse);
      expect(d.risiko.bewertung.uebersteuertDesign).toBe(true);
      expect(await audit(z.id, 'tcms.risiko.uebersteuerung_freigegeben')).toHaveLength(1);
      // Bereits entschieden → KONFLIKT.
      const nochmal = await fehlerVon(
        rufe(akt.admin, (ctx) =>
          uebersteuerungEntscheiden(ctx, {
            mandantId: a.mandantId,
            uebersteuerungId: antrag.uebersteuerungId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect(nochmal.code).toBe('KONFLIKT');
    });

    it('berechneter Wert als Ziel, kurze Begründung, Ablehnung ohne Begründung → UNGUELTIG', async () => {
      const z = await ziel();
      const d = await rufe(akt.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: z.id }),
      );
      const gleich = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          uebersteuerungBeantragen(ctx, {
            mandantId: a.mandantId,
            risikoId: z.id,
            sicht: 'BETRIEB',
            klasse: d.risiko.bewertung.nettoBetrieb.klasse,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(gleich.code).toBe('UNGUELTIG');
      const kurz = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          uebersteuerungBeantragen(ctx, {
            mandantId: a.mandantId,
            risikoId: z.id,
            sicht: 'BETRIEB',
            klasse: 'KRITISCH',
            begruendung: 'kurz',
          }),
        ),
      );
      expect(kurz.code).toBe('UNGUELTIG');
      const ablehnung = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          uebersteuerungEntscheiden(ctx, {
            mandantId: a.mandantId,
            uebersteuerungId: 'beliebig',
            entscheidung: 'ABLEHNEN',
          }),
        ),
      );
      expect(ablehnung.code).toBe('UNGUELTIG');
    });

    it('TS-05: zwei gleichzeitige Anträge derselben Sicht → genau einer', async () => {
      const id = risiko([...a.risiken.keys()][2]);
      const d = await rufe(akt.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: id }),
      );
      const berechnet = d.risiko.bewertung.nettoBetrieb.klasse;
      const klasse = berechnet === 'KRITISCH' ? 'HOCH' : 'KRITISCH';
      const lauf = (client?: PrismaClient) =>
        rufe(
          akt.hb,
          (ctx) =>
            uebersteuerungBeantragen(ctx, {
              mandantId: a.mandantId,
              risikoId: id,
              sicht: 'BETRIEB',
              klasse,
              begruendung: BEGRUENDUNG,
            }),
          client,
        );
      expect(
        await gleichzeitig(
          () => lauf(),
          () => lauf(zweite),
        ),
      ).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      const offen = await lies((tx) =>
        tx.uebersteuerung.count({ where: { risikoId: id, sicht: 'BETRIEB', status: 'BEANTRAGT' } }),
      );
      expect(offen).toBe(1);
    });

    it('TS-05: zwei gleichzeitige Entscheidungen → genau eine wirkt', async () => {
      const id = risiko([...a.risiken.keys()][3]);
      const d = await rufe(akt.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: a.mandantId, risikoId: id }),
      );
      const berechnet = d.risiko.bewertung.nettoDesign.klasse;
      const antrag = await rufe(akt.hb, (ctx) =>
        uebersteuerungBeantragen(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          sicht: 'DESIGN',
          klasse: berechnet === 'KRITISCH' ? 'HOCH' : 'KRITISCH',
          begruendung: BEGRUENDUNG,
        }),
      );
      const e = await gleichzeitig(
        () =>
          rufe(akt.bt, (ctx) =>
            uebersteuerungEntscheiden(ctx, {
              mandantId: a.mandantId,
              uebersteuerungId: antrag.uebersteuerungId,
              entscheidung: 'FREIGEBEN',
            }),
          ),
        () =>
          rufe(
            akt.admin,
            (ctx) =>
              uebersteuerungEntscheiden(ctx, {
                mandantId: a.mandantId,
                uebersteuerungId: antrag.uebersteuerungId,
                entscheidung: 'ABLEHNEN',
                begruendung: BEGRUENDUNG,
              }),
            zweite,
          ),
      );
      expect(e).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      const u = await lies((tx) =>
        tx.uebersteuerung.findUniqueOrThrow({ where: { id: antrag.uebersteuerungId } }),
      );
      expect(['FREIGEGEBEN', 'ABGELEHNT']).toContain(u.status);
      const entschieden = await lies((tx) =>
        tx.auditEvent.count({
          where: {
            objektId: id,
            aktion: {
              in: [
                'tcms.risiko.uebersteuerung_freigegeben',
                'tcms.risiko.uebersteuerung_abgelehnt',
              ],
            },
          },
        }),
      );
      expect(entschieden).toBe(1);
    });

    it('Rechte negativ und fremde Übersteuerung → NICHT_GEFUNDEN', async () => {
      await rechteNegativ((ctx, mandantId) =>
        uebersteuerungBeantragen(ctx, {
          mandantId,
          risikoId: risiko(),
          sicht: 'DESIGN',
          klasse: 'KRITISCH',
          begruendung: BEGRUENDUNG,
        }),
      );
      // Antrag in Mandant B; Entscheidung über Mandant A.
      const akteureB = akteureVon(b);
      const idB = [...b.risiken.values()][0]!;
      const dB = await rufe(akteureB.bt, (ctx) =>
        ladeRisiko(ctx, { mandantId: b.mandantId, risikoId: idB }),
      );
      const kB = dB.risiko.bewertung.nettoDesign.klasse === 'KRITISCH' ? 'HOCH' : 'KRITISCH';
      const uB = await rufe(akteureB.hb, (ctx) =>
        uebersteuerungBeantragen(ctx, {
          mandantId: b.mandantId,
          risikoId: idB,
          sicht: 'DESIGN',
          klasse: kB,
          begruendung: BEGRUENDUNG,
        }),
      );
      const f = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          uebersteuerungEntscheiden(ctx, {
            mandantId: a.mandantId,
            uebersteuerungId: uB.uebersteuerungId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
      const unveraendert = await mitTenant(tenant, (tx) =>
        tx.uebersteuerung.findUniqueOrThrow({ where: { id: uB.uebersteuerungId } }),
      );
      expect(unveraendert.status).toBe('BEANTRAGT');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Freigabe des Inventars', () => {
    /** Risiko auf BEWERTET setzen (neu bewerten mit geänderten Werten). */
    async function bewertet(code: string) {
      const id = risiko(code);
      const st = await offenerStand(id);
      await rufe(akt.hb, (ctx) =>
        risikoNeuBewerten(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          standId: st.id,
          s: st.s === 'H' ? 'M' : 'H',
          w: st.w,
          r: st.r as 1 | 2 | 3,
          gt: st.gt,
          begruendung: BEGRUENDUNG,
        }),
      );
      return id;
    }

    it('einreichen, Vier-Augen, freigeben; Zurückweisen', async () => {
      const codes = [...a.risiken.keys()];
      const id1 = await bewertet(codes[4]!);
      const id2 = await bewertet(codes[5]!);
      const ein = await rufe(akt.hb, (ctx) =>
        risikenZurFreigabe(ctx, { mandantId: a.mandantId, risikoIds: [id1, id2] }),
      );
      expect(ein.bearbeitet.map((x) => x.risikoId).sort()).toEqual([id1, id2].sort());
      // Selbst eingereicht → nicht freigeben.
      const selbst = await fehlerVon(
        rufe(akt.hb, (ctx) => risikenFreigeben(ctx, { mandantId: a.mandantId, risikoIds: [id1] })),
      );
      expect(selbst.code).toBe('NICHT_BERECHTIGT');
      const zurueck = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          risikoZurueckweisen(ctx, {
            mandantId: a.mandantId,
            risikoId: id2,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(zurueck.code).toBe('NICHT_BERECHTIGT');
      const frei = await rufe(akt.bt, (ctx) =>
        risikenFreigeben(ctx, { mandantId: a.mandantId, risikoIds: [id1] }),
      );
      expect(frei.bearbeitet).toEqual([{ risikoId: id1, code: codes[4]! }]);
      const zw = await rufe(akt.bt, (ctx) =>
        risikoZurueckweisen(ctx, {
          mandantId: a.mandantId,
          risikoId: id2,
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(zw.freigabe).toBe('BEWERTET');
      // Nicht (mehr) eingereicht → KONFLIKT.
      const nicht = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          risikoZurueckweisen(ctx, {
            mandantId: a.mandantId,
            risikoId: id2,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(nicht.code).toBe('KONFLIKT');
      expect(await audit(id1, 'tcms.risiko.freigegeben')).toHaveLength(1);
      expect(await audit(id2, 'tcms.risiko.zurueckgewiesen')).toHaveLength(1);
    });

    it('fremdes Risiko in der Auswahl → NICHT_GEFUNDEN, nichts geändert', async () => {
      const codes = [...a.risiken.keys()];
      const id = await bewertet(codes[6]!);
      const fremd = [...b.risiken.values()][0]!;
      const f = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          risikenZurFreigabe(ctx, { mandantId: a.mandantId, risikoIds: [id, fremd] }),
        ),
      );
      expect(f.code).toBe('NICHT_GEFUNDEN');
      const r = await lies((tx) => tx.risiko.findUniqueOrThrow({ where: { id } }));
      expect(r.freigabe).toBe('BEWERTET');
      const dubletten = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          risikenZurFreigabe(ctx, { mandantId: a.mandantId, risikoIds: [id, id] }),
        ),
      );
      expect(dubletten.code).toBe('UNGUELTIG');
    });

    it('TS-05: zwei gleichzeitige Freigaben durch zweite Personen → genau eine', async () => {
      const codes = [...a.risiken.keys()];
      const id = await bewertet(codes[7]!);
      await rufe(akt.hb, (ctx) =>
        risikenZurFreigabe(ctx, { mandantId: a.mandantId, risikoIds: [id] }),
      );
      const e = await gleichzeitig(
        () =>
          rufe(akt.bt, (ctx) => risikenFreigeben(ctx, { mandantId: a.mandantId, risikoIds: [id] })),
        () =>
          rufe(
            akt.admin,
            (ctx) => risikenFreigeben(ctx, { mandantId: a.mandantId, risikoIds: [id] }),
            zweite,
          ),
      );
      expect(e).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      expect(await audit(id, 'tcms.risiko.freigegeben')).toHaveLength(1);
    });

    it('Rechte negativ', async () => {
      await rechteNegativ((ctx, mandantId) =>
        risikenZurFreigabe(ctx, { mandantId, risikoIds: [risiko()] }),
      );
      await rechteNegativ((ctx, mandantId) =>
        risikoZurueckweisen(ctx, { mandantId, risikoId: risiko(), begruendung: BEGRUENDUNG }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('Risikoakzeptanz', () => {
    async function ueberAppetit() {
      const { risiken } = await rufe(akt.bt, (ctx) => ladeRisiken(ctx, { mandantId: a.mandantId }));
      const r = risiken.find((x) => x.ueberAppetit && x.akzeptanzen.length === 0);
      if (!r) throw new Error('kein Risiko über dem Appetit');
      return r.id;
    }

    it('nur an die gesetzliche Vertretung des Mandanten; je Risiko eine offene', async () => {
      const id = await ueberAppetit();
      for (const empfaengerId of [a.personen.tcb, b.personen.gv, randomUUID()]) {
        const f = await fehlerVon(
          rufe(akt.hb, (ctx) =>
            risikoakzeptanzAnfordern(ctx, {
              mandantId: a.mandantId,
              risikoId: id,
              empfaengerId,
              begruendung: BEGRUENDUNG,
            }),
          ),
        );
        expect(f.code).toBe('UNGUELTIG');
      }
      const ok = await rufe(akt.hb, (ctx) =>
        risikoakzeptanzAnfordern(ctx, {
          mandantId: a.mandantId,
          risikoId: id,
          empfaengerId: a.personen.gv,
          begruendung: BEGRUENDUNG,
        }),
      );
      const f = await lies((tx) => tx.freigabe.findUniqueOrThrow({ where: { id: ok.freigabeId } }));
      expect(f.empfaengerId).toBe(a.personen.gv);
      expect(f.status).toBe('OFFEN');
      // TS-06: Nachricht über die Kontakt-ID adressiert.
      const n = await lies((tx) =>
        tx.nachricht.findFirst({
          where: { empfaengerId: a.personen.gv, zweck: 'FREIGABE_ANGEFORDERT' },
        }),
      );
      expect(n).not.toBeNull();
      const zweiteAnf = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          risikoakzeptanzAnfordern(ctx, {
            mandantId: a.mandantId,
            risikoId: id,
            empfaengerId: a.personen.gv,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(zweiteAnf.code).toBe('KONFLIKT');
      const ev = await audit(id, 'tcms.risiko.akzeptanz_angefordert');
      expect(ev).toHaveLength(1);
      expect(JSON.stringify(ev[0]!.detail)).not.toContain('Person ');
    });

    it('nicht über dem Appetit → KONFLIKT; Rechte negativ', async () => {
      const x = await legeProgrammAn(tenant, { appetit: 'KRITISCH' });
      const ax = akteureVon(x);
      const f = await fehlerVon(
        rufe(ax.hb, (ctx) =>
          risikoakzeptanzAnfordern(ctx, {
            mandantId: x.mandantId,
            risikoId: [...x.risiken.values()][0]!,
            empfaengerId: x.personen.gv,
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(f.code).toBe('KONFLIKT');
      await rechteNegativ((ctx, mandantId) =>
        risikoakzeptanzAnfordern(ctx, {
          mandantId,
          risikoId: risiko(),
          empfaengerId: a.personen.gv,
          begruendung: BEGRUENDUNG,
        }),
      );
    }, 60_000);
  });
});
