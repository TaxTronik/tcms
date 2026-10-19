// Endpunktregister (ADR 0001 §3.3, §7): Aufbau und Sicherheitsinvarianten
// jedes Eintrags. Die Übereinstimmung mit der Routentabelle des Dienstes
// prüft apps/api (register.test.ts).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BausteinSatzSchema, BeschreibungSnapshotSchema } from '../bereiche/programm-beschreibung';
import {
  ENDPUNKT_LISTE,
  ENDPUNKT_METHODEN,
  ENDPUNKTE,
  pruefeAkteure,
  pruefePortal,
  type Endpunkt,
} from '../endpunkte';

const SEGMENT_FEST = /^[a-z0-9-]+$/;
const SEGMENT_PARAM = /^:[a-zA-Z][a-zA-Z0-9]*$/;
const MANDANT = '/v1/mandanten/:mandantId';

const segmente = (e: Endpunkt) => e.pfad.slice(1).split('/');
const parameter = (e: Endpunkt) =>
  segmente(e)
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));

/** Gültiger Beispielwert je Parameter (kanonisches Pfadsegment, ADR 0001 §3.2). */
function beispiel(name: string): string {
  if (name === 'mandantId') return '3c3c3c3c-3333-4333-8333-33333333abcd';
  if (name === 'sha256') return 'a'.repeat(64);
  return 'ckz0a1b2c3d4e5f6g7h8i9j0';
}

/**
 * Bewusste Ausnahmen: Inhalt einer eingefrorenen CMS-Beschreibung (Snapshot,
 * per SHA-256 festgeschrieben) und die daraus gebauten Bausteine. Der Dienst
 * gibt den gespeicherten Inhalt unverändert zurück; ein strenges Schema würde
 * frühere Snapshots nach einer Formatänderung unlesbar machen.
 */
const AUSNAHMEN: ReadonlySet<unknown> = new Set([BeschreibungSnapshotSchema, BausteinSatzSchema]);

/** Alle Objekt-Schemas innerhalb eines Schemas, die unbekannte Felder durchlassen. */
function nichtStrikt(schema: z.ZodType, pfad = 'daten', gesehen = new Set<unknown>()): string[] {
  if (gesehen.has(schema) || AUSNAHMEN.has(schema)) return [];
  gesehen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const kind = (s: unknown, p: string) => nichtStrikt(s as z.ZodType, p, gesehen);
  switch (def['type']) {
    case 'object': {
      const catchall = def['catchall'] as { _zod: { def: { type: string } } } | undefined;
      const eigen = catchall?._zod.def.type === 'never' ? [] : [pfad];
      const shape = def['shape'] as Record<string, unknown>;
      return [...eigen, ...Object.entries(shape).flatMap(([k, v]) => kind(v, `${pfad}.${k}`))];
    }
    case 'array':
      return kind(def['element'], `${pfad}[]`);
    case 'union':
      return (def['options'] as unknown[]).flatMap((o, i) => kind(o, `${pfad}|${i}`));
    case 'intersection':
      return [...kind(def['left'], pfad), ...kind(def['right'], pfad)];
    case 'record':
      return kind(def['valueType'], `${pfad}{}`);
    case 'tuple':
      return (def['items'] as unknown[]).flatMap((o, i) => kind(o, `${pfad}[${i}]`));
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return kind(def['innerType'], pfad);
    case 'pipe':
      return [...kind(def['in'], pfad), ...kind(def['out'], pfad)];
    case 'lazy':
      return kind((def['getter'] as () => unknown)(), pfad);
    default:
      return [];
  }
}

describe('Endpunktregister', () => {
  it('führt jeden Eintrag unter seinem Namen, ohne doppelte Methode und Pfad', () => {
    for (const [schluessel, e] of Object.entries(ENDPUNKTE)) expect(e.name).toBe(schluessel);
    expect(ENDPUNKT_LISTE).toHaveLength(Object.keys(ENDPUNKTE).length);
    const paare = ENDPUNKT_LISTE.map((e) => `${e.methode} ${e.pfad}`);
    expect(new Set(paare).size).toBe(paare.length);
    expect(Object.isFrozen(ENDPUNKTE)).toBe(true);
    for (const e of ENDPUNKT_LISTE) expect(Object.isFrozen(e)).toBe(true);
  });

  it('nutzt nur gültige Muster; :mandantId nur als /v1/mandanten/:mandantId', () => {
    for (const e of ENDPUNKT_LISTE) {
      expect(ENDPUNKT_METHODEN).toContain(e.methode);
      expect(e.pfad.startsWith('/v1/'), e.name).toBe(true);
      const s = segmente(e);
      for (const [i, seg] of s.entries()) {
        expect(SEGMENT_FEST.test(seg) || SEGMENT_PARAM.test(seg), `${e.name}: ${seg}`).toBe(true);
        if (seg === ':mandantId') expect(i === 2 && s[1] === 'mandanten', e.name).toBe(true);
      }
      if (s[1] === 'mandanten') expect(e.pfad.startsWith(MANDANT), e.name).toBe(true);
      expect(new Set(parameter(e)).size, e.name).toBe(parameter(e).length);
      expect(e.mandantenbezogen, e.name).toBe(e.pfad.startsWith(MANDANT));
    }
  });

  it('hat keine zwei Muster derselben Methode, die dieselbe Anfrage treffen', () => {
    const mehrdeutig = (a: string[], b: string[]) =>
      a.length === b.length &&
      a.every((s, i) => s === b[i] || s.startsWith(':') || b[i]!.startsWith(':'));
    for (const [i, a] of ENDPUNKT_LISTE.entries()) {
      for (const b of ENDPUNKT_LISTE.slice(i + 1)) {
        if (a.methode !== b.methode) continue;
        expect(mehrdeutig(segmente(a), segmente(b)), `${a.name} / ${b.name}`).toBe(false);
      }
    }
  });

  it('öffnet für Mandantenkontakte nur /v1/ich und Pfade unter …/portal/', () => {
    for (const e of ENDPUNKT_LISTE) {
      const portalPfad = e.pfad.startsWith(`${MANDANT}/portal/`);
      expect(e.portal, e.name).toBe(portalPfad || e.name === 'ich');
    }
  });

  it('nennt je Endpunkt die zugelassenen Akteursarten; portal ist daraus abgeleitet', () => {
    for (const e of ENDPUNKT_LISTE) {
      expect(Object.isFrozen(e.akteure), e.name).toBe(true);
      expect(new Set(e.akteure).size, e.name).toBe(e.akteure.length);
      for (const a of e.akteure) expect(['KANZLEI', 'MANDANT', 'SYSTEM'], e.name).toContain(a);
      expect(e.portal, e.name).toBe(e.akteure.includes('MANDANT'));
      if (!e.akteur) expect(e.akteure, e.name).toEqual([]);
      else expect(e.akteure.length, e.name).toBeGreaterThan(0);
      if (e.akteure.includes('SYSTEM')) {
        // Systemendpunkte lassen keine Person zu und sind nie an einen Mandanten gebunden.
        expect(e.akteure, e.name).toEqual(['SYSTEM']);
        expect(e.mandantenbezogen, e.name).toBe(false);
      }
    }
    expect(ENDPUNKTE.ich.akteure).toEqual(['KANZLEI', 'MANDANT']);
    expect(ENDPUNKTE.kontextLesen.akteure).toEqual(['KANZLEI']);
  });

  it('Portal-Endpunkte nur für Mandantenkontakte; beide Personenarten nur an /v1/ich (Stufe 5)', () => {
    const portal = ENDPUNKT_LISTE.filter((e) => e.pfad.startsWith(`${MANDANT}/portal/`));
    expect(portal.length).toBe(16);
    for (const e of portal) expect(e.akteure, e.name).toEqual(['MANDANT']);
    const mitKanzleiUndMandant = ENDPUNKT_LISTE.filter(
      (e) => e.akteure.includes('KANZLEI') && e.akteure.includes('MANDANT'),
    );
    expect(mitKanzleiUndMandant.map((e) => e.name)).toEqual(['ich']);
    for (const e of ENDPUNKT_LISTE) {
      if (e.akteure.includes('MANDANT'))
        expect(portal.includes(e) || e.name === 'ich', e.name).toBe(true);
    }
  });

  it('weist Portal-Pfade für Kanzleipersonen und Mandantenkontakte außerhalb des Portals ab (fail closed)', () => {
    const P = `${MANDANT}/portal/x`;
    const fehler: [string, readonly ('KANZLEI' | 'MANDANT' | 'SYSTEM')[], RegExp][] = [
      [P, ['KANZLEI', 'MANDANT'], /Portal-Pfade nur für MANDANT/],
      [P, ['KANZLEI'], /Portal-Pfade nur für MANDANT/],
      [`${MANDANT}/portal`, ['MANDANT'], /MANDANT nur auf Portal-Pfaden/],
      [`${MANDANT}/kontakte`, ['KANZLEI', 'MANDANT'], /MANDANT nur auf Portal-Pfaden/],
      ['/v1/portfolio', ['MANDANT'], /MANDANT nur auf Portal-Pfaden/],
      ['/v1/ich/x', ['MANDANT'], /MANDANT nur auf Portal-Pfaden/],
    ];
    for (const [pfad, akteure, meldung] of fehler) {
      expect(() => pruefePortal('test', pfad, akteure), `${pfad} ${akteure.join('+')}`).toThrow(
        meldung,
      );
    }
    expect(() => pruefePortal('test', P, ['MANDANT'])).not.toThrow();
    expect(() => pruefePortal('test', '/v1/ich', ['KANZLEI', 'MANDANT'])).not.toThrow();
    expect(() => pruefePortal('test', `${MANDANT}/kontakte`, ['KANZLEI'])).not.toThrow();
  });

  it('lässt den Systemakteur genau an die zwei Nachrichten-Endpunkte, an keinen anderen', () => {
    const mitSystem = ENDPUNKT_LISTE.filter((e) => e.akteure.includes('SYSTEM')).map((e) => e.name);
    expect(mitSystem.sort()).toEqual(['nachrichtZugestelltMelden', 'nachrichtenOffenLesen']);
    expect(ENDPUNKTE.nachrichtenOffenLesen.akteure).toEqual(['SYSTEM']);
    expect(ENDPUNKTE.nachrichtZugestelltMelden.akteure).toEqual(['SYSTEM']);
    for (const e of ENDPUNKT_LISTE) {
      if (!mitSystem.includes(e.name)) expect(e.akteure, e.name).not.toContain('SYSTEM');
    }
  });

  it('weist falsch definierte Akteursarten beim Laden ab (fail closed)', () => {
    const M = '/v1/mandanten/:mandantId/x';
    const fehler: [string, boolean, unknown[] | undefined, RegExp][] = [
      ['/v1/x', true, [], /mindestens eine/],
      ['/v1/x', true, ['ADMIN'], /unbekannte Akteursart/],
      ['/v1/x', true, ['KANZLEI', 'KANZLEI'], /doppelt/],
      ['/v1/x', true, ['SYSTEM', 'KANZLEI'], /SYSTEM nur allein/],
      ['/v1/x', true, ['MANDANT', 'SYSTEM'], /SYSTEM nur allein/],
      [M, true, ['SYSTEM'], /nicht auf Mandantenpfaden/],
      ['/v1/x', false, ['KANZLEI'], /ohne Bestätigung/],
    ];
    for (const [pfad, akteur, akteure, meldung] of fehler) {
      expect(() => pruefeAkteure('test', pfad, akteur, akteure), JSON.stringify(akteure)).toThrow(
        meldung,
      );
    }
    expect(pruefeAkteure('test', '/v1/x', true, undefined)).toEqual(['KANZLEI']);
    expect(pruefeAkteure('test', '/v1/x', true, ['SYSTEM'])).toEqual(['SYSTEM']);
    expect(pruefeAkteure('test', '/v1/x', false, undefined)).toEqual([]);
  });

  it('verlangt die Akteursbestätigung überall außer bei health', () => {
    for (const e of ENDPUNKT_LISTE) expect(e.akteur, e.name).toBe(e.name !== 'health');
    expect(ENDPUNKTE.health).toMatchObject({ methode: 'GET', pfad: '/v1/health', akteur: false });
  });

  it('nimmt Query nur beim Lesen und Body nur beim Schreiben an (TS-07)', () => {
    for (const e of ENDPUNKT_LISTE) {
      if (e.methode === 'GET') {
        expect(e.bodySchema, e.name).toBeNull();
        expect(e.erfolgStatus, e.name).toBe(200);
      } else {
        expect(e.querySchema, `${e.name}: schreibende Endpunkte ohne Stichtag`).toBeNull();
      }
      if (e.erfolgStatus === 201) expect(e.methode, e.name).toBe('POST');
    }
  });

  it('prüft Pfadparameter streng: genau die Parameter des Musters, kanonische Werte', () => {
    for (const e of ENDPUNKT_LISTE) {
      const namen = parameter(e);
      const shape = (e.paramsSchema as z.ZodObject).shape;
      expect(Object.keys(shape).sort(), e.name).toEqual([...namen].sort());
      const gut = Object.fromEntries(namen.map((n) => [n, beispiel(n)]));
      expect(e.paramsSchema.safeParse(gut).success, e.name).toBe(true);
      expect(e.paramsSchema.safeParse({ ...gut, fremd: 'x' }).success, e.name).toBe(false);
      for (const n of namen) {
        const ohne = { ...gut };
        delete ohne[n];
        expect(e.paramsSchema.safeParse(ohne).success, `${e.name} ohne ${n}`).toBe(false);
        expect(e.paramsSchema.safeParse({ ...gut, [n]: '' }).success, `${e.name} leer ${n}`).toBe(
          false,
        );
      }
      if (namen.includes('mandantId')) {
        const kein = { ...gut, mandantId: 'kein-uuid' };
        expect(e.paramsSchema.safeParse(kein).success, e.name).toBe(false);
      }
    }
  });

  it('weist unbekannte Query-Parameter ab', () => {
    for (const e of ENDPUNKT_LISTE) {
      if (!e.querySchema) continue;
      expect(e.querySchema.safeParse({}).success, e.name).toBe(true);
      expect(e.querySchema.safeParse({ unbekannt: '1' }).success, e.name).toBe(false);
    }
  });

  it('beschreibt jede Antwort mit strengen Objekten (keine ungeplanten Felder)', () => {
    const befunde = ENDPUNKT_LISTE.flatMap((e) =>
      nichtStrikt(e.antwortSchema).map((p) => `${e.name}: ${p}`),
    );
    expect(befunde).toEqual([]);
  });

  it('bildet health und ich mit eigenen strengen Schemas ab', () => {
    const health = ENDPUNKTE.health.antwortSchema;
    expect(health.safeParse({ version: '1.2.3', datenbank: 'ok' }).success).toBe(true);
    expect(health.safeParse({ version: '1.2.3', datenbank: 'ok', x: 1 }).success).toBe(false);
    expect(health.safeParse({ version: '', datenbank: 'ok' }).success).toBe(false);
    const ich = ENDPUNKTE.ich.antwortSchema;
    const kanzlei = {
      art: 'KANZLEI',
      tenantId: '11111111-1111-4111-8111-111111111111',
      id: '22222222-2222-4222-8222-222222222222',
      name: 'StB Dr. Anna Roth',
      istAdmin: false,
      istBerufstraeger: true,
      mandant: null,
    };
    expect(ich.safeParse(kanzlei).success).toBe(true);
    expect(ich.safeParse({ ...kanzlei, mandantId: kanzlei.id }).success).toBe(false);
    expect(
      ich.safeParse({
        art: 'MANDANT',
        tenantId: kanzlei.tenantId,
        id: kanzlei.id,
        name: 'Jana Weller',
        mandantId: '3c3c3c3c-3333-4333-8333-33333333abcd',
      }).success,
    ).toBe(true);
  });
});
