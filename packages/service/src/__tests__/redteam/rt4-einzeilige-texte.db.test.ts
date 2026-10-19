// =============================================================================
// RED TEAM RT4-T-03 — Angreifermodelle D (Eingaben) und F (Snapshots),
// betrifft s4 (strukturierte Nachrichten) und s7 (strengere Zeichenregel).
//
// Die strengere Zeichenregel (`UNZULAESSIGE_ZEICHEN`) gilt nur für drei
// einzeilige Felder (Ankername, Rechtsform, Kontaktfunktion) und Dateinamen.
// Andere einzeilige Texte prüfen nur `freitext` (C0 ohne TAB/LF/CR) oder gar
// nichts und lassen Richtungs-Overrides (U+202E), Isolierungen und – bei
// `freitext` – Zeilenumbrüche CR/LF zu. Zwei Wege tragen solche Texte in
// Ausgaben, die der Vertrag als geprüft bzw. eingefroren ausweist:
//
//   1. Ein Mandantenkontakt (GV/TCB) meldet im Portal ein Ereignis. Der Titel
//      landet unverändert in den Vorlagendaten (`daten.titel`) der Nachricht
//      EREIGNIS_GEMELDET an die Kanzlei; `NachrichtDatenEreignisGemeldetSchema`
//      (Vertrag, `nachrichtTitel`) nimmt RLO und CR/LF an, der Systemakteur
//      erhält sie als vertragsgemäße Vorlagendaten (z. B. für einen Betreff:
//      CR/LF = Header-Injektion, RLO = vertauschte Anzeige).
//   2. Die Kanzlei fordert die Freigabe einer CMS-Beschreibung an; die Namen
//      der Verantwortung (`verantwortung.*.name`, `namen[].name`) werden ohne
//      Zeichenregel in den Snapshot eingefroren. Die gesetzliche Vertretung
//      sieht im Portal einen Text, dessen Anzeige von seinem gehashten Inhalt
//      abweicht, und `snapshotGeprueft: true`.
//
// Der Test ist rot, solange einer der beiden Wege die Zeichen durchlässt, und
// wird grün, sobald die Eingaben mit `UNGUELTIG` abgewiesen werden (oder die
// Ausgaben keine solchen Zeichen mehr enthalten).
// =============================================================================

import { NachrichtDatenEreignisGemeldetSchema, UNZULAESSIGE_ZEICHEN } from '@tcms/contract';
import { DienstFehler } from '@tcms/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { meldeEreignis } from '../../bereiche/feststellungen-ereignisse/portal';
import {
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
} from '../../bereiche/programm-beschreibung/beschreibung';
import { ladePortalFreigaben } from '../../bereiche/programm-beschreibung/freigaben';
import { ladeOffeneNachrichten } from '../../bereiche/programm-beschreibung/nachrichten';
import { richteEin } from '../../bereiche/programm-beschreibung/testprogramm';
import {
  baueWelt,
  btA,
  hbA,
  im,
  imSystem,
  kontakt,
  system,
  type Welt,
} from '../../bereiche/programm-beschreibung/testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const RLO = '\u202e';
const PDF = '\u202c';
const ZEILENUMBRUCH = /[\r\n]/;

/** Erfolg → 'angenommen'; `DienstFehler` → Code; andere Fehler werden weitergeworfen. */
async function ausgang(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'angenommen';
  } catch (e) {
    if (e instanceof DienstFehler) return e.code;
    throw e;
  }
}

describe.skipIf(!AKTIV)('RT4-T-03 Zeichenregel gilt nicht für einzeilige Titel und Namen', () => {
  let w: Welt;

  beforeAll(async () => {
    w = await baueWelt();
    await richteEin(w);
  });

  it('Vertrag: Vorlagendaten EREIGNIS_GEMELDET nehmen RLO und CR/LF im Titel an', () => {
    const daten = {
      ereignisId: 'ckereignis000000000000001',
      nummer: '2026-T-0001',
      titel: `Lager in Polen${RLO}fdp.exe${PDF}\r\nBcc: angreifer@example.invalid`,
      typ: 'Neues Lager- oder Fulfillment-Land',
      gemeldetVonId: '11111111-1111-4111-8111-111111111111',
    };
    const angenommen = NachrichtDatenEreignisGemeldetSchema.safeParse(daten).success;
    // SICHERE ERWARTUNG: Vorlagendaten eines einzeiligen Titels ohne Steuer-/Richtungszeichen.
    expect(angenommen, 'Vertrag lässt RLO und CR/LF in daten.titel zu').toBe(false);
  });

  it('Portal-Meldung: RLO und CR/LF erreichen die Vorlagendaten des Systemakteurs', async () => {
    const titel = `Lager in Polen${RLO}fdp.exe${PDF}\r\nBcc: angreifer@example.invalid`;
    let ereignisId = '';
    const e = await ausgang(
      im(kontakt(w, w.gv, w.mandantA), async (ctx) => {
        const r = await meldeEreignis(ctx, {
          mandantId: w.mandantA,
          typ: 'T-02',
          titel,
          beschreibung: 'Ab November lagern wir Ware in Posen.',
          datum: '2026-10-12',
          anlagen: [],
          zusageAenderungen: true,
          benachrichtigen: { id: w.hb, name: 'Bearbeitung' },
        });
        ereignisId = r.id;
        return r;
      }),
    );
    if (e !== 'angenommen') {
      // Nach einem Fix: die Eingabe wird als ungültig abgewiesen.
      expect(e).toBe('UNGUELTIG');
      return;
    }
    const abruf = await imSystem(system(w), (ctx) => ladeOffeneNachrichten(ctx, { limit: 100 }));
    const n = abruf.nachrichten.find(
      (x) => x.zweck === 'EREIGNIS_GEMELDET' && x.daten.ereignisId === ereignisId,
    );
    expect(n, 'Nachricht an die Kanzlei ausgeliefert').toBeDefined();
    const geliefert = n!.zweck === 'EREIGNIS_GEMELDET' ? n!.daten.titel : '';
    // SICHERE ERWARTUNG: kein Richtungs-Override und kein Zeilenumbruch in daten.titel.
    expect(UNZULAESSIGE_ZEICHEN.test(geliefert), 'RLO in daten.titel ausgeliefert').toBe(false);
    expect(ZEILENUMBRUCH.test(geliefert), 'CR/LF in daten.titel ausgeliefert').toBe(false);
  });

  it('Beschreibungsfreigabe: ein Name mit RLO wird eingefroren und gilt im Portal als geprüft', async () => {
    const v = await im(hbA(w), (ctx) => legeBeschreibungsversionAn(ctx, { mandantId: w.mandantA }));
    const ziel = { mandantId: w.mandantA, versionId: v.versionId };
    await im(hbA(w), (ctx) =>
      speichereBeschreibungsabschnitt(ctx, {
        ...ziel,
        key: 'kultur',
        bloecke: [{ typ: 'text', text: 'Kultur der Steuerehrlichkeit.' }],
      }),
    );
    await im(hbA(w), (ctx) => gibBeschreibungZurReview(ctx, ziel));
    await im(btA(w), (ctx) => schliesseBeschreibungsreviewAb(ctx, ziel));
    // Angezeigt: „StB Dr. Anna Roth“; gespeichert und gehasht: ein anderer Text.
    const name = `StB Dr. Anna ${RLO}htoR${PDF}`;
    const e = await ausgang(
      im(btA(w), (ctx) =>
        fordereBeschreibungsfreigabeAn(ctx, {
          ...ziel,
          empfaengerId: w.gv,
          verantwortung: {
            berufstraeger: { id: w.bt, name },
            bearbeitung: { id: w.hb, name: 'Bearbeitung' },
          },
          namen: [{ id: w.gv, name: `Geschäftsführung${RLO}` }],
        }),
      ),
    );
    if (e !== 'angenommen') {
      expect(e).toBe('UNGUELTIG');
      return;
    }
    const portal = await im(kontakt(w, w.gv, w.mandantA), (ctx) =>
      ladePortalFreigaben(ctx, { mandantId: w.mandantA }),
    );
    const f = portal.freigaben.find((x) => x.art === 'BESCHREIBUNG' && x.status === 'OFFEN');
    expect(f?.version?.snapshotGeprueft, 'Snapshot gilt als geprüft').toBe(true);
    const eingefroren = JSON.stringify(f?.version?.snapshot ?? null);
    // SICHERE ERWARTUNG: kein Richtungs-Override im eingefrorenen, als geprüft angezeigten Inhalt.
    expect(UNZULAESSIGE_ZEICHEN.test(eingefroren), 'RLO im eingefrorenen Snapshot').toBe(false);
  });
});
