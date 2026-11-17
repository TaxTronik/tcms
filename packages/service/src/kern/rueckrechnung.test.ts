import { describe, expect, it } from 'vitest';
import {
  ereignisZumStand,
  feststellungsStatusZumStand,
  folgeZumStand,
  massnahmenZumStand,
  p153OffenAm,
  type SpaeterEintrag,
} from './rueckrechnung';

const ende = new Date('2026-10-15T23:59:59.999Z');
const vorher = new Date('2026-10-10T09:00:00Z');
const danach = new Date('2026-10-20T09:00:00Z');
const e = (aktion: string, detail: Record<string, unknown> = {}): SpaeterEintrag => ({
  aktion,
  objektId: 'x',
  detail,
});

describe('Rückrechnung zum Stichtag (rein)', () => {
  it('Maßnahmen: später angelegte fehlen, später erledigte sind offen, Frist der offenen', () => {
    const m = (createdAt: Date, frist: string, erledigtAm: Date | null = null) => ({
      createdAt,
      frist: new Date(frist),
      status: erledigtAm ? ('ERLEDIGT' as const) : ('OFFEN' as const),
      erledigtAm,
    });
    const r = massnahmenZumStand(
      [
        m(vorher, '2026-11-01T00:00:00Z', vorher),
        m(vorher, '2026-12-01T00:00:00Z', danach),
        m(danach, '2026-10-20T00:00:00Z'),
      ],
      ende,
    );
    expect(r.bestand).toHaveLength(2);
    expect(r.offen).toHaveLength(1);
    expect(r.aeltesteFrist).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('Feststellung: Ausgangsstatus des ersten späteren Wechsels, sonst später geschlossen → Nachkontrolle', () => {
    const f = { status: 'VERWORFEN' as const, geschlossenAm: null };
    expect(
      feststellungsStatusZumStand(
        f,
        [e('tcms.feststellung.verwerfen_bestaetigt', { von: 'IN_WUERDIGUNG' })],
        ende,
      ),
    ).toBe('IN_WUERDIGUNG');
    expect(feststellungsStatusZumStand(f, [], ende)).toBe('VERWORFEN');
    expect(
      feststellungsStatusZumStand({ status: 'GESCHLOSSEN', geschlossenAm: danach }, [], ende),
    ).toBe('NACHKONTROLLE');
    expect(p153OffenAm({ auswirkung: 'UNKLAR' }, false, 'IN_WUERDIGUNG')).toBe(true);
    expect(p153OffenAm({ auswirkung: 'UNKLAR' }, false, 'VERWORFEN')).toBe(false);
    expect(p153OffenAm({ auswirkung: 'NEIN' }, false, 'ERFASST')).toBe(false);
  });

  it('Ereignis: Triage und Abschluss nach dem Stichtag; Verwerfen-Antrag zum Stand', () => {
    const basis = {
      status: 'VERWORFEN' as const,
      triagiertVon: 'p',
      triagiertAm: vorher,
      verwerfenBegruendung: 'heute',
    };
    expect(ereignisZumStand({ ...basis, triagiertAm: danach }, [], ende)).toEqual({
      status: 'NEU',
      triagiertVon: null,
      triagiertAm: null,
      verwerfenBegruendung: 'heute',
    });
    const bestaetigt = ereignisZumStand(basis, [e('tcms.ereignis.verwerfen_bestaetigt')], ende);
    expect(bestaetigt).toMatchObject({ status: 'IN_TRIAGE', verwerfenBegruendung: 'heute' });
    expect(
      ereignisZumStand(
        basis,
        [e('tcms.ereignis.verwerfen_beantragt'), e('tcms.ereignis.verwerfen_bestaetigt')],
        ende,
      ).verwerfenBegruendung,
    ).toBeNull();
    const abgelehnt = ereignisZumStand(
      { ...basis, status: 'IN_TRIAGE', verwerfenBegruendung: null },
      [e('tcms.ereignis.verwerfen_abgelehnt', { begruendung: 'damals' })],
      ende,
    );
    expect(abgelehnt).toMatchObject({ status: 'IN_TRIAGE', verwerfenBegruendung: 'damals' });
    // Ohne spätere Einträge: der gespeicherte Zustand.
    expect(ereignisZumStand(basis, [], ende)).toEqual(basis);
  });

  it('Folge: später hinzugefügt fehlt; später verworfen, erledigt oder angelegt zurückgerechnet', () => {
    const f = (
      status: 'VORGESCHLAGEN' | 'ANGELEGT' | 'ERLEDIGT' | 'VERWORFEN',
      erledigtAm: Date | null = null,
    ) => ({
      status,
      erledigtAm,
      objektId: 'obj',
    });
    expect(
      folgeZumStand(f('VORGESCHLAGEN'), [e('tcms.ereignis.folge_hinzugefuegt')], ende),
    ).toBeNull();
    expect(
      folgeZumStand(
        f('VERWORFEN'),
        [e('tcms.ereignis.folge_verworfen', { vorher: 'ANGELEGT' })],
        ende,
      ),
    ).toEqual({ status: 'ANGELEGT', objektId: 'obj' });
    expect(folgeZumStand(f('ERLEDIGT', danach), [], ende)).toEqual({
      status: 'ANGELEGT',
      objektId: 'obj',
    });
    expect(folgeZumStand(f('ERLEDIGT', danach), [e('tcms.ereignis.folge_angelegt')], ende)).toEqual(
      { status: 'VORGESCHLAGEN', objektId: null },
    );
    expect(folgeZumStand(f('ERLEDIGT', vorher), [], ende)).toEqual({
      status: 'ERLEDIGT',
      objektId: 'obj',
    });
  });
});
