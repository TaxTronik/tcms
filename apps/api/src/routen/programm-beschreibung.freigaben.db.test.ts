// CMS-Beschreibung und Freigaben über die App (DB_TESTS=1): Ablauf über alle
// Endpunkte (Version, Abschnitt, Review mit Vier-Augen, Freigabe anfordern,
// Portal: lesen, Code, freigeben, Kenntnisnahme; Neuadressierung) und je
// Endpunkt die Negativfälle. Codes erscheinen nur im Postausgang.
import { mitTenant } from '@tcms/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { json } from '../__tests__/hilfen';
import {
  akteure,
  legeMandantenAn,
  mandantPfad,
  neueApiWelt,
  ok,
  pruefeEndpunkte,
  richteEinUeberHttp,
  senden,
} from './programm-beschreibung.testapp';

const AKTIV = process.env['DB_TESTS'] === '1';
const w = neueApiWelt();
const a = akteure(w);
const m = mandantPfad;

describe.skipIf(!AKTIV)('Endpunkte CMS-Beschreibung und Freigaben (App + PostgreSQL)', () => {
  beforeAll(async () => {
    await legeMandantenAn(w);
    await richteEinUeberHttp(w);
  });

  it('Ablauf über alle Endpunkte (Erfolg)', async () => {
    const v = await ok(await senden(w, 'POST', `${m(w.A)}/beschreibung/versionen`, a.hb()), 201);
    const V = `${m(w.A)}/beschreibung/versionen/${String(v['versionId'])}`;
    await ok(
      await senden(w, 'POST', `${V}/abschnitte`, a.hb(), {
        key: 'kultur',
        bloecke: [{ typ: 'text', text: 'Kultur' }],
      }),
    );
    await ok(await senden(w, 'POST', `${V}/review`, a.hb()));
    await ok(
      await senden(w, 'POST', `${V}/review/zurueckweisen`, a.bt(), {
        begruendung: 'Bitte die Kultur konkreter beschreiben, mit Beispielen.',
      }),
    );
    await ok(await senden(w, 'POST', `${V}/review`, a.hb()));
    // Vier-Augen über HTTP: 403 mit fachlichem Grund für die letzte Bearbeitung.
    const selbst = await senden(w, 'POST', `${V}/review/abschliessen`, a.hb());
    expect(selbst.status).toBe(403);
    expect((await json(selbst))['fehler']).toMatchObject({
      code: 'NICHT_BERECHTIGT',
      meldung: expect.stringContaining('zweite Person'),
    });
    await ok(await senden(w, 'POST', `${V}/review/abschliessen`, a.bt()));
    const fr = await ok(
      await senden(w, 'POST', `${V}/freigabe`, a.bt(), {
        empfaengerId: w.GV,
        verantwortung: { berufstraeger: { id: w.BT, name: 'StB Test' }, bearbeitung: null },
        namen: [],
      }),
      201,
    );
    const besch = await ok(await senden(w, 'GET', `${m(w.A)}/beschreibung`, a.bt()));
    expect((besch['versionen'] as unknown[]).length).toBe(1);
    const frueher = await ok(
      await senden(w, 'GET', `${m(w.A)}/beschreibung?stand=2000-01-01`, a.bt()),
    );
    expect(frueher).toMatchObject({ historisch: true, versionen: [], darfBearbeiten: false });

    // Postausgang: Code nur hier (für die Zustellung), nirgends sonst.
    const post = await ok(await senden(w, 'GET', '/v1/nachrichten/offen?limit=50', a.admin()));
    const nachrichten = post['nachrichten'] as {
      empfaengerId: string;
      zweck: string;
      text: string;
    }[];
    const text = nachrichten.find(
      (n) => n.zweck === 'FREIGABE_CODE' && n.empfaengerId === w.GV,
    )!.text;
    const code = /Bestätigungscode: (\d{6})/.exec(text)![1]!;
    expect(JSON.stringify(fr)).not.toContain(code);

    const portal = await ok(
      await senden(w, 'GET', `${m(w.A)}/portal/freigaben`, a.kontakt(w.GV, w.A)),
    );
    expect(JSON.stringify(portal)).not.toContain(code);
    expect(JSON.stringify(portal)).not.toMatch(/codeHash|codeFehlversuche/);
    const P = `${m(w.A)}/portal/freigaben/${String(fr['freigabeId'])}`;
    const falsch = await ok(
      await senden(w, 'POST', `${P}/freigeben`, a.kontakt(w.GV, w.A), {
        code: code === '000000' ? '000001' : '000000',
      }),
    );
    expect(falsch).toMatchObject({
      freigegeben: false,
      grund: 'CODE_FALSCH',
      verbleibendeVersuche: 4,
    });
    const erteilt = await ok(
      await senden(w, 'POST', `${P}/freigeben`, a.kontakt(w.GV, w.A), { code }),
    );
    expect(erteilt).toMatchObject({ freigegeben: true });

    const ziele = await mitTenant(w.T, (tx) =>
      tx.freigabe.findFirstOrThrow({ where: { art: 'ZIELE', programm: { mandantId: w.A } } }),
    );
    const c = await ok(
      await senden(w, 'POST', `${m(w.A)}/portal/freigaben/${ziele.id}/code`, a.kontakt(w.GV, w.A)),
    );
    expect(Object.keys(c).sort()).toEqual(['codeAblauf', 'freigabeId']);
    await ok(
      await senden(w, 'POST', `${m(w.A)}/freigaben/${ziele.id}/neuadressierung`, a.bt(), {
        empfaengerId: w.GV,
      }),
    );

    const programm = await mitTenant(w.T, (tx) =>
      tx.tcmsProgramm.findFirstOrThrow({ where: { mandantId: w.A } }),
    );
    const kenntnis = await mitTenant(w.T, (tx) =>
      tx.freigabe.create({
        data: {
          programmId: programm.id,
          art: 'KENNTNISNAHME',
          refId: 'richtlinie',
          titel: 'Richtlinie',
          angefordertVon: w.BT,
          empfaengerId: w.TCB,
        },
      }),
    );
    await ok(
      await senden(
        w,
        'POST',
        `${m(w.A)}/portal/freigaben/${kenntnis.id}/kenntnisnahme`,
        a.kontakt(w.TCB, w.A),
        {
          gelesen: true,
        },
      ),
    );
  });

  const V = (x: string) => `${m(x)}/beschreibung/versionen/v123`;
  const P = (x: string) => `${m(x)}/portal/freigaben/f123`;
  pruefeEndpunkte(w, [
    {
      name: 'Beschreibung lesen',
      methode: 'GET',
      pfad: (x) => `${m(x)}/beschreibung`,
      ungueltig: { query: '?stand=gestern' },
    },
    {
      name: 'Version anlegen',
      methode: 'POST',
      pfad: (x) => `${m(x)}/beschreibung/versionen`,
      ungueltig: { body: { nummer: '9.9' } },
    },
    {
      name: 'Abschnitt speichern',
      methode: 'POST',
      pfad: (x) => `${V(x)}/abschnitte`,
      body: { key: 'kultur', bloecke: [{ typ: 'text', text: 'x' }] },
      ungueltig: { body: { key: 'kultur', bloecke: [{ typ: 'baustein', art: 'BOESE' }] } },
    },
    { name: 'zur Review', methode: 'POST', pfad: (x) => `${V(x)}/review`, ungueltig: { body: {} } },
    {
      name: 'Review abschließen',
      methode: 'POST',
      pfad: (x) => `${V(x)}/review/abschliessen`,
      ungueltig: { body: { reviewVon: w.BT } },
    },
    {
      name: 'Review zurückweisen',
      methode: 'POST',
      pfad: (x) => `${V(x)}/review/zurueckweisen`,
      body: { begruendung: 'x'.repeat(40) },
      ungueltig: { body: { begruendung: 'zu kurz' } },
    },
    {
      name: 'Freigabe anfordern',
      methode: 'POST',
      pfad: (x) => `${V(x)}/freigabe`,
      body: {
        empfaengerId: w.GV,
        verantwortung: { berufstraeger: null, bearbeitung: null },
        namen: [],
      },
      ungueltig: {
        body: {
          empfaengerId: 'Jana Weller',
          verantwortung: { berufstraeger: null, bearbeitung: null },
          namen: [],
        },
      },
    },
    {
      name: 'Neuadressierung',
      methode: 'POST',
      pfad: (x) => `${m(x)}/freigaben/f123/neuadressierung`,
      body: { empfaengerId: w.GV },
      ungueltig: { body: { empfaengerId: w.GV, codeHash: null } },
    },
    {
      name: 'Portal lesen',
      methode: 'GET',
      pfad: (x) => `${m(x)}/portal/freigaben`,
      ungueltig: { query: '?alle=1' },
      portal: true,
    },
    {
      name: 'Code anfordern',
      methode: 'POST',
      pfad: (x) => `${P(x)}/code`,
      ungueltig: { body: { empfaengerId: w.GV } },
      portal: true,
    },
    {
      name: 'Freigeben',
      methode: 'POST',
      pfad: (x) => `${P(x)}/freigeben`,
      body: { code: '123456' },
      ungueltig: { body: { code: '12345a' } },
      portal: true,
    },
    {
      name: 'Kenntnisnahme',
      methode: 'POST',
      pfad: (x) => `${P(x)}/kenntnisnahme`,
      body: { gelesen: true },
      ungueltig: { body: { gelesen: 'ja' } },
      portal: true,
    },
  ]);
});
