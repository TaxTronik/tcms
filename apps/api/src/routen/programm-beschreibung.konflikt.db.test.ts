// Konfliktgrund (`fehler.konflikt`, tcms-s10) über die App (DB_TESTS=1): Code
// anfordern und Freigeben melden jedes 409 mit einem Grund aus dem
// Registereintrag (Vertragsprüfung der Test-App mit `fehlerSchemaFuer`).
// Fremde, unbekannte und nicht sichtbare Freigaben bleiben 404 ohne Grund.
import { randomUUID } from 'node:crypto';
import { ENDPUNKTE, type KonfliktGrund } from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { json } from '../__tests__/hilfen';
import {
  akteure,
  legeMandantenAn,
  mandantPfad,
  neueApiWelt,
  ok,
  richteEinUeberHttp,
  senden,
} from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);
const MITARBEITER = randomUUID();

describe.skipIf(!AKTIV)(
  '409 mit Konfliktgrund: Code anfordern und Freigeben (App + PostgreSQL)',
  () => {
    let programmId = '';
    let programmB = '';
    beforeAll(async () => {
      await legeMandantenAn(w);
      await richteEinUeberHttp(w);
      await mitTenant(w.T, async (tx) => {
        programmId = (await tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: w.A } })).id;
        await tx.mandantKontaktRolle.create({
          data: { mandantId: w.A, kontaktId: MITARBEITER, rolle: 'MITARBEITER' },
        });
        // Programm von Mandant B (gleicher Tenant) für den Fremdzugriff.
        programmB = (
          await tx.tcmsProgramm.create({
            data: { mandantId: w.B, paketId: 'ecommerce', paketVersion: '1.0' },
          })
        ).id;
      });
    });

    /** Neue offene Freigabe (Ziele) an die GV von A; Beschreibung mit Version. */
    const freigabe = (
      daten: { art?: 'ZIELE' | 'BESCHREIBUNG'; refId?: string; programm?: string } = {},
    ) =>
      mitTenant(
        w.T,
        async (tx) =>
          (
            await tx.freigabe.create({
              data: {
                programmId: daten.programm ?? programmId,
                art: daten.art ?? 'ZIELE',
                refId: daten.refId ?? 'teilbereich-test',
                titel: 'Ziele 2026',
                angefordertVon: w.BT,
                empfaengerId: w.GV,
              },
            })
          ).id,
      );
    const pfad = (id: string, mandant = w.A) => `${mandantPfad(mandant)}/portal/freigaben/${id}`;
    const gv = () => a.kontakt(w.GV, w.A);
    const code = (id: string, wer = gv(), mandant = w.A) =>
      senden(w, 'POST', `${pfad(id, mandant)}/code`, wer);
    const freigeben = (id: string, c: string, wer = gv(), mandant = w.A) =>
      senden(w, 'POST', `${pfad(id, mandant)}/freigeben`, wer, { code: c });
    /** Zuletzt ausgestellter Code (nur im Postausgang). */
    const letzterCode = (id: string) =>
      mitTenant(w.T, async (tx) => {
        const n = await tx.nachricht.findMany({
          where: { zweck: 'FREIGABE_CODE', daten: { path: ['freigabeId'], equals: id } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        });
        return n[0]!.code!;
      });
    const falsch = (richtig: string) => (richtig === '000000' ? '000001' : '000000');

    async function konfliktVon(r: Response, grund: KonfliktGrund) {
      const j = await json(r);
      expect(r.status, JSON.stringify(j)).toBe(409);
      expect(j).toEqual({
        ok: false,
        fehler: { code: 'KONFLIKT', meldung: expect.any(String), konflikt: grund },
      });
    }
    async function nichtGefunden(r: Response) {
      expect(r.status).toBe(404);
      expect(await json(r)).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
    }

    it('CODE_FEHLT: Freigeben ohne angeforderten Code', async () => {
      await konfliktVon(await freigeben(await freigabe(), '123456'), 'CODE_FEHLT');
    });

    it('ZU_VIELE_CODES: der sechste Code in einer Stunde', async () => {
      const id = await freigabe();
      for (let i = 0; i < 5; i++) await ok(await code(id));
      await konfliktVon(await code(id), 'ZU_VIELE_CODES');
    });

    it('CODE_GESPERRT: nach fünf Fehlversuchen beim Anfordern und Freigeben', async () => {
      const id = await freigabe();
      await ok(await code(id));
      const richtig = await letzterCode(id);
      for (let i = 0; i < 5; i++) {
        expect(await ok(await freigeben(id, falsch(richtig)))).toMatchObject({
          freigegeben: false,
        });
      }
      await konfliktVon(await code(id), 'CODE_GESPERRT');
      await konfliktVon(await freigeben(id, richtig), 'CODE_GESPERRT');
    });

    it('CODE_ABGELAUFEN: Frist vorbei bzw. Schlüssel nicht mehr konfiguriert (H5)', async () => {
      for (const daten of [
        { codeAblauf: new Date(Date.now() - 60_000) },
        { codeSchluesselId: 'f'.repeat(16) },
      ]) {
        const id = await freigabe();
        await ok(await code(id));
        const richtig = await letzterCode(id);
        await mitTenant(w.T, (tx) => tx.freigabe.update({ where: { id }, data: daten }));
        await konfliktVon(await freigeben(id, richtig), 'CODE_ABGELAUFEN');
      }
    });

    it('BEREITS_ERLEDIGT: erteilte Freigabe beim Anfordern und Freigeben', async () => {
      const id = await freigabe();
      await ok(await code(id));
      expect(await ok(await freigeben(id, await letzterCode(id)))).toMatchObject({
        freigegeben: true,
      });
      await konfliktVon(await code(id), 'BEREITS_ERLEDIGT');
      await konfliktVon(await freigeben(id, '123456'), 'BEREITS_ERLEDIGT');
    });

    it('VERSION_NICHT_VORGELEGT und INHALT_VERAENDERT: Beschreibung', async () => {
      const version = (beimMandanten: boolean) =>
        mitTenant(w.T, async (tx) => {
          const v = await tx.beschreibungVersion.create({
            data: {
              programmId,
              nummer: beimMandanten ? '7.2' : '7.1',
              status: 'ENTWURF',
              abschnitte: [],
            },
          });
          if (beimMandanten) {
            // Eingefroren, aber der Hash passt nicht zum Inhalt.
            await tx.beschreibungVersion.update({
              where: { id: v.id },
              data: {
                status: 'BEIM_MANDANTEN',
                snapshot: { eingefroren: true },
                snapshotSha256: 'a'.repeat(64),
              },
            });
          }
          return v.id;
        });
      for (const [beimMandanten, grund] of [
        [false, 'VERSION_NICHT_VORGELEGT'],
        [true, 'INHALT_VERAENDERT'],
      ] as const) {
        const id = await freigabe({ art: 'BESCHREIBUNG', refId: await version(beimMandanten) });
        await ok(await code(id));
        const richtig = await letzterCode(id);
        await konfliktVon(await freigeben(id, richtig), grund);
        // Kein Versuch verbraucht: Die Prüfung liegt vor dem Codevergleich.
        const z = await mitTenant(w.T, (tx) => tx.freigabe.findUniqueOrThrow({ where: { id } }));
        expect(z).toMatchObject({ status: 'OFFEN', codeFehlversuche: 0 });
      }
    });

    it('kein Existenz-Orakel: fremde, unbekannte und nicht sichtbare Freigaben → 404 ohne Grund', async () => {
      // Erledigte Freigabe an die GV: für sie 409 mit Grund …
      const erledigt = await freigabe();
      await mitTenant(w.T, (tx) =>
        tx.freigabe.update({ where: { id: erledigt }, data: { status: 'ABGELEHNT' } }),
      );
      await konfliktVon(await code(erledigt), 'BEREITS_ERLEDIGT');
      // … für eine Mitarbeiterin ohne Sicht auf fremd adressierte Freigaben 404.
      const ma = a.kontakt(MITARBEITER, w.A);
      await nichtGefunden(await code(erledigt, ma));
      await nichtGefunden(await freigeben(erledigt, '123456', ma));
      // Unbekannte ID und Freigabe von Mandant B unter dem Pfad von A.
      const vonB = await freigabe({ programm: programmB });
      for (const id of ['ckunbekannt0000000000000', vonB]) {
        await nichtGefunden(await code(id));
        await nichtGefunden(await freigeben(id, '123456'));
      }
    });

    it('jede erreichbare Lage ist abgedeckt; ZWISCHENZEITLICH_GEAENDERT nur bei Gleichzeitigkeit', () => {
      // Die übrigen Gründe der Registereinträge prüfen die Fälle oben; der Wettlauf
      // unter der Zeilensperre ist über HTTP nicht herstellbar (statisch:
      // packages/service/src/__tests__/konflikt.test.ts).
      const register = new Set([
        ...ENDPUNKTE.portalFreigabeCodeAnfordern.konflikte,
        ...ENDPUNKTE.portalFreigabeErteilen.konflikte,
      ]);
      expect([...register].sort()).toEqual(
        [
          'BEREITS_ERLEDIGT',
          'CODE_ABGELAUFEN',
          'CODE_FEHLT',
          'CODE_GESPERRT',
          'INHALT_VERAENDERT',
          'VERSION_NICHT_VORGELEGT',
          'ZU_VIELE_CODES',
          'ZWISCHENZEITLICH_GEAENDERT',
        ].sort(),
      );
    });
  },
);
