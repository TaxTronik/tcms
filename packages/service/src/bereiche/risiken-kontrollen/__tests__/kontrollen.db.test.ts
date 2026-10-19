// =============================================================================
// Fachoperationen Kontrollen gegen PostgreSQL (DB_TESTS=1, DATABASE_URL =
// tcms_app): Designbeurteilung, Frequenzabweichung (Vier-Augen,
// Doppelentscheidung), Neuplanung ohne Verlust abgeschlossener oder
// begonnener Durchführungen, Zuständigkeiten (Personen passend zum Mandanten),
// TS-05 mit zwei Verbindungen, Rechte negativ.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KontrolleEintrag } from '@tcms/contract';
import { erzeugeClient, mitTenant, type PrismaClient } from '@tcms/db';
import type { DienstKontext } from '../../../kontext';
import {
  designBeurteilen,
  frequenzAbweichungAufheben,
  frequenzAbweichungBeantragen,
  frequenzAbweichungEntscheiden,
  verantwortlicheAendern,
} from '../kontrollen';
import { ladeKontrolle, ladeKontrollen } from '../lesen';
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

describe.skipIf(!AKTIV)('Kontrollen: Fachoperationen', () => {
  const tenant = randomUUID();
  const tenantFremd = randomUUID();
  let a: Programm;
  let b: Programm;
  let c: Programm;
  let zweite: PrismaClient;
  let akt: ReturnType<typeof akteureVon>;
  let liste: KontrolleEintrag[];

  beforeAll(async () => {
    zweite = erzeugeClient(process.env['DATABASE_URL']);
    a = await legeProgrammAn(tenant);
    b = await legeProgrammAn(tenant);
    c = await legeProgrammAn(tenantFremd);
    akt = akteureVon(a);
    liste = (await rufe(akt.bt, (ctx) => ladeKontrollen(ctx, { mandantId: a.mandantId })))
      .kontrollen;
  }, 120_000);

  afterAll(async () => {
    await zweite?.$disconnect();
  });

  const lies = <T>(fn: Parameters<typeof mitTenant<T>>[1]) => mitTenant(tenant, fn);
  const stand = (kontrolleId: string) =>
    lies((tx) => tx.kontrolleStand.findFirstOrThrow({ where: { kontrolleId, gueltigBis: null } }));
  const audit = (objektId: string, aktion: string) =>
    lies((tx) => tx.auditEvent.findMany({ where: { objektId, aktion } }));
  const kanzleiKontrollen = () => liste.filter((k) => k.partei === 'KANZLEI');
  const monatlich = () =>
    liste.filter(
      (k) => k.partei === 'KANZLEI' && k.frequenz.turnus === 'MONATLICH' && k.risikoIds.length > 0,
    );

  async function rechteNegativ(
    lauf: (ctx: DienstKontext, mandantId: string) => Promise<unknown>,
  ): Promise<void> {
    expect(await fehlerVon(rufe(akt.leser, (ctx) => lauf(ctx, a.mandantId)))).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      grund: 'BEARBEITEN',
    });
    for (const akteur of [
      kanzlei(tenant, a.personen.bt, b.mandantId, { admin: true, bt: true, zustaendig: true }),
      kontakt(tenant, a.personen.gv, a.mandantId),
      kanzlei(tenantFremd, c.personen.bt, a.mandantId, { admin: true, bt: true, zustaendig: true }),
    ]) {
      const f = await fehlerVon(rufe(akteur, (ctx) => lauf(ctx, a.mandantId)));
      expect(f.code).toBe('NICHT_GEFUNDEN');
      expect(f.message).toBe('NICHT_GEFUNDEN');
    }
  }

  // ---------------------------------------------------------------------------
  describe('Designbeurteilung', () => {
    it('neuer Stand mit Person, Datum, Begründung; Audit; veralteter Stand → KONFLIKT', async () => {
      const k = kanzleiKontrollen()[0]!;
      const alt = await stand(k.id);
      const r = await rufe(akt.bt, (ctx) =>
        designBeurteilen(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: alt.id,
          design: 'MANGEL',
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(r.version).toBe(alt.version + 1);
      const neu = await stand(k.id);
      expect(neu).toMatchObject({ design: 'MANGEL', designVon: a.personen.bt });
      expect(await audit(k.id, 'tcms.kontrolle.design')).toHaveLength(1);
      const f = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          designBeurteilen(ctx, {
            mandantId: a.mandantId,
            kontrolleId: k.id,
            standId: alt.id,
            design: 'ANGEMESSEN',
            begruendung: BEGRUENDUNG,
          }),
        ),
      );
      expect(f.code).toBe('KONFLIKT');
    });

    it('TS-05: zwei gleichzeitige Änderungen desselben Stands → genau eine, keine Gabelung', async () => {
      const k = kanzleiKontrollen()[1]!;
      const alt = await stand(k.id);
      const lauf = (design: 'ANGEMESSEN' | 'MANGEL', client?: PrismaClient) =>
        rufe(
          akt.bt,
          (ctx) =>
            designBeurteilen(ctx, {
              mandantId: a.mandantId,
              kontrolleId: k.id,
              standId: alt.id,
              design,
              begruendung: BEGRUENDUNG,
            }),
          client,
        );
      expect(
        await gleichzeitig(
          () => lauf('MANGEL'),
          () => lauf('ANGEMESSEN', zweite),
        ),
      ).toEqual({
        erfolge: 1,
        codes: ['KONFLIKT'],
      });
      const staende = await lies((tx) =>
        tx.kontrolleStand.findMany({ where: { kontrolleId: k.id } }),
      );
      expect(staende.filter((s) => s.gueltigBis === null)).toHaveLength(1);
      expect(new Set(staende.map((s) => s.version)).size).toBe(staende.length);
    });

    it('Rechte negativ, fremde Kontrolle, Eingaben', async () => {
      const k = kanzleiKontrollen()[2]!;
      const st = await stand(k.id);
      await rechteNegativ((ctx, mandantId) =>
        designBeurteilen(ctx, {
          mandantId,
          kontrolleId: k.id,
          standId: st.id,
          design: 'ANGEMESSEN',
          begruendung: BEGRUENDUNG,
        }),
      );
      for (const fremd of [[...b.kontrollen.values()][0]!, [...c.kontrollen.values()][0]!]) {
        const f = await fehlerVon(
          rufe(akt.bt, (ctx) =>
            designBeurteilen(ctx, {
              mandantId: a.mandantId,
              kontrolleId: fremd,
              standId: st.id,
              design: 'ANGEMESSEN',
              begruendung: BEGRUENDUNG,
            }),
          ),
        );
        expect(f.code).toBe('NICHT_GEFUNDEN');
      }
      for (const eingabe of [
        { design: 'NICHT_BEURTEILT' },
        { begruendung: 'kurz' },
        { stand: '2026-01-01' },
        { designVon: randomUUID() },
      ]) {
        const f = await fehlerVon(
          rufe(akt.bt, (ctx) =>
            designBeurteilen(ctx, {
              mandantId: a.mandantId,
              kontrolleId: k.id,
              standId: st.id,
              design: 'ANGEMESSEN',
              begruendung: BEGRUENDUNG,
              ...eingabe,
            } as never),
          ),
        );
        expect(f.code).toBe('UNGUELTIG');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('Frequenzabweichung', () => {
    it('Vier-Augen, Freigabe plant neu, abgeschlossene und begonnene bleiben; Aufheben', async () => {
      const k = monatlich()[0]!;
      const heute = new Date('2026-10-16T00:00:00.000Z');
      // Künftige Durchführungen in Zuständen, die nie gelöscht werden dürfen.
      const kuenftig = await lies((tx) =>
        tx.durchfuehrung.findMany({
          where: { kontrolleId: k.id, status: 'GEPLANT', periodeBis: { gt: heute } },
          orderBy: { periodeVon: 'asc' },
        }),
      );
      expect(kuenftig.length).toBeGreaterThanOrEqual(4);
      const [abgeschlossen, begonnen, mitNachweis] = [kuenftig[1]!, kuenftig[2]!, kuenftig[3]!];
      await lies(async (tx) => {
        await tx.durchfuehrung.update({
          where: { id: abgeschlossen.id },
          data: {
            status: 'OHNE_BEFUND',
            durchgefuehrtVon: a.personen.hb,
            begonnenAm: heute,
            eingereichtAm: heute,
            gegengezeichnetVon: a.personen.bt,
            abgeschlossenAm: heute,
          },
        });
        await tx.durchfuehrung.update({
          where: { id: begonnen.id },
          data: { status: 'IN_DURCHFUEHRUNG', begonnenAm: heute, durchgefuehrtVon: a.personen.hb },
        });
        await tx.nachweis.create({
          data: {
            durchfuehrungId: mitNachweis.id,
            dokumentId: randomUUID(),
            dateiname: 'beleg.pdf',
            mime: 'application/pdf',
            groesse: 10,
            sha256: 'a'.repeat(64),
            hochgeladenVon: a.personen.hb,
          },
        });
      });

      const st = await stand(k.id);
      const antrag = await rufe(akt.hb, (ctx) =>
        frequenzAbweichungBeantragen(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: st.id,
          turnus: 'QUARTALSWEISE',
          anlass: false,
          begruendung: BEGRUENDUNG,
        }),
      );
      // Bis zur Freigabe gilt die berechnete Frequenz.
      expect(antrag.frequenz.turnus).toBe('MONATLICH');
      const selbst = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          frequenzAbweichungEntscheiden(ctx, {
            mandantId: a.mandantId,
            kontrolleId: k.id,
            standId: antrag.standId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect([selbst.code, selbst.grund]).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);
      // Eine Designänderung durch die beantragende Person ändert den Antragsteller nicht.
      const zwischen = await rufe(akt.bt, (ctx) =>
        designBeurteilen(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: antrag.standId,
          design: 'ANGEMESSEN',
          begruendung: BEGRUENDUNG,
        }),
      );
      // Der alte (gesehene) Stand ist nicht mehr gültig → KONFLIKT.
      const veraltet = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          frequenzAbweichungEntscheiden(ctx, {
            mandantId: a.mandantId,
            kontrolleId: k.id,
            standId: antrag.standId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect(veraltet.code).toBe('KONFLIKT');
      // Antragsteller bleibt hb, auch wenn bt den letzten Stand erzeugt hat.
      const nochSelbst = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          frequenzAbweichungEntscheiden(ctx, {
            mandantId: a.mandantId,
            kontrolleId: k.id,
            standId: zwischen.standId,
            entscheidung: 'FREIGEBEN',
          }),
        ),
      );
      expect([nochSelbst.code, nochSelbst.grund]).toEqual(['NICHT_BERECHTIGT', 'VIER_AUGEN']);

      const frei = await rufe(akt.bt, (ctx) =>
        frequenzAbweichungEntscheiden(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: zwischen.standId,
          entscheidung: 'FREIGEBEN',
        }),
      );
      expect(frei.frequenz.turnus).toBe('QUARTALSWEISE');
      expect(frei.neuplanung).not.toBeNull();
      const nachher = await lies((tx) =>
        tx.durchfuehrung.findMany({ where: { kontrolleId: k.id } }),
      );
      const ids = new Set(nachher.map((d) => d.id));
      for (const d of [abgeschlossen, begonnen, mitNachweis]) expect(ids.has(d.id)).toBe(true);
      expect(nachher.find((d) => d.id === abgeschlossen.id)?.status).toBe('OHNE_BEFUND');
      expect(nachher.find((d) => d.id === begonnen.id)?.status).toBe('IN_DURCHFUEHRUNG');
      // Vergangene, abgeschlossene Durchführungen bleiben vollständig erhalten.
      const vorbei = nachher.filter((d) => d.status === 'OHNE_BEFUND');
      expect(vorbei.length).toBeGreaterThan(1);
      expect(await audit(k.id, 'tcms.kontrolle.neu_geplant')).toHaveLength(1);

      const d = await rufe(akt.bt, (ctx) =>
        ladeKontrolle(ctx, { mandantId: a.mandantId, kontrolleId: k.id }),
      );
      expect(d.kontrolle.abweichung?.beantragtVon).toBe(a.personen.hb);
      expect(d.kontrolle.abweichung?.freigegebenVon).toBe(a.personen.bt);
      expect(d.kontrolle.ableitung.effektiv.turnus).toBe('MONATLICH');

      const auf = await rufe(akt.hb, (ctx) =>
        frequenzAbweichungAufheben(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: frei.standId,
          begruendung: BEGRUENDUNG,
        }),
      );
      expect(auf.frequenz.turnus).toBe('MONATLICH');
      const zuletzt = await lies((tx) =>
        tx.durchfuehrung.findMany({ where: { kontrolleId: k.id } }),
      );
      for (const x of [abgeschlossen, begonnen, mitNachweis])
        expect(zuletzt.some((y) => y.id === x.id)).toBe(true);
    });

    it('TS-05: zwei gleichzeitige Entscheidungen → genau eine wirkt', async () => {
      const k = monatlich()[1]!;
      const st = await stand(k.id);
      const antrag = await rufe(akt.hb, (ctx) =>
        frequenzAbweichungBeantragen(ctx, {
          mandantId: a.mandantId,
          kontrolleId: k.id,
          standId: st.id,
          turnus: 'JAEHRLICH',
          anlass: true,
          begruendung: BEGRUENDUNG,
        }),
      );
      const e = await gleichzeitig(
        () =>
          rufe(akt.bt, (ctx) =>
            frequenzAbweichungEntscheiden(ctx, {
              mandantId: a.mandantId,
              kontrolleId: k.id,
              standId: antrag.standId,
              entscheidung: 'FREIGEBEN',
            }),
          ),
        () =>
          rufe(
            akt.admin,
            (ctx) =>
              frequenzAbweichungEntscheiden(ctx, {
                mandantId: a.mandantId,
                kontrolleId: k.id,
                standId: antrag.standId,
                entscheidung: 'ABLEHNEN',
                begruendung: BEGRUENDUNG,
              }),
            zweite,
          ),
      );
      expect(e).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      const entschieden = await lies((tx) =>
        tx.auditEvent.count({
          where: {
            objektId: k.id,
            aktion: {
              in: ['tcms.kontrolle.abweichung_freigegeben', 'tcms.kontrolle.abweichung_abgelehnt'],
            },
          },
        }),
      );
      expect(entschieden).toBe(1);
      const staende = await lies((tx) =>
        tx.kontrolleStand.findMany({ where: { kontrolleId: k.id, gueltigBis: null } }),
      );
      expect(staende).toHaveLength(1);
    });

    it('gleiche Frequenz, offener Antrag, ohne Turnus und Anlass, Rechte', async () => {
      const k = monatlich()[2] ?? monatlich()[0]!;
      const st = await stand(k.id);
      const basis = {
        mandantId: a.mandantId,
        kontrolleId: k.id,
        standId: st.id,
        begruendung: BEGRUENDUNG,
      };
      const gleich = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          frequenzAbweichungBeantragen(ctx, {
            ...basis,
            turnus: k.frequenz.turnus,
            anlass: k.frequenz.anlass,
          }),
        ),
      );
      expect(['UNGUELTIG', 'KONFLIKT']).toContain(gleich.code);
      const ohne = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          frequenzAbweichungBeantragen(ctx, { ...basis, turnus: 'KEIN', anlass: false }),
        ),
      );
      expect(ohne.code).toBe('UNGUELTIG');
      await rechteNegativ((ctx, mandantId) =>
        frequenzAbweichungBeantragen(ctx, {
          ...basis,
          mandantId,
          turnus: 'JAEHRLICH',
          anlass: true,
        }),
      );
      await rechteNegativ((ctx, mandantId) =>
        frequenzAbweichungEntscheiden(ctx, { ...basis, mandantId, entscheidung: 'FREIGEBEN' }),
      );
      await rechteNegativ((ctx, mandantId) =>
        frequenzAbweichungAufheben(ctx, { ...basis, mandantId }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('Zuständigkeiten', () => {
    it('Kanzleiseite: kein Mandantenkontakt; Gegenzeichnung ≠ durchführend; positiv mit Audit', async () => {
      const k = kanzleiKontrollen().find((x) => x.schluessel)!;
      const st = await stand(k.id);
      const basis = {
        mandantId: a.mandantId,
        kontrolleId: k.id,
        standId: st.id,
        partei: 'KANZLEI' as 'KANZLEI' | 'MANDANT',
        durchfuehrendId: a.personen.vertretung,
        vertretungId: a.personen.hb,
        gegenzeichnerId: a.personen.bt as string | null,
        gegenzeichnungMandant: false,
      };
      const faelle: [Partial<typeof basis>, string][] = [
        [{ durchfuehrendId: a.personen.gv }, 'durchfuehrendId'],
        [{ vertretungId: a.personen.tcb }, 'vertretungId'],
        [{ vertretungId: a.personen.ehemals }, 'vertretungId'],
        [{ gegenzeichnerId: a.personen.ma }, 'gegenzeichnerId'],
        [{ gegenzeichnerId: a.personen.vertretung }, 'gegenzeichnerId'],
        [{ gegenzeichnerId: null }, 'gegenzeichnerId'],
        [{ vertretungId: a.personen.vertretung }, 'vertretungId'],
        [{ gegenzeichnungMandant: true, gegenzeichnerId: null }, 'gegenzeichnungMandant'],
      ];
      for (const [aenderung, feld] of faelle) {
        const f = await fehlerVon(
          rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, { ...basis, ...aenderung })),
        );
        expect(f.code).toBe('UNGUELTIG');
        expect(Object.keys(f.felder ?? {})).toContain(feld);
      }
      const r = await rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, basis));
      expect(r.version).toBe(st.version + 1);
      const neu = await stand(k.id);
      expect(neu).toMatchObject({
        durchfuehrendId: a.personen.vertretung,
        vertretungId: a.personen.hb,
        gegenzeichnerId: a.personen.bt,
      });
      const ev = await audit(k.id, 'tcms.kontrolle.zustaendigkeit');
      expect(ev).toHaveLength(1);
      expect(JSON.stringify(ev[0]!.detail)).not.toContain('Person ');
      // Keine Änderung → UNGUELTIG.
      const gleich = await fehlerVon(
        rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, { ...basis, standId: neu.id })),
      );
      expect(gleich.code).toBe('UNGUELTIG');
      // Kein Existenz-Orakel über andere Mandanten: ein Kontakt von B wird wie
      // jede unbekannte UUID behandelt (Kanzleiseite nur in UUID-Form prüfbar).
      const ohneOrakel = await rufe(akt.bt, (ctx) =>
        verantwortlicheAendern(ctx, { ...basis, standId: neu.id, vertretungId: b.personen.tcb }),
      );
      expect(ohneOrakel.version).toBe(neu.version + 1);
    });

    it('Mandantenseite: nur aktive Rolle bei genau diesem Mandanten', async () => {
      const k = liste.find((x) => x.partei === 'MANDANT')!;
      const st = await stand(k.id);
      const basis = {
        mandantId: a.mandantId,
        kontrolleId: k.id,
        standId: st.id,
        partei: 'MANDANT' as 'KANZLEI' | 'MANDANT',
        durchfuehrendId: a.personen.ma,
        vertretungId: a.personen.tcb,
        gegenzeichnerId: null as string | null,
        gegenzeichnungMandant: true,
      };
      for (const [aenderung, feld] of [
        [{ durchfuehrendId: a.personen.hb }, 'durchfuehrendId'],
        [{ durchfuehrendId: b.personen.tcb }, 'durchfuehrendId'],
        [{ vertretungId: a.personen.ehemals }, 'vertretungId'],
        [{ vertretungId: randomUUID() }, 'vertretungId'],
      ] as const) {
        const f = await fehlerVon(
          rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, { ...basis, ...aenderung })),
        );
        expect(f.code).toBe('UNGUELTIG');
        expect(Object.keys(f.felder ?? {})).toContain(feld);
      }
      const r = await rufe(akt.hb, (ctx) => verantwortlicheAendern(ctx, basis));
      expect(r.version).toBe(st.version + 1);
      expect(await stand(k.id)).toMatchObject({
        durchfuehrendId: a.personen.ma,
        vertretungId: a.personen.tcb,
        gegenzeichnungMandant: true,
      });
    });

    it('Rechte negativ', async () => {
      const k = kanzleiKontrollen()[3]!;
      const st = await stand(k.id);
      await rechteNegativ((ctx, mandantId) =>
        verantwortlicheAendern(ctx, {
          mandantId,
          kontrolleId: k.id,
          standId: st.id,
          partei: 'KANZLEI',
          durchfuehrendId: a.personen.vertretung,
          vertretungId: a.personen.hb,
          gegenzeichnerId: a.personen.bt,
          gegenzeichnungMandant: false,
        }),
      );
    });

    it('TS-05: gesehene Seite (partei) unter der Sperre geprüft – passt sie nicht, KONFLIKT', async () => {
      // Kanzlei-Kontrolle, Aufrufer hält sie für eine Mandanten-Kontrolle: Die
      // Personen (Kanzleipersonen) bestünden die Prüfung der Kanzleiseite, die
      // Änderung beruhte aber auf einer anderen Seite → KONFLIKT, nichts geändert.
      const kk = kanzleiKontrollen().find((x) => !x.schluessel) ?? kanzleiKontrollen()[0]!;
      const stK = await stand(kk.id);
      const kanzleiSeite = {
        mandantId: a.mandantId,
        kontrolleId: kk.id,
        standId: stK.id,
        partei: 'MANDANT' as const,
        // Neue Kanzleipersonen (nur UUID-Form prüfbar): ohne die Prüfung der
        // Seite ginge die Änderung durch.
        durchfuehrendId: randomUUID(),
        vertretungId: randomUUID(),
        gegenzeichnerId: a.personen.bt,
        gegenzeichnungMandant: false,
      };
      const f1 = await fehlerVon(rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, kanzleiSeite)));
      expect(f1.code).toBe('KONFLIKT');
      expect(f1.felder).toBeUndefined();
      // Mandanten-Kontrolle mit Seite „Kanzlei" (Kontakte mit aktiver Rolle).
      const km = liste.find((x) => x.partei === 'MANDANT')!;
      const stM = await stand(km.id);
      const mandantSeite = {
        mandantId: a.mandantId,
        kontrolleId: km.id,
        standId: stM.id,
        partei: 'KANZLEI' as const,
        durchfuehrendId: a.personen.tcb,
        vertretungId: a.personen.ma,
        gegenzeichnerId: a.personen.bt,
        gegenzeichnungMandant: false,
      };
      const f2 = await fehlerVon(rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, mandantSeite)));
      expect(f2.code).toBe('KONFLIKT');
      // Nichts geschrieben: Stand und Audit unverändert.
      expect((await stand(kk.id)).id).toBe(stK.id);
      expect((await stand(km.id)).id).toBe(stM.id);
      // Fremde ID bleibt NICHT_GEFUNDEN – die Seite verrät nichts über fremde Kontrollen.
      const fremd = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          verantwortlicheAendern(ctx, { ...kanzleiSeite, kontrolleId: 'cfremdekontrolle00000000' }),
        ),
      );
      expect(fremd.code).toBe('NICHT_GEFUNDEN');
      // Schema: Gegenzeichnung beim Mandanten nur mit Seite „Mandant"; partei Pflicht.
      const schema = await fehlerVon(
        rufe(akt.bt, (ctx) =>
          verantwortlicheAendern(ctx, {
            ...kanzleiSeite,
            partei: 'KANZLEI',
            gegenzeichnerId: null,
            gegenzeichnungMandant: true,
          }),
        ),
      );
      expect(schema.code).toBe('UNGUELTIG');
      expect(Object.keys(schema.felder ?? {})).toContain('gegenzeichnungMandant');
      const { partei: _p, ...ohnePartei } = kanzleiSeite;
      const ohne = await fehlerVon(
        rufe(akt.bt, (ctx) => verantwortlicheAendern(ctx, ohnePartei as never)),
      );
      expect(ohne.code).toBe('UNGUELTIG');
      expect(Object.keys(ohne.felder ?? {})).toContain('partei');
    });
  });
});
