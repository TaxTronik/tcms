// Gemeinsame Zuständigkeitsregel (rein): Partei und Personenkreise, Gegenzeichnung beim
// Mandanten nur bei Kontrollen des Mandanten, Kanzleipersonen fail closed (Befunde 9/10/117).
import { describe, expect, it } from 'vitest';
import { pruefeZustaendigkeit, type ZustaendigkeitsPools } from './zustaendigkeit';
import type { VorbelegteZustaendigkeit } from './kontroll-vorlage';

const BT = '10000000-0000-4000-8000-000000000001';
const HB = '10000000-0000-4000-8000-000000000002';
const UNBEKANNT = '10000000-0000-4000-8000-000000000003';
const GV = '20000000-0000-4000-8000-000000000001';
const TCB = '20000000-0000-4000-8000-000000000002';
const FRUEHER = '20000000-0000-4000-8000-000000000003';

const pools = (kanzlei: string[] | null = [BT, HB]): ZustaendigkeitsPools => ({
  kanzlei: kanzlei ? new Set(kanzlei) : null,
  mandantAktiv: new Set([GV, TCB]),
  kontakte: new Set([GV, TCB, FRUEHER]),
});

const kanzleiKontrolle: VorbelegteZustaendigkeit = {
  partei: 'KANZLEI',
  durchfuehrendId: HB,
  vertretungId: null,
  gegenzeichnerId: BT,
  gegenzeichnungMandant: false,
};
const mandantKontrolle: VorbelegteZustaendigkeit = {
  partei: 'MANDANT',
  durchfuehrendId: TCB,
  vertretungId: GV,
  gegenzeichnerId: GV,
  gegenzeichnungMandant: true,
};
const felder = (z: VorbelegteZustaendigkeit, schluessel = true, p = pools()) =>
  pruefeZustaendigkeit(z, schluessel, p).map((f) => f.feld);

describe('pruefeZustaendigkeit', () => {
  it('gültige Belegungen beider Seiten', () => {
    expect(felder(kanzleiKontrolle)).toEqual([]);
    expect(felder(mandantKontrolle)).toEqual([]);
    expect(
      felder({ ...mandantKontrolle, gegenzeichnungMandant: false, gegenzeichnerId: BT }),
    ).toEqual([]);
  });

  it('Gegenzeichnung beim Mandanten nur bei Kontrollen des Mandanten', () => {
    expect(
      felder({ ...kanzleiKontrolle, gegenzeichnerId: GV, gegenzeichnungMandant: true }),
    ).toEqual(['gegenzeichnungMandant']);
  });

  it('Gegenzeichnung beim Mandanten braucht die Vertretung', () => {
    expect(felder({ ...mandantKontrolle, vertretungId: null })).toEqual(['vertretungId']);
  });

  it('Kanzlei-Gegenzeichnung: Pflicht bei Schlüsselkontrollen, nie die durchführende Person', () => {
    expect(felder({ ...kanzleiKontrolle, gegenzeichnerId: null })).toEqual(['gegenzeichnerId']);
    expect(felder({ ...kanzleiKontrolle, gegenzeichnerId: null }, false)).toEqual([]);
    expect(felder({ ...kanzleiKontrolle, gegenzeichnerId: HB.toUpperCase() })).toEqual([
      'gegenzeichnerId',
    ]);
  });

  it('fail closed: ein Kontakt (auch mit nur früherer Rolle) ist nie Kanzleiperson', () => {
    for (const id of [GV, FRUEHER]) {
      // Auch wenn die kanzleikonsole ihn in der Liste der Kanzlei führt.
      const p = pools([BT, HB, id]);
      expect(felder({ ...kanzleiKontrolle, durchfuehrendId: id }, true, p), id).toEqual([
        'durchfuehrendId',
      ]);
      expect(
        felder({ ...mandantKontrolle, gegenzeichnungMandant: false, gegenzeichnerId: id }, true, p),
        id,
      ).toEqual(['gegenzeichnerId']);
      // Ohne Liste der Kanzlei (nur Form bekannt) ebenso.
      expect(felder({ ...kanzleiKontrolle, vertretungId: id }, true, pools(null)), id).toEqual([
        'vertretungId',
      ]);
    }
  });

  it('unbekannte bzw. nicht mehr aktive Personen werden gemeldet, nicht geleert', () => {
    expect(felder({ ...kanzleiKontrolle, vertretungId: UNBEKANNT })).toEqual(['vertretungId']);
    expect(felder({ ...kanzleiKontrolle, gegenzeichnerId: UNBEKANNT })).toEqual([
      'gegenzeichnerId',
    ]);
    expect(felder({ ...mandantKontrolle, durchfuehrendId: FRUEHER })).toEqual(['durchfuehrendId']);
    // Ohne Liste der Kanzlei zählt jede ID, die kein Kontakt ist.
    expect(felder({ ...kanzleiKontrolle, vertretungId: UNBEKANNT }, true, pools(null))).toEqual([]);
  });

  it('Pflicht und Vier-Augen der durchführenden Person und Vertretung', () => {
    expect(felder({ ...kanzleiKontrolle, durchfuehrendId: null })).toEqual(['durchfuehrendId']);
    expect(felder({ ...kanzleiKontrolle, vertretungId: HB })).toEqual(['vertretungId']);
    expect(felder({ ...kanzleiKontrolle, durchfuehrendId: TCB })).toEqual(['durchfuehrendId']);
  });
});
