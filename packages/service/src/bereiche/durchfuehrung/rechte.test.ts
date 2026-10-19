import { describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import type { KontaktRolle } from '../../rechte';
import { darfPortalLesen, durchfuehrungsRechte, rechteFlags, type RechteLage } from './rechte';
import { pruefeEinreichung, leseWerte, toleranzLagen, type KennzahlDef } from './werte';

const T = '7a1e0000-0000-4000-8000-00000000d3e0';
const M = 'a1000000-0000-4000-8000-000000004711';
const id = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BEARBEITER = id(1);
const VERTRETUNG = id(2);
const PRUEFER = id(3);
const BT = id(4);
const MA = id(11);
const GV = id(12);

const kanzlei = (
  pid: string,
  o: { bt?: boolean; adm?: boolean; zust?: boolean; hb?: boolean } = {},
): Akteur => ({
  art: 'KANZLEI',
  tenantId: T,
  id: pid,
  name: 'K',
  istAdmin: o.adm ?? false,
  istBerufstraeger: o.bt ?? false,
  mandant: { id: M, zustaendigBerufstraeger: o.zust ?? false, hauptbearbeitung: o.hb ?? false },
});
const kontakt = (pid: string): Akteur => ({
  art: 'MANDANT',
  tenantId: T,
  id: pid,
  name: 'M',
  mandantId: M,
});
const rolle = (kontaktId: string, r: KontaktRolle['rolle']): KontaktRolle => ({
  mandantId: M,
  kontaktId,
  rolle: r,
  aktiv: true,
});

function lage(over: Partial<RechteLage> = {}): RechteLage {
  return {
    akteur: kanzlei(BEARBEITER, { hb: true }),
    rollen: [],
    mandantId: M,
    historisch: false,
    status: 'GEPLANT',
    anzeige: 'FAELLIG',
    periodeBis: new Date('2026-09-30T00:00:00Z'),
    zustaendigkeit: {
      partei: 'KANZLEI',
      durchfuehrendId: BEARBEITER,
      vertretungId: VERTRETUNG,
      gegenzeichnerId: PRUEFER,
      gegenzeichnungMandant: false,
    },
    durchgefuehrtVon: null,
    mandantBestaetigtVon: null,
    entfallenBegruendung: null,
    entfallenVon: null,
    beteiligte: [],
    ...over,
  };
}

describe('durchfuehrungsRechte', () => {
  it('Statusablehnungen sind STATUS (→ KONFLIKT), Personenablehnungen RECHT (→ NICHT_BERECHTIGT)', () => {
    const r = durchfuehrungsRechte(lage({ status: 'IN_DURCHFUEHRUNG' }));
    expect(r.beginnen).toMatchObject({ erlaubt: false, art: 'STATUS', grund: 'Bereits begonnen' });
    const fremd = durchfuehrungsRechte(lage({ akteur: kanzlei(id(99)) }));
    expect(fremd.beginnen).toMatchObject({ erlaubt: false, art: 'RECHT' });
  });

  it('historischer Stand sperrt jede Handlung', () => {
    const r = rechteFlags(durchfuehrungsRechte(lage({ historisch: true })));
    for (const x of Object.values(r)) {
      expect(x).toEqual({ erlaubt: false, grund: 'Änderungen nur im aktuellen Stand möglich' });
    }
  });

  it('Vier-Augen: Beteiligte zeichnen nicht gegen, auch nicht in anderer Schreibweise', () => {
    const basis = { status: 'ZUR_GEGENZEICHNUNG' as const, durchgefuehrtVon: BEARBEITER };
    const pruefer = durchfuehrungsRechte(lage({ ...basis, akteur: kanzlei(PRUEFER) }));
    expect(pruefer.gegenzeichnen.erlaubt).toBe(true);
    const beteiligt = durchfuehrungsRechte(
      lage({ ...basis, akteur: kanzlei(PRUEFER), beteiligte: [PRUEFER.toUpperCase()] }),
    );
    expect(beteiligt.gegenzeichnen).toMatchObject({ erlaubt: false, art: 'RECHT' });
    expect(beteiligt.zurueckweisen.erlaubt).toBe(false);
  });

  it('Mandanten-Gegenzeichnung: Kanzlei erst nach Bestätigung (STATUS), Bestätigung nur Mandant', () => {
    const z = {
      partei: 'MANDANT' as const,
      durchfuehrendId: MA,
      vertretungId: id(13),
      gegenzeichnerId: GV,
      gegenzeichnungMandant: true,
    };
    const rollen = [rolle(GV, 'GESETZLICHER_VERTRETER'), rolle(MA, 'MITARBEITER')];
    const basis = {
      status: 'ZUR_GEGENZEICHNUNG' as const,
      zustaendigkeit: z,
      durchgefuehrtVon: MA,
    };
    const bt = durchfuehrungsRechte(
      lage({ ...basis, akteur: kanzlei(BT, { bt: true, zust: true }) }),
    );
    expect(bt.gegenzeichnen).toMatchObject({ erlaubt: false, art: 'STATUS' });
    expect(bt.mandantBestaetigen).toMatchObject({ erlaubt: false, art: 'RECHT' });
    const gv = durchfuehrungsRechte(lage({ ...basis, akteur: kontakt(GV), rollen }));
    expect(gv.mandantBestaetigen.erlaubt).toBe(true);
    const ma = durchfuehrungsRechte(
      lage({ ...basis, akteur: kontakt(MA), rollen, beteiligte: [MA] }),
    );
    expect(ma.mandantBestaetigen).toMatchObject({ erlaubt: false, art: 'RECHT' });
  });

  it('Entfallen: Freigabe nur mit Würdigungsrecht und nie durch die antragstellende Person', () => {
    const antrag = { entfallenBegruendung: 'x'.repeat(30), entfallenVon: BT };
    const selbst = durchfuehrungsRechte(
      lage({ ...antrag, akteur: kanzlei(BT, { bt: true, zust: true }) }),
    );
    expect(selbst.entfallenFreigeben).toMatchObject({ erlaubt: false, art: 'RECHT' });
    expect(selbst.entfallenAblehnen.erlaubt).toBe(true);
    const zweite = durchfuehrungsRechte(
      lage({ ...antrag, akteur: kanzlei(id(5), { bt: true, adm: true }) }),
    );
    expect(zweite.entfallenFreigeben.erlaubt).toBe(true);
    const ohneBt = durchfuehrungsRechte(lage({ ...antrag, akteur: kanzlei(id(6), { adm: true }) }));
    expect(ohneBt.entfallenFreigeben).toMatchObject({ erlaubt: false, art: 'RECHT' });
    // Nach Einreichung kein offener Antrag mehr entscheidbar.
    const eingereicht = durchfuehrungsRechte(
      lage({
        ...antrag,
        status: 'ZUR_GEGENZEICHNUNG',
        akteur: kanzlei(id(5), { bt: true, adm: true }),
      }),
    );
    expect(eingereicht.entfallenFreigeben).toMatchObject({ erlaubt: false, art: 'STATUS' });
  });
});

describe('darfPortalLesen', () => {
  const k = {
    partei: 'MANDANT' as const,
    durchfuehrendId: MA,
    vertretungId: null,
    gegenzeichnerId: null,
  };
  it('GV/TCB alle Mandanten-Aufgaben, Mitarbeitende nur zugewiesene, nie Kanzlei-Kontrollen', () => {
    const rollen = [
      rolle(GV, 'GESETZLICHER_VERTRETER'),
      rolle(MA, 'MITARBEITER'),
      rolle(id(14), 'MITARBEITER'),
    ];
    expect(darfPortalLesen(kontakt(GV), M, rollen, k)).toBe(true);
    expect(darfPortalLesen(kontakt(MA), M, rollen, k)).toBe(true);
    expect(darfPortalLesen(kontakt(id(14)), M, rollen, k)).toBe(false);
    expect(darfPortalLesen(kontakt(GV), M, rollen, { ...k, partei: 'KANZLEI' })).toBe(false);
    expect(darfPortalLesen(kontakt(MA), M, [], k)).toBe(false);
    expect(darfPortalLesen(kanzlei(BT, { adm: true }), M, rollen, k)).toBe(false);
  });
});

describe('Einreichprüfung', () => {
  const defs: KennzahlDef[] = [
    { key: 'a', label: 'A', sollEur: null },
    { key: 'b', label: 'B', sollEur: null },
    { key: 'd', label: 'Differenz', sollEur: 0, differenzAus: ['a', 'b'] },
  ];
  it('Toleranz: Differenz außerhalb nur mit Erklärung oder Befund', () => {
    const werte = leseWerte(
      { a: { wert: 110, bemerkung: '', erklaert: false }, b: { wert: 100 } },
      defs,
    );
    expect(toleranzLagen(defs, werte, 5).find((x) => x.def.key === 'd')?.lage).toBe('AUSSERHALB');
    const p = pruefeEinreichung({
      schritte: [{ erledigt: true }],
      kennzahlen: defs,
      werte,
      toleranzEur: 5,
      nachweise: 1,
      mindestNachweise: 1,
      ergebnis: 'OHNE_BEFUND',
      ergebnisKommentar: null,
    });
    expect(p.maengel).toEqual(['Abweichung außerhalb der Toleranz ohne Erklärung: Differenz']);
    const mitBefund = pruefeEinreichung({
      schritte: [{ erledigt: true }],
      kennzahlen: defs,
      werte,
      toleranzEur: 5,
      nachweise: 0,
      mindestNachweise: 1,
      ergebnis: 'MIT_BEFUND',
      ergebnisKommentar: 'zu kurz',
    });
    expect(mitBefund.maengel).toEqual([
      'Nachweise: 0 von mindestens 1',
      'Befund beschreiben (mindestens 20 Zeichen)',
    ]);
  });

  it('liest gespeicherte Werte nur für Kennzahlen der Kontrolle (keine Prototyp-Schlüssel)', () => {
    const roh = JSON.parse('{"__proto__":{"wert":1},"a":{"wert":5},"x":{"wert":2}}') as unknown;
    const w = leseWerte(roh, defs);
    expect(Object.keys(w)).toEqual(['a']);
    expect(Object.getPrototypeOf(w)).toBeNull();
  });
});
