// =============================================================================
// Geschäftsprofil gegen PostgreSQL (DB_TESTS=1, DATABASE_URL = tcms_app):
// Profiländerung als neuer Stand (TS-05: kein Gabeln, veralteter Stand →
// KONFLIKT), Trigger (Neubewertung, Ereignisse), Aufnahme eines
// vorgeschlagenen Risikos (nur deterministische Vorschläge, Personen der
// Kanzleiseite sind keine Mandantenkontakte), Rechte negativ.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant, type PrismaClient } from '@tcms/db';
import { schlageRisikenVor } from '@tcms/domain';
import type { DienstKontext } from '../../../kontext';
import { ladeProfil } from '../lesen';
import { profilAendern, vorgeschlagenesRisikoAufnehmen } from '../profil';
import {
  akteureVon,
  fehlerVon,
  gleichzeitig,
  HEUTE,
  kanzlei,
  kontakt,
  legeProgrammAn,
  rufe,
  type Programm,
} from './fixture';

const AKTIV = process.env['DB_TESTS'] === '1';

describe.skipIf(!AKTIV)('Geschäftsprofil: Fachoperationen', () => {
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
  const offenerStand = (x: Programm) =>
    mitTenant(x.tenantId, (tx) =>
      tx.profilStand.findFirstOrThrow({ where: { programmId: x.programmId, gueltigBis: null } }),
    );
  const verantwortliche = (x: Programm) => ({
    berufstraeger: { id: x.personen.bt, name: 'StB Test' },
    hauptbearbeitung: { id: x.personen.hb, name: 'Bearbeitung' },
    vertretung: { id: x.personen.vertretung, name: 'Vertretung' },
  });

  async function rechteNegativ(
    lauf: (ctx: DienstKontext, mandantId: string) => Promise<unknown>,
  ): Promise<void> {
    expect((await fehlerVon(rufe(akt.leser, (ctx) => lauf(ctx, a.mandantId)))).code).toBe(
      'NICHT_BERECHTIGT',
    );
    for (const akteur of [
      kanzlei(tenant, a.personen.bt, b.mandantId, { admin: true, bt: true, zustaendig: true }),
      kontakt(tenant, a.personen.gv, a.mandantId),
      kanzlei(tenantFremd, c.personen.bt, a.mandantId, { admin: true, bt: true, zustaendig: true }),
    ]) {
      const f = await fehlerVon(rufe(akteur, (ctx) => lauf(ctx, a.mandantId)));
      expect(f.code).toBe('NICHT_GEFUNDEN');
    }
  }

  describe('Profil ändern', () => {
    it('neuer Stand, Trigger, Ereignisse; veralteter Stand → KONFLIKT', async () => {
      const st = await offenerStand(a);
      const profil = structuredClone(a.profil);
      // P2: neues Lager in CZ → T-02 (Lager/Registrierung) und Neubewertung.
      profil.p2.lager.push({ land: 'CZ', seit: '2026-09', art: 'PAN-EU' });
      const r = await rufe(akt.hb, (ctx) =>
        profilAendern(ctx, {
          mandantId: a.mandantId,
          profilStandId: st.id,
          profil,
          gueltigAb: HEUTE,
          ereignisseAnlegen: true,
        }),
      );
      expect(r.version).toBe(2);
      expect(r.ereignisse.length).toBeGreaterThan(0);
      const staende = await lies((tx) =>
        tx.profilStand.findMany({ where: { programmId: a.programmId } }),
      );
      expect(staende.filter((s) => s.gueltigBis === null)).toHaveLength(1);
      const ev = await lies((tx) =>
        tx.auditEvent.findMany({
          where: { programmId: a.programmId, aktion: 'tcms.profil.geaendert' },
        }),
      );
      expect(ev).toHaveLength(1);
      const angelegt = await lies((tx) =>
        tx.ereignis.findMany({ where: { programmId: a.programmId, quelle: 'STAMMDATEN' } }),
      );
      expect(angelegt.map((e) => e.nummer).sort()).toEqual([...r.ereignisse].sort());
      for (const e of angelegt) expect(e.gemeldetVon).toBe(a.personen.hb);
      // Erneut auf dem alten Stand → KONFLIKT.
      const f = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          profilAendern(ctx, {
            mandantId: a.mandantId,
            profilStandId: st.id,
            profil: a.profil,
            gueltigAb: HEUTE,
            ereignisseAnlegen: false,
          }),
        ),
      );
      expect(f.code).toBe('KONFLIKT');
      const p = await rufe(akt.hb, (ctx) => ladeProfil(ctx, { mandantId: a.mandantId }));
      expect(p.staende).toHaveLength(2);
      // Im Voraus erfasster Stand (gültig in 30 Tagen) mit Gebrauchtware → EC-UST-14:
      // erscheint in den Ständen, die Vorschläge folgen aber dem heute gültigen Stand.
      const offen2 = p.staende.find((x) => x.gueltigBis === null)!;
      const kuenftig = structuredClone(offen2.antworten);
      kuenftig.p4.gebrauchtware = true;
      const spaeter = new Date(Date.parse(`${HEUTE}T00:00:00Z`) + 30 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await rufe(akt.hb, (ctx) =>
        profilAendern(ctx, {
          mandantId: a.mandantId,
          profilStandId: offen2.id,
          profil: kuenftig,
          gueltigAb: spaeter,
          ereignisseAnlegen: false,
        }),
      );
      const p2 = await rufe(akt.hb, (ctx) => ladeProfil(ctx, { mandantId: a.mandantId }));
      expect(p2.staende).toHaveLength(3);
      expect(p2.vorschlaege.map((v) => v.code)).not.toContain('EC-UST-14');
      expect(p2.vorschlaege.map((v) => v.code)).toEqual(
        schlageRisikenVor(offen2.antworten).map((v) => v.code),
      );
    });

    it('TS-05: zwei gleichzeitige Änderungen desselben Stands → genau eine, keine Gabelung', async () => {
      const st = await offenerStand(b);
      const akteureB = akteureVon(b);
      const lauf = (land: string, client?: PrismaClient) => {
        const profil = structuredClone(b.profil);
        profil.p3.laender.push(land);
        return rufe(
          akteureB.hb,
          (ctx) =>
            profilAendern(ctx, {
              mandantId: b.mandantId,
              profilStandId: st.id,
              profil,
              gueltigAb: HEUTE,
              ereignisseAnlegen: false,
            }),
          client,
        );
      };
      expect(
        await gleichzeitig(
          () => lauf('IT'),
          () => lauf('ES', zweite),
        ),
      ).toEqual({
        erfolge: 1,
        codes: ['KONFLIKT'],
      });
      const staende = await lies((tx) =>
        tx.profilStand.findMany({ where: { programmId: b.programmId } }),
      );
      expect(staende.filter((s) => s.gueltigBis === null)).toHaveLength(1);
      expect(staende.map((s) => s.version).sort()).toEqual([1, 2]);
    });

    it('Eingaben: Vergangenheit, unverändert, unvollständig, Zusatzfelder, Rechte', async () => {
      const st = await offenerStand(a);
      const basis = {
        mandantId: a.mandantId,
        profilStandId: st.id,
        gueltigAb: HEUTE,
        ereignisseAnlegen: false,
      };
      const aktuell = st.antworten as unknown as typeof a.profil;
      const geaendert = structuredClone(aktuell);
      geaendert.p6.zahlungswege = ['Rechnung'];
      const leer = structuredClone(aktuell);
      leer.p6.zahlungswege = [];
      for (const eingabe of [
        { ...basis, profil: geaendert, gueltigAb: '2026-10-15' },
        { ...basis, profil: geaendert, gueltigAb: '2028-01-01' },
        { ...basis, profil: aktuell },
        { ...basis, profil: leer },
        { ...basis, profil: { ...geaendert, p13: {} } },
        { ...basis, profil: { ...geaendert, p1: { ...geaendert.p1, extra: 1 } } },
        { ...basis, profil: geaendert, stand: HEUTE },
      ]) {
        const f = await fehlerVon(rufe(akt.hb, (ctx) => profilAendern(ctx, eingabe as never)));
        expect(f.code).toBe('UNGUELTIG');
      }
      await rechteNegativ((ctx, mandantId) =>
        profilAendern(ctx, { ...basis, mandantId, profil: geaendert }),
      );
    });
  });

  describe('Vorgeschlagenes Risiko aufnehmen', () => {
    it('legt Risiko und Kontrollen an; Vorbelegung aus Eingabe und Kontaktrollen; zweites Mal KONFLIKT', async () => {
      const x = await legeProgrammAn(tenant);
      const ax = akteureVon(x);
      const r = await rufe(ax.hb, (ctx) =>
        vorgeschlagenesRisikoAufnehmen(ctx, {
          mandantId: x.mandantId,
          code: x.offenerVorschlag,
          verantwortliche: verantwortliche(x),
        }),
      );
      expect(r.code).toBe(x.offenerVorschlag);
      const risiko = await lies((tx) =>
        tx.risiko.findUniqueOrThrow({ where: { id: r.risikoId }, include: { staende: true } }),
      );
      expect(risiko).toMatchObject({ entscheidung: 'UEBERNOMMEN', freigabe: 'BEWERTET' });
      expect(risiko.ownerId).toBe(x.personen.tcb);
      expect(risiko.staende).toHaveLength(1);
      for (const code of r.neueKontrollen) {
        const k = await lies((tx) =>
          tx.kontrolle.findFirstOrThrow({
            where: { programmId: x.programmId, code },
            include: { staende: true },
          }),
        );
        const s = k.staende[0]!;
        const erlaubt = [
          x.personen.bt,
          x.personen.hb,
          x.personen.vertretung,
          x.personen.tcb,
          x.personen.ma,
          x.personen.gv,
          null,
        ];
        expect(erlaubt).toContain(s.durchfuehrendId);
        expect(s.gegenzeichnerId).not.toBe(s.durchfuehrendId);
      }
      const ev = await lies((tx) =>
        tx.auditEvent.findMany({
          where: { objektId: r.risikoId, aktion: 'tcms.risiko.aufgenommen' },
        }),
      );
      expect(ev).toHaveLength(1);
      const f = await fehlerVon(
        rufe(ax.hb, (ctx) =>
          vorgeschlagenesRisikoAufnehmen(ctx, {
            mandantId: x.mandantId,
            code: x.offenerVorschlag,
            verantwortliche: verantwortliche(x),
          }),
        ),
      );
      expect(f.code).toBe('KONFLIKT');
    }, 60_000);

    it('TS-05: zwei gleichzeitige Aufnahmen → genau eine', async () => {
      const x = await legeProgrammAn(tenant);
      const ax = akteureVon(x);
      const lauf = (client?: PrismaClient) =>
        rufe(
          ax.hb,
          (ctx) =>
            vorgeschlagenesRisikoAufnehmen(ctx, {
              mandantId: x.mandantId,
              code: x.offenerVorschlag,
              verantwortliche: verantwortliche(x),
            }),
          client,
        );
      expect(
        await gleichzeitig(
          () => lauf(),
          () => lauf(zweite),
        ),
      ).toEqual({ erfolge: 1, codes: ['KONFLIKT'] });
      const n = await lies((tx) =>
        tx.risiko.count({ where: { programmId: x.programmId, code: x.offenerVorschlag } }),
      );
      expect(n).toBe(1);
    }, 60_000);

    it('nicht vorgeschlagen, Kontakt als Kanzleiperson, gleiche Personen, Rechte', async () => {
      const nichtVorgeschlagen = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          vorgeschlagenesRisikoAufnehmen(ctx, {
            mandantId: a.mandantId,
            code: 'EC-XXX-99',
            verantwortliche: verantwortliche(a),
          }),
        ),
      );
      expect(nichtVorgeschlagen.code).toBe('UNGUELTIG');
      const kontaktAlsKanzlei = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          vorgeschlagenesRisikoAufnehmen(ctx, {
            mandantId: a.mandantId,
            code: a.offenerVorschlag,
            verantwortliche: {
              ...verantwortliche(a),
              hauptbearbeitung: { id: a.personen.tcb, name: 'Kontakt' },
            },
          }),
        ),
      );
      expect(kontaktAlsKanzlei.code).toBe('UNGUELTIG');
      const gleich = await fehlerVon(
        rufe(akt.hb, (ctx) =>
          vorgeschlagenesRisikoAufnehmen(ctx, {
            mandantId: a.mandantId,
            code: a.offenerVorschlag,
            verantwortliche: {
              ...verantwortliche(a),
              hauptbearbeitung: { id: a.personen.bt.toUpperCase(), name: 'BT' },
            },
          }),
        ),
      );
      expect(gleich.code).toBe('UNGUELTIG');
      await rechteNegativ((ctx, mandantId) =>
        vorgeschlagenesRisikoAufnehmen(ctx, {
          mandantId,
          code: a.offenerVorschlag,
          verantwortliche: verantwortliche(a),
        }),
      );
      // Nichts angelegt.
      const n = await lies((tx) =>
        tx.risiko.count({ where: { programmId: a.programmId, code: a.offenerVorschlag } }),
      );
      expect(n).toBe(0);
    });
  });
});
