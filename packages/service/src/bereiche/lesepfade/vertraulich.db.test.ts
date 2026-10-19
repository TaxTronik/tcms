// =============================================================================
// RT-01: Jede Ausgabe mit Feststellungsdaten gibt einer Person ohne
// `kannVertraulichLesen` von einer vertraulichen Feststellung nur preis, was
// auch der dedizierte Lesepfad zeigt (`ladeFeststellungen`, `maskiert: true`:
// Nummer, Status, Erfassung, Wiedervorlagen). Kennzahlen dürfen vertrauliche
// Feststellungen zählen, wo die Zahl aus sichtbaren Angaben folgt (Status,
// Zahl der Maßnahmen), leiten aber keine Inhalte ab (Steuerwirkung, §-153,
// Schwere) – sonst ergäbe die Differenz zu den sichtbaren Einträgen den
// Inhalt einer vertraulichen Feststellung.
//
// Testwelt: frischer Tenant, ein Programm ohne weitere Feststellungen; alle
// Zahlen gehen also allein auf die vertrauliche Feststellung zurück.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import { ladeDurchfuehrung } from '../durchfuehrung/lesen';
import { ladeEreignis } from '../feststellungen-ereignisse/ereignisse-lesen';
import { ladeFeststellungen } from '../feststellungen-ereignisse/feststellungen-lesen';
import {
  akteure,
  baueWelt,
  eindeutig,
  im,
  inTenant,
  kanzlei,
  type Welt,
} from '../feststellungen-ereignisse/testwelt';
import { ladeKontrolle } from '../risiken-kontrollen/lesen';
import { ladeArbeitskorb } from './arbeitskorb';
import { leseKontext } from './kontext';
import { ladePortfolio } from './portfolio';

const AKTIV = process.env['DB_TESTS'] === '1';

const TITEL = 'Selbstanzeige Geschäftsführer – streng vertraulich';
const SACHVERHALT = 'Verdeckte Gewinnausschüttung über das Verrechnungskonto';
const MASKIERT_FELDER = ['erfasstAm', 'id', 'maskiert', 'nummer', 'status', 'vertraulich'];
const P153_LUECKE = '1 §-153-Würdigung(en) offen';

describe.skipIf(!AKTIV)('RT-01 vertrauliche Feststellungen in allen Ausgaben', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;
  let f: { id: string; nummer: string };
  let ereignisId: string;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
    // Vertraulich, mögliche Steuerwirkung, §-153 offen, Schwere hoch, aus der
    // Durchführung der Testwelt; erfasst von der zuständigen BT (nicht vom leser).
    f = await inTenant(w, (tx) =>
      tx.feststellung.create({
        data: {
          programmId: w.programm,
          nummer: eindeutig('F'),
          titel: TITEL,
          sachverhalt: SACHVERHALT,
          quelle: 'KONTROLLE',
          quelleText: 'Durchführung Q3',
          durchfuehrungId: w.durchfuehrung,
          klasse: 'STEUERLICHER_FEHLER',
          schwere: 'HOCH',
          auswirkung: 'JA',
          status: 'IN_WUERDIGUNG',
          vertraulich: true,
          erfasstVon: w.p.zbt,
          erfasstAm: new Date('2026-10-01T09:00:00Z'),
        },
        select: { id: true, nummer: true },
      }),
    );
    // Ereignis, dessen Folge „Feststellung anlegen" auf die Feststellung zeigt.
    ereignisId = await inTenant(w, async (tx) => {
      const e = await tx.ereignis.create({
        data: {
          programmId: w.programm,
          nummer: eindeutig('2026-T'),
          typ: 'HINWEIS',
          titel: 'Hinweis Geschäftsführung',
          beschreibung: 'Hinweis eingegangen',
          quelle: 'MANUELL',
          gemeldetAm: new Date('2026-09-30T09:00:00Z'),
          ereignisDatum: new Date('2026-09-30T00:00:00Z'),
          status: 'ERLEDIGT',
        },
      });
      await tx.ereignisFolge.create({
        data: {
          ereignisId: e.id,
          art: 'FESTSTELLUNG_ANLEGEN',
          text: 'Feststellung anlegen',
          status: 'ERLEDIGT',
          objektId: f.id,
          erledigtAm: new Date('2026-10-01T09:00:00Z'),
        },
      });
      return e.id;
    });
  });

  it('Kontext: maskierte Sicht hat genau die Felder des dedizierten Lesepfads', async () => {
    const k = await im(A.leser, (ctx) => leseKontext(ctx, { mandantId: w.mandant }));
    const eintrag = k.feststellungen.find((x) => x.id === f.id)!;
    expect(Object.keys(eintrag).sort()).toEqual(MASKIERT_FELDER);

    const liste = await im(A.leser, (ctx) => ladeFeststellungen(ctx, { mandantId: w.mandant }));
    const dediziert = liste.feststellungen.find((x) => x.id === f.id)!;
    expect(dediziert.maskiert).toBe(true);
    const { massnahmen: _wiedervorlagen, ...ohneWiedervorlagen } = dediziert as typeof dediziert & {
      massnahmen: unknown;
    };
    expect(eintrag).toEqual(ohneWiedervorlagen);

    const text = JSON.stringify(k);
    for (const geheim of [TITEL, SACHVERHALT, 'STEUERLICHER_FEHLER', 'Durchführung Q3']) {
      expect(text).not.toContain(geheim);
    }
  });

  it('Kontext: Beteiligte, Admin, zuständige BT und Hauptbearbeitung sehen den Inhalt', async () => {
    const beteiligt = kanzlei(w.tenant, w.p.zbt, w.mandant); // erfassend, ohne Zuständigkeit
    for (const wer of [beteiligt, A.zbt, A.admin, A.adminOhneBt, A.hb]) {
      const k = await im(wer, (ctx) => leseKontext(ctx, { mandantId: w.mandant }));
      expect(k.feststellungen.find((x) => x.id === f.id)).toMatchObject({
        maskiert: false,
        titel: TITEL,
        auswirkung: 'JA',
        schwere: 'HOCH',
        p153Offen: true,
      });
    }
  });

  it('Kontext-Kennzahlen: §-153-Lücke nur aus lesbaren, Maßnahmen-Lücke aus allen', async () => {
    const luecken = async (a: typeof A.leser) =>
      (await im(a, (ctx) => leseKontext(ctx, { mandantId: w.mandant }))).grundelemente.find(
        (g) => g.key === 'ueberwachung',
      )!.luecken;
    const leser = await luecken(A.leser);
    expect(leser).not.toContain(P153_LUECKE);
    // Status und Zahl der Maßnahmen sind auch maskiert sichtbar: darf zählen.
    expect(leser).toContain('1 Feststellung(en) ohne Maßnahme');
    const zbt = await luecken(A.zbt);
    expect(zbt).toContain(P153_LUECKE);
    expect(zbt).toContain('1 Feststellung(en) ohne Maßnahme');
  });

  it('Portfolio: offene zählen, Schwere und §-153 nur lesbar (auch nicht über die Priorität)', async () => {
    const zeile = async (person: string, bt: string[]) => {
      const p = await im(kanzlei(w.tenant, person, null, { bt: true }), (ctx) =>
        ladePortfolio(ctx, { mandantIds: [w.mandant], bt }),
      );
      return p.zeilen.find((z) => z.mandant.id === w.mandant)!;
    };
    const leser = await zeile(w.p.leser, []);
    expect(leser).toMatchObject({
      feststellungenOffen: 1,
      feststellungenHochOffen: 0,
      p153Offen: 0,
    });
    const zbt = await zeile(w.p.zbt, [w.mandant]);
    expect(zbt).toMatchObject({ feststellungenOffen: 1, feststellungenHochOffen: 1, p153Offen: 1 });
    // Priorität: §-153 zählt 10 000, hoch/kritisch 300 – beim leser beides nicht.
    expect(zbt.prioritaet - leser.prioritaet).toBe(10_300);
  });

  it('Arbeitskorb: keine §-153-Aufgaben aus maskierten Feststellungen', async () => {
    const korb = async (person: string, liste: { bt?: string[]; hb?: string[] }) =>
      im(kanzlei(w.tenant, person, null, { bt: person !== w.p.hb }), (ctx) =>
        ladeArbeitskorb(ctx, { mandantIds: [w.mandant], ...liste }),
      );
    const leser = await korb(w.p.leser, {});
    expect(leser.p153).toEqual([]);
    expect(leser.p153BeiAnderen).toEqual({ anzahl: 0, mandantIds: [] });
    expect(JSON.stringify(leser)).not.toContain(TITEL);
    // Zuständige gehören zum Kreis der Beteiligten (kannVertraulichLesen).
    const zbt = await korb(w.p.zbt, { bt: [w.mandant] });
    expect(zbt.p153.map((x) => x.id)).toEqual([f.id]);
    const hb = await korb(w.p.hb, { hb: [w.mandant] });
    expect(hb.p153BeiAnderen).toEqual({ anzahl: 1, mandantIds: [w.mandant] });
  });

  it('Kontrolle: §-153-Kennzeichen der Feststellung einer Durchführung nur lesbar', async () => {
    const feststellung = async (a: typeof A.leser) => {
      const k = await im(a, (ctx) =>
        ladeKontrolle(ctx, { mandantId: w.mandant, kontrolleId: w.kontrolle }),
      );
      return k.durchfuehrungen.find((d) => d.id === w.durchfuehrung)!.feststellung;
    };
    expect(await feststellung(A.leser)).toEqual({ maskiert: true, id: f.id, nummer: f.nummer });
    expect(await feststellung(A.zbt)).toEqual({
      maskiert: false,
      id: f.id,
      nummer: f.nummer,
      p153Offen: true,
    });
  });

  it('Durchführung: verknüpfte Feststellung ohne Titel und Schwere', async () => {
    const d = await im(A.leser, (ctx) =>
      ladeDurchfuehrung(ctx, { mandantId: w.mandant, durchfuehrungId: w.durchfuehrung }),
    );
    expect(d.feststellungen).toEqual([
      { maskiert: true, id: f.id, nummer: f.nummer, status: 'IN_WUERDIGUNG', vertraulich: true },
    ]);
  });

  it('Ereignis: Folge nennt die vertrauliche Feststellung nur mit ID und Nummer', async () => {
    const e = await im(A.leser, (ctx) => ladeEreignis(ctx, { mandantId: w.mandant, ereignisId }));
    expect(e.folgen.map((x) => x.feststellung)).toEqual([{ id: f.id, nummer: f.nummer }]);
    expect(JSON.stringify(e)).not.toContain(TITEL);
  });
});
