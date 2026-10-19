import { describe, expect, it } from 'vitest';
import {
  DF_MAX_NACHWEIS_BYTES,
  DurchfuehrungBegruendungBodySchema,
  DurchfuehrungLesenEingabeSchema,
  DurchfuehrungSpeichernBodySchema,
  DurchfuehrungSpeichernEingabeSchema,
  DurchfuehrungZielSchema,
  EntfallenAblehnenBodySchema,
  GegenzeichnenBodySchema,
  NachweisAnhaengenBodySchema,
  NachweisAnhaengenEingabeSchema,
  NachweisVerweisSchema,
  gueltigerNachweisDateiname,
} from './durchfuehrung';

const MANDANT = '3c3c3c3c-3333-4333-8333-33333333abcd';
const DID = 'cmvep7iwo003rp17dhz7nhhpg';
const VERWEIS = {
  dokumentId: '0f0e0d0c-0b0a-4908-8706-050403020100',
  dateiname: 'Kontoauszug Oktober.pdf',
  mime: 'application/pdf',
  groesse: 1234,
  sha256: 'a'.repeat(64),
};
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

describe('Vertrag durchfuehrung: Eingaben', () => {
  it('Ziel: Mandant als UUID (kanonisch klein), Durchführung als Objekt-ID', () => {
    const p = DurchfuehrungZielSchema.parse({
      mandantId: MANDANT.toUpperCase(),
      durchfuehrungId: DID,
    });
    expect(p.mandantId).toBe(MANDANT);
    for (const durchfuehrungId of ['', 'ABC', 'a/b', 'a'.repeat(65), '../x', 'x y', 1]) {
      expect(ok(DurchfuehrungZielSchema, { mandantId: MANDANT, durchfuehrungId })).toBe(false);
    }
    expect(ok(DurchfuehrungZielSchema, { mandantId: 'kein-uuid', durchfuehrungId: DID })).toBe(
      false,
    );
  });

  it('strikt: unbekannte Felder und Stichtag in schreibenden Eingaben werden abgewiesen (TS-07)', () => {
    expect(
      ok(DurchfuehrungZielSchema, {
        mandantId: MANDANT,
        durchfuehrungId: DID,
        stand: '2026-01-01',
      }),
    ).toBe(false);
    expect(ok(DurchfuehrungBegruendungBodySchema, { begruendung: 'x'.repeat(30), extra: 1 })).toBe(
      false,
    );
    // IDs stehen im Pfad, nie im Body.
    expect(
      ok(DurchfuehrungBegruendungBodySchema, { begruendung: 'x'.repeat(30), mandantId: MANDANT }),
    ).toBe(false);
    expect(
      ok(DurchfuehrungLesenEingabeSchema, {
        mandantId: MANDANT,
        durchfuehrungId: DID,
        stand: '2026-02-30',
      }),
    ).toBe(false);
    expect(
      ok(DurchfuehrungLesenEingabeSchema, {
        mandantId: MANDANT,
        durchfuehrungId: DID,
        stand: '2026-02-28',
      }),
    ).toBe(true);
  });

  it('Begründung: getrimmt mindestens 30, höchstens 4000 Zeichen', () => {
    expect(ok(DurchfuehrungBegruendungBodySchema, { begruendung: ` ${'x'.repeat(29)} ` })).toBe(
      false,
    );
    expect(ok(DurchfuehrungBegruendungBodySchema, { begruendung: 'x'.repeat(30) })).toBe(true);
    expect(ok(DurchfuehrungBegruendungBodySchema, { begruendung: 'x'.repeat(4001) })).toBe(false);
    expect(ok(EntfallenAblehnenBodySchema, {})).toBe(true);
    expect(ok(EntfallenAblehnenBodySchema, { begruendung: 'x'.repeat(4001) })).toBe(false);
  });

  it('Speichern: Grenzen für Schritte, Werte, Beträge und Kommentare', () => {
    const basis = { schritte: [], werte: [], ergebnis: null, ergebnisKommentar: null };
    expect(ok(DurchfuehrungSpeichernBodySchema, basis)).toBe(true);
    const zuViele = Array.from({ length: 101 }, () => ({ erledigt: true, kommentar: '' }));
    expect(ok(DurchfuehrungSpeichernBodySchema, { ...basis, schritte: zuViele })).toBe(false);
    expect(
      ok(DurchfuehrungSpeichernBodySchema, {
        ...basis,
        schritte: [{ erledigt: true, kommentar: 'x'.repeat(2001) }],
      }),
    ).toBe(false);
    const wert = (w: unknown, key = 'saldo') => ({
      ...basis,
      werte: [{ key, wert: w, bemerkung: '', erklaert: false }],
    });
    expect(ok(DurchfuehrungSpeichernBodySchema, wert(12.5))).toBe(true);
    expect(ok(DurchfuehrungSpeichernBodySchema, wert(null))).toBe(true);
    for (const w of [1e12, -1e12, Infinity, NaN, '1,00']) {
      expect(ok(DurchfuehrungSpeichernBodySchema, wert(w))).toBe(false);
    }
    // Kennzahl-Schlüssel: keine Prototyp-Namen, keine Sonderzeichen.
    for (const key of ['__proto__', 'constructor x', '', '1abc', 'a.b']) {
      expect(ok(DurchfuehrungSpeichernBodySchema, wert(1, key))).toBe(false);
    }
    const doppelt = {
      ...basis,
      werte: [
        { key: 'a', wert: 1, bemerkung: '', erklaert: false },
        { key: 'a', wert: 2, bemerkung: '', erklaert: false },
      ],
    };
    expect(ok(DurchfuehrungSpeichernBodySchema, doppelt)).toBe(false);
    expect(ok(DurchfuehrungSpeichernBodySchema, { ...basis, ergebnis: 'WIRKSAM' })).toBe(false);
    expect(
      ok(DurchfuehrungSpeichernEingabeSchema, {
        ...basis,
        mandantId: MANDANT,
        durchfuehrungId: DID,
      }),
    ).toBe(true);
  });
});

describe('Vertrag durchfuehrung: Nachweis-Verweis (ADR 0001 §6)', () => {
  it('nimmt einen gültigen Verweis an und kanonisiert die Dokument-ID', () => {
    const v = NachweisVerweisSchema.parse({
      ...VERWEIS,
      dokumentId: VERWEIS.dokumentId.toUpperCase(),
    });
    expect(v.dokumentId).toBe(VERWEIS.dokumentId);
    expect(ok(NachweisAnhaengenBodySchema, { verweis: VERWEIS })).toBe(true);
    expect(
      ok(NachweisAnhaengenEingabeSchema, {
        mandantId: MANDANT,
        durchfuehrungId: DID,
        verweis: VERWEIS,
      }),
    ).toBe(true);
  });

  it('dokumentId muss eine UUID sein (kein Pfad, keine freie Zeichenkette)', () => {
    for (const dokumentId of ['ab/abcdef', '../../etc/passwd', 'x', '', 42, null]) {
      expect(ok(NachweisVerweisSchema, { ...VERWEIS, dokumentId })).toBe(false);
    }
  });

  it('sha256: genau 64 Hex-Zeichen in Kleinbuchstaben', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '']) {
      expect(ok(NachweisVerweisSchema, { ...VERWEIS, sha256 })).toBe(false);
    }
  });

  it('Größe: ganze Zahl ab 1 Byte bis zur Spaltengrenze', () => {
    for (const groesse of [0, -1, 1.5, DF_MAX_NACHWEIS_BYTES + 1, '12', Number.MAX_SAFE_INTEGER]) {
      expect(ok(NachweisVerweisSchema, { ...VERWEIS, groesse })).toBe(false);
    }
    expect(ok(NachweisVerweisSchema, { ...VERWEIS, groesse: DF_MAX_NACHWEIS_BYTES })).toBe(true);
  });

  it('MIME: Typ/Subtyp ohne Parameter, Großbuchstaben oder Steuerzeichen', () => {
    for (const mime of [
      'text/html; charset=utf-8',
      'Application/PDF',
      'pdf',
      '/x',
      'a/\n',
      'a'.repeat(120) + '/' + 'b'.repeat(10),
    ]) {
      expect(ok(NachweisVerweisSchema, { ...VERWEIS, mime })).toBe(false);
    }
  });

  it('Dateiname: keine Pfade, Steuer- oder Richtungszeichen, nicht leer, höchstens 255', () => {
    for (const dateiname of [
      '',
      '   ',
      '.',
      '..',
      'a/b.pdf',
      'a\\b.pdf',
      'a\u0000.pdf',
      'rechnung\u202efdp.exe',
      'a\u2066b',
      'a\u200fb',
      'x'.repeat(256),
    ]) {
      expect(gueltigerNachweisDateiname(dateiname as string)).toBe(false);
      expect(ok(NachweisVerweisSchema, { ...VERWEIS, dateiname })).toBe(false);
    }
    expect(gueltigerNachweisDateiname('Übersicht – Q3 (final).xlsx')).toBe(true);
  });

  it('weist zusätzliche Felder ab (z. B. Speicherpfad, Inhalt)', () => {
    expect(ok(NachweisVerweisSchema, { ...VERWEIS, pfad: '/tmp/x' })).toBe(false);
    expect(ok(NachweisAnhaengenBodySchema, { verweis: VERWEIS, inhalt: 'AAAA' })).toBe(false);
  });
});

describe('Vertrag durchfuehrung: Gegenzeichnen', () => {
  const f = {
    titel: 'Abweichung Clearingkonto',
    sachverhalt: 'Differenz von 12,50 EUR ungeklärt',
    klasse: 'DURCHFUEHRUNGSMANGEL',
    schwere: 'MITTEL',
    auswirkung: 'UNKLAR',
    risikoIds: ['cmvep7ipd001pp17d35jc5c01'],
  };
  it('ohne Feststellung und mit vollständiger Feststellung', () => {
    expect(ok(GegenzeichnenBodySchema, {})).toBe(true);
    expect(ok(GegenzeichnenBodySchema, { feststellung: f })).toBe(true);
  });
  it('weist unvollständige oder doppelte Angaben ab', () => {
    expect(ok(GegenzeichnenBodySchema, { feststellung: { ...f, risikoIds: [] } })).toBe(false);
    expect(
      ok(GegenzeichnenBodySchema, {
        feststellung: { ...f, risikoIds: [f.risikoIds[0], f.risikoIds[0]] },
      }),
    ).toBe(false);
    expect(ok(GegenzeichnenBodySchema, { feststellung: { ...f, titel: 'kurz' } })).toBe(false);
    expect(ok(GegenzeichnenBodySchema, { feststellung: { ...f, auswirkung: 'VIELLEICHT' } })).toBe(
      false,
    );
    expect(ok(GegenzeichnenBodySchema, { feststellung: { ...f, status: 'GESCHLOSSEN' } })).toBe(
      false,
    );
  });
});
