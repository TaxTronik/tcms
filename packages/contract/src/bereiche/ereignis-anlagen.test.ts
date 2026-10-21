// Vertrag „Ereignis-Anlagen je Dokument“ (tcms-s11): nur Kanzlei, Dokument-ID
// nur als UUID (kanonisch klein), Antwort als strikte Positivliste (Ereignis-ID,
// Nummer, Status, SHA-256, entfernt) – kein Dateiname, keine Personen, nichts
// aus Feststellungen.
import { describe, expect, it } from 'vitest';
import { ENDPUNKTE } from '../endpunkte';
import {
  EreignisAnlagenJeDokumentEingabeSchema,
  EreignisAnlagenJeDokumentQuerySchema,
  EreignisAnlagenJeDokumentSchema,
} from './feststellungen-ereignisse';

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

const DOK = '0f0e0d0c-0b0a-4908-8706-050403020100';
const MANDANT = '3c3c3c3c-3333-4333-8333-33333333abcd';

describe('Vertrag: Ereignis-Anlagen je Dokument', () => {
  it('Registereintrag: GET unter dem Mandanten, nur KANZLEI, eigenes Segment', () => {
    const e = ENDPUNKTE.ereignisAnlagenJeDokumentLesen;
    expect(e.methode).toBe('GET');
    expect(e.pfad).toBe('/v1/mandanten/:mandantId/ereignis-anlagen');
    expect(e.akteure).toEqual(['KANZLEI']);
    expect(e.portal).toBe(false);
    expect(e.mandantenbezogen).toBe(true);
    expect(e.querySchema).toBe(EreignisAnlagenJeDokumentQuerySchema);
    expect(e.antwortSchema).toBe(EreignisAnlagenJeDokumentSchema);
    expect(e.konflikte).toEqual([]);
  });

  it('Query und Eingabe: nur UUIDs, kanonisch klein; Pflicht erst in der Eingabe; keine Zusatzfelder', () => {
    expect(EreignisAnlagenJeDokumentQuerySchema.parse({ dokumentId: DOK.toUpperCase() })).toEqual({
      dokumentId: DOK,
    });
    expect(ok(EreignisAnlagenJeDokumentQuerySchema, {})).toBe(true);
    for (const dokumentId of ['ab/0123', `kk:${DOK}`, `${DOK} `, '', 42, null]) {
      expect(ok(EreignisAnlagenJeDokumentQuerySchema, { dokumentId }), String(dokumentId)).toBe(
        false,
      );
    }
    expect(ok(EreignisAnlagenJeDokumentQuerySchema, { dokumentId: DOK, stand: '2026-10-01' })).toBe(
      false,
    );
    expect(ok(EreignisAnlagenJeDokumentEingabeSchema, { mandantId: MANDANT })).toBe(false);
    expect(
      EreignisAnlagenJeDokumentEingabeSchema.parse({ mandantId: MANDANT, dokumentId: DOK }),
    ).toEqual({ mandantId: MANDANT, dokumentId: DOK });
  });

  it('Antwort: strikte Positivliste je Anlage', () => {
    const anlage = {
      ereignisId: 'ckz0a1b2c3d4e5f6g7h8i9j0',
      nummer: '2026-T-0001',
      status: 'VERWORFEN',
      sha256: 'a'.repeat(64),
      entfernt: false,
    };
    expect(ok(EreignisAnlagenJeDokumentSchema, { dokumentId: DOK, anlagen: [anlage] })).toBe(true);
    expect(ok(EreignisAnlagenJeDokumentSchema, { dokumentId: DOK, anlagen: [] })).toBe(true);
    for (const [feld, wert] of Object.entries({
      dateiname: 'Vertrag.pdf',
      titel: 'Neues Lager',
      gemeldetVon: MANDANT,
      feststellungId: 'ckz0a1b2c3d4e5f6g7h8i9j1',
      dokumentId: DOK,
    })) {
      expect(
        ok(EreignisAnlagenJeDokumentSchema, {
          dokumentId: DOK,
          anlagen: [{ ...anlage, [feld]: wert }],
        }),
        feld,
      ).toBe(false);
    }
    for (const falsch of [{ status: 'GELOESCHT' }, { sha256: 'ZZ' }, { entfernt: 'nein' }]) {
      expect(
        ok(EreignisAnlagenJeDokumentSchema, {
          dokumentId: DOK,
          anlagen: [{ ...anlage, ...falsch }],
        }),
        JSON.stringify(falsch),
      ).toBe(false);
    }
  });
});
