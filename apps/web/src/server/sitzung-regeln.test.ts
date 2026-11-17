import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beendeCookie,
  DAUER_MS,
  demoLoginErlaubt,
  erzeugeCookie,
  pruefeCookie,
  pruefeSessionSecret,
} from './sitzung-regeln';

// Je Lauf zufällig erzeugt; im Code steht kein Geheimnis.
const GEHEIM = randomBytes(32).toString('hex');
const PERSON = 'b1000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TS-01: Demo-Anmeldung', () => {
  it('ist mit NODE_ENV=production immer verweigert, unabhängig von Schaltern', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TCMS_DEV_LOGIN', '1');
    vi.stubEnv('TCMS_DEMO_LOGIN', '1');
    expect(demoLoginErlaubt()).toBe(false);
  });

  it('ist außerhalb von Produktion erlaubt', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(demoLoginErlaubt()).toBe(true);
    vi.stubEnv('NODE_ENV', 'test');
    expect(demoLoginErlaubt()).toBe(true);
  });
});

describe('TS-02: SESSION_SECRET', () => {
  it.each([
    ['fehlt', undefined],
    ['zu kurz', 'a1b2c3d4e5f6'],
    ['Platzhalter aus .env.example', 'bitte-durch-einen-langen-zufallswert-ersetzen'],
    ['Platzhalter mit Zusatz', 'bitte-durch-einen-langen-zufallswert-ersetzen-xyz'],
    ['changeme', 'changeme-changeme-changeme-changeme-123'],
    ['example', 'example-session-secret-for-local-dev-1234'],
    ['gleichförmig', 'a'.repeat(64)],
    ['wenige Zeichen', 'abababababababababababababababababab'],
  ])('weist ab: %s', (_n, wert) => {
    expect(() => pruefeSessionSecret(wert)).toThrow(/SESSION_SECRET/);
  });

  it('nimmt einen Zufallswert an', () => {
    expect(pruefeSessionSecret(GEHEIM)).toBe(GEHEIM);
  });

  it('signiert nicht mit einem Platzhalter (fail closed)', () => {
    vi.stubEnv('SESSION_SECRET', 'bitte-durch-einen-langen-zufallswert-ersetzen');
    expect(() => erzeugeCookie(PERSON)).toThrow(/Platzhalter/);
  });
});

describe('Sitzungs-Cookie', () => {
  it('nimmt ein gültiges Cookie an', () => {
    vi.stubEnv('SESSION_SECRET', GEHEIM);
    expect(pruefeCookie(erzeugeCookie(PERSON))).toBe(PERSON);
  });

  it('weist manipulierte, abgelaufene und fremd signierte Cookies ab', () => {
    vi.stubEnv('SESSION_SECRET', GEHEIM);
    const jetzt = Date.now();
    const gut = erzeugeCookie(PERSON, jetzt);
    const [id, ablauf, sid, sig] = gut.split('.') as [string, string, string, string];
    const andere = 'b1000000-0000-4000-8000-000000000002';
    expect(pruefeCookie(gut, jetzt)).toBe(PERSON);
    expect(pruefeCookie(`${andere}.${ablauf}.${sid}.${sig}`)).toBeNull();
    expect(pruefeCookie(`${id}.${Number(ablauf) + 1}.${sid}.${sig}`)).toBeNull();
    const fremdeSid = erzeugeCookie(PERSON, jetzt).split('.')[2]!;
    expect(pruefeCookie(`${id}.${ablauf}.${fremdeSid}.${sig}`)).toBeNull();
    const anderesZeichen = sig.endsWith('A') ? 'B' : 'A';
    expect(pruefeCookie(`${id}.${ablauf}.${sid}.${sig.slice(0, -1)}${anderesZeichen}`)).toBeNull();
    expect(pruefeCookie(gut, jetzt + DAUER_MS + 1)).toBeNull();
    expect(pruefeCookie(`${id}.${ablauf}.${sid}`)).toBeNull();
    expect(pruefeCookie(`${id}.abc.${sid}.${sig}`)).toBeNull();
    expect(pruefeCookie('x'.repeat(600))).toBeNull();
    vi.stubEnv('SESSION_SECRET', randomBytes(32).toString('hex'));
    expect(pruefeCookie(gut)).toBeNull();
  });

  it('Abmelden beendet die Sitzung serverseitig: derselbe Cookie-Wert gilt danach nicht mehr', () => {
    vi.stubEnv('SESSION_SECRET', GEHEIM);
    const eins = erzeugeCookie(PERSON);
    const zwei = erzeugeCookie(PERSON);
    beendeCookie(eins);
    expect(pruefeCookie(eins)).toBeNull();
    // Andere Sitzungen derselben Person bleiben bestehen.
    expect(pruefeCookie(zwei)).toBe(PERSON);
  });

  it('ein korrekt signierter Wert ohne Eintrag im Register gilt nicht (z. B. nach Neustart)', () => {
    vi.stubEnv('SESSION_SECRET', GEHEIM);
    const wert = erzeugeCookie(PERSON);
    const register = (globalThis as Record<symbol, Map<string, number>>)[
      Symbol.for('tcms.demo.sitzungen')
    ]!;
    register.clear();
    expect(pruefeCookie(wert)).toBeNull();
  });

  it('Abmelden mit manipuliertem Wert beendet keine fremde Sitzung', () => {
    vi.stubEnv('SESSION_SECRET', GEHEIM);
    const wert = erzeugeCookie(PERSON);
    const [id, ablauf, sid] = wert.split('.') as [string, string, string, string];
    beendeCookie(`${id}.${ablauf}.${sid}.${'A'.repeat(43)}`);
    expect(pruefeCookie(wert)).toBe(PERSON);
  });
});
