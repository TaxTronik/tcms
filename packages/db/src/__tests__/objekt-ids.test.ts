// Objekt-IDs (Befund 18): Prisma erzeugt sie im Client. cuid Version 1 trägt
// Zeitstempel, einen prozessweiten Zähler über alle Tenants und einen
// Fingerabdruck des Hosts – ablesbar wäre, wie viele Zeilen andere Kanzleien
// zwischen zwei eigenen Objekten angelegt haben (dieselbe Informationsklasse
// wie `seq`, RT-03). cuid2 ist ein Hash ohne ablesbare Bestandteile. Statisch,
// ohne Datenbank; die Vertragsmuster prüft packages/contract (objekt-id.test.ts).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCHEMA = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

describe('Objekt-IDs im Prisma-Schema', () => {
  it('jede erzeugte ID ist cuid2, nie cuid Version 1', () => {
    const defaults = [...SCHEMA.matchAll(/@default\((cuid|uuid|nanoid|ulid)\(([^)]*)\)\)/g)];
    expect(defaults.length).toBeGreaterThanOrEqual(22);
    for (const [ausdruck, art, argument] of defaults) {
      expect({ ausdruck, art, argument }).toEqual({ ausdruck, art: 'cuid', argument: '2' });
    }
  });

  it('Gegenprobe: das Muster erkennt cuid() ohne Version', () => {
    const alt = 'id String @id @default(cuid())';
    const [treffer] = [...alt.matchAll(/@default\((cuid|uuid|nanoid|ulid)\(([^)]*)\)\)/g)];
    expect(treffer?.[2]).toBe('');
  });
});
