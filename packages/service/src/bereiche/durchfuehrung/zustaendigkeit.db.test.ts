// =============================================================================
// Zuständigkeit offener Durchführungen aus dem aktuell gültigen Kontrollstand
// (`kern/zustaendigkeit.ts`) gegen PostgreSQL (DB_TESTS=1): Nach einem
// Zuständigkeitswechsel darf die abgelöste Person nicht mehr, die neue schon –
// Kennzeichen (Detail, Portal-Aufgabe, Kontext) und Operation rechnen mit
// demselben Stand; abgeschlossene Durchführungen behalten den Stand ihrer
// Durchführung. Dazu: Gegenzeichnung beim Mandanten folgt der Vertretung
// (Befund 38), Rollen erst unter `halteRollenFest` nach der Zeilensperre
// (Befunde 97/107) und die Sperrreihenfolge Programm → Risiko → Kontrolle →
// Durchführung beim Gegenzeichnen mit Befund und beim Nachtrag (Befund 29).
// =============================================================================

import { beforeAll, describe, expect, it } from 'vitest';
import type { Akteur } from '@tcms/contract';
import { mitTenant } from '@tcms/db';
import { ladeKontext } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import { zweiteVerbindung } from '../programm-beschreibung/testwelt';
import { verantwortlicheAendern } from '../risiken-kontrollen/kontrollen';
import { ladeDurchfuehrung, ladeKontrollaufgabe, listeKontrollaufgaben } from './lesen';
import {
  beginneDurchfuehrung,
  gegenzeichneDurchfuehrung,
  haengeNachweisAn,
  legeNachtragAn,
} from './operationen';
import { akteure, baueFall, fehlerVon, reicheEin, speichere, verweis, type Fall } from './testfall';

const AKTIV = process.env['DB_TESTS'] === '1';
const BEGRUENDUNG = 'Begründung mit ausreichend vielen Zeichen für die Prüfung.';

const vollstaendig = (ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' = 'OHNE_BEFUND') => ({
  schritte: [
    { erledigt: true, kommentar: 'erledigt' },
    { erledigt: true, kommentar: '' },
  ],
  werte: [
    { key: 'saldoShop', wert: 100, bemerkung: '', erklaert: false },
    { key: 'saldoFibu', wert: 100, bemerkung: '', erklaert: false },
  ],
  ergebnis,
  ergebnisKommentar: ergebnis === 'MIT_BEFUND' ? 'Differenz im Clearingkonto ungeklärt.' : null,
});

/** Zahl der Sitzungen dieser Datenbank, die auf eine Sperre warten. */
async function wartende(tenantId: string): Promise<number> {
  const [z] = await mitTenant(
    tenantId,
    (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return z?.n ?? 0;
}

async function bisWartend(tenantId: string, n = 1): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if ((await wartende(tenantId)) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Kein Lauf wartet auf die Sperre');
}

function schranke() {
  let auf!: () => void;
  const zu = new Promise<void>((r) => (auf = r));
  return { auf, zu };
}

describe.skipIf(!AKTIV)('Durchführung: Zuständigkeit aus dem aktuellen Kontrollstand', () => {
  let f: Fall;
  let a: ReturnType<typeof akteure>;
  const ziel = (durchfuehrungId: string) => ({ mandantId: f.mandant, durchfuehrungId });
  const stand = (kontrolleId: string) =>
    f.tx((tx) => tx.kontrolleStand.findFirstOrThrow({ where: { kontrolleId, gueltigBis: null } }));
  /** Zuständigkeit einer Kontrolle über `verantwortlicheAendern` (neuer Kontrollstand). */
  async function wechsle(
    k: 'k1' | 'k2',
    z: {
      durchfuehrendId: string;
      vertretungId: string;
      gegenzeichnerId: string | null;
      gegenzeichnungMandant: boolean;
    },
  ) {
    const kontrolleId = f[k].id;
    const alt = await stand(kontrolleId);
    return f.dienst(a.bt, (ctx) =>
      verantwortlicheAendern(ctx, {
        mandantId: f.mandant,
        kontrolleId,
        standId: alt.id,
        partei: alt.partei,
        ...z,
      }),
    );
  }
  async function eingereicht(k: 'k1' | 'k2', wer: Akteur, ergebnis?: 'MIT_BEFUND') {
    const did = await f.durchfuehrung(k);
    await f.dienst(wer, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig(ergebnis) }));
    await f.dienst(wer, (ctx) => haengeNachweisAn(ctx, { ...ziel(did), verweis: verweis() }));
    await f.dienst(wer, (ctx) => reicheEin(ctx, ziel(did)));
    return did;
  }
  const rechte = (wer: Akteur, did: string) =>
    f.dienst(wer, (ctx) => ladeDurchfuehrung(ctx, ziel(did))).then((d) => d.rechte);

  beforeAll(async () => {
    f = await baueFall();
    a = akteure(f);
  });

  it('Kanzlei: nach dem Wechsel darf die abgelöste Person nicht mehr beginnen oder speichern, die neue schon (Kennzeichen = Operation)', async () => {
    const geplant = await f.durchfuehrung('k1');
    const begonnen = await f.durchfuehrung('k1');
    await f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(begonnen)));
    const abgeschlossen = await eingereicht('k1', a.bearbeiter);
    await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(abgeschlossen)));
    const kollege = f.kanzlei(f.p.kollege);

    await wechsle('k1', {
      durchfuehrendId: f.p.kollege,
      vertretungId: f.p.vertretung,
      gegenzeichnerId: f.p.pruefer,
      gegenzeichnungMandant: false,
    });

    // Abgelöst: Kennzeichen und Operation verweigern mit demselben Grund.
    const alt = await rechte(a.bearbeiter, geplant);
    expect(alt.beginnen).toMatchObject({ erlaubt: false, verweigerung: 'DURCHFUEHREN' });
    const e1 = await fehlerVon(
      f.dienst(a.bearbeiter, (ctx) => beginneDurchfuehrung(ctx, ziel(geplant))),
    );
    expect([e1.code, e1.grund]).toEqual(['NICHT_BERECHTIGT', 'DURCHFUEHREN']);
    const e2 = await fehlerVon(
      f.dienst(a.bearbeiter, (ctx) => speichere(ctx, { ...ziel(begonnen), ...vollstaendig() })),
    );
    expect([e2.code, e2.grund]).toEqual(['NICHT_BERECHTIGT', 'DURCHFUEHREN']);

    // Neu: Kennzeichen erlaubt, Operation gelingt – auch an der schon begonnenen.
    expect((await rechte(kollege, geplant)).beginnen.erlaubt).toBe(true);
    await f.dienst(kollege, (ctx) => beginneDurchfuehrung(ctx, ziel(geplant)));
    expect((await rechte(kollege, begonnen)).bearbeiten.erlaubt).toBe(true);
    await f.dienst(kollege, (ctx) => speichere(ctx, { ...ziel(begonnen), ...vollstaendig() }));

    // Detail und Kontext nennen dieselbe Zuständigkeit; abgeschlossene behält ihren Stand.
    const detail = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(begonnen)));
    expect(detail.kontrolle.durchfuehrendId).toBe(f.p.kollege);
    const fertig = await f.dienst(a.bt, (ctx) => ladeDurchfuehrung(ctx, ziel(abgeschlossen)));
    expect(fertig.kontrolle.durchfuehrendId).toBe(f.p.bearbeiter);
    const k = await f.dienst(a.bt, (ctx) => ladeKontext(ctx, { mandantId: f.mandant }));
    const view = (id: string) => k.durchfuehrungen.find((d) => d.id === id)!;
    expect(view(begonnen).durchfuehrendId).toBe(f.p.kollege);
    expect(view(abgeschlossen).durchfuehrendId).toBe(f.p.bearbeiter);
  });

  it('Kanzlei: Gegenzeichnung einer eingereichten Durchführung folgt dem neuen Stand', async () => {
    const did = await eingereicht('k1', f.kanzlei(f.p.kollege));
    await wechsle('k1', {
      durchfuehrendId: f.p.kollege,
      vertretungId: f.p.vertretung,
      gegenzeichnerId: f.p.bearbeiter,
      gegenzeichnungMandant: false,
    });
    // pruefer war zugewiesene Gegenzeichnung (kein Berufsträger) und ist abgelöst.
    expect((await rechte(a.pruefer, did)).gegenzeichnen).toMatchObject({
      erlaubt: false,
      verweigerung: 'GEGENZEICHNEN',
    });
    const e = await fehlerVon(
      f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did))),
    );
    expect([e.code, e.grund]).toEqual(['NICHT_BERECHTIGT', 'GEGENZEICHNEN']);
    expect((await rechte(a.bearbeiter, did)).gegenzeichnen.erlaubt).toBe(true);
    const r = await f.dienst(a.bearbeiter, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
    expect(r.status).toBe('OHNE_BEFUND');
    // Zurück auf die Ausgangszuständigkeit für die übrigen Fälle.
    await wechsle('k1', {
      durchfuehrendId: f.p.bearbeiter,
      vertretungId: f.p.vertretung,
      gegenzeichnerId: f.p.pruefer,
      gegenzeichnungMandant: false,
    });
  });

  it('Portal: abgelöster Kontakt sieht die Aufgabe nicht mehr (404), der neue sieht und bearbeitet sie', async () => {
    const did = await f.durchfuehrung('k2');
    await f.dienst(a.ma, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig() }));
    await wechsle('k2', {
      durchfuehrendId: f.p.ma3,
      vertretungId: f.p.ma2,
      gegenzeichnerId: null,
      gegenzeichnungMandant: true,
    });
    const e = await fehlerVon(f.dienst(a.ma, (ctx) => ladeKontrollaufgabe(ctx, ziel(did))));
    expect(e.code).toBe('NICHT_GEFUNDEN');
    const e2 = await fehlerVon(
      f.dienst(a.ma, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig() })),
    );
    expect(e2.code).toBe('NICHT_GEFUNDEN');
    const listeAlt = await f.dienst(a.ma, (ctx) =>
      listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
    );
    expect(listeAlt.aufgaben.map((x) => x.id)).not.toContain(did);

    const neu = await f.dienst(a.ma3, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)));
    expect(neu.kontrolle.durchfuehrendId).toBe(f.p.ma3);
    expect(neu.rechte.bearbeiten.erlaubt).toBe(true);
    const liste = await f.dienst(a.ma3, (ctx) =>
      listeKontrollaufgaben(ctx, { mandantId: f.mandant }),
    );
    expect(liste.aufgaben.find((x) => x.id === did)).toMatchObject({ eigene: true });
    await f.dienst(a.ma3, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig() }));
    await wechsle('k2', {
      durchfuehrendId: f.p.ma,
      vertretungId: f.p.ma2,
      gegenzeichnerId: null,
      gegenzeichnungMandant: true,
    });
  });

  it('Gegenzeichnung beim Mandanten: die Gegenzeichnung folgt der neuen Vertretung; die ersetzte Person verliert Lese- und Bestätigungsrecht (Befund 38)', async () => {
    // Ausgangslage wie die Vorbelegung: Vertretung = Gegenzeichnung beim Mandanten (ma2).
    await f.tx((tx) =>
      tx.kontrolleStand.updateMany({
        where: { kontrolleId: f.k2.id, gueltigBis: null },
        data: { vertretungId: f.p.ma2, gegenzeichnerId: f.p.ma2, gegenzeichnungMandant: true },
      }),
    );
    const did = await f.durchfuehrung('k2');
    expect((await f.dienst(a.ma2, (ctx) => ladeKontrollaufgabe(ctx, ziel(did)))).id).toBe(did);

    await wechsle('k2', {
      durchfuehrendId: f.p.ma,
      vertretungId: f.p.ma3,
      gegenzeichnerId: null,
      gegenzeichnungMandant: true,
    });
    const neu = await stand(f.k2.id);
    expect([neu.vertretungId, neu.gegenzeichnerId]).toEqual([f.p.ma3, f.p.ma3]);
    const e = await fehlerVon(f.dienst(a.ma2, (ctx) => ladeKontrollaufgabe(ctx, ziel(did))));
    expect(e.code).toBe('NICHT_GEFUNDEN');
    const audit = await f.tx((tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { objektId: f.k2.id, aktion: 'tcms.kontrolle.zustaendigkeit' },
        orderBy: { pos: 'desc' },
      }),
    );
    expect(audit.detail).toMatchObject({ nachher: { gegenzeichnung: f.p.ma3 } });
    await wechsle('k2', {
      durchfuehrendId: f.p.ma,
      vertretungId: f.p.ma2,
      gegenzeichnerId: null,
      gegenzeichnungMandant: true,
    });
  });

  it('Rollen gelten erst nach der Zeilensperre: in der Wartezeit entzogene Rolle → NICHT_GEFUNDEN (Befunde 97/107)', async () => {
    const did = await f.durchfuehrung('k2');
    const ma = f.kontakt(f.p.ma3);
    await wechsle('k2', {
      durchfuehrendId: f.p.ma3,
      vertretungId: f.p.ma2,
      gegenzeichnerId: null,
      gegenzeichnungMandant: true,
    });
    const zweite = zweiteVerbindung();
    try {
      const halt = schranke();
      const gehalten = schranke();
      const halter = mitTenant(
        f.tenant,
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${did} FOR UPDATE`;
          gehalten.auf();
          await halt.zu;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await gehalten.zu;
      const op = fehlerVon(
        f.dienst(ma, (ctx) => speichere(ctx, { ...ziel(did), ...vollstaendig() })),
      );
      await bisWartend(f.tenant);
      // Rolle entziehen, während die Operation an der Zeilensperre wartet.
      await f.tx((tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { mandantId: f.mandant, kontaktId: f.p.ma3 },
          data: { aktiv: false },
        }),
      );
      halt.auf();
      await halter;
      expect((await op).code).toBe('NICHT_GEFUNDEN');
      const d = await f.tx((tx) => tx.durchfuehrung.findUniqueOrThrow({ where: { id: did } }));
      expect(d.status).toBe('GEPLANT');
    } finally {
      await zweite.$disconnect();
      await f.tx((tx) =>
        tx.mandantKontaktRolle.updateMany({
          where: { mandantId: f.mandant, kontaktId: f.p.ma3 },
          data: { aktiv: true },
        }),
      );
      await wechsle('k2', {
        durchfuehrendId: f.p.ma,
        vertretungId: f.p.ma2,
        gegenzeichnerId: null,
        gegenzeichnungMandant: true,
      });
    }
  });

  /**
   * Gegenseite einer Neuplanung (Risiko/Kontrolle FOR UPDATE, danach alle
   * Durchführungen der Kontrolle): Mit der Sperrreihenfolge wartet die
   * Durchführungs-Operation vor ihrer Zeilensperre, die Neuplanung kommt
   * ohne Verklemmung durch, danach die Operation.
   */
  async function ohneVerklemmung(
    eltern: (tx: DienstKontext['tx']) => Promise<unknown>,
    operation: () => Promise<unknown>,
  ) {
    const zweite = zweiteVerbindung();
    try {
      const weiter = schranke();
      const gehalten = schranke();
      const neuplanung = mitTenant(
        f.tenant,
        async (tx) => {
          await eltern(tx);
          gehalten.auf();
          await weiter.zu;
          // Ohne Sperrreihenfolge hielte die Operation hier die Durchführung (Verklemmung).
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          await tx.$queryRaw`
            SELECT id FROM "Durchfuehrung" WHERE "kontrolleId" = ${f.k1.id} ORDER BY id FOR UPDATE`;
        },
        { timeoutMs: 30_000, client: zweite },
      );
      await gehalten.zu;
      const op = operation();
      await bisWartend(f.tenant);
      weiter.auf();
      await neuplanung;
      return await op;
    } finally {
      await zweite.$disconnect();
    }
  }

  it('Gegenzeichnen mit Befund sperrt Programm und Risiken vor der Durchführung: keine Verklemmung mit einer Neuplanung (Befund 29 a)', async () => {
    const did = await eingereicht('k1', a.bearbeiter, 'MIT_BEFUND');
    const r = await ohneVerklemmung(
      (tx) => tx.$queryRaw`SELECT id FROM "Risiko" WHERE id = ${f.risiko} FOR UPDATE`,
      () =>
        f.dienst(a.pruefer, (ctx) =>
          gegenzeichneDurchfuehrung(ctx, {
            ...ziel(did),
            feststellung: {
              titel: 'Differenz Clearingkonto',
              sachverhalt: 'Die Differenz im Clearingkonto ist nicht geklärt.',
              klasse: 'DURCHFUEHRUNGSMANGEL',
              schwere: 'MITTEL',
              auswirkung: 'UNKLAR',
              risikoIds: [f.risiko],
            },
          }),
        ),
    );
    expect(r).toMatchObject({ status: 'MIT_BEFUND' });
  });

  it('Gegenzeichnen mit Befund: auch gegen eine Programmsperre ohne Verklemmung (Befund 29 c)', async () => {
    const did = await eingereicht('k1', a.bearbeiter, 'MIT_BEFUND');
    const r = await ohneVerklemmung(
      (tx) => tx.$queryRaw`SELECT id FROM "TcmsProgramm" WHERE id = ${f.programm} FOR UPDATE`,
      () =>
        f.dienst(a.pruefer, (ctx) =>
          gegenzeichneDurchfuehrung(ctx, {
            ...ziel(did),
            feststellung: {
              titel: 'Differenz Clearingkonto',
              sachverhalt: 'Die Differenz im Clearingkonto ist nicht geklärt.',
              klasse: 'DURCHFUEHRUNGSMANGEL',
              schwere: 'MITTEL',
              auswirkung: 'UNKLAR',
              risikoIds: [f.risiko],
            },
          }),
        ),
    );
    expect(r).toMatchObject({ status: 'MIT_BEFUND' });
  });

  it('Nachtrag sperrt die Kontrolle vor der Durchführung: keine Verklemmung mit Abweichung/Neuplanung (Befund 29 b)', async () => {
    const did = await eingereicht('k1', a.bearbeiter);
    await f.dienst(a.pruefer, (ctx) => gegenzeichneDurchfuehrung(ctx, ziel(did)));
    const r = await ohneVerklemmung(
      (tx) => tx.$queryRaw`SELECT id FROM "Kontrolle" WHERE id = ${f.k1.id} FOR UPDATE`,
      () =>
        f.dienst(a.bearbeiter, (ctx) =>
          legeNachtragAn(ctx, { ...ziel(did), begruendung: BEGRUENDUNG }),
        ),
    );
    expect(r).toMatchObject({ nachtragZuId: did });
  });
});
