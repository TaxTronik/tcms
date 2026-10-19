import { describe, expect, it } from 'vitest';
import { DEMO_IDS, DEMO_TENANT_ID } from '@tcms/db/demo';
import { akteurFuer, demoPerson, fuerMandant, type KanzleiAkteur } from './demo';
import { kannBearbeiten, kannGegenzeichnen, kannWuerdigen } from './berechtigung';

// Die Demo bildet den Akteur wie die kanzleikonsole (ADR 0001 §3.2, §5): Bezug
// (`cli`) nur auf bekannte Mandanten, Zuständigkeit aus dem Verzeichnis.
const person = (id: string) => demoPerson(id)!;

describe('Demo-Akteur', () => {
  it('Kanzleiperson: Bezug und Zuständigkeit je Mandant', () => {
    const anna = akteurFuer(person(DEMO_IDS.anna), DEMO_IDS.talwind) as KanzleiAkteur;
    expect(anna).toMatchObject({
      art: 'KANZLEI',
      tenantId: DEMO_TENANT_ID,
      istAdmin: true,
      istBerufstraeger: true,
      mandant: { id: DEMO_IDS.talwind, zustaendigBerufstraeger: true, hauptbearbeitung: false },
    });
    const leon = akteurFuer(person(DEMO_IDS.leon), DEMO_IDS.seestern) as KanzleiAkteur;
    expect(leon.mandant).toMatchObject({ zustaendigBerufstraeger: false, hauptbearbeitung: true });
  });

  it('unbekannter Mandant: kein Bezug, also kein Recht', () => {
    const fremd = 'a1000000-0000-4000-8000-999999999999';
    const anna = akteurFuer(person(DEMO_IDS.anna), fremd) as KanzleiAkteur;
    expect(anna.mandant).toBeNull();
    expect(kannBearbeiten(anna, { id: fremd })).toBe(false);
    expect(kannWuerdigen(anna, { id: fremd })).toBe(false);
  });

  it('Mandantenkontakt: immer der eigene Mandant, nie ein angefragter', () => {
    const jana = akteurFuer(person(DEMO_IDS.jana), DEMO_IDS.seestern);
    expect(jana).toMatchObject({ art: 'MANDANT', mandantId: DEMO_IDS.talwind });
    expect(() => fuerMandant(jana as unknown as KanzleiAkteur, DEMO_IDS.talwind)).toThrow();
  });

  it('Rechte wie im Prototyp: Bearbeitung ja, §-153 nur zuständige BT oder Admin-BT', () => {
    const leon = akteurFuer(person(DEMO_IDS.leon), null);
    const thomas = akteurFuer(person(DEMO_IDS.thomas), null);
    const anna = akteurFuer(person(DEMO_IDS.anna), null);
    const talwind = { id: DEMO_IDS.talwind };
    expect(kannBearbeiten(leon, talwind)).toBe(true);
    expect(kannWuerdigen(leon, talwind)).toBe(false);
    expect(kannBearbeiten(thomas, talwind)).toBe(false);
    expect(kannWuerdigen(thomas, talwind)).toBe(false);
    expect(kannWuerdigen(thomas, { id: DEMO_IDS.seestern })).toBe(true);
    expect(kannWuerdigen(anna, { id: DEMO_IDS.seestern })).toBe(true);
  });

  it('Gegenzeichnung: die durchführende Person nie selbst', () => {
    const anna = akteurFuer(person(DEMO_IDS.anna), null);
    const k = {
      durchfuehrendId: DEMO_IDS.leon,
      vertretungId: DEMO_IDS.thomas,
      gegenzeichnerId: DEMO_IDS.anna,
      gegenzeichnungMandant: false,
      partei: 'KANZLEI' as const,
    };
    const talwind = { id: DEMO_IDS.talwind };
    expect(kannGegenzeichnen(anna, k, talwind, DEMO_IDS.leon).erlaubt).toBe(true);
    expect(kannGegenzeichnen(anna, k, talwind, DEMO_IDS.anna).erlaubt).toBe(false);
  });
});
