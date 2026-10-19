import { describe, expect, it } from 'vitest';
import { MANDANT_ROLLE_LABEL, MANDANT_ROLLEN } from '../index';

// Abgleich mit Prisma-Enum und Vertrag: packages/service/src/__tests__/mandant-rollen.test.ts.
describe('Rollen der Mandantenseite', () => {
  it('führt jede Rolle genau einmal mit eigenem Label', () => {
    expect(new Set(MANDANT_ROLLEN).size).toBe(MANDANT_ROLLEN.length);
    expect(Object.keys(MANDANT_ROLLE_LABEL)).toEqual([...MANDANT_ROLLEN]);
    const labels = Object.values(MANDANT_ROLLE_LABEL);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('benennt die Rollen wie die Oberflächen der kanzleikonsole', () => {
    expect(MANDANT_ROLLE_LABEL).toEqual({
      GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
      TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte',
      MITARBEITER: 'Mitarbeitende',
    });
  });
});
