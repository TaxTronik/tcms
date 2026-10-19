import { describe, expect, it } from 'vitest';
import { kannBearbeiten, kannDurchfuehren, kannGegenzeichnen, kannWuerdigen } from './rechte';
import type { Nutzer } from './sitzung';

const n = (p: Partial<Nutzer>): Nutzer => ({
  id: 'x',
  name: 'X',
  kuerzel: 'X',
  email: 'x@x',
  art: 'KANZLEI',
  kanzleiRolle: 'BEARBEITUNG',
  istAdmin: false,
  mandantId: null,
  mandantRolle: null,
  funktion: null,
  ...p,
});
const m = { id: 'm1', berufstraegerId: 'bt', bearbeitungId: 'hb' };
const k = {
  durchfuehrendId: 'hb',
  vertretungId: 'v',
  gegenzeichnerId: 'bt',
  gegenzeichnungMandant: false,
  partei: 'KANZLEI' as const,
};

describe('Rechte', () => {
  it('Bearbeiten nur für Zuständige und Admins', () => {
    expect(kannBearbeiten(n({ id: 'hb' }), m)).toBe(true);
    expect(kannBearbeiten(n({ id: 'z' }), m)).toBe(false);
    expect(kannBearbeiten(n({ id: 'z', istAdmin: true }), m)).toBe(true);
    expect(kannBearbeiten(n({ id: 'hb', art: 'MANDANT' }), m)).toBe(false);
  });
  it('§-153 nur Berufsträger', () => {
    expect(kannWuerdigen(n({ id: 'bt', kanzleiRolle: 'BERUFSTRAEGER' }), m)).toBe(true);
    expect(kannWuerdigen(n({ id: 'hb' }), m)).toBe(false);
  });
  it('Durchführen nur zugewiesen und auf der richtigen Seite', () => {
    expect(kannDurchfuehren(n({ id: 'hb' }), k, 'm1')).toBe(true);
    expect(kannDurchfuehren(n({ id: 'bt' }), k, 'm1')).toBe(false);
    expect(
      kannDurchfuehren(
        n({ id: 'hb', art: 'MANDANT', mandantId: 'm1' }),
        { ...k, partei: 'MANDANT' },
        'm1',
      ),
    ).toBe(true);
  });
  it('die durchführende Person kann nie gegenzeichnen', () => {
    const r = kannGegenzeichnen(n({ id: 'bt', kanzleiRolle: 'BERUFSTRAEGER' }), k, m, 'bt');
    expect(r.erlaubt).toBe(false);
    expect(r.grund).toContain('andere Person');
    expect(
      kannGegenzeichnen(n({ id: 'bt', kanzleiRolle: 'BERUFSTRAEGER' }), k, m, 'hb').erlaubt,
    ).toBe(true);
  });
  it('Mandanten-Gegenzeichnung nur durch zweite Person des Mandanten', () => {
    const km = { ...k, gegenzeichnungMandant: true, partei: 'MANDANT' as const };
    expect(
      kannGegenzeichnen(n({ id: 'sk', art: 'MANDANT', mandantId: 'm1' }), km, m, 'ma').erlaubt,
    ).toBe(true);
    expect(
      kannGegenzeichnen(n({ id: 'bt', kanzleiRolle: 'BERUFSTRAEGER' }), km, m, 'ma').erlaubt,
    ).toBe(false);
  });
  it('Kanzlei schließt Mandanten-Gegenzeichnung erst nach der Bestätigung ab', () => {
    const km = { ...k, gegenzeichnungMandant: true, partei: 'MANDANT' as const };
    const bt = n({ id: 'bt', kanzleiRolle: 'BERUFSTRAEGER' });
    expect(kannGegenzeichnen(bt, km, m, 'ma', true).erlaubt).toBe(true);
    expect(
      kannGegenzeichnen(n({ id: 'sk', art: 'MANDANT', mandantId: 'm1' }), k, m, 'ma').erlaubt,
    ).toBe(false);
  });
});
