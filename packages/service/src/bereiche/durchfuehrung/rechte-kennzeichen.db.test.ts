// =============================================================================
// Rechte-Kennzeichen der Durchführung = tatsächliches Ergebnis der
// Schreiboperationen (DB_TESTS=1, DATABASE_URL = tcms_app). Für jede Lage
// (Status, Antrag, Beteiligte) und jeden Akteur liest der Test die Flags
// `{ erlaubt, grund, verweigerung }` (Kanzlei: ladeDurchfuehrung, Portal:
// ladeKontrollaufgabe) und führt jede zugehörige Operation in einer
// Transaktion aus, die danach zurückgerollt wird (der Zustand bleibt für den
// nächsten Fall). Erwartet:
//   erlaubt                → Erfolg
//   verweigerung = Grund   → 403 NICHT_BERECHTIGT mit genau diesem Grund
//   verweigert, ohne Grund → 409 KONFLIKT (der Zustand steht entgegen)
//   nicht lesbar (404)     → jede Operation 404
// Gleiche Quelle: Lader und Operationen rechnen mit `durchfuehrungsRechte`.
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DienstFehler,
  DurchfuehrungRechteSchema,
  type Akteur,
  type VerweigerungGrund,
} from '@tcms/contract';
import type { DienstKontext } from '../../kontext';
import { ladeDurchfuehrung, ladeKontrollaufgabe } from './lesen';
import {
  beantrageEntfallen,
  beginneDurchfuehrung,
  bestaetigeDurchfuehrung,
  gegenzeichneDurchfuehrung,
  gibEntfallenFrei,
  haengeNachweisAn,
  legeNachtragAn,
  lehneEntfallenAb,
  reicheDurchfuehrungEin,
  speichereDurchfuehrung,
  weiseDurchfuehrungZurueck,
} from './operationen';
import type { HandlungsRechte } from './rechte';
import { akteure, baueFall, verweis, type Fall } from './testfall';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';
const SPEICHERN = {
  schritte: [
    { erledigt: true, kommentar: 'ok' },
    { erledigt: true, kommentar: '' },
  ],
  werte: [
    { key: 'saldoShop', wert: 100, bemerkung: '', erklaert: false },
    { key: 'saldoFibu', wert: 100, bemerkung: '', erklaert: false },
  ],
  ergebnis: 'OHNE_BEFUND' as const,
  ergebnisKommentar: null,
};

type Ziel = { mandantId: string; durchfuehrungId: string };
type Operation = (z: Ziel) => (ctx: DienstKontext) => Promise<unknown>;
type Ergebnis = 'ERFOLG' | { code: string; grund?: VerweigerungGrund };
type Flag = { erlaubt: boolean; grund: string | null; verweigerung: VerweigerungGrund | null };

/**
 * Operationen je Handlung. `bearbeiten` steht für Speichern und Nachweis
 * anhängen (Einreichen prüft zusätzlich Beginn und Mängel und ist eigens
 * getestet).
 */
const OPERATIONEN: Record<keyof HandlungsRechte, Operation[]> = {
  beginnen: [(z) => (ctx) => beginneDurchfuehrung(ctx, z)],
  bearbeiten: [
    (z) => (ctx) => speichereDurchfuehrung(ctx, { ...z, ...SPEICHERN }),
    (z) => (ctx) => haengeNachweisAn(ctx, { ...z, verweis: verweis() }),
  ],
  gegenzeichnen: [(z) => (ctx) => gegenzeichneDurchfuehrung(ctx, z)],
  mandantBestaetigen: [(z) => (ctx) => bestaetigeDurchfuehrung(ctx, z)],
  zurueckweisen: [
    (z) => (ctx) => weiseDurchfuehrungZurueck(ctx, { ...z, begruendung: BEGRUENDUNG }),
  ],
  entfallenBeantragen: [
    (z) => (ctx) => beantrageEntfallen(ctx, { ...z, begruendung: BEGRUENDUNG }),
  ],
  entfallenFreigeben: [(z) => (ctx) => gibEntfallenFrei(ctx, z)],
  entfallenAblehnen: [(z) => (ctx) => lehneEntfallenAb(ctx, { ...z, begruendung: BEGRUENDUNG })],
  nachtrag: [(z) => (ctx) => legeNachtragAn(ctx, { ...z, begruendung: BEGRUENDUNG })],
};

class Zurueckrollen extends Error {}

function erwartet(flag: Flag): Ergebnis {
  if (flag.erlaubt) return 'ERFOLG';
  return flag.verweigerung
    ? { code: 'NICHT_BERECHTIGT', grund: flag.verweigerung }
    : { code: 'KONFLIKT' };
}

describe.skipIf(!AKTIV)('Durchführung: Rechte-Kennzeichen = Ergebnis der Operation', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;
  const lagen: Record<string, string> = {};
  const ziel = (durchfuehrungId: string): Ziel => ({ mandantId: f.mandant, durchfuehrungId });

  /** Führt die Operation aus und rollt sie zurück. */
  async function probe(akteur: Akteur, op: (ctx: DienstKontext) => Promise<unknown>) {
    try {
      await f.dienst(akteur, async (ctx) => {
        await op(ctx);
        throw new Zurueckrollen();
      });
    } catch (e) {
      if (e instanceof Zurueckrollen) return 'ERFOLG' as const;
      if (e instanceof DienstFehler)
        return e.grund ? { code: e.code, grund: e.grund } : { code: e.code };
      throw e;
    }
    throw new Error('Operation ohne Ergebnis');
  }

  async function kennzeichen(akteur: Akteur, did: string): Promise<HandlungsFlags | null> {
    try {
      const d = await f.dienst(akteur, (ctx) =>
        akteur.art === 'KANZLEI'
          ? ladeDurchfuehrung(ctx, ziel(did))
          : ladeKontrollaufgabe(ctx, ziel(did)),
      );
      expect(DurchfuehrungRechteSchema.parse(d.rechte)).toEqual(d.rechte);
      return d.rechte as HandlungsFlags;
    } catch (e) {
      if (e instanceof DienstFehler && e.code === 'NICHT_GEFUNDEN') return null;
      throw e;
    }
  }
  type HandlungsFlags = Record<keyof HandlungsRechte, Flag>;

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
    const bearbeitet = async (k: 'k1' | 'k2', wer: Akteur) => {
      const did = await f.durchfuehrung(k);
      await f.dienst(wer, (ctx) => speichereDurchfuehrung(ctx, { ...ziel(did), ...SPEICHERN }));
      await f.dienst(wer, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }));
      return did;
    };
    const eingereicht = async (k: 'k1' | 'k2', wer: Akteur) => {
      const did = await bearbeitet(k, wer);
      await f.dienst(wer, (ctx) => reicheDurchfuehrungEin(ctx, ziel(did)));
      return did;
    };
    lagen['K1 geplant'] = await f.durchfuehrung('k1');
    lagen['K1 in Durchführung'] = await bearbeitet('k1', a.bearbeiter);
    lagen['K1 eingereicht'] = await eingereicht('k1', a.bearbeiter);
    lagen['K1 abgeschlossen'] = await eingereicht('k1', a.bearbeiter);
    await f.dienst(a.pruefer, (ctx) =>
      gegenzeichneDurchfuehrung(ctx, ziel(lagen['K1 abgeschlossen']!)),
    );
    lagen['K1 Entfallen beantragt'] = await f.durchfuehrung('k1');
    await f.dienst(a.bt, (ctx) =>
      beantrageEntfallen(ctx, {
        ...ziel(lagen['K1 Entfallen beantragt']!),
        begruendung: BEGRUENDUNG,
      }),
    );
    lagen['K2 geplant'] = await f.durchfuehrung('k2');
    lagen['K2 eingereicht'] = await eingereicht('k2', a.ma);
    lagen['K2 bestätigt'] = await eingereicht('k2', a.ma);
    await f.dienst(a.gv, (ctx) => bestaetigeDurchfuehrung(ctx, ziel(lagen['K2 bestätigt']!)));
  }, 120_000);

  it('für jede Lage, jeden Akteur und jede Handlung', async () => {
    const wer: Record<string, Akteur> = {
      'BT (zuständig)': a.bt,
      'BT (Admin)': a.bt2,
      Bearbeitung: a.bearbeiter,
      Vertretung: a.vertretung,
      Gegenzeichnung: a.pruefer,
      Kollege: a.kollege,
      GV: a.gv,
      'MA (durchführend K2)': a.ma,
      'MA (ohne Zuweisung)': a.ma3,
    };
    const abweichungen: string[] = [];
    const beobachtet = { ERFOLG: 0, KONFLIKT: 0, NICHT_GEFUNDEN: 0 } as Record<string, number>;
    const gruende = new Set<string>();
    for (const [lage, did] of Object.entries(lagen)) {
      for (const [name, akteur] of Object.entries(wer)) {
        const flags = await kennzeichen(akteur, did);
        for (const [handlung, ops] of Object.entries(OPERATIONEN) as [
          keyof HandlungsRechte,
          Operation[],
        ][]) {
          const soll: Ergebnis = flags ? erwartet(flags[handlung]) : { code: 'NICHT_GEFUNDEN' };
          for (const op of ops) {
            const ist = await probe(akteur, op(ziel(did)));
            if (JSON.stringify(ist) !== JSON.stringify(soll)) {
              abweichungen.push(
                `${lage} · ${name} · ${handlung}: Kennzeichen ${JSON.stringify(soll)}, Operation ${JSON.stringify(ist)}`,
              );
            }
            if (ist === 'ERFOLG') beobachtet['ERFOLG']! += 1;
            else if (ist.grund) gruende.add(ist.grund);
            else beobachtet[ist.code] = (beobachtet[ist.code] ?? 0) + 1;
          }
        }
      }
    }
    expect(abweichungen).toEqual([]);
    // Der Test deckt alle Ergebnisarten und die Gründe der Durchführung ab.
    expect(beobachtet['ERFOLG']).toBeGreaterThan(10);
    expect(beobachtet['KONFLIKT']).toBeGreaterThan(10);
    expect(beobachtet['NICHT_GEFUNDEN']).toBeGreaterThan(10);
    expect([...gruende].sort()).toEqual(
      [
        'BEARBEITEN',
        'DURCHFUEHREN',
        'GEGENZEICHNEN',
        'PARTEI',
        'PORTAL_ZUGEORDNET',
        'VIER_AUGEN',
        'WUERDIGEN',
      ].sort(),
    );
  }, 300_000);
});
