// Pflichtattribute einer Kontrolle (rein): Lücken in fester Reihenfolge, leer
// genau dann, wenn alle Pflichtangaben vorliegen.
import { PFLICHTATTRIBUT_LUECKEN } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { pflichtattributLuecken } from './tcms-kontext';

const voll = {
  ziel: 'Abgleich',
  schritte: [{ titel: 'a' }],
  nachweis: 'Liste',
  durchfuehrendId: 'd',
  vertretungId: 'v',
  gegenzeichnerId: 'g',
  gegenzeichnungMandant: false,
  schluessel: true,
};

describe('pflichtattributLuecken', () => {
  it('vollständig: keine Lücke', () => {
    expect(pflichtattributLuecken(voll)).toEqual([]);
  });

  it('nennt jede Lücke einzeln', () => {
    const [ziel, schritte, nachweis, durchf, vertretung, gegen] = PFLICHTATTRIBUT_LUECKEN;
    expect(pflichtattributLuecken({ ...voll, ziel: '' })).toEqual([ziel]);
    expect(pflichtattributLuecken({ ...voll, schritte: [] })).toEqual([schritte]);
    expect(pflichtattributLuecken({ ...voll, nachweis: '' })).toEqual([nachweis]);
    expect(pflichtattributLuecken({ ...voll, durchfuehrendId: null })).toEqual([durchf]);
    expect(pflichtattributLuecken({ ...voll, vertretungId: null })).toEqual([vertretung]);
    expect(pflichtattributLuecken({ ...voll, vertretungId: 'd' })).toEqual([vertretung]);
    expect(pflichtattributLuecken({ ...voll, gegenzeichnerId: null })).toEqual([gegen]);
    expect(pflichtattributLuecken({ ...voll, gegenzeichnerId: 'd' })).toEqual([gegen]);
  });

  it('Gegenzeichnung nur bei Schlüsselkontrollen Pflicht; beim Mandanten genügt die Vertretung', () => {
    expect(pflichtattributLuecken({ ...voll, schluessel: false, gegenzeichnerId: null })).toEqual(
      [],
    );
    expect(
      pflichtattributLuecken({ ...voll, gegenzeichnerId: null, gegenzeichnungMandant: true }),
    ).toEqual([]);
  });

  it('alle Lücken in der Reihenfolge des Vertrags', () => {
    expect(
      pflichtattributLuecken({
        ziel: '',
        schritte: [],
        nachweis: '',
        durchfuehrendId: null,
        vertretungId: null,
        gegenzeichnerId: null,
        gegenzeichnungMandant: false,
        schluessel: true,
      }),
    ).toEqual([...PFLICHTATTRIBUT_LUECKEN]);
  });
});
