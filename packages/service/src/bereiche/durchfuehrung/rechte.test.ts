import { describe, expect, it } from 'vitest';
import { VERWEIGERUNG_GRUENDE, type Akteur } from '@tcms/contract';
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
    expect(fremd.beginnen).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'DURCHFUEHREN',
    });
  });

  it('Flags tragen den Verweigerungsgrund der Rechtefunktion, ohne interne Art', () => {
    const fremd = rechteFlags(durchfuehrungsRechte(lage({ akteur: kanzlei(id(99)) })));
    expect(fremd.beginnen).toEqual({
      erlaubt: false,
      grund: 'Durchführung durch die zugewiesene Person oder ihre Vertretung',
      verweigerung: 'DURCHFUEHREN',
    });
    const begonnen = rechteFlags(durchfuehrungsRechte(lage({ status: 'IN_DURCHFUEHRUNG' })));
    expect(begonnen.beginnen).toEqual({
      erlaubt: false,
      grund: 'Bereits begonnen',
      verweigerung: null,
    });
    expect(begonnen.bearbeiten).toEqual({ erlaubt: true, grund: null, verweigerung: null });
    // Für jede Handlung: Flag = Rechtefunktion (erlaubt, Text, Grund), nie `art`.
    const r = durchfuehrungsRechte(lage({ akteur: kontakt(GV) }));
    const flags = rechteFlags(r);
    for (const [k, v] of Object.entries(r) as [keyof typeof r, (typeof r)[keyof typeof r]][]) {
      expect(flags[k]).toEqual({
        erlaubt: v.erlaubt,
        grund: v.grund,
        verweigerung: v.verweigerung,
      });
      expect(flags[k]).not.toHaveProperty('art');
    }
  });

  it('historischer Stand sperrt jede Handlung', () => {
    const r = rechteFlags(durchfuehrungsRechte(lage({ historisch: true })));
    for (const x of Object.values(r)) {
      expect(x).toEqual({
        erlaubt: false,
        grund: 'Änderungen nur im aktuellen Stand möglich',
        verweigerung: null,
      });
    }
  });

  it('Vier-Augen: Beteiligte zeichnen nicht gegen, auch nicht in anderer Schreibweise', () => {
    const basis = { status: 'ZUR_GEGENZEICHNUNG' as const, durchgefuehrtVon: BEARBEITER };
    const pruefer = durchfuehrungsRechte(lage({ ...basis, akteur: kanzlei(PRUEFER) }));
    expect(pruefer.gegenzeichnen.erlaubt).toBe(true);
    const beteiligt = durchfuehrungsRechte(
      lage({ ...basis, akteur: kanzlei(PRUEFER), beteiligte: [PRUEFER.toUpperCase()] }),
    );
    expect(beteiligt.gegenzeichnen).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'VIER_AUGEN',
    });
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
    expect(bt.mandantBestaetigen).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'PARTEI',
    });
    const gv = durchfuehrungsRechte(lage({ ...basis, akteur: kontakt(GV), rollen }));
    expect(gv.mandantBestaetigen.erlaubt).toBe(true);
    const ma = durchfuehrungsRechte(
      lage({ ...basis, akteur: kontakt(MA), rollen, beteiligte: [MA] }),
    );
    expect(ma.mandantBestaetigen).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'VIER_AUGEN',
    });
    // Kontakt ohne Rolle beim Mandanten (nicht GV/TCB, nicht zugewiesen).
    const ohne = durchfuehrungsRechte(lage({ ...basis, akteur: kontakt(id(14)), rollen }));
    expect(ohne.mandantBestaetigen).toMatchObject({ art: 'RECHT', verweigerung: 'PORTAL_ROLLE' });
    // Kanzleiabschluss durch einen Mandantenkontakt: andere Seite.
    expect(gv.gegenzeichnen).toMatchObject({ art: 'RECHT', verweigerung: 'PARTEI' });
  });

  it('Entfallen: Freigabe nur mit Würdigungsrecht und nie durch die antragstellende Person', () => {
    const antrag = { entfallenBegruendung: 'x'.repeat(30), entfallenVon: BT };
    const selbst = durchfuehrungsRechte(
      lage({ ...antrag, akteur: kanzlei(BT, { bt: true, zust: true }) }),
    );
    expect(selbst.entfallenFreigeben).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'VIER_AUGEN',
    });
    expect(selbst.entfallenAblehnen.erlaubt).toBe(true);
    const zweite = durchfuehrungsRechte(
      lage({ ...antrag, akteur: kanzlei(id(5), { bt: true, adm: true }) }),
    );
    expect(zweite.entfallenFreigeben.erlaubt).toBe(true);
    const ohneBt = durchfuehrungsRechte(lage({ ...antrag, akteur: kanzlei(id(6), { adm: true }) }));
    expect(ohneBt.entfallenFreigeben).toMatchObject({
      erlaubt: false,
      art: 'RECHT',
      verweigerung: 'WUERDIGEN',
    });
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

describe('Verweigerungsgrund je Handlung', () => {
  it('Kanzlei auf Mandanten-Kontrolle und Kontakt auf Kanzlei-Kontrolle: PARTEI', () => {
    const mandantK = {
      partei: 'MANDANT' as const,
      durchfuehrendId: MA,
      vertretungId: null,
      gegenzeichnerId: null,
      gegenzeichnungMandant: false,
    };
    const k = durchfuehrungsRechte(lage({ zustaendigkeit: mandantK }));
    expect(k.beginnen).toMatchObject({ art: 'RECHT', verweigerung: 'PARTEI' });
    const m = durchfuehrungsRechte(lage({ akteur: kontakt(BEARBEITER) }));
    expect(m.beginnen).toMatchObject({ art: 'RECHT', verweigerung: 'PARTEI' });
    // Kontakt, sichtbar (GV), aber nicht zugewiesen: Portal-Zuordnung.
    const gv = durchfuehrungsRechte(
      lage({
        zustaendigkeit: mandantK,
        akteur: kontakt(GV),
        rollen: [rolle(GV, 'GESETZLICHER_VERTRETER')],
      }),
    );
    expect(gv.beginnen).toMatchObject({ art: 'RECHT', verweigerung: 'PORTAL_ZUGEORDNET' });
  });

  it('Kanzlei: Gegenzeichnung, Entfallen und Nachtrag', () => {
    const zur = { status: 'ZUR_GEGENZEICHNUNG' as const, durchgefuehrtVon: BEARBEITER };
    const kollege = durchfuehrungsRechte(lage({ ...zur, akteur: kanzlei(id(7)) }));
    expect(kollege.gegenzeichnen).toMatchObject({ art: 'RECHT', verweigerung: 'GEGENZEICHNEN' });
    const offen = durchfuehrungsRechte(lage({ akteur: kanzlei(id(7)) }));
    expect(offen.entfallenBeantragen).toMatchObject({ art: 'RECHT', verweigerung: 'BEARBEITEN' });
    const kontaktOffen = durchfuehrungsRechte(lage({ akteur: kontakt(GV) }));
    expect(kontaktOffen.entfallenBeantragen).toMatchObject({
      art: 'RECHT',
      verweigerung: 'PARTEI',
    });
    const fertig = { status: 'OHNE_BEFUND' as const };
    expect(
      durchfuehrungsRechte(lage({ ...fertig, akteur: kanzlei(id(7)) })).nachtrag,
    ).toMatchObject({ art: 'RECHT', verweigerung: 'BEARBEITEN' });
    expect(durchfuehrungsRechte(lage({ ...fertig, akteur: kontakt(GV) })).nachtrag).toMatchObject({
      art: 'RECHT',
      verweigerung: 'PARTEI',
    });
  });

  it('jede Personenablehnung trägt einen Grund der Liste, keine Statusablehnung einen', () => {
    const akteure = [
      kanzlei(BEARBEITER, { hb: true }),
      kanzlei(PRUEFER),
      kanzlei(BT, { bt: true, zust: true }),
      kanzlei(id(7)),
      kanzlei(id(8), { adm: true }),
      kontakt(GV),
      kontakt(MA),
      kontakt(id(14)),
    ];
    const rollen = [rolle(GV, 'GESETZLICHER_VERTRETER'), rolle(MA, 'MITARBEITER')];
    const zustaendigkeiten = [
      lage().zustaendigkeit,
      {
        partei: 'MANDANT' as const,
        durchfuehrendId: MA,
        vertretungId: null,
        gegenzeichnerId: GV,
        gegenzeichnungMandant: true,
      },
    ];
    const status = [
      'GEPLANT',
      'IN_DURCHFUEHRUNG',
      'ZUR_GEGENZEICHNUNG',
      'ZURUECKGEWIESEN',
      'OHNE_BEFUND',
      'ENTFALLEN',
    ] as const;
    let rechtFaelle = 0;
    for (const akteur of akteure)
      for (const zustaendigkeit of zustaendigkeiten)
        for (const s of status)
          for (const historisch of [false, true])
            for (const antrag of [null, BT]) {
              const r = durchfuehrungsRechte(
                lage({
                  akteur,
                  rollen,
                  zustaendigkeit,
                  status: s,
                  historisch,
                  durchgefuehrtVon: s === 'GEPLANT' ? null : zustaendigkeit.durchfuehrendId,
                  beteiligte: s === 'GEPLANT' ? [] : [zustaendigkeit.durchfuehrendId!],
                  entfallenBegruendung: antrag ? 'x'.repeat(30) : null,
                  entfallenVon: antrag,
                }),
              );
              for (const [handlung, x] of Object.entries(r)) {
                const wo = `${akteur.id} ${s} ${handlung}`;
                if (x.erlaubt) expect(x.verweigerung, wo).toBe(null);
                else if (x.art === 'STATUS') expect(x.verweigerung, wo).toBe(null);
                else {
                  rechtFaelle += 1;
                  expect(VERWEIGERUNG_GRUENDE, wo).toContain(x.verweigerung);
                }
              }
            }
    expect(rechtFaelle).toBeGreaterThan(100);
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
