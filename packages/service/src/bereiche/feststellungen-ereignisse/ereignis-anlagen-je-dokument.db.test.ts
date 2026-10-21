// =============================================================================
// Lesepfad „Ereignis-Anlagen je Dokument“ (DB_TESTS=1, tcms-s11): Ereignisse
// eines Mandanten, deren Meldung eine Dokument-ID der kanzleikonsole als Anlage
// nennt – Grundlage für das Freigeben „ungeklärter Anlagen“ in der
// kanzleikonsole (nur bei leerer Liste). Nur Kanzleipersonen mit Leserecht;
// Dokument-IDs anderer Mandanten und Tenants ergeben dieselbe leere Liste wie
// unbekannte (kein Existenz-Orakel); Vergleich ohne Groß-/Kleinschreibung
// (ein verpasster Treffer gäbe ein gebundenes Dokument frei); keine Inhalte
// vertraulicher Feststellungen (RT-01).
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { EreignisAnlagenJeDokumentSchema, type Akteur, type AnlageVerweis } from '@tcms/contract';
import { schreibeAudit } from '@tcms/db';
import {
  beantrageEreignisVerwerfen,
  bestaetigeEreignisVerwerfen,
  legeEreignisAn,
} from './ereignisse';
import { ladeEreignisAnlagenJeDokument } from './ereignisse-lesen';
import { ladeFeststellung } from './feststellungen-lesen';
import { meldeEreignis } from './portal';
import {
  akteure,
  baueWelt,
  eindeutig,
  fehlerVon,
  im,
  inTenant,
  kanzlei,
  type Welt,
} from './testwelt';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Meldung betrifft einen anderen Mandanten, irrtümlich gemeldet.';

describe.skipIf(!AKTIV)('Ereignis-Anlagen je Dokument (Service, PostgreSQL)', () => {
  let w: Welt;
  let A: ReturnType<typeof akteure>;

  beforeAll(async () => {
    w = await baueWelt();
    A = akteure(w);
  });

  const anlage = (dokumentId: string, dateiname = 'Mietvertrag Lager.pdf'): AnlageVerweis => ({
    dokumentId,
    dateiname,
    mime: 'application/pdf',
    groesse: 2048,
    sha256: randomBytes(32).toString('hex'),
  });

  /** Portal-Meldung mit genau diesen Anlagen (GV des Mandanten). */
  async function melde(anlagen: AnlageVerweis[], wer: Akteur = A.gv, mandantId = w.mandant) {
    return im(wer, (ctx) =>
      meldeEreignis(ctx, {
        mandantId,
        typ: 'T-02',
        titel: 'Neues Lager in Polen',
        beschreibung: 'Ab November lagern wir Ware in Posen.',
        datum: '2026-10-12',
        anlagen,
        zusageAenderungen: true,
      } as never),
    );
  }

  const lies = (a: Akteur, eingabe: Record<string, unknown>) =>
    im(a, (ctx) => ladeEreignisAnlagenJeDokument(ctx, eingabe as never));

  it('liefert jede Anlage dieses Mandanten zur Dokument-ID, auch an verworfenen Ereignissen; Leserecht genügt', async () => {
    const dok = randomUUID();
    // Gespeichert in Großbuchstaben (der Vertrag der Meldung normalisiert nicht).
    const a1 = anlage(dok.toUpperCase());
    const andere = anlage(randomUUID());
    const e1 = await melde([andere, a1]);
    const a2 = anlage(dok, 'Mietvertrag Lager (2).pdf');
    const e2 = await melde([a2]);
    await im(A.hb, (ctx) =>
      beantrageEreignisVerwerfen(ctx, {
        mandantId: w.mandant,
        ereignisId: e2.id,
        begruendung: BEGRUENDUNG,
      }),
    );
    await im(A.zbt, (ctx) =>
      bestaetigeEreignisVerwerfen(ctx, { mandantId: w.mandant, ereignisId: e2.id }),
    );
    const erwartet = {
      dokumentId: dok,
      anlagen: [
        { ereignisId: e1.id, nummer: e1.nummer, status: 'NEU', sha256: a1.sha256, entfernt: false },
        {
          ereignisId: e2.id,
          nummer: e2.nummer,
          status: 'VERWORFEN',
          sha256: a2.sha256,
          entfernt: false,
        },
      ].sort((x, y) => x.nummer.localeCompare(y.nummer)),
    };
    for (const a of [A.leser, A.admin, A.hb]) {
      for (const abfrage of [dok, dok.toUpperCase()]) {
        const r = await lies(a, { mandantId: w.mandant.toUpperCase(), dokumentId: abfrage });
        expect(EreignisAnlagenJeDokumentSchema.parse(r)).toEqual(r);
        expect(r, `${a.id} ${abfrage}`).toEqual(erwartet);
      }
    }
    // Die andere Anlage derselben Meldung gehört nicht dazu.
    const r = await lies(A.leser, { mandantId: w.mandant, dokumentId: andere.dokumentId });
    expect(r.anlagen.map((x) => x.sha256)).toEqual([andere.sha256]);
  });

  it('Dokument-ID eines anderen Mandanten oder Tenants: dieselbe leere Liste wie eine unbekannte', async () => {
    const dokFremd = randomUUID();
    await melde([anlage(dokFremd)], A.gvFremd, w.fremd);
    // Meldungs-Audit eines Ereignisses im fremden Tenant (B) mit eigener Dokument-ID.
    const dokB = randomUUID();
    await inTenant(
      w,
      async (tx) => {
        const e = await legeEreignisAn(tx, {
          programmId: w.programmB,
          typ: 'T-02',
          titel: 'Neues Lager in Polen',
          beschreibung: 'Ab November lagern wir Ware in Posen.',
          quelle: 'PORTAL',
          gemeldetVon: w.p.gv,
          ereignisDatum: new Date('2026-10-12T00:00:00Z'),
          zeitpunkt: new Date('2026-10-12T09:00:00Z'),
        });
        await schreibeAudit(tx, {
          actorId: w.p.gv,
          actorName: 'Kontakt',
          aktion: 'tcms.ereignis.gemeldet',
          objektTyp: 'Ereignis',
          objektId: e.id,
          programmId: w.programmB,
          detail: { nummer: e.nummer, anlagen: [anlage(dokB)] },
        });
      },
      w.tenantB,
    );
    // Gegenprobe: im eigenen Mandanten (F) bzw. Tenant (B) ist der Verweis da.
    const imFremden = await lies(A.fremdBezug, { mandantId: w.fremd, dokumentId: dokFremd });
    expect(imFremden.anlagen).toHaveLength(1);
    const imTenantB = await lies(kanzlei(w.tenantB, w.p.zbt, w.mandantB), {
      mandantId: w.mandantB,
      dokumentId: dokB,
    });
    expect(imTenantB.anlagen).toHaveLength(1);

    const ergebnisse = [];
    for (const dokumentId of [dokFremd, dokB, randomUUID()]) {
      const r = await lies(A.zbt, { mandantId: w.mandant, dokumentId });
      expect(r).toEqual({ dokumentId, anlagen: [] });
      ergebnisse.push(Object.keys(r));
    }
    expect(new Set(ergebnisse.map((k) => k.join()))).toEqual(new Set(['dokumentId,anlagen']));
  });

  it('nur Kanzleipersonen mit Bezug: Kontakte, ohne/fremder Bezug, fremder Tenant, unbekannter Mandant → NICHT_GEFUNDEN', async () => {
    const dok = randomUUID();
    await melde([anlage(dok)]);
    const unbekannt = randomUUID();
    const faelle: [Akteur, string][] = [
      [A.gv, w.mandant],
      [A.tcb, w.mandant],
      [A.ma, w.mandant],
      [A.ohneBezug, w.mandant],
      [A.fremdBezug, w.mandant],
      [A.fremdTenant, w.mandant],
      [A.leerTenant, w.mandant],
      [kanzlei(w.tenant, w.p.admin, unbekannt, { admin: true, bt: true }), unbekannt],
    ];
    for (const [a, mandantId] of faelle) {
      const e = await fehlerVon(lies(a, { mandantId, dokumentId: dok }));
      expect(e.code, `${a.art} ${a.id} ${mandantId}`).toBe('NICHT_GEFUNDEN');
      expect(e.message).toBe('NICHT_GEFUNDEN');
      expect(e.grund).toBeUndefined();
    }
  });

  it('Mandant ohne Tax-CMS: leere Liste', async () => {
    const ohne = randomUUID();
    await inTenant(w, (tx) =>
      tx.mandant.create({ data: { id: ohne, name: 'Ohne Programm', rechtsform: 'KapG' } }),
    );
    const a = kanzlei(w.tenant, w.p.leser, ohne, { bt: true });
    expect(await lies(a, { mandantId: ohne, dokumentId: randomUUID() })).toMatchObject({
      anlagen: [],
    });
  });

  it('Eingabe streng: Dokument-ID Pflicht und UUID (keine Ablagepfade), keine Zusatzfelder', async () => {
    const dok = randomUUID();
    for (const eingabe of [
      { mandantId: w.mandant },
      { mandantId: w.mandant, dokumentId: 'ab/0123' },
      { mandantId: w.mandant, dokumentId: `kk:${dok}` },
      { mandantId: w.mandant, dokumentId: `${dok} ` },
      { mandantId: w.mandant, dokumentId: dok, ereignisId: 'x' },
      { mandantId: 'kein-mandant', dokumentId: dok },
    ]) {
      const e = await fehlerVon(lies(A.zbt, eingabe));
      expect(e.code, JSON.stringify(eingabe)).toBe('UNGUELTIG');
    }
  });

  it('robust gegen fremde Formen im Meldungs-Audit; nur die Meldung zählt, eine Anlage nur mit gültigem SHA-256', async () => {
    const dok = randomUUID();
    const sha = randomBytes(32).toString('hex');
    const ids = await inTenant(w, async (tx) => {
      const neu = () =>
        legeEreignisAn(tx, {
          programmId: w.programm,
          typ: 'T-02',
          titel: 'Altbestand',
          beschreibung: 'Meldung aus einer früheren Fassung.',
          quelle: 'PORTAL',
          gemeldetVon: w.p.gv,
          ereignisDatum: new Date('2026-10-01T00:00:00Z'),
          zeitpunkt: new Date('2026-10-01T09:00:00Z'),
        });
      const [skalar, gemischt, andereAktion] = [await neu(), await neu(), await neu()];
      const meldung = (objektId: string, detail: Record<string, unknown>, aktion: string) =>
        schreibeAudit(tx, {
          actorId: w.p.gv,
          actorName: 'Kontakt',
          aktion,
          objektTyp: 'Ereignis',
          objektId,
          programmId: w.programm,
          detail,
        });
      await meldung(skalar.id, { anlagen: 'kaputt' }, 'tcms.ereignis.gemeldet');
      await meldung(
        gemischt.id,
        {
          anlagen: [
            42,
            null,
            ['x'],
            { dokumentId: dok.toUpperCase(), sha256: 'nicht-hex' },
            { dokumentId: dok.toUpperCase(), sha256: sha, dateiname: 'a.pdf' },
          ],
        },
        'tcms.ereignis.gemeldet',
      );
      // Nennt die Dokument-ID, ist aber keine Meldung: zählt nicht (wie Detail und Download).
      await meldung(
        andereAktion.id,
        { anlagen: [{ dokumentId: dok, sha256: sha }] },
        'tcms.ereignis.in_triage',
      );
      return { gemischt: gemischt.id };
    });
    const r = await lies(A.leser, { mandantId: w.mandant, dokumentId: dok });
    expect(r.anlagen.map((x) => [x.ereignisId, x.sha256])).toEqual([[ids.gemischt, sha]]);
  });

  it('RT-01: vertrauliche Feststellung aus dem Ereignis – Ausgabe ohne Feststellung, für Beteiligte und Unbeteiligte gleich', async () => {
    const dok = randomUUID();
    const a = anlage(dok, 'Prüfungsanordnung Geheim.pdf');
    const e = await melde([a]);
    const titel = `Geheime Feststellung ${eindeutig('T')}`;
    const f = await inTenant(w, (tx) =>
      tx.feststellung.create({
        data: {
          programmId: w.programm,
          nummer: eindeutig('F'),
          titel,
          sachverhalt: 'Vertraulicher Sachverhalt zur Außenprüfung.',
          quelle: 'EREIGNIS',
          quelleText: 'Ereignis',
          ereignisId: e.id,
          klasse: 'STEUERLICHER_FEHLER',
          schwere: 'HOCH',
          auswirkung: 'JA',
          vertraulich: true,
          erfasstVon: w.p.zbt,
          erfasstAm: new Date('2026-10-13T09:00:00Z'),
        },
      }),
    );
    // Vorbedingung: der Leser ist nicht beteiligt (maskiert), die zuständige BT schon.
    const sicht = await im(A.leser, (ctx) =>
      ladeFeststellung(ctx, { mandantId: w.mandant, feststellungId: f.id }),
    );
    expect(sicht.maskiert).toBe(true);
    const unbeteiligt = await lies(A.leser, { mandantId: w.mandant, dokumentId: dok });
    const beteiligt = await lies(A.zbt, { mandantId: w.mandant, dokumentId: dok });
    expect(unbeteiligt).toEqual(beteiligt);
    expect(unbeteiligt.anlagen).toEqual([
      { ereignisId: e.id, nummer: e.nummer, status: 'NEU', sha256: a.sha256, entfernt: false },
    ]);
    const json = JSON.stringify(unbeteiligt);
    for (const geheim of [f.id, f.nummer, titel, 'Vertraulicher', a.dateiname, 'Lager']) {
      expect(json, geheim).not.toContain(geheim);
    }
  });
});
