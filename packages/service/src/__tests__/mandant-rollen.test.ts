// =============================================================================
// Rollen der Mandantenseite (ADR 0001 §5): eine Werteliste in vier Schichten –
// Prisma-Enum `MandantRolle` (Datenbank), `MANDANT_ROLLEN` mit
// `MANDANT_ROLLE_LABEL` (@tcms/domain, Oberflächen der kanzleikonsole), das
// Enum im Vertrag (`KontaktRollenBodySchema`) und der Typ der Rechte
// (@tcms/service). Kommt im Enum eine Rolle hinzu, scheitert dieser Test, bis
// Domain (mit Label) und Vertrag nachgezogen sind.
// =============================================================================

import { readFileSync } from 'node:fs';
import { KontaktRollenBodySchema } from '@tcms/contract';
import type { MandantRolle as DbRolle } from '@tcms/db';
import {
  MANDANT_ROLLE_LABEL,
  MANDANT_ROLLEN,
  type MandantRolle as DomainRolle,
} from '@tcms/domain';
import { describe, expect, it } from 'vitest';
import type { MandantRolle as ServiceRolle } from '../rechte';

type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Typen: Datenbank, Domain und Rechte beschreiben dieselbe Menge (Übersetzung
// scheitert sonst).
const typDbDomain: Gleich<DbRolle, DomainRolle> = true;
const typServiceDomain: Gleich<ServiceRolle, DomainRolle> = true;

/**
 * Werte eines Enums aus dem Prisma-Schema (Quelle der Migrationen). Der
 * erzeugte Client führt zur Laufzeit keine Enum-Liste (`dmmf` ohne Enums); den
 * erzeugten Typ prüft `typDbDomain`.
 */
function enumWerte(name: string): string[] {
  const schema = readFileSync(new URL('../../../db/prisma/schema.prisma', import.meta.url), 'utf8');
  const block = new RegExp(`^enum ${name} \\{\\n([^}]*)\\}`, 'm').exec(schema);
  if (!block) throw new Error(`Enum ${name} fehlt im Prisma-Schema`);
  return block[1]!
    .split('\n')
    .map((z) => z.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((z) => z.split(/\s+/)[0]!);
}

describe('Rollen der Mandantenseite', () => {
  it('Domain führt genau die Werte des Prisma-Enums, in derselben Reihenfolge', () => {
    expect(typDbDomain && typServiceDomain).toBe(true);
    expect([...MANDANT_ROLLEN]).toEqual(enumWerte('MandantRolle'));
  });

  it('jede Rolle hat genau ein nicht leeres, eindeutiges Label', () => {
    expect(Object.keys(MANDANT_ROLLE_LABEL)).toEqual([...MANDANT_ROLLEN]);
    const labels = MANDANT_ROLLEN.map((r) => MANDANT_ROLLE_LABEL[r]);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('der Vertrag nimmt genau diese Rollen an', () => {
    const optionen = KontaktRollenBodySchema.shape.rollen.element.options;
    expect([...optionen]).toEqual([...MANDANT_ROLLEN]);
  });
});
