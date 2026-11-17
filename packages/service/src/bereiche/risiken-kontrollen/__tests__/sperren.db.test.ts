// =============================================================================
// Sperrordnung (TS-05, AGENTS.md; Befunde 27, 31, 62, 68, 133) gegen
// PostgreSQL mit zwei Verbindungen:
//   - Programm, Risiko und Kontrolle sind FOR NO KEY UPDATE gesperrt: Das
//     Anlegen einer Kindzeile (FK-Prüfung FOR KEY SHARE) wartet nicht – so
//     entsteht keine Kante „Kind → Eltern“ gegen die Ordnung (Verklemmung
//     Profiländerung ↔ Ereignis erfassen bzw. ↔ Risikoakzeptanz anfordern).
//     Änderungen derselben Zeile bleiben gegenseitig ausgeschlossen.
//   - `profilAendern` sperrt die Risiken, bevor es „neu bewerten“ liest.
//   - Die Neubewertung sperrt betroffene Ereignisse vor dem Risiko
//     (Ereignis → Risiko → Folge) und schließt ein Ereignis nur unter dessen
//     Sperre ab.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erzeugeClient, mitTenant, type PrismaClient, type Tx } from '@tcms/db';
import { bisWartend } from '../../../__tests__/sperr-hilfen';
import {
  sperreEreignis,
  sperreProgramm as sperreProgrammLaender,
} from '../../feststellungen-ereignisse/gemeinsam';
import { sperreKontrollen, sperreProgramm, sperreRisiken } from '../gemeinsam';
import { profilAendern } from '../profil';
import { risikoNeuBewerten } from '../risiken';
import { akteureVon, BEGRUENDUNG, HEUTE, legeProgrammAn, rufe, type Programm } from './fixture';

const AKTIV = process.env['DB_TESTS'] === '1';
const WARTEZEIT_MS = 2000;

describe.skipIf(!AKTIV)('Sperrordnung (TS-05)', () => {
  const tenant = randomUUID();
  let a: Programm;
  let zweite: PrismaClient;
  let akt: ReturnType<typeof akteureVon>;

  beforeAll(async () => {
    zweite = erzeugeClient(process.env['DATABASE_URL']);
    a = await legeProgrammAn(tenant);
    akt = akteureVon(a);
  }, 120_000);

  afterAll(async () => {
    await zweite?.$disconnect();
  });

  const lies = <T>(fn: (tx: Tx) => Promise<T>) => mitTenant(tenant, fn);
  const risiko = () => [...a.risiken.values()][0]!;
  const kontrolle = () => [...a.kontrollen.values()][0]!;

  /**
   * Hält `sperre` in der zweiten Verbindung, startet `lauf` und meldet, ob er
   * innerhalb der Wartezeit fertig wird ('fertig') oder auf die Sperre wartet
   * ('wartet'). Danach wird die Sperre freigegeben und beides abgewartet.
   */
  async function waehrendGesperrt(
    sperre: (tx: Tx) => Promise<unknown>,
    lauf: () => Promise<unknown>,
  ): Promise<'fertig' | 'wartet'> {
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(
      tenant,
      async (tx) => {
        await sperre(tx);
        gehalten();
        await schranke;
      },
      { timeoutMs: 30_000, client: zweite },
    );
    await haelt;
    const l = lauf();
    let zeit: NodeJS.Timeout | undefined;
    const ergebnis = await Promise.race([
      l.then(() => 'fertig' as const),
      new Promise<'wartet'>((r) => (zeit = setTimeout(() => r('wartet'), WARTEZEIT_MS))),
    ]);
    clearTimeout(zeit);
    loslassen();
    await halter;
    await l;
    return ergebnis;
  }

  const ereignisAnlegen = () =>
    lies((tx) =>
      tx.ereignis.create({
        data: {
          programmId: a.programmId,
          nummer: `S-${randomUUID()}`,
          typ: 'T-02',
          titel: 'Sperrtest',
          beschreibung: 'Sperrtest',
          quelle: 'STAMMDATEN',
          ereignisDatum: new Date(`${HEUTE}T00:00:00.000Z`),
        },
      }),
    );

  it('Programmsperre: Ereignis und Freigabe lassen sich anlegen, Änderungen warten (Befunde 27, 31)', async () => {
    expect(await waehrendGesperrt((tx) => sperreProgramm(tx, a.mandantId), ereignisAnlegen)).toBe(
      'fertig',
    );
    expect(
      await waehrendGesperrt(
        (tx) => sperreProgramm(tx, a.mandantId),
        () =>
          lies((tx) =>
            tx.freigabe.create({
              data: {
                programmId: a.programmId,
                art: 'RISIKOAKZEPTANZ',
                refId: risiko(),
                titel: 'Sperrtest',
                angefordertVon: a.personen.bt,
                empfaengerId: a.personen.gv,
                status: 'ABGELEHNT',
              },
            }),
          ),
      ),
    ).toBe('fertig');
    // Gegenprobe: eine zweite Programmsperre wartet weiterhin.
    expect(
      await waehrendGesperrt(
        (tx) => sperreProgramm(tx, a.mandantId),
        () => lies((tx) => sperreProgramm(tx, a.mandantId)),
      ),
    ).toBe('wartet');
    // Länder-Monitor (eigene Programmsperre des Bereichs feststellungen-ereignisse).
    expect(
      await waehrendGesperrt((tx) => sperreProgrammLaender(tx, a.mandantId), ereignisAnlegen),
    ).toBe('fertig');
    expect(
      await waehrendGesperrt(
        (tx) => sperreProgrammLaender(tx, a.mandantId),
        () => lies((tx) => sperreProgramm(tx, a.mandantId)),
      ),
    ).toBe('wartet');
  });

  it('Risiko- und Kontrollsperre: Kindzeilen ja, zweite Sperre nein', async () => {
    expect(
      await waehrendGesperrt(
        (tx) => sperreRisiken(tx, a.programmId, [risiko()]),
        () =>
          lies((tx) =>
            tx.uebersteuerung.create({
              data: {
                risikoId: risiko(),
                sicht: 'DESIGN',
                klasse: 'GERING',
                berechnet: 'HOCH',
                begruendung: BEGRUENDUNG,
                status: 'ABGELEHNT',
                beantragtVon: a.personen.hb,
              },
            }),
          ),
      ),
    ).toBe('fertig');
    expect(
      await waehrendGesperrt(
        (tx) => sperreRisiken(tx, a.programmId, [risiko()]),
        () => lies((tx) => sperreRisiken(tx, a.programmId, [risiko()])),
      ),
    ).toBe('wartet');
    expect(
      await waehrendGesperrt(
        (tx) => sperreKontrollen(tx, a.programmId, [kontrolle()]),
        () =>
          lies(async (tx) => {
            const s = await tx.kontrolleStand.findFirstOrThrow({
              where: { kontrolleId: kontrolle(), gueltigBis: null },
            });
            const tag = new Date(`${HEUTE}T00:00:00.000Z`);
            return tx.durchfuehrung.create({
              data: {
                kontrolleId: kontrolle(),
                kontrolleStandId: s.id,
                periodeLabel: 'Sperrtest',
                periodeVon: tag,
                periodeBis: tag,
                faelligAm: tag,
                ausserplanmaessig: true,
                anlass: 'Sperrtest',
              },
            });
          }),
      ),
    ).toBe('fertig');
  });

  it('profilAendern liest „neu bewerten“ erst unter der Risikosperre (Befund 62)', async () => {
    const id = risiko();
    // Bereits markiert: ohne Sperre läse profilAendern `true` und liefe durch.
    await lies((tx) => tx.risiko.update({ where: { id }, data: { neuBewerten: true } }));
    const st = await lies((tx) =>
      tx.profilStand.findFirstOrThrow({ where: { programmId: a.programmId, gueltigBis: null } }),
    );
    const profil = structuredClone(a.profil);
    profil.p2.lager.push({ land: 'CZ', seit: '2026-09', art: 'PAN-EU' });
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    const halter = mitTenant(
      tenant,
      async (tx) => {
        await sperreRisiken(tx, a.programmId, [id]);
        gehalten();
        await schranke;
      },
      { timeoutMs: 30_000, client: zweite },
    );
    await haelt;
    const lauf = rufe(akt.hb, (ctx) =>
      profilAendern(ctx, {
        mandantId: a.mandantId,
        profilStandId: st.id,
        profil,
        gueltigAb: HEUTE,
        ereignisseAnlegen: false,
      }),
    );
    try {
      await bisWartend(tenant, 'FROM "Risiko"');
    } finally {
      loslassen();
      await halter;
    }
    expect((await lauf).version).toBe(st.version + 1);
  });

  it('Neubewertung sperrt betroffene Ereignisse vor dem Risiko (Befunde 28, 68)', async () => {
    const id = risiko();
    const code = [...a.risiken.entries()].find(([, v]) => v === id)![0];
    const ev = await lies((tx) =>
      tx.ereignis.create({
        data: {
          programmId: a.programmId,
          nummer: `S-${randomUUID()}`,
          typ: 'T-02',
          titel: 'Sperrtest Folge',
          beschreibung: 'Sperrtest',
          quelle: 'STAMMDATEN',
          ereignisDatum: new Date(`${HEUTE}T00:00:00.000Z`),
          status: 'IN_TRIAGE',
          verwerfenBegruendung: 'Antrag auf Verwerfen mit ausreichend langer Begründung.',
          verwerfenBeantragtVon: a.personen.bt,
          folgen: {
            create: [
              { art: 'RISIKO_NEU_BEWERTEN', ziel: code, text: 'neu bewerten', status: 'ANGELEGT' },
            ],
          },
        },
      }),
    );
    const alt = await lies((tx) =>
      tx.risikoStand.findFirstOrThrow({ where: { risikoId: id, gueltigBis: null } }),
    );
    let loslassen!: () => void;
    const schranke = new Promise<void>((r) => (loslassen = r));
    let gehalten!: () => void;
    const haelt = new Promise<void>((r) => (gehalten = r));
    // Hält das Ereignis wie „Folge hinzufügen“ und legt darunter eine weitere Folge an.
    const halter = mitTenant(
      tenant,
      async (tx) => {
        await sperreEreignis(tx, a.mandantId, ev.id);
        gehalten();
        await schranke;
        await tx.ereignisFolge.create({
          data: { ereignisId: ev.id, art: 'PROFIL_AENDERN', text: 'neu', status: 'VORGESCHLAGEN' },
        });
      },
      { timeoutMs: 30_000, client: zweite },
    );
    await haelt;
    const lauf = rufe(akt.hb, (ctx) =>
      risikoNeuBewerten(ctx, {
        mandantId: a.mandantId,
        risikoId: id,
        standId: alt.id,
        s: alt.s === 'H' ? 'N' : 'H',
        w: alt.w,
        r: alt.r as 1 | 2 | 3,
        gt: alt.gt,
        begruendung: BEGRUENDUNG,
      }),
    );
    try {
      await bisWartend(tenant, 'FROM "Ereignis"');
    } finally {
      loslassen();
      await halter;
    }
    await lauf;
    const nachher = await lies((tx) =>
      tx.ereignis.findUniqueOrThrow({
        where: { id: ev.id },
        include: { folgen: { orderBy: { id: 'asc' } } },
      }),
    );
    // Die Folge der Neubewertung ist erledigt; die unter der Sperre angelegte
    // Folge ist offen, also bleibt das Ereignis in der Triage.
    expect(nachher.folgen.find((f) => f.art === 'RISIKO_NEU_BEWERTEN')?.status).toBe('ERLEDIGT');
    expect(nachher.status).toBe('IN_TRIAGE');
  });

  it('automatischer Abschluss leert einen offenen Verwerfen-Antrag (Befund 68)', async () => {
    const id = [...a.risiken.values()][1]!;
    const code = [...a.risiken.entries()].find(([, v]) => v === id)![0];
    const ev = await lies((tx) =>
      tx.ereignis.create({
        data: {
          programmId: a.programmId,
          nummer: `S-${randomUUID()}`,
          typ: 'T-02',
          titel: 'Sperrtest Abschluss',
          beschreibung: 'Sperrtest',
          quelle: 'STAMMDATEN',
          ereignisDatum: new Date(`${HEUTE}T00:00:00.000Z`),
          status: 'IN_TRIAGE',
          verwerfenBegruendung: 'Antrag auf Verwerfen mit ausreichend langer Begründung.',
          verwerfenBeantragtVon: a.personen.bt,
          folgen: {
            create: [
              { art: 'RISIKO_NEU_BEWERTEN', ziel: code, text: 'neu bewerten', status: 'ANGELEGT' },
            ],
          },
        },
      }),
    );
    const alt = await lies((tx) =>
      tx.risikoStand.findFirstOrThrow({ where: { risikoId: id, gueltigBis: null } }),
    );
    await rufe(akt.hb, (ctx) =>
      risikoNeuBewerten(ctx, {
        mandantId: a.mandantId,
        risikoId: id,
        standId: alt.id,
        s: alt.s === 'H' ? 'N' : 'H',
        w: alt.w,
        r: alt.r as 1 | 2 | 3,
        gt: alt.gt,
        begruendung: BEGRUENDUNG,
      }),
    );
    const nachher = await lies((tx) => tx.ereignis.findUniqueOrThrow({ where: { id: ev.id } }));
    expect([nachher.status, nachher.verwerfenBegruendung, nachher.verwerfenBeantragtVon]).toEqual([
      'ERLEDIGT',
      null,
      null,
    ]);
  });
});
