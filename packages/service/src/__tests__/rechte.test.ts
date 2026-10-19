import { describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import {
  aktiveRollen,
  istGesetzlicherVertreter,
  kannBearbeiten,
  kannDurchfuehren,
  kannGegenzeichnen,
  kannLesen,
  kannPortalLesen,
  kannVertraulichLesen,
  kannVerwalten,
  kannWuerdigen,
  zweitePerson,
  type KontaktRolle,
  type KontrollZustaendigkeit,
} from '../rechte';

// ---------------------------------------------------------------- Fixtures --

const T = '11111111-1111-4111-8111-111111111111';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const M2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

function kanzlei(
  pid: string,
  p: { adm?: boolean; bt?: boolean; cli?: { id: string; bt?: boolean; hb?: boolean } | null },
): Akteur {
  return {
    art: 'KANZLEI',
    tenantId: T,
    id: pid,
    name: `Person ${pid.slice(-2)}`,
    istAdmin: p.adm ?? false,
    istBerufstraeger: p.bt ?? false,
    mandant: p.cli
      ? {
          id: p.cli.id,
          zustaendigBerufstraeger: p.cli.bt ?? false,
          hauptbearbeitung: p.cli.hb ?? false,
        }
      : null,
  };
}
const kontakt = (pid: string, mandantId = M1): Akteur => ({
  art: 'MANDANT',
  tenantId: T,
  id: pid,
  name: `Kontakt ${pid.slice(-2)}`,
  mandantId,
});
const rolle = (
  kontaktId: string,
  r: KontaktRolle['rolle'],
  aktiv = true,
  mandantId = M1,
): KontaktRolle => ({ kontaktId, rolle: r, aktiv, mandantId });

// Personen
const ADMIN_BT = kanzlei(id(1), { adm: true, bt: true, cli: { id: M1, bt: true } });
const ADMIN_OHNE_CLI = kanzlei(id(2), { adm: true, bt: true, cli: null });
const ADMIN_FREMD = kanzlei(id(3), { adm: true, bt: true, cli: { id: M2, bt: true } });
const BT_ZUST = kanzlei(id(4), { bt: true, cli: { id: M1, bt: true } });
const BT_OHNE_ZUST = kanzlei(id(5), { bt: true, cli: { id: M1 } });
const HB = kanzlei(id(6), { cli: { id: M1, hb: true } });
const KANZLEI_OHNE = kanzlei(id(7), { cli: { id: M1 } });
const KANZLEI_OHNE_CLI = kanzlei(id(8), { cli: null });
const ADMIN_OHNE_BT = kanzlei(id(9), { adm: true, cli: { id: M1 } });
// Widersprüchliche Claims: zuständig als BT, aber keine Berufsträger-Rolle.
const CLI_BT_OHNE_ROLLE = kanzlei(id(10), { cli: { id: M1, bt: true } });
const GV = kontakt(id(20));
const TCB = kontakt(id(21));
const MA = kontakt(id(22));
const OHNE_ROLLE = kontakt(id(23));
const DEAKTIVIERT = kontakt(id(24));
const FREMDER_KONTAKT = kontakt(id(25), M2);
const FREMDE_ROLLENZEILE = kontakt(id(26));

const ROLLEN: KontaktRolle[] = [
  rolle(GV.id, 'GESETZLICHER_VERTRETER'),
  rolle(TCB.id, 'TAX_COMPLIANCE_BEAUFTRAGTER'),
  rolle(MA.id, 'MITARBEITER'),
  rolle(DEAKTIVIERT.id, 'GESETZLICHER_VERTRETER', false),
  rolle(FREMDER_KONTAKT.id, 'GESETZLICHER_VERTRETER', true, M2),
  // Rolle eines anderen Kontakts: darf FREMDE_ROLLENZEILE nicht berechtigen.
  rolle(id(99), 'GESETZLICHER_VERTRETER'),
];

// ----------------------------------------------------------------- Matrix --

type Zeile = [
  string,
  Akteur,
  {
    lesen: boolean;
    portal: boolean;
    bearbeiten: boolean;
    wuerdigen: boolean;
    gv: boolean;
    verwalten: boolean;
  },
];

// Erwartung je Person für Mandant M1.
const MATRIX: Zeile[] = [
  [
    'Admin-BT mit cli',
    ADMIN_BT,
    { lesen: true, portal: false, bearbeiten: true, wuerdigen: true, gv: false, verwalten: true },
  ],
  [
    'Admin ohne cli',
    ADMIN_OHNE_CLI,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: true,
    },
  ],
  [
    'Admin, cli fremder Mandant',
    ADMIN_FREMD,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: true,
    },
  ],
  [
    'BT zuständig',
    BT_ZUST,
    { lesen: true, portal: false, bearbeiten: true, wuerdigen: true, gv: false, verwalten: false },
  ],
  [
    'BT ohne Zuständigkeit',
    BT_OHNE_ZUST,
    {
      lesen: true,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Hauptbearbeitung',
    HB,
    { lesen: true, portal: false, bearbeiten: true, wuerdigen: false, gv: false, verwalten: false },
  ],
  [
    'Kanzlei ohne Zuständigkeit',
    KANZLEI_OHNE,
    {
      lesen: true,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Admin ohne BT-Rolle (TS-04)',
    ADMIN_OHNE_BT,
    { lesen: true, portal: false, bearbeiten: true, wuerdigen: false, gv: false, verwalten: true },
  ],
  [
    'cli.bt ohne BT-Rolle (TS-04)',
    CLI_BT_OHNE_ROLLE,
    { lesen: true, portal: false, bearbeiten: true, wuerdigen: false, gv: false, verwalten: false },
  ],
  [
    'Kanzlei ohne cli',
    KANZLEI_OHNE_CLI,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'GV',
    GV,
    { lesen: true, portal: true, bearbeiten: false, wuerdigen: false, gv: true, verwalten: false },
  ],
  [
    'TCB',
    TCB,
    { lesen: true, portal: true, bearbeiten: false, wuerdigen: false, gv: false, verwalten: false },
  ],
  [
    'Mitarbeiter',
    MA,
    {
      lesen: true,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Kontakt ohne Rolle',
    OHNE_ROLLE,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Kontakt mit deaktivierter Rolle',
    DEAKTIVIERT,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Kontakt eines fremden Mandanten',
    FREMDER_KONTAKT,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
  [
    'Kontakt, Rolle gehört anderem Kontakt',
    FREMDE_ROLLENZEILE,
    {
      lesen: false,
      portal: false,
      bearbeiten: false,
      wuerdigen: false,
      gv: false,
      verwalten: false,
    },
  ],
];

describe('Rechtematrix (ADR 0001 §5) für Mandant M1', () => {
  it.each(MATRIX)('%s', (_name, a, e) => {
    expect({
      lesen: kannLesen(a, M1, ROLLEN),
      portal: kannPortalLesen(a, M1, ROLLEN),
      bearbeiten: kannBearbeiten(a, M1),
      wuerdigen: kannWuerdigen(a, M1),
      gv: istGesetzlicherVertreter(a, M1, ROLLEN),
      verwalten: kannVerwalten(a),
    }).toEqual(e);
  });

  it('der eigene Mandant eines Kontakts berechtigt nicht für M1, wenn die Rolle bei M2 liegt', () => {
    expect(kannLesen(FREMDER_KONTAKT, M2, ROLLEN)).toBe(true);
    expect(kannLesen(FREMDER_KONTAKT, M1, ROLLEN)).toBe(false);
  });

  it('kein Recht auf einem anderen Mandanten als dem in cli bestätigten', () => {
    // Nur ADMIN_FREMD (cli = M2) und FREMDER_KONTAKT (Rolle bei M2) haben einen Bezug zu M2.
    for (const [name, a] of MATRIX) {
      if (a === ADMIN_FREMD || a === FREMDER_KONTAKT) continue;
      expect(kannLesen(a, M2, ROLLEN), name).toBe(false);
      expect(kannBearbeiten(a, M2), name).toBe(false);
      expect(kannWuerdigen(a, M2), name).toBe(false);
    }
    expect(kannBearbeiten(ADMIN_FREMD, M2)).toBe(true);
  });

  it('aktive Rollen ignorieren Zeilen anderer Kontakte, Mandanten und deaktivierte Rollen', () => {
    expect([...aktiveRollen(GV, M1, ROLLEN)]).toEqual(['GESETZLICHER_VERTRETER']);
    expect(aktiveRollen(DEAKTIVIERT, M1, ROLLEN).size).toBe(0);
    expect(aktiveRollen(FREMDE_ROLLENZEILE, M1, ROLLEN).size).toBe(0);
    expect(aktiveRollen(GV, M2, ROLLEN).size).toBe(0);
    expect(aktiveRollen(ADMIN_BT, M1, ROLLEN).size).toBe(0);
  });

  it('Mandanten-ID wird ohne Rücksicht auf Groß-/Kleinschreibung verglichen', () => {
    expect(kannBearbeiten(ADMIN_BT, M1.toUpperCase())).toBe(true);
    expect(kannLesen(GV, M1.toUpperCase(), ROLLEN)).toBe(true);
  });
});

// ------------------------------------------------------------ Vertraulich --

describe('Vertrauliche Feststellungen', () => {
  it('nur Admin, zuständige:r BT, Hauptbearbeitung und Beteiligte – jeweils mit cli', () => {
    const beteiligte = [KANZLEI_OHNE.id];
    expect(kannVertraulichLesen(ADMIN_BT, M1, beteiligte)).toBe(true);
    expect(kannVertraulichLesen(BT_ZUST, M1, beteiligte)).toBe(true);
    expect(kannVertraulichLesen(HB, M1, beteiligte)).toBe(true);
    expect(kannVertraulichLesen(KANZLEI_OHNE, M1, beteiligte)).toBe(true);
    expect(kannVertraulichLesen(BT_OHNE_ZUST, M1, beteiligte)).toBe(false);
    expect(kannVertraulichLesen(ADMIN_OHNE_CLI, M1, beteiligte)).toBe(false);
    expect(kannVertraulichLesen(ADMIN_FREMD, M1, beteiligte)).toBe(false);
    expect(kannVertraulichLesen(GV, M1, [GV.id])).toBe(false);
  });
});

// ---------------------------------------------------- Durchführen, Vier-Augen --

const K_KANZLEI: KontrollZustaendigkeit = {
  durchfuehrendId: HB.id,
  vertretungId: KANZLEI_OHNE.id,
  gegenzeichnerId: BT_ZUST.id,
  gegenzeichnungMandant: false,
  partei: 'KANZLEI',
};
const K_MANDANT: KontrollZustaendigkeit = {
  durchfuehrendId: TCB.id,
  vertretungId: MA.id,
  gegenzeichnerId: null,
  gegenzeichnungMandant: true,
  partei: 'MANDANT',
};

describe('Durchführen', () => {
  it('nur zugewiesene Person oder Vertretung auf der richtigen Seite, mit Bezug', () => {
    expect(kannDurchfuehren(HB, K_KANZLEI, M1)).toBe(true);
    expect(kannDurchfuehren(KANZLEI_OHNE, K_KANZLEI, M1)).toBe(true);
    expect(kannDurchfuehren(ADMIN_BT, K_KANZLEI, M1)).toBe(false);
    // zugewiesen, aber cli fehlt bzw. anderer Mandant
    expect(kannDurchfuehren({ ...HB, mandant: null } as Akteur, K_KANZLEI, M1)).toBe(false);
    expect(kannDurchfuehren(HB, K_KANZLEI, M2)).toBe(false);
    // Kanzleiperson mit gleicher ID auf Mandantenseite: falsche Seite
    expect(kannDurchfuehren(HB, { ...K_KANZLEI, partei: 'MANDANT' }, M1)).toBe(false);
  });

  it('Mandantenseite: zugewiesen und aktive Rolle beim eigenen Mandanten', () => {
    expect(kannDurchfuehren(TCB, K_MANDANT, M1, ROLLEN)).toBe(true);
    expect(kannDurchfuehren(MA, K_MANDANT, M1, ROLLEN)).toBe(true);
    expect(kannDurchfuehren(GV, K_MANDANT, M1, ROLLEN)).toBe(false);
    // Rolle deaktiviert bzw. keine Rolle
    const ohne = ROLLEN.map((r) => (r.kontaktId === TCB.id ? { ...r, aktiv: false } : r));
    expect(kannDurchfuehren(TCB, K_MANDANT, M1, ohne)).toBe(false);
    expect(kannDurchfuehren(TCB, K_MANDANT, M1, [])).toBe(false);
    // falscher Mandant
    expect(kannDurchfuehren(TCB, K_MANDANT, M2, ROLLEN)).toBe(false);
  });
});

describe('Gegenzeichnen (Vier-Augen)', () => {
  it('die durchführende Person kann nie gegenzeichnen – auch nicht in anderer Schreibweise', () => {
    const r = kannGegenzeichnen(BT_ZUST, K_KANZLEI, M1, BT_ZUST.id);
    expect(r).toEqual({ erlaubt: false, grund: expect.stringContaining('andere Person') });
    expect(kannGegenzeichnen(BT_ZUST, K_KANZLEI, M1, BT_ZUST.id.toUpperCase()).erlaubt).toBe(false);
    expect(kannGegenzeichnen(BT_ZUST, K_KANZLEI, M1, HB.id).erlaubt).toBe(true);
  });

  it('Kanzlei: zugewiesene Gegenzeichnung oder zuständige BT mit Bezug', () => {
    expect(kannGegenzeichnen(ADMIN_BT, K_KANZLEI, M1, HB.id).erlaubt).toBe(true);
    expect(kannGegenzeichnen(BT_OHNE_ZUST, K_KANZLEI, M1, HB.id).erlaubt).toBe(false);
    expect(kannGegenzeichnen(KANZLEI_OHNE, K_KANZLEI, M1, HB.id).erlaubt).toBe(false);
    expect(kannGegenzeichnen(ADMIN_OHNE_CLI, K_KANZLEI, M1, HB.id).erlaubt).toBe(false);
    expect(kannGegenzeichnen(ADMIN_FREMD, K_KANZLEI, M1, HB.id).erlaubt).toBe(false);
    // zugewiesene Gegenzeichnung, aber cli auf anderen Mandanten
    const fremd = kanzlei(BT_ZUST.id, { bt: true, cli: { id: M2, bt: true } });
    expect(kannGegenzeichnen(fremd, K_KANZLEI, M1, HB.id).erlaubt).toBe(false);
  });

  it('Mandanten-Gegenzeichnung: zweite Person des Mandanten mit aktiver Rolle, danach Kanzlei', () => {
    expect(kannGegenzeichnen(MA, K_MANDANT, M1, TCB.id, false, ROLLEN).erlaubt).toBe(true);
    expect(kannGegenzeichnen(TCB, K_MANDANT, M1, TCB.id, false, ROLLEN).erlaubt).toBe(false);
    expect(kannGegenzeichnen(OHNE_ROLLE, K_MANDANT, M1, TCB.id, false, ROLLEN).erlaubt).toBe(false);
    expect(kannGegenzeichnen(DEAKTIVIERT, K_MANDANT, M1, TCB.id, false, ROLLEN).erlaubt).toBe(
      false,
    );
    expect(kannGegenzeichnen(FREMDER_KONTAKT, K_MANDANT, M1, TCB.id, false, ROLLEN).erlaubt).toBe(
      false,
    );
    // Kanzlei erst nach der Bestätigung
    expect(kannGegenzeichnen(BT_ZUST, K_MANDANT, M1, TCB.id, false).erlaubt).toBe(false);
    expect(kannGegenzeichnen(BT_ZUST, K_MANDANT, M1, TCB.id, true).erlaubt).toBe(true);
    // Mandantenkontakt bei Kanzlei-Gegenzeichnung
    expect(kannGegenzeichnen(MA, K_KANZLEI, M1, HB.id, false, ROLLEN).erlaubt).toBe(false);
  });

  it('zweite Person: verschieden von der beantragenden, beantragt muss gesetzt sein', () => {
    expect(zweitePerson(ADMIN_BT, HB.id)).toBe(true);
    expect(zweitePerson(ADMIN_BT, ADMIN_BT.id)).toBe(false);
    expect(zweitePerson(ADMIN_BT, ADMIN_BT.id.toUpperCase())).toBe(false);
    expect(zweitePerson(ADMIN_BT, null)).toBe(false);
    expect(zweitePerson(ADMIN_BT, '')).toBe(false);
  });
});
