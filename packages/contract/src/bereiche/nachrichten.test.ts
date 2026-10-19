// Offene Nachrichten (Stufe 4): diskriminiert über `zweck`, Empfängerart fest je
// Zweck, Vorlagendaten streng (genau die Felder der Vorlage, keine Namen).
// Unzustellbarkeit: Grund nur aus der festen Liste, Body und Ergebnis streng.
import { describe, expect, it } from 'vitest';
import {
  NACHRICHT_EMPFAENGER,
  NACHRICHT_ZWECKE,
  NachrichtenOffenSchema,
  NachrichtPfadSchema,
  NachrichtUnzustellbarBodySchema,
  NachrichtUnzustellbarEingabeSchema,
  NachrichtUnzustellbarErgebnisSchema,
  OffeneNachrichtSchema,
} from './programm-beschreibung';
import { NACHRICHT_UNZUSTELLBAR_GRUENDE } from './zustellung';

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

describe('Unzustellbarkeit melden', () => {
  const ID = 'cknachricht00000000000a';

  it('nimmt jeden Grund der Liste an (Body, Eingabe, Ergebnis)', () => {
    expect([...NACHRICHT_UNZUSTELLBAR_GRUENDE]).toEqual([
      'EMPFAENGER_UNGUELTIG',
      'KEIN_PORTALZUGANG',
      'ABGELAUFEN',
      'SONSTIGES',
    ]);
    for (const grund of NACHRICHT_UNZUSTELLBAR_GRUENDE) {
      expect(NachrichtUnzustellbarBodySchema.safeParse({ grund }).success, grund).toBe(true);
      expect(
        NachrichtUnzustellbarEingabeSchema.safeParse({ nachrichtId: ID, grund }).success,
        grund,
      ).toBe(true);
      expect(
        NachrichtUnzustellbarErgebnisSchema.safeParse({
          nachrichtId: ID,
          unzustellbar: true,
          grund,
        }).success,
      ).toBe(true);
    }
    expect(NachrichtPfadSchema.safeParse({ nachrichtId: ID }).success).toBe(true);
  });

  it('weist Freitext, fehlenden Grund, Zusatzfelder und fremde IDs ab (fail closed)', () => {
    const body: [string, unknown][] = [
      ['ohne Grund', {}],
      ['Freitext', { grund: 'Postfach voll' }],
      ['Kleinschreibung', { grund: 'sonstiges' }],
      ['Grund null', { grund: null }],
      ['Zusatzfeld', { grund: 'SONSTIGES', text: 'Details' }],
      ['ID im Body', { grund: 'SONSTIGES', nachrichtId: ID }],
      ['kein Objekt', ['SONSTIGES']],
    ];
    for (const [name, b] of body) {
      expect(NachrichtUnzustellbarBodySchema.safeParse(b).success, name).toBe(false);
    }
    for (const nachrichtId of ['', 'a/b', 'x y', 'a'.repeat(65), '../offen']) {
      expect(NachrichtPfadSchema.safeParse({ nachrichtId }).success, nachrichtId).toBe(false);
      expect(
        NachrichtUnzustellbarEingabeSchema.safeParse({ nachrichtId, grund: 'SONSTIGES' }).success,
      ).toBe(false);
    }
    const ergebnis: [string, unknown][] = [
      ['unzustellbar false', { nachrichtId: ID, unzustellbar: false, grund: 'SONSTIGES' }],
      ['ohne Grund', { nachrichtId: ID, unzustellbar: true }],
      ['mit Text', { nachrichtId: ID, unzustellbar: true, grund: 'SONSTIGES', text: 'x' }],
    ];
    for (const [name, e] of ergebnis) {
      expect(NachrichtUnzustellbarErgebnisSchema.safeParse(e).success, name).toBe(false);
    }
  });
});
