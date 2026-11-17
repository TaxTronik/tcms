// Objekt-IDs des Tax-CMS (Befund 18): Neue Objekte tragen cuid2 (Prisma
// `@default(cuid(2))`, 24 Zeichen, Kleinbuchstabe zuerst), Objekte aus der Zeit
// davor cuid Version 1 (25 Zeichen, beginnt mit `c`). Jeder Pfadparameter und
// jedes Schema einer Objekt-ID nimmt beide Formen an; UUIDs der kanzleikonsole
// (Mandant, Person, Dokument) bleiben davon unberührt.

import { describe, expect, it } from 'vitest';
import { DurchfuehrungIdSchema, NachweisIdSchema } from '../bereiche/durchfuehrung';
import { ObjektIdSchema } from '../bereiche/feststellungen-ereignisse';
import { ENDPUNKT_LISTE } from '../endpunkte';

/** cuid Version 1 (Bestand), z. B. aus einem Lauf vom 19.10.2026. */
const CUID1 = ['cmvep7iwo003rp17dhz7nhhpg', 'cmvep7ipd001pp17d35jc5c01'];
/** cuid2 aus Prisma 7.9.1 (`cuid(2)`), erzeugt beim Seed. */
const CUID2 = [
  'a4mtgbml9fjlf95cl219f7hu',
  'zxefojxdeem73hnlfeijpvur',
  'j59pn2costecibf6a0hgxakk',
  'yytaq6miblylj917u2e1pszi',
];
const UUID = '0b6f4a52-3c1e-4d0a-9f62-7f1d2c3b4a59';

const parameter = (pfad: string) =>
  pfad
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));

/** Alle Belegungen der übrigen Parameter mit UUID bzw. cuid v1. */
function belegungen(namen: string[]): Record<string, string>[] {
  return namen.reduce<Record<string, string>[]>(
    (alle, n) => alle.flatMap((b) => [UUID, CUID1[0]!].map((w) => ({ ...b, [n]: w }))),
    [{}],
  );
}

describe('Objekt-IDs: cuid v1 und cuid2', () => {
  it('die Objekt-ID-Schemas nehmen beide Formen an und weisen Fremdes ab', () => {
    for (const schema of [DurchfuehrungIdSchema, NachweisIdSchema, ObjektIdSchema]) {
      for (const id of [...CUID1, ...CUID2]) expect(schema.safeParse(id).success, id).toBe(true);
      for (const id of ['', 'A4MTGBML9FJLF95CL219F7HU', 'a4mtgbml9fjlf95c/l219f7h', UUID]) {
        expect(schema.safeParse(id).success, id).toBe(false);
      }
    }
  });

  it('jeder Pfadparameter, der eine cuid v1 annimmt, nimmt auch jede cuid2 an', () => {
    const geprueft = new Set<string>();
    for (const e of ENDPUNKT_LISTE) {
      const namen = parameter(e.pfad).filter((n) => n !== 'mandantId');
      for (const p of namen) {
        const basis = { ...(e.mandantenbezogen ? { mandantId: UUID } : {}) };
        const passend = belegungen(namen.filter((n) => n !== p)).find(
          (b) => e.paramsSchema.safeParse({ ...basis, ...b, [p]: CUID1[0] }).success,
        );
        if (!passend) continue; // Parameter ist keine Objekt-ID (z. B. UUID der kanzleikonsole)
        geprueft.add(`${e.name}.${p}`);
        for (const id of [...CUID1, ...CUID2]) {
          expect(
            e.paramsSchema.safeParse({ ...basis, ...passend, [p]: id }).success,
            `${e.name}.${p} = ${id}`,
          ).toBe(true);
        }
      }
    }
    // Der Prüfer läuft wirklich über die Objekt-IDs des Registers.
    const art = new Set([...geprueft].map((g) => g.split('.')[1]));
    expect(geprueft.size).toBeGreaterThan(20);
    for (const p of [
      'risikoId',
      'kontrolleId',
      'durchfuehrungId',
      'feststellungId',
      'ereignisId',
    ]) {
      expect(art, p).toContain(p);
    }
  });
});
