// =============================================================================
// Kanzleileitung liest alles (Produktentscheidung Rey Koxha, 21.10.2026,
// tcms-s12, ADR 0001 §5.1): Admins/Partner (`rol.adm`, `liestAlleVertraulichen`)
// sehen vertrauliche Feststellungen samt Maßnahmen, Begründungen und
// §-153-Entscheidungen auf jedem Lesepfad – ohne Beteiligung, ohne Zuständigkeit
// im Bezug und dort, wo kein Mandantenbezug nötig ist (Portfolio, Arbeitskorb,
// Audit), auch ohne bzw. mit fremdem `cli`. Für alle anderen gilt RT-01
// unverändert: Nicht-Admins ohne Beteiligung sehen dieselbe Feststellung auf
// demselben Pfad maskiert, Beteiligte ohne Zuständigkeit lesen sie (Regel aus
// `beteiligteVon`, auf jedem Pfad dieselbe). Zugriff auf Mandantenpfade (nur mit
// `cli`) und Schreibrechte ändern sich nicht.
//
// Testwelt: frischer Tenant. Zwei vertrauliche Feststellungen, erfasst von der
// Hauptbearbeitung: F1 mit §-153-Entscheidung der zuständigen BT, Maßnahme,
// Verwerfen-Antrag, Länderbezug LU und Audit-Einträgen, verknüpft mit der
// Durchführung; F2 mit offener §-153-Würdigung (Kennzahlen). Keine der
// Leitungspersonen ist beteiligt oder zuständig.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuditListeAntwortSchema,
  DurchfuehrungDetailSchema,
  FeststellungDetailSchema,
  FeststellungListeSchema,
  LaenderSchema,
  type Akteur,
} from '@tcms/contract';
import { schreibeAudit } from '@tcms/db';
import * as dienst from '../../index';
import { ladeDurchfuehrung } from '../durchfuehrung/lesen';
import {
  beantrageFeststellungVerwerfen,
  entscheideP153,
  erledigeMassnahme,
  legeMassnahmeAn,
  setzeVertraulich,
} from '../feststellungen-ereignisse/feststellungen';
import {
  ladeFeststellung,
  ladeFeststellungen,
} from '../feststellungen-ereignisse/feststellungen-lesen';
import { ladeLaender } from '../feststellungen-ereignisse/laender';
import {
  akteure,
  baueWelt,
  eindeutig,
  fehlerVon,
  im,
  inTenant,
  kanzlei,
  type Welt,
} from '../feststellungen-ereignisse/testwelt';
import { ladeKontrolle } from '../risiken-kontrollen/lesen';
import { ladeArbeitskorb } from './arbeitskorb';
import { ladeAudit, leseAuditSeite } from './audit';
import { leseKontext } from './kontext';
import { ladePortfolio } from './portfolio';

const AKTIV = process.env['DB_TESTS'] === '1';

const TITEL_1 = 'Selbstanzeige Geschäftsführer – Leitung liest';
const TITEL_2 = 'Verdeckte Ausschüttung – Würdigung offen';
const SACHVERHALT = 'Verrechnungskonto des Gesellschafters mit Restsaldo (vertraulich).';
const QUELLE = 'Hinweis aus der Geheimakte 12';
const BEGRUENDUNG_P153 = 'Berichtigung geboten; Begründung nur für Berechtigte (Geheimvermerk).';
const VERWERFEN_BEGRUENDUNG = 'Doppelt erfasst, Begründung des Antrags bleibt vertraulich.';
const MASSNAHME = 'Berichtigung der Voranmeldung vorbereiten (Geheimkonto)';
const AKTEUR_NAME = 'Kanzlei Geheimname';
const P153_LUECKE = '1 §-153-Würdigung(en) offen';
const GEHEIM = [TITEL_1, TITEL_2, SACHVERHALT, QUELLE, BEGRUENDUNG_P153, MASSNAHME];

describe.skipIf(!AKTIV)(
  'Kanzleileitung liest vertrauliche Feststellungen auf jedem Lesepfad',
  () => {
    let w: Welt;
    let A: ReturnType<typeof akteure>;
    let f1 = { id: '', nummer: '' };
    let f2 = { id: '', nummer: '' };
    let massnahmeId = '';
    /** Admin/Partner ohne BT-Rolle, Bezug ohne Zuständigkeit, nicht beteiligt. */
    let leitung: Akteur;
    /** Admin/Partner (BT) ohne Mandantenbezug. */
    let leitungOhneCli: Akteur;
    /** Admin/Partner mit Bezug zu einem anderen Mandanten desselben Tenants. */
    let leitungFremd: Akteur;
    /** Kanzleiperson mit Bezug, weder Admin noch zuständig noch beteiligt. */
    let ohneAlles: Akteur;
    /** Erfassende Person (Beteiligte) mit Bezug, aber ohne Zuständigkeit und ohne Admin. */
    let erfassend: Akteur;

    beforeAll(async () => {
      w = await baueWelt();
      A = akteure(w);
      leitung = kanzlei(w.tenant, randomUUID(), w.mandant, { admin: true });
      leitungOhneCli = kanzlei(w.tenant, randomUUID(), null, { admin: true, bt: true });
      leitungFremd = kanzlei(w.tenant, randomUUID(), w.fremd, {
        admin: true,
        bt: true,
        zustaendig: true,
      });
      ohneAlles = kanzlei(w.tenant, randomUUID(), w.mandant);
      erfassend = kanzlei(w.tenant, w.p.hb, w.mandant);

      await inTenant(w, async (tx) => {
        await tx.tcmsProgramm.update({
          where: { id: w.programm },
          data: {
            wirksamAb: new Date('2026-01-01T00:00:00Z'),
            wirksamBis: new Date('2026-12-31T00:00:00Z'),
          },
        });
        const basis = {
          programmId: w.programm,
          sachverhalt: SACHVERHALT,
          quelle: 'HINWEIS' as const,
          quelleText: QUELLE,
          klasse: 'STEUERLICHER_FEHLER' as const,
          vertraulich: true,
          erfasstVon: w.p.hb,
          erfasstAm: new Date('2026-10-01T09:00:00Z'),
        };
        f1 = await tx.feststellung.create({
          data: {
            ...basis,
            nummer: eindeutig('F'),
            titel: TITEL_1,
            durchfuehrungId: w.durchfuehrung,
            schwere: 'HOCH',
            auswirkung: 'JA',
            status: 'MASSNAHMEN_OFFEN',
            p153Entscheidung: 'BERICHTIGUNG',
            p153Begruendung: BEGRUENDUNG_P153,
            p153Frist: new Date('2026-12-31T00:00:00Z'),
            p153EntschiedenVon: w.p.zbt,
            p153EntschiedenAm: new Date('2026-10-02T09:00:00Z'),
            verwerfenBeantragtVon: w.p.hb,
            verwerfenBegruendung: VERWERFEN_BEGRUENDUNG,
          },
          select: { id: true, nummer: true },
        });
        f2 = await tx.feststellung.create({
          data: {
            ...basis,
            nummer: eindeutig('F'),
            titel: TITEL_2,
            schwere: 'KRITISCH',
            auswirkung: 'UNKLAR',
            status: 'IN_WUERDIGUNG',
          },
          select: { id: true, nummer: true },
        });
        const m = await tx.massnahme.create({
          data: {
            feststellungId: f1.id,
            wiedervorlageNr: 700_000 + Math.floor(Math.random() * 100_000),
            beschreibung: MASSNAHME,
            verantwortlich: w.p.hb,
            frist: new Date('2026-11-30T00:00:00Z'),
            createdAt: new Date('2026-10-03T09:00:00Z'),
          },
        });
        massnahmeId = m.id;
        await tx.betroffeneErklaerung.create({
          data: { feststellungId: f1.id, steuerart: 'USt', land: 'LU', zeitraum: '2026' },
        });
        await tx.landStand.create({
          data: {
            programmId: w.programm,
            land: 'LU',
            fernverkaeufeLfdEur: 1200,
            fernverkaeufeVorjahrEur: 800,
            lagerSeit: null,
            oss: true,
            lokaleUstNr: false,
            zmRelevant: false,
            steuersaetzeGeprueftAm: new Date('2026-09-30T00:00:00Z'),
            stand: new Date('2026-10-01T00:00:00Z'),
            quelle: 'MANUELL',
            erfasstVon: w.p.hb,
            createdAt: new Date('2026-10-01T09:00:00Z'),
          },
        });
        // Audit wie aus den Operationen: Erfassung, §-153-Entscheidung, Maßnahme.
        const audit = (aktion: string, objektTyp: string, objektId: string, detail: object) =>
          schreibeAudit(tx, {
            actorId: w.p.zbt,
            actorName: AKTEUR_NAME,
            aktion,
            objektTyp,
            objektId,
            programmId: w.programm,
            detail: detail as Record<string, unknown>,
          });
        await audit('tcms.feststellung.erfasst', 'Feststellung', f1.id, { quelle: QUELLE });
        await audit('tcms.feststellung.p153_entschieden', 'Feststellung', f1.id, {
          entscheidung: 'BERICHTIGUNG',
          begruendung: BEGRUENDUNG_P153,
        });
        await audit('tcms.massnahme.angelegt', 'Massnahme', m.id, {
          wiedervorlageNr: m.wiedervorlageNr,
          beschreibung: MASSNAHME,
        });
      });
    });

    const keinGeheimnis = (wert: unknown, wer: string) => {
      const text = JSON.stringify(wert);
      for (const g of [...GEHEIM, VERWERFEN_BEGRUENDUNG])
        expect(text, `${wer}: ${g}`).not.toContain(g);
    };

    it('Regel: eine Quelle in `rechte.ts`, über `@tcms/service` exportiert; `leseAuditSeite` nicht', () => {
      expect(dienst.liestAlleVertraulichen(leitung)).toBe(true);
      expect(dienst.liestAlleVertraulichen(leitungOhneCli)).toBe(true);
      for (const a of [ohneAlles, erfassend, A.zbt, A.hb, A.leser, A.gv]) {
        expect(dienst.liestAlleVertraulichen(a), a.id).toBe(false);
      }
      expect(typeof dienst.beteiligteVon).toBe('function');
      expect('leseAuditSeite' in dienst).toBe(false);
    });

    it('Feststellungen (Liste): Leitung liest Inhalt, §-153-Begründung und Maßnahmen; Nicht-Admins ohne Beteiligung maskiert', async () => {
      const liste = await im(leitung, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
      expect(FeststellungListeSchema.parse(liste)).toEqual(liste);
      const e1 = liste.feststellungen.find((x) => x.id === f1.id)!;
      expect(e1).toMatchObject({
        maskiert: false,
        titel: TITEL_1,
        quelleText: QUELLE,
        vertraulich: true,
      });
      if (e1.maskiert) throw new Error('maskiert');
      expect(e1.p153).toMatchObject({
        entscheidung: 'BERICHTIGUNG',
        begruendung: BEGRUENDUNG_P153,
      });
      expect(e1.massnahmen.map((m) => m.beschreibung)).toEqual([MASSNAHME]);
      expect(liste.feststellungen.find((x) => x.id === f2.id)).toMatchObject({
        maskiert: false,
        titel: TITEL_2,
        p153Offen: true,
      });
      for (const a of [A.leser, ohneAlles]) {
        const l = await im(a, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
        for (const id of [f1.id, f2.id]) {
          expect(l.feststellungen.find((x) => x.id === id)?.maskiert, a.id).toBe(true);
        }
        keinGeheimnis(l, a.id);
      }
      // Beteiligte (erfassend) ohne Zuständigkeit: lesbar wie bisher (`beteiligteVon`).
      const b = await im(erfassend, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
      expect(b.feststellungen.find((x) => x.id === f1.id)).toMatchObject({ maskiert: false });
    });

    it('Feststellung (Detail): Leitung liest Sachverhalt, §-153, Verwerfen-Begründung, Maßnahmen, Erklärungen und Verlauf', async () => {
      const d = await im(leitung, (ctx) =>
        ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f1.id }),
      );
      expect(FeststellungDetailSchema.parse(d)).toEqual(d);
      if (d.maskiert) throw new Error('maskiert');
      expect(d).toMatchObject({
        sachverhalt: SACHVERHALT,
        quelleText: QUELLE,
        vertraulich: true,
        p153: { entscheidung: 'BERICHTIGUNG', begruendung: BEGRUENDUNG_P153, von: w.p.zbt },
        verwerfen: { begruendung: VERWERFEN_BEGRUENDUNG, beantragtVon: w.p.hb },
      });
      expect(d.massnahmen.map((m) => m.beschreibung)).toEqual([MASSNAHME]);
      expect(d.erklaerungen.map((x) => x.land)).toEqual(['LU']);
      expect(d.verlauf.map((v) => v.text).join('\n')).toContain(MASSNAHME);
      for (const a of [A.leser, ohneAlles]) {
        for (const id of [f1.id, f2.id]) {
          const m = await im(a, (ctx) =>
            ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: id }),
          );
          expect(m.maskiert, a.id).toBe(true);
          keinGeheimnis(m, a.id);
        }
      }
      const b = await im(erfassend, (ctx) =>
        ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f1.id }),
      );
      expect(b).toMatchObject({ maskiert: false, sachverhalt: SACHVERHALT });
    });

    it('Kontext, Kennzahlen und Zeitraumzahlen: Leitung liest alle, zählt §-153 aus allen; Nicht-Admins maskiert', async () => {
      const kontext = (a: Akteur) => im(a, (ctx) => leseKontext(ctx, { mandantId: w.mandant }));
      const lueckenVon = (k: Awaited<ReturnType<typeof kontext>>) =>
        k.grundelemente.find((g) => g.key === 'ueberwachung')!.luecken;
      const k = await kontext(leitung);
      expect(k.feststellungen.find((x) => x.id === f1.id)).toMatchObject({
        maskiert: false,
        titel: TITEL_1,
        sachverhalt: SACHVERHALT,
        p153Entscheidung: 'BERICHTIGUNG',
        schwere: 'HOCH',
      });
      expect(k.feststellungen.find((x) => x.id === f2.id)).toMatchObject({
        maskiert: false,
        p153Offen: true,
      });
      expect(lueckenVon(k)).toContain(P153_LUECKE);
      expect(k.zeitraum).not.toBeNull();
      for (const a of [A.leser, ohneAlles]) {
        const x = await kontext(a);
        for (const id of [f1.id, f2.id]) {
          expect(x.feststellungen.find((f) => f.id === id)?.maskiert, a.id).toBe(true);
        }
        expect(lueckenVon(x), a.id).not.toContain(P153_LUECKE);
        // Zeitraumzahlen: Feststellungen gehen nicht ein – für alle gleich.
        expect(x.zeitraum, a.id).toEqual(k.zeitraum);
        keinGeheimnis(x.feststellungen, a.id);
      }
      const b = await kontext(erfassend);
      expect(b.feststellungen.find((x) => x.id === f1.id)).toMatchObject({ maskiert: false });
    });

    it('Portfolio ohne cli und ohne Zuständigkeit: Leitung zählt Schwere und §-153 aus allen, Nicht-Admins nur lesbare', async () => {
      const zeile = async (a: Akteur) =>
        (await im(a, (ctx) => ladePortfolio(ctx, { mandantIds: [w.mandant] }))).zeilen.find(
          (z) => z.mandant.id === w.mandant,
        )!;
      expect(await zeile(leitungOhneCli)).toMatchObject({
        feststellungenOffen: 2,
        feststellungenHochOffen: 2,
        p153Offen: 1,
      });
      const nichtAdmin = kanzlei(w.tenant, randomUUID(), null, { bt: true });
      expect(await zeile(nichtAdmin)).toMatchObject({
        feststellungenOffen: 2,
        feststellungenHochOffen: 0,
        p153Offen: 0,
      });
    });

    it('Kontrolle und Durchführung: Leitung sieht §-153-Kennzeichen, Titel und Schwere; Nicht-Admins maskiert', async () => {
      const kontrolle = (a: Akteur) =>
        im(a, (ctx) => ladeKontrolle(ctx, { mandantId: w.mandant, kontrolleId: w.kontrolle }));
      const durchf = (a: Akteur) =>
        im(a, (ctx) =>
          ladeDurchfuehrung(ctx, { mandantId: w.mandant, durchfuehrungId: w.durchfuehrung }),
        );
      const k = await kontrolle(leitung);
      expect(k.durchfuehrungen.find((d) => d.id === w.durchfuehrung)!.feststellung).toEqual({
        maskiert: false,
        id: f1.id,
        nummer: f1.nummer,
        p153Offen: false,
      });
      const d = await durchf(leitung);
      expect(DurchfuehrungDetailSchema.parse(d)).toEqual(d);
      expect(d.feststellungen).toEqual([
        {
          maskiert: false,
          id: f1.id,
          nummer: f1.nummer,
          titel: TITEL_1,
          status: 'MASSNAHMEN_OFFEN',
          schwere: 'HOCH',
          vertraulich: true,
        },
      ]);
      for (const a of [A.leser, ohneAlles]) {
        expect(
          (await kontrolle(a)).durchfuehrungen.find((x) => x.id === w.durchfuehrung)!.feststellung,
          a.id,
        ).toEqual({
          maskiert: true,
          id: f1.id,
          nummer: f1.nummer,
        });
        const x = await durchf(a);
        expect(x.feststellungen, a.id).toEqual([
          {
            maskiert: true,
            id: f1.id,
            nummer: f1.nummer,
            status: 'MASSNAHMEN_OFFEN',
            vertraulich: true,
          },
        ]);
        keinGeheimnis(x, a.id);
      }
      // Beteiligte (erfassend): lesbar wie bisher – dieselbe Regel wie in Liste und Kontext.
      expect((await durchf(erfassend)).feststellungen[0]).toMatchObject({
        maskiert: false,
        titel: TITEL_1,
      });
    });

    it('Länder-Monitor: vertrauliche Feststellung mit Länderbezug nur für die Leitung; alle anderen wie bisher ohne', async () => {
      const lu = async (a: Akteur) => {
        const l = await im(a, (ctx) => ladeLaender(ctx, { mandantId: w.mandant }));
        expect(LaenderSchema.parse(l)).toEqual(l);
        return { l, eintraege: l.feststellungen.find((x) => x.land === 'LU')?.eintraege ?? [] };
      };
      expect((await lu(leitung)).eintraege).toEqual([
        {
          id: f1.id,
          nummer: f1.nummer,
          titel: TITEL_1,
          status: 'MASSNAHMEN_OFFEN',
          p153Offen: false,
        },
      ]);
      // Auch Beteiligte und Zuständige nicht: der Eintrag hat keine maskierte Variante (unverändert).
      for (const a of [A.leser, ohneAlles, erfassend, A.zbt, A.hb]) {
        const { l, eintraege } = await lu(a);
        expect(eintraege, a.id).toEqual([]);
        expect(JSON.stringify(l), a.id).not.toContain(f1.id);
        keinGeheimnis(l, a.id);
      }
    });

    it('Arbeitskorb ohne cli: Verwerfen-Antrag mit Titel und Begründung nur für die Leitung; Zuständige wie bisher ohne', async () => {
      const verwerfen = async (
        a: Akteur,
        liste: { bt?: readonly string[]; hb?: readonly string[] },
      ) => {
        const korb = await im(a, (ctx) =>
          ladeArbeitskorb(ctx, {
            mandantIds: [w.mandant],
            bt: [...(liste.bt ?? [])],
            hb: [...(liste.hb ?? [])],
          }),
        );
        return korb.vierAugen.find((x) => x.art === 'VERWERFEN' && x.objektId === f1.id);
      };
      expect(
        await verwerfen(kanzlei(w.tenant, randomUUID(), null, { admin: true }), {
          hb: [w.mandant],
        }),
      ).toMatchObject({
        titel: `${f1.nummer} · ${TITEL_1}`,
        begruendung: VERWERFEN_BEGRUENDUNG,
        beantragtVon: [w.p.hb],
      });
      // Zuständige Nicht-Admins (Hauptbearbeitung bzw. zuständige BT über die Liste): unverändert ohne Inhalt.
      for (const [a, liste] of [
        [kanzlei(w.tenant, randomUUID(), null), { hb: [w.mandant] }],
        [kanzlei(w.tenant, w.p.zbt, null, { bt: true }), { bt: [w.mandant] }],
      ] as const) {
        expect(await verwerfen(a, liste), a.id).toMatchObject({
          titel: `${f1.nummer} · vertrauliche Feststellung`,
          begruendung: null,
        });
      }
      // §-153-Aufgaben: die zuständige Leitung (BT) erhält auch vertrauliche, mit Titel.
      const korb = await im(leitungOhneCli, (ctx) =>
        ladeArbeitskorb(ctx, { mandantIds: [w.mandant], bt: [w.mandant] }),
      );
      expect(korb.p153.find((x) => x.id === f2.id)).toMatchObject({
        titel: TITEL_2,
        vertraulich: true,
      });
    });

    it('Audit ohne bzw. mit fremdem cli: Leitung liest alle Einträge mit Namen, Details und Hashes', async () => {
      const zuF1 = (e: { objektTyp: string; objektId: string }) =>
        (e.objektTyp === 'Feststellung' && e.objektId === f1.id) ||
        (e.objektTyp === 'Massnahme' && e.objektId === massnahmeId);
      for (const a of [leitungOhneCli, leitungFremd, leitung]) {
        const s = await im(a, (ctx) => ladeAudit(ctx, { limit: 500 }));
        expect(AuditListeAntwortSchema.parse(s)).toEqual(s);
        expect(
          s.eintraege.some((e) => e.maskiert),
          a.id,
        ).toBe(false);
        const f = s.eintraege.filter(zuF1);
        expect(f, a.id).toHaveLength(3);
        for (const e of f) {
          expect(e, a.id).toMatchObject({
            maskiert: false,
            actorId: w.p.zbt,
            actorName: AKTEUR_NAME,
          });
        }
        const text = JSON.stringify(f);
        for (const g of [QUELLE, BEGRUENDUNG_P153, MASSNAHME]) expect(text, a.id).toContain(g);
        for (const e of s.eintraege) {
          if (e.maskiert) throw new Error('maskiert');
          expect(e.hash, `${a.id} pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
          expect(e.prevHash, `${a.id} pos ${e.pos}`).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(s.kopf?.hash, a.id).toMatch(/^[0-9a-f]{64}$/);
      }
      // Nicht-Admins lesen das Audit weiterhin nicht; die Maskierung (für einen
      // künftigen Lesepfad) bleibt für Unbeteiligte, Beteiligte mit Bezug lesen.
      for (const a of [A.leser, ohneAlles, erfassend]) {
        expect(await fehlerVon(im(a, (ctx) => ladeAudit(ctx, {}))), a.id).toMatchObject({
          code: 'NICHT_BERECHTIGT',
          grund: 'VERWALTUNG',
        });
      }
      for (const a of [A.leser, ohneAlles, kanzlei(w.tenant, w.p.hb, null)]) {
        const s = await im(a, (ctx) => leseAuditSeite(ctx, { limit: 500 }));
        expect(
          s.eintraege.filter(zuF1).every((e) => e.maskiert),
          a.id,
        ).toBe(true);
        expect(s.kopf?.hash, a.id).toBeNull();
        keinGeheimnis(s, a.id);
        expect(JSON.stringify(s), a.id).not.toContain(AKTEUR_NAME);
      }
      const b = await im(erfassend, (ctx) => leseAuditSeite(ctx, { limit: 500 }));
      expect(b.eintraege.filter(zuF1).every((e) => !e.maskiert)).toBe(true);
    });

    it('Zugriff und Schreibrechte unverändert: ohne bzw. mit fremdem cli 404, Würdigen nur BT, Inhalt unverändert', async () => {
      const vorher = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: f1.id }, include: { massnahmen: true } }),
      );
      for (const a of [leitungOhneCli, leitungFremd]) {
        const versuche: (() => Promise<unknown>)[] = [
          () =>
            im(a, (ctx) => ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f1.id })),
          () => im(a, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant })),
          () => im(a, (ctx) => leseKontext(ctx, { mandantId: w.mandant })),
          () =>
            im(a, (ctx) =>
              entscheideP153(ctx, {
                mandantId: w.mandant,
                feststellungId: f2.id,
                entscheidung: 'KEINE_PFLICHT',
                begruendung: 'Keine Pflicht nach Prüfung durch die Kanzleileitung ohne Bezug.',
                bisher: null,
              }),
            ),
          () =>
            im(a, (ctx) =>
              setzeVertraulich(ctx, {
                mandantId: w.mandant,
                feststellungId: f1.id,
                vertraulich: false,
              }),
            ),
          () =>
            im(a, (ctx) =>
              legeMassnahmeAn(ctx, {
                mandantId: w.mandant,
                feststellungId: f1.id,
                beschreibung: 'Maßnahme ohne Bezug',
                verantwortlich: { id: a.id, art: 'KANZLEI' },
                frist: '2026-12-31',
              }),
            ),
          () =>
            im(a, (ctx) =>
              erledigeMassnahme(ctx, {
                mandantId: w.mandant,
                massnahmeId,
                nachweis: 'Nachweis ohne Bezug erbracht',
              }),
            ),
          () =>
            im(a, (ctx) =>
              beantrageFeststellungVerwerfen(ctx, {
                mandantId: w.mandant,
                feststellungId: f2.id,
                begruendung: 'Verwerfen ohne Bezug beantragt, das darf nicht gehen.',
              }),
            ),
        ];
        for (const [i, versuch] of versuche.entries()) {
          expect((await fehlerVon(versuch())).code, `${a.id} #${i}`).toBe('NICHT_GEFUNDEN');
        }
      }
      // Mit Bezug: Würdigen und Vertraulich-Markieren weiter nur mit `kannWuerdigen` (BT-Rolle).
      for (const versuch of [
        () =>
          im(leitung, (ctx) =>
            entscheideP153(ctx, {
              mandantId: w.mandant,
              feststellungId: f2.id,
              entscheidung: 'KEINE_PFLICHT',
              begruendung: 'Keine Pflicht nach Prüfung durch die Kanzleileitung ohne BT-Rolle.',
              bisher: null,
            }),
          ),
        () =>
          im(leitung, (ctx) =>
            setzeVertraulich(ctx, {
              mandantId: w.mandant,
              feststellungId: f1.id,
              vertraulich: false,
            }),
          ),
      ]) {
        expect(await fehlerVon(versuch())).toMatchObject({
          code: 'NICHT_BERECHTIGT',
          grund: 'WUERDIGEN',
        });
      }
      const nachher = await inTenant(w, (tx) =>
        tx.feststellung.findUniqueOrThrow({ where: { id: f1.id }, include: { massnahmen: true } }),
      );
      expect(nachher).toEqual(vorher);
      expect(
        await inTenant(w, (tx) => tx.feststellung.findUniqueOrThrow({ where: { id: f2.id } })),
      ).toMatchObject({ p153Entscheidung: null, verwerfenBeantragtVon: null, vertraulich: true });
    });
  },
);
