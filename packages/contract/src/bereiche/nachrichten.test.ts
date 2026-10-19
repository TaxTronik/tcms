// Offene Nachrichten (Stufe 4): diskriminiert über `zweck`, Empfängerart fest je
// Zweck, Vorlagendaten streng (genau die Felder der Vorlage, keine Namen).
import { describe, expect, it } from 'vitest';
import {
  NACHRICHT_EMPFAENGER,
  NACHRICHT_ZWECKE,
  NachrichtenOffenSchema,
  OffeneNachrichtSchema,
} from './programm-beschreibung';

const KOPF = {
  id: 'cknachricht00000000000a',
  mandantId: '3c3c3c3c-3333-4333-8333-33333333abcd',
  empfaengerId: '22222222-2222-4222-8222-222222222222',
  betreff: 'Freigabe angefordert',
  text: 'Rückfalltext',
  erstelltAm: '2026-10-19T09:00:00.000Z',
};
const FREIGABE = {
  freigabeId: 'ckfreigabe0000000000000a',
  art: 'BESCHREIBUNG',
  titel: 'CMS-Beschreibung v1.2',
  version: '1.2',
};
const GUELTIG = {
  FREIGABE_ANGEFORDERT: {
    ...KOPF,
    zweck: 'FREIGABE_ANGEFORDERT',
    empfaengerArt: 'KONTAKT',
    daten: FREIGABE,
  },
  FREIGABE_NEU_ADRESSIERT: {
    ...KOPF,
    zweck: 'FREIGABE_NEU_ADRESSIERT',
    empfaengerArt: 'KONTAKT',
    daten: { ...FREIGABE, art: 'KENNTNISNAHME', version: null },
  },
  FREIGABE_CODE: {
    ...KOPF,
    zweck: 'FREIGABE_CODE',
    empfaengerArt: 'KONTAKT',
    daten: {
      ...FREIGABE,
      code: '012345',
      gueltigBis: '2026-10-26T09:00:00.000Z',
      sha256: 'a'.repeat(64),
    },
  },
  EREIGNIS_GEMELDET: {
    ...KOPF,
    zweck: 'EREIGNIS_GEMELDET',
    empfaengerArt: 'KANZLEI',
    daten: {
      ereignisId: 'ckereignis000000000000a',
      nummer: '2026-E-0001',
      titel: 'Neues Lager in Polen',
      typ: 'Lager',
      gemeldetVonId: '22222222-2222-4222-8222-222222222222',
    },
  },
} as const;

describe('OffeneNachrichtSchema', () => {
  it('nimmt je Zweck die gültige Nachricht an; Empfängerart folgt aus dem Zweck', () => {
    expect(Object.keys(GUELTIG).sort()).toEqual([...NACHRICHT_ZWECKE].sort());
    for (const n of Object.values(GUELTIG)) {
      expect(OffeneNachrichtSchema.safeParse(n).success, n.zweck).toBe(true);
      expect(n.empfaengerArt).toBe(NACHRICHT_EMPFAENGER[n.zweck]);
    }
    expect(NachrichtenOffenSchema.safeParse({ nachrichten: Object.values(GUELTIG) }).success).toBe(
      true,
    );
  });

  it('weist falsche Empfängerart, fremde Vorlagendaten und Zusatzfelder ab', () => {
    const c = GUELTIG.FREIGABE_CODE;
    const falsch: [string, unknown][] = [
      ['Code an Kanzlei', { ...c, empfaengerArt: 'KANZLEI' }],
      ['Ereignis an Kontakt', { ...GUELTIG.EREIGNIS_GEMELDET, empfaengerArt: 'KONTAKT' }],
      ['Code fehlt', { ...c, daten: { ...c.daten, code: undefined } }],
      ['Code fünf Ziffern', { ...c, daten: { ...c.daten, code: '12345' } }],
      ['Code mit Buchstaben', { ...c, daten: { ...c.daten, code: '12a456' } }],
      [
        'Code bei Anforderung',
        { ...GUELTIG.FREIGABE_ANGEFORDERT, daten: { ...FREIGABE, code: '123456' } },
      ],
      [
        'Name in den Daten',
        { ...GUELTIG.FREIGABE_ANGEFORDERT, daten: { ...FREIGABE, name: 'Jana' } },
      ],
      ['Zusatzfeld', { ...c, an: 'jana@example.test' }],
      ['Daten eines anderen Zwecks', { ...GUELTIG.EREIGNIS_GEMELDET, daten: FREIGABE }],
      ['Mandant keine UUID', { ...c, mandantId: 'Talwind' }],
      ['Empfänger keine UUID', { ...c, empfaengerId: 'Jana Weller' }],
      ['unbekannter Zweck', { ...c, zweck: 'SONSTIGES' }],
      ['unbekannte Art', { ...GUELTIG.FREIGABE_ANGEFORDERT, daten: { ...FREIGABE, art: 'X' } }],
      ['Version frei', { ...GUELTIG.FREIGABE_ANGEFORDERT, daten: { ...FREIGABE, version: 'v1' } }],
      ['SHA-256 ungültig', { ...c, daten: { ...c.daten, sha256: 'xyz' } }],
    ];
    for (const [name, n] of falsch)
      expect(OffeneNachrichtSchema.safeParse(n).success, name).toBe(false);
  });
});
