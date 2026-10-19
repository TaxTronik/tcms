// =============================================================================
// Bausteine der CMS-Beschreibung: lebend streng, eingefroren tolerant.
// Neue Antworten und neue Snapshots tragen `gegenzeichnungMandant` als Feld
// (nicht mehr als Textendung „ (Mandant)") und jedes ID-Feld; ältere
// Snapshots ohne diese Felder bleiben lesbar, weil ihr Inhalt per SHA-256
// festgeschrieben ist und nicht umgeschrieben werden darf.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  BausteinSatzSchema,
  BausteinSatzSnapshotSchema,
  BeschreibungSnapshotSchema,
  type BausteinSatzDaten,
} from './programm-beschreibung';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

function satz(): BausteinSatzDaten {
  return {
    TEILBEREICH: {
      name: 'Umsatzsteuer',
      abgrenzung: 'Onlinehandel',
      einschluesse: [],
      ausschluesse: [],
      zielLaender: ['FR'],
      kanaele: ['Amazon'],
    },
    ZIELE: {
      appetit: 'MITTEL',
      ziele: [
        {
          text: 'Fristgerecht',
          wesentlichkeitEur: 5000,
          risikoappetit: 'MITTEL',
          freigabe: 'FREIGEGEBEN',
          freigegebenAm: '2026-10-01',
          freigegebenVon: 'Jana Weller',
          freigegebenVonId: P1,
        },
      ],
    },
    RISIKOINVENTAR: {
      appetit: 'MITTEL',
      sicht: 'DESIGN',
      risiken: [
        {
          code: 'EC-UST-01',
          titel: 'Steuersatz',
          gt: 'FF',
          brutto: 'HOCH',
          netto: 'MITTEL',
          ueberAppetit: true,
          kontrollen: 1,
        },
      ],
    },
    KONTROLLMATRIX: {
      kontrollen: [
        {
          code: 'K-EC-02',
          titel: 'Abgleich',
          art: 'D',
          frequenz: 'monatlich',
          partei: 'MANDANT',
          schluessel: true,
          design: 'ANGEMESSEN',
          designVon: 'StB Roth',
          designVonId: P2,
          designAm: '2026-09-01',
          risikoCodes: ['EC-UST-01'],
        },
      ],
    },
    VERANTWORTUNG: {
      rollen: [{ rolle: 'Gesetzliche Vertretung', name: 'Jana Weller', personId: P1 }],
      kontrollen: [
        {
          code: 'K-EC-02',
          titel: 'Abgleich',
          partei: 'MANDANT',
          durchfuehrend: 'Murat Aydin',
          vertretung: 'Sabine Kraus',
          gegenzeichnung: 'Sabine Kraus',
          gegenzeichnungMandant: true,
          durchfuehrendId: P3,
          vertretungId: P1,
          gegenzeichnungId: P1,
        },
      ],
    },
    LAENDER: {
      stand: '2026-09-30',
      summeLfd: 8000,
      summeVorjahr: 6000,
      schwelle: '80 %',
      laender: [
        {
          land: 'FR',
          name: 'Frankreich',
          fernverkaeufeLfdEur: 8000,
          lagerSeit: null,
          oss: true,
          lokaleUstNr: false,
          registrierung: 'PRUEFEN',
        },
      ],
    },
    FESTSTELLUNGEN: {
      feststellungen: [
        {
          nummer: 'F-2026-001',
          titel: 'Satz',
          schwere: 'MITTEL',
          status: 'erfasst',
          massnahmenOffen: 0,
        },
      ],
    },
  };
}

const verantwortung = (s: BausteinSatzDaten) => s.VERANTWORTUNG.kontrollen[0]!;

/** Inhalt, wie ihn Snapshots vor dem Feld `gegenzeichnungMandant` speicherten. */
function alterSnapshot() {
  return {
    nummer: '1.0',
    mandant: 'Talwind Outdoor GmbH',
    eingefroren: true as const,
    stand: '2026-06-30',
    erzeugtAm: '2026-06-30T10:00:00.000Z',
    abschnitte: [{ key: 'organisation', bloecke: [{ typ: 'baustein', art: 'VERANTWORTUNG' }] }],
    bausteine: {
      VERANTWORTUNG: {
        rollen: [{ rolle: 'Gesetzliche Vertretung', name: 'Jana Weller' }],
        kontrollen: [
          {
            code: 'K-EC-02',
            titel: 'Abgleich',
            partei: 'MANDANT',
            durchfuehrend: 'Murat Aydin',
            vertretung: 'Sabine Kraus',
            gegenzeichnung: 'Sabine Kraus (Mandant)',
          },
        ],
      },
    },
  };
}

describe('Bausteine lebend (streng)', () => {
  it('nimmt den vollständigen Satz an', () => {
    expect(BausteinSatzSchema.parse(satz())).toEqual(satz());
  });

  it('verlangt gegenzeichnungMandant als Wahrheitswert', () => {
    const s = satz();
    delete (verantwortung(s) as Partial<ReturnType<typeof verantwortung>>).gegenzeichnungMandant;
    expect(BausteinSatzSchema.safeParse(s).success).toBe(false);
    const t = satz();
    (verantwortung(t) as Record<string, unknown>)['gegenzeichnungMandant'] = 'ja';
    expect(BausteinSatzSchema.safeParse(t).success).toBe(false);
  });

  it('verlangt die Personen-IDs (null erlaubt) und weist Zusatzfelder ab', () => {
    for (const feld of ['durchfuehrendId', 'vertretungId', 'gegenzeichnungId'] as const) {
      const s = satz();
      delete (verantwortung(s) as Partial<ReturnType<typeof verantwortung>>)[feld];
      expect(BausteinSatzSchema.safeParse(s).success, feld).toBe(false);
      const n = satz();
      (verantwortung(n) as Record<string, unknown>)[feld] = null;
      expect(BausteinSatzSchema.safeParse(n).success, `${feld} null`).toBe(true);
    }
    const zusatz = satz();
    (verantwortung(zusatz) as Record<string, unknown>)['intern'] = 'x';
    expect(BausteinSatzSchema.safeParse(zusatz).success).toBe(false);
    const oben = { ...satz(), ANDERES: {} };
    expect(BausteinSatzSchema.safeParse(oben).success).toBe(false);
    const ziel = satz();
    delete (ziel.ZIELE.ziele[0] as Partial<BausteinSatzDaten['ZIELE']['ziele'][number]>)
      .freigegebenVonId;
    expect(BausteinSatzSchema.safeParse(ziel).success).toBe(false);
  });
});

describe('Bausteine eingefroren (tolerant)', () => {
  it('liest ältere Snapshots ohne Flag und IDs, die Endung bleibt im Namen', () => {
    const p = BeschreibungSnapshotSchema.safeParse(alterSnapshot());
    expect(p.success).toBe(true);
    const k = p.data!.bausteine!.VERANTWORTUNG!.kontrollen[0]!;
    expect(k.gegenzeichnung).toBe('Sabine Kraus (Mandant)');
    expect(k.gegenzeichnungMandant).toBeUndefined();
    // Das lebende Schema nähme diesen Inhalt nicht an (Flag und IDs fehlen).
    expect(
      BausteinSatzSchema.shape.VERANTWORTUNG.safeParse(alterSnapshot().bausteine.VERANTWORTUNG)
        .success,
    ).toBe(false);
  });

  it('liest neue Snapshots mit Flag und behält es', () => {
    const neu = { ...alterSnapshot(), bausteine: { VERANTWORTUNG: satz().VERANTWORTUNG } };
    const p = BeschreibungSnapshotSchema.parse(neu);
    expect(p.bausteine?.VERANTWORTUNG?.kontrollen[0]).toMatchObject({
      gegenzeichnung: 'Sabine Kraus',
      gegenzeichnungMandant: true,
      gegenzeichnungId: P1,
    });
    // Jeder strenge Satz ist auch ein gültiger eingefrorener Satz.
    expect(BausteinSatzSnapshotSchema.safeParse(satz()).success).toBe(true);
  });
});
