// Gespeicherter Entwurf des Einrichtungsassistenten (rein): Texte aus der Zeit
// vor einer strengeren Eingaberegel (RT4-T-03 einzeilig, tcms-s9
// Richtungssteuerzeichen) bleiben lesbar und fallen nicht still auf Startwerte
// zurück; Struktur und Längen prüft das Lesen weiter.
import { describe, expect, it } from 'vitest';
import { SetupEntwurfSchema, TeilbereichSchrittSchema, ZieleSchrittSchema } from '@tcms/contract';
import { leseEntwurf, mindestEnde, neuerEntwurf, pruefeSchritt1 } from './entwurf';
import { berechnePlan } from './aufbau';

const HEUTE = new Date('2026-10-19T00:00:00Z');

describe('leseEntwurf: Altbestand', () => {
  const basis = neuerEntwurf(HEUTE, null);
  const alt = {
    ...basis,
    abgeschlossen: 3,
    teilbereich: {
      ...basis.teilbereich,
      name: 'Teilbereich\tmit TAB',
      abgrenzung: 'Abgrenzung \u202ealt\u202c',
      einschluesse: ['Kanal \u2066isoliert\u2069'],
    },
    ziele: basis.ziele.map((z, i) => (i === 0 ? { ...z, text: 'Ziel \u202bRLE\u202c' } : z)),
    risiken: { 'EC-UST-01': { uebernehmen: false, begruendung: 'Begründung \u2068FSI\u2069' } },
  };

  it('behält Texte, die die heutige Eingaberegel abweist', () => {
    // Voraussetzung: Die Eingabe-Schemas weisen genau diese Texte ab.
    expect(
      TeilbereichSchrittSchema.safeParse({ teilbereich: alt.teilbereich, zeitraum: alt.zeitraum })
        .success,
    ).toBe(false);
    expect(ZieleSchrittSchema.safeParse({ ziele: alt.ziele, freigabe: alt.freigabe }).success).toBe(
      false,
    );
    const e = leseEntwurf(JSON.parse(JSON.stringify(alt)), HEUTE, null);
    expect(e.teilbereich).toEqual(alt.teilbereich);
    expect(e.ziele).toEqual(alt.ziele);
    expect(e.risiken).toEqual(alt.risiken);
    expect(e.abgeschlossen).toBe(3);
    // Die Antwort (`EinrichtungView.entwurf`) nimmt den gelesenen Entwurf an.
    expect(SetupEntwurfSchema.parse(e)).toEqual(e);
  });

  it('Struktur und Längen gelten weiter: Ungültiges fällt je Schritt auf Startwerte zurück', () => {
    const lang = {
      ...alt,
      teilbereich: { ...alt.teilbereich, abgrenzung: 'x'.repeat(4001) },
      ziele: [{ ...alt.ziele[0]!, unbekannt: 1 }],
    };
    const e = leseEntwurf(lang, HEUTE, null);
    expect(e.teilbereich).toEqual(basis.teilbereich);
    expect(e.ziele).toEqual(basis.ziele);
    expect(e.risiken).toEqual(alt.risiken);
  });
});

describe('mindestEnde: sechs Monate Wirksamkeit', () => {
  const t = (s: string) => new Date(`${s}T00:00:00Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it.each([
    ['0099-08-31', '0100-02-28'],
    ['2026-01-01', '2026-06-30'],
    ['2026-03-31', '2026-09-30'],
    ['2026-08-29', '2027-02-28'],
    ['2026-10-31', '2027-04-30'],
    ['2026-12-31', '2027-06-30'],
  ])('%s → %s (unverändert)', (ab, ende) => {
    expect(iso(mindestEnde(t(ab)))).toBe(ende);
  });

  it('plant für einen unmöglichen Kalendertag im gespeicherten Entwurf keine Durchführungen', () => {
    const e = neuerEntwurf(HEUTE, null);
    e.zeitraum.wirksamAb = '2027-02-31';
    const plan = berechnePlan(e, {
      heute: HEUTE,
      mandant: { id: 'm', name: 'Mandant', berufstraegerId: null, bearbeitungId: null },
      kanzlei: [],
      mandantPersonen: [],
      mandantRollen: [],
    });
    expect(plan.zeitraum).toBeNull();
    expect(plan.durchfuehrungen).toBe(0);
    expect(plan.prueflast).toEqual([]);
    expect(pruefeSchritt1(e, HEUTE)).toContain(
      'Beginn und Ende des Wirksamkeitszeitraums angeben.',
    );
  });

  it.each([
    ['2026-08-30', '2027-02-28'],
    ['2026-08-31', '2027-02-28'],
    ['2027-08-30', '2028-02-29'],
    ['2027-08-31', '2028-02-29'],
  ])('Beginn %s: Ende spätestens am Monatsende des Februars (%s)', (ab, ende) => {
    expect(iso(mindestEnde(t(ab)))).toBe(ende);
  });

  it('Schritt 1 nimmt 31.08.–28.02. als sechs Monate an', () => {
    const e = neuerEntwurf(HEUTE, null);
    const mit = {
      ...e,
      teilbereich: { ...e.teilbereich, abgrenzung: 'x'.repeat(40) },
      zeitraum: {
        ...e.zeitraum,
        angemessenheitStichtag: '2026-08-30',
        wirksamAb: '2026-08-31',
        wirksamBis: '2027-02-28',
      },
    };
    expect(pruefeSchritt1(mit, t('2026-08-01'))).toEqual([]);
  });
});
