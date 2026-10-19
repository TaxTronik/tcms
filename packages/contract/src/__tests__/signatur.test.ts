import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AKTEUR_TYP, akteurAusClaims, type AkteurClaims } from '../akteur';
import {
  bodySha256,
  parsePrivatenSchluessel,
  parseSchluesselListe,
  pruefeAkteur,
  signiereAkteur,
  type AnfrageMerkmale,
  type PruefGrund,
} from '../signatur';

// Feste Testwerte; Schlüssel werden je Lauf frisch erzeugt (keine echten Werte).
const JETZT = new Date('2026-10-19T10:00:00.000Z');
const JETZT_S = JETZT.getTime() / 1000;
const LEER_HASH = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const MANDANT = '33333333-3333-4333-8333-333333333333';
const PFAD = `/v1/mandanten/${MANDANT}/risiken?stand=2026-10-16&art=offen`;
const BODY = new TextEncoder().encode('{"titel":"Lieferschwelle"}');

const a = generateKeyPairSync('ed25519');
const b = generateKeyPairSync('ed25519');
// Fremde Schlüsseltypen einmal je Lauf (RSA-Erzeugung ist langsam).
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EC = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const X25519 = generateKeyPairSync('x25519');
const SCHLUESSEL = new Map<string, KeyObject>([
  ['kk-a', a.publicKey],
  ['kk-b', b.publicKey],
]);

function anfrage(over: Partial<AnfrageMerkmale> = {}): AnfrageMerkmale {
  return { methode: 'POST', pfad: PFAD, bodySha256: bodySha256(BODY), ...over };
}

function claims(over: Partial<AkteurClaims> = {}): AkteurClaims {
  return {
    iss: 'kanzleikonsole',
    aud: 'tcms',
    iat: JETZT_S - 5,
    exp: JETZT_S + 55,
    jti: 'abcdefghijklmnopqrstuv',
    tnt: TENANT,
    sub: PERSON,
    knd: 'KANZLEI',
    nam: 'StB Dr. Anna Roth',
    rol: { adm: true, bt: true },
    cli: { id: MANDANT, bt: true, hb: false },
    req: { m: 'POST', p: PFAD, b: bodySha256(BODY) },
    ...over,
  };
}

function token(c: AkteurClaims = claims(), kid = 'kk-a', key: KeyObject = a.privateKey): string {
  return signiereAkteur(c, { kid, privateKey: key });
}

function pruefe(t: string, over: Partial<AnfrageMerkmale> = {}, jetzt: Date = JETZT) {
  return pruefeAkteur(t, { schluessel: SCHLUESSEL, jetzt, anfrage: anfrage(over) });
}

function grund(t: string, over: Partial<AnfrageMerkmale> = {}, jetzt: Date = JETZT): PruefGrund {
  const e = pruefe(t, over, jetzt);
  if (e.ok) throw new Error('Token wurde akzeptiert');
  return e.grund;
}

const b64u = (s: string | Uint8Array) =>
  (typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s)).toString('base64url');

/**
 * Baut ein Token aus beliebigem Header- und Payload-Text und signiert es
 * korrekt. So scheitert ein Negativtest nur an der geprüften Eigenschaft,
 * nicht an der Signatur.
 */
function roh(headerText: string, payloadText: string | Uint8Array, key = a.privateKey): string {
  const h = b64u(headerText);
  const p = b64u(payloadText);
  const s = sign(null, Buffer.from(`${h}.${p}`, 'ascii'), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

const HEADER = JSON.stringify({ alg: 'EdDSA', typ: AKTEUR_TYP, kid: 'kk-a' });
const header = (h: Record<string, unknown>) => JSON.stringify(h);

describe('bodySha256', () => {
  it('liefert base64url ohne Padding mit 43 Zeichen', () => {
    expect(bodySha256(new Uint8Array())).toBe(LEER_HASH);
    expect(bodySha256(BODY)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('pruefeAkteur – gültige Bestätigungen', () => {
  it('akzeptiert eine korrekt signierte Kanzlei-Bestätigung', () => {
    const e = pruefe(token());
    expect(e).toEqual({ ok: true, claims: claims() });
  });

  it('akzeptiert eine Mandanten-Bestätigung mit cli ohne bt/hb', () => {
    const c = claims({
      knd: 'MANDANT',
      rol: undefined,
      cli: { id: MANDANT, bt: false, hb: false },
    });
    delete c.rol;
    expect(pruefe(token(c)).ok).toBe(true);
  });

  it('akzeptiert beide Schlüssel während der Rotation', () => {
    expect(pruefe(token(claims(), 'kk-a', a.privateKey)).ok).toBe(true);
    expect(pruefe(token(claims(), 'kk-b', b.privateKey)).ok).toBe(true);
  });

  it('akzeptiert die Grenzwerte: exp-iat = 120, iat = jetzt + 30, exp = jetzt + 1', () => {
    expect(pruefe(token(claims({ iat: JETZT_S - 60, exp: JETZT_S + 60 }))).ok).toBe(true);
    expect(pruefe(token(claims({ iat: JETZT_S + 30, exp: JETZT_S + 90 }))).ok).toBe(true);
    expect(pruefe(token(claims({ iat: JETZT_S - 10, exp: JETZT_S + 1 }))).ok).toBe(true);
  });

  it('akzeptiert einen leeren Body mit dem Hash des leeren Strings', () => {
    const c = claims({ req: { m: 'GET', p: '/v1/ich', b: LEER_HASH } });
    const e = pruefe(token(c), { methode: 'GET', pfad: '/v1/ich', bodySha256: LEER_HASH });
    expect(e.ok).toBe(true);
  });
});

describe('pruefeAkteur – Größe und Struktur', () => {
  it('weist leere und fehlende Tokens ab', () => {
    expect(grund('')).toBe('GROESSE');
    expect(grund(undefined as unknown as string)).toBe('GROESSE');
  });

  it('weist ein korrekt signiertes Token über 4 KiB allein wegen der Größe ab', () => {
    // nam aus 3-Byte-Zeichen und langer Pfad: Claims bleiben gültig, Token > 4096.
    const p = `/v1/${'x'.repeat(2040)}`;
    const c = claims({ nam: '€'.repeat(200), req: { m: 'POST', p, b: bodySha256(BODY) } });
    const t = roh(HEADER, JSON.stringify(c));
    expect(t.length).toBeGreaterThan(4096);
    expect(grund(t, { pfad: p })).toBe('GROESSE');
  });

  it('weist sehr große Eingaben sofort ab', () => {
    expect(grund('a'.repeat(1024 * 1024))).toBe('GROESSE');
    expect(grund(`${token()}${'A'.repeat(4097)}`)).toBe('GROESSE');
  });

  it('weist falsche Teilezahl ab', () => {
    const [h, p, s] = token().split('.');
    expect(grund(`${h}.${p}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p}.${s}.`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p}.${s}.${s}`)).toBe('STRUKTUR');
    expect(grund(`.${p}.${s}`)).toBe('STRUKTUR');
  });

  it('weist base64url mit Padding ab', () => {
    // Payload so wählen, dass die Länge nicht durch 3 teilbar ist (Padding möglich).
    let c = claims();
    for (let n = 0; Buffer.byteLength(JSON.stringify(c)) % 3 === 0; n++) {
      c = claims({ nam: `Anna Roth${'x'.repeat(n + 1)}` });
    }
    const [h, p, s] = roh(HEADER, JSON.stringify(c)).split('.') as [string, string, string];
    const gepadded = Buffer.from(p, 'base64url').toString('base64').replace(/[^=]/g, '');
    expect(gepadded.length).toBeGreaterThan(0);
    expect(grund(`${h}.${p}${gepadded}.${s}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p}.${s}==`)).toBe('STRUKTUR');
  });

  it('weist + und / statt - und _ ab', () => {
    const t = token();
    const [h, p, s] = t.split('.') as [string, string, string];
    // Signatur mit Standard-base64-Alphabet: gleiche Bytes, andere Zeichen.
    const sStd = Buffer.from(s, 'base64url').toString('base64').replace(/=+$/, '');
    if (sStd !== s) expect(grund(`${h}.${p}.${sStd}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p.slice(0, -1)}+.${s}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p.slice(0, -1)}/.${s}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p} .${s}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p}.${s.slice(0, -1)}%`)).toBe('STRUKTUR');
  });

  it('weist eine nicht kanonische Signatur-Kodierung mit denselben Bytes ab', () => {
    // 64 Bytes → 86 Zeichen, das letzte Zeichen trägt 4 ungenutzte Bits.
    const [h, p, s] = token().split('.') as [string, string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const letztes = alphabet.indexOf(s.at(-1)!);
    const variante = `${s.slice(0, -1)}${alphabet[letztes | 0b0001]}`;
    expect(variante).not.toBe(s);
    expect(Buffer.from(variante, 'base64url').equals(Buffer.from(s, 'base64url'))).toBe(true);
    expect(grund(`${h}.${p}.${variante}`)).toBe('STRUKTUR');
  });

  it('weist eine nicht kanonische Payload-Kodierung ab', () => {
    let c = claims();
    for (let n = 0; Buffer.byteLength(JSON.stringify(c)) % 3 === 0; n++) {
      c = claims({ nam: `Anna Roth${'y'.repeat(n + 1)}` });
    }
    const [h, p, s] = roh(HEADER, JSON.stringify(c)).split('.') as [string, string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variante = `${p.slice(0, -1)}${alphabet[alphabet.indexOf(p.at(-1)!) | 1]}`;
    expect(variante).not.toBe(p);
    expect(Buffer.from(variante, 'base64url').equals(Buffer.from(p, 'base64url'))).toBe(true);
    expect(grund(`${h}.${variante}.${s}`)).toBe('STRUKTUR');
  });

  it('weist eine Signatur mit falscher Länge ab', () => {
    const [h, p] = token().split('.');
    expect(grund(`${h}.${p}.${b64u(new Uint8Array(63))}`)).toBe('STRUKTUR');
    expect(grund(`${h}.${p}.${b64u(new Uint8Array(65))}`)).toBe('STRUKTUR');
  });

  it('weist einen Header ab, der kein JSON-Objekt ist', () => {
    const p = JSON.stringify(claims());
    for (const h of ['[]', 'null', '"EdDSA"', '1', '{', `\ufeff${HEADER}`]) {
      expect(grund(roh(h, p))).toBe('STRUKTUR');
    }
  });

  it('weist doppelte Schlüssel im Header ab, auch escaped', () => {
    const p = JSON.stringify(claims());
    const doppelt = `{"alg":"EdDSA","typ":"${AKTEUR_TYP}","kid":"kk-unbekannt","kid":"kk-a"}`;
    expect(grund(roh(doppelt, p))).toBe('STRUKTUR');
    const escaped = `{"alg":"none","typ":"${AKTEUR_TYP}","kid":"kk-a","\\u0061lg":"EdDSA"}`;
    expect(grund(roh(escaped, p))).toBe('STRUKTUR');
  });
});

describe('pruefeAkteur – Header', () => {
  const p = JSON.stringify(claims());

  it('weist alg none ab (ohne und mit gültiger Ed25519-Signatur)', () => {
    const h = b64u(header({ alg: 'none', typ: AKTEUR_TYP, kid: 'kk-a' }));
    expect(grund(`${h}.${b64u(p)}.`)).toBe('STRUKTUR');
    expect(grund(roh(header({ alg: 'none', typ: AKTEUR_TYP, kid: 'kk-a' }), p))).toBe('HEADER');
  });

  it('weist HS256 ab: HMAC mit dem öffentlichen Schlüssel als Geheimnis und mit Ed25519-Signatur', () => {
    const hText = header({ alg: 'HS256', typ: AKTEUR_TYP, kid: 'kk-a' });
    const h = b64u(hText);
    const geheim = a.publicKey.export({ format: 'der', type: 'spki' });
    const mac = createHmac('sha256', geheim)
      .update(`${h}.${b64u(p)}`)
      .digest('base64url');
    expect(grund(`${h}.${b64u(p)}.${mac}`)).toBe('STRUKTUR');
    const mac512 = createHmac('sha512', geheim)
      .update(`${h}.${b64u(p)}`)
      .digest('base64url');
    expect(grund(`${h}.${b64u(p)}.${mac512}`)).toBe('HEADER');
    expect(grund(roh(hText, p))).toBe('HEADER');
  });

  it('weist fehlendes alg und andere Schreibweisen ab', () => {
    expect(grund(roh(header({ typ: AKTEUR_TYP, kid: 'kk-a' }), p))).toBe('HEADER');
    expect(grund(roh(header({ alg: 'eddsa', typ: AKTEUR_TYP, kid: 'kk-a' }), p))).toBe('HEADER');
    expect(grund(roh(header({ alg: 'Ed25519', typ: AKTEUR_TYP, kid: 'kk-a' }), p))).toBe('HEADER');
  });

  it('weist falschen oder fehlenden typ ab', () => {
    expect(grund(roh(header({ alg: 'EdDSA', typ: 'JWT', kid: 'kk-a' }), p))).toBe('HEADER');
    expect(grund(roh(header({ alg: 'EdDSA', kid: 'kk-a' }), p))).toBe('HEADER');
  });

  it('weist zusätzliche Header-Felder ab (jku, crit, jwk)', () => {
    for (const extra of [{ jku: 'https://x' }, { crit: ['b64'] }, { jwk: {} }]) {
      expect(grund(roh(header({ alg: 'EdDSA', typ: AKTEUR_TYP, kid: 'kk-a', ...extra }), p))).toBe(
        'HEADER',
      );
    }
  });

  it('weist einen unbekannten kid ab', () => {
    expect(grund(token(claims(), 'kk-x'))).toBe('KID_UNBEKANNT');
    expect(grund(roh(header({ alg: 'EdDSA', typ: AKTEUR_TYP, kid: '__proto__' }), p))).toBe(
      'KID_UNBEKANNT',
    );
  });

  it('weist einen Schlüssel ab, der kein öffentlicher Ed25519-Schlüssel ist', () => {
    const rsa = RSA;
    const t = token();
    const opts = { jetzt: JETZT, anfrage: anfrage() };
    for (const k of [rsa.publicKey, a.privateKey]) {
      const e = pruefeAkteur(t, { ...opts, schluessel: new Map([['kk-a', k]]) });
      expect(e).toEqual({ ok: false, grund: 'SCHLUESSEL_TYP' });
    }
  });
});

describe('pruefeAkteur – Signatur', () => {
  it('weist die Signatur eines anderen Schlüssels unter bekanntem kid ab', () => {
    expect(grund(token(claims(), 'kk-a', b.privateKey))).toBe('SIGNATUR');
    const fremd = generateKeyPairSync('ed25519');
    expect(grund(token(claims(), 'kk-a', fremd.privateKey))).toBe('SIGNATUR');
  });

  it('weist jede Manipulation eines einzelnen Payload-Bytes ab', () => {
    const [h, p, s] = token().split('.') as [string, string, string];
    const bytes = Buffer.from(p, 'base64url');
    for (let i = 0; i < bytes.length; i++) {
      for (const maske of [0x01, 0x80]) {
        const kopie = Buffer.from(bytes);
        kopie[i] = kopie[i]! ^ maske;
        expect(grund(`${h}.${kopie.toString('base64url')}.${s}`)).toBe('SIGNATUR');
      }
    }
  });

  it('weist manipulierte Header ab: anderer kid, andere Schreibweise, einzelne Bytes', () => {
    const [, p, s] = token().split('.') as [string, string, string];
    const umgehaengt = b64u(header({ alg: 'EdDSA', typ: AKTEUR_TYP, kid: 'kk-b' }));
    expect(grund(`${umgehaengt}.${p}.${s}`)).toBe('SIGNATUR');
    const leerzeichen = b64u(`{"alg": "EdDSA","typ":"${AKTEUR_TYP}","kid":"kk-a"}`);
    expect(grund(`${leerzeichen}.${p}.${s}`)).toBe('SIGNATUR');
    const hBytes = Buffer.from(token().split('.')[0]!, 'base64url');
    for (let i = 0; i < hBytes.length; i++) {
      const kopie = Buffer.from(hBytes);
      kopie[i] = kopie[i]! ^ 0x01;
      expect(pruefe(`${kopie.toString('base64url')}.${p}.${s}`).ok).toBe(false);
    }
  });

  it('weist ein manipuliertes Signatur-Byte ab', () => {
    const [h, p, s] = token().split('.') as [string, string, string];
    const bytes = Buffer.from(s, 'base64url');
    for (const i of [0, 31, 32, 63]) {
      const kopie = Buffer.from(bytes);
      kopie[i] = kopie[i]! ^ 0x01;
      expect(grund(`${h}.${p}.${kopie.toString('base64url')}`)).toBe('SIGNATUR');
    }
  });
});

describe('pruefeAkteur – Payload und Claims', () => {
  it('weist einen Payload ab, der kein UTF-8-JSON-Objekt ist', () => {
    for (const p of ['[]', 'null', '"x"', '42', '{"iss":', `\ufeff${JSON.stringify(claims())}`]) {
      expect(grund(roh(HEADER, p))).toBe('PAYLOAD');
    }
    expect(grund(roh(HEADER, new Uint8Array([0x7b, 0xff, 0x7d])))).toBe('PAYLOAD');
  });

  it('weist ungültiges UTF-8 innerhalb eines JSON-Strings ab (sonst U+FFFD im Namen)', () => {
    const [vor, nach] = JSON.stringify(claims({ nam: 'Anna#Roth' })).split('#') as [string, string];
    const bytes = Buffer.concat([Buffer.from(vor), Buffer.from([0xff]), Buffer.from(nach)]);
    expect(grund(roh(HEADER, bytes))).toBe('PAYLOAD');
    // Gegenprobe: dieselben Claims mit gültigem Zeichen werden akzeptiert.
    expect(pruefe(roh(HEADER, JSON.stringify(claims({ nam: 'Anna�Roth' })))).ok).toBe(true);
  });

  it('weist doppelte Claims ab, auch escaped und verschachtelt', () => {
    const json = JSON.stringify(claims());
    const doppelt = json.replace('{', `{"sub":"${MANDANT}",`);
    expect(grund(roh(HEADER, doppelt))).toBe('PAYLOAD');
    const escaped = json.replace('{', `{"s\\u0075b":"${MANDANT}",`);
    expect(grund(roh(HEADER, escaped))).toBe('PAYLOAD');
    const verschachtelt = json.replace('"adm":true', '"adm":false,"adm":true');
    expect(verschachtelt).not.toBe(json);
    expect(grund(roh(HEADER, verschachtelt))).toBe('PAYLOAD');
  });

  it('erkennt gleiche Schlüssel in verschiedenen Objekten nicht als doppelt', () => {
    // rol.bt und cli.bt: gleicher Name, verschiedene Objekte.
    expect(pruefe(roh(HEADER, JSON.stringify(claims()))).ok).toBe(true);
  });

  it('weist falsches iss und aud ab', () => {
    const c = claims() as Record<string, unknown>;
    expect(grund(roh(HEADER, JSON.stringify({ ...c, iss: 'tcms' })))).toBe('CLAIMS');
    expect(grund(roh(HEADER, JSON.stringify({ ...c, aud: 'kanzleikonsole' })))).toBe('CLAIMS');
    expect(grund(roh(HEADER, JSON.stringify({ ...c, aud: ['tcms'] })))).toBe('CLAIMS');
  });

  it('weist zusätzliche Claims ab', () => {
    const json = JSON.stringify(claims());
    expect(grund(roh(HEADER, json.replace('{', '{"admin":true,')))).toBe('CLAIMS');
    expect(grund(roh(HEADER, json.replace('{', '{"constructor":1,')))).toBe('CLAIMS');
    const rolExtra = json.replace('"adm":true', '"adm":true,"su":true');
    expect(grund(roh(HEADER, rolExtra))).toBe('CLAIMS');
  });

  it('weist __proto__ in Payload und Header ab (zod strikt meldet es nicht)', () => {
    const json = JSON.stringify(claims());
    expect(grund(roh(HEADER, json.replace('{', '{"__proto__":{"adm":true},')))).toBe('PAYLOAD');
    expect(grund(roh(HEADER, json.replace('{', String.raw`{"\u005f_proto__":1,`)))).toBe('PAYLOAD');
    const rol = json.replace('"adm":true', '"adm":true,"__proto__":null');
    expect(grund(roh(HEADER, rol))).toBe('PAYLOAD');
    const h = `{"alg":"EdDSA","typ":"${AKTEUR_TYP}","kid":"kk-a","__proto__":{}}`;
    expect(grund(roh(h, json))).toBe('STRUKTUR');
  });

  it('weist jedes fehlende Pflicht-Claim ab', () => {
    for (const feld of ['iss', 'aud', 'iat', 'exp', 'jti', 'tnt', 'sub', 'knd', 'nam', 'req']) {
      const c: Record<string, unknown> = { ...claims() };
      delete c[feld];
      expect(grund(roh(HEADER, JSON.stringify(c))), feld).toBe('CLAIMS');
    }
    const ohneRol: Record<string, unknown> = { ...claims() };
    delete ohneRol.rol;
    expect(grund(roh(HEADER, JSON.stringify(ohneRol)))).toBe('CLAIMS');
  });

  it('weist MANDANT ohne cli, mit rol und mit bt/hb ab', () => {
    const basis: Record<string, unknown> = { ...claims(), knd: 'MANDANT' };
    delete basis.rol;
    const ohneCli = { ...basis };
    delete ohneCli.cli;
    expect(grund(roh(HEADER, JSON.stringify(ohneCli)))).toBe('CLAIMS');
    const mitRol = {
      ...basis,
      rol: { adm: false, bt: false },
      cli: { id: MANDANT, bt: false, hb: false },
    };
    expect(grund(roh(HEADER, JSON.stringify(mitRol)))).toBe('CLAIMS');
    const mitBt = { ...basis, cli: { id: MANDANT, bt: true, hb: false } };
    expect(grund(roh(HEADER, JSON.stringify(mitBt)))).toBe('CLAIMS');
    const gueltig = { ...basis, cli: { id: MANDANT, bt: false, hb: false } };
    expect(pruefe(roh(HEADER, JSON.stringify(gueltig))).ok).toBe(true);
  });

  it('akzeptiert SYSTEM nur ohne rol und cli (keine verdeckte Person, kein Mandantenpfad)', () => {
    const basis: Record<string, unknown> = { ...claims(), knd: 'SYSTEM', nam: 'Zustellung' };
    delete basis.rol;
    delete basis.cli;
    const gueltig = pruefe(roh(HEADER, JSON.stringify(basis)));
    expect(gueltig.ok).toBe(true);
    for (const over of [
      { rol: { adm: true, bt: true } },
      { rol: { adm: false, bt: false } },
      { cli: { id: MANDANT, bt: false, hb: false } },
      { rol: { adm: false, bt: false }, cli: { id: MANDANT, bt: false, hb: false } },
    ]) {
      expect(grund(roh(HEADER, JSON.stringify({ ...basis, ...over }))), JSON.stringify(over)).toBe(
        'CLAIMS',
      );
    }
    // Auch der Signierer der kanzleikonsole erzeugt kein solches Token.
    expect(() =>
      signiereAkteur(
        { ...(basis as AkteurClaims), rol: { adm: true, bt: false } },
        {
          kid: 'kk-a',
          privateKey: a.privateKey,
        },
      ),
    ).toThrow();
  });

  it('weist exp - iat > 120 und exp ≤ iat ab', () => {
    const c = (iat: number, exp: number) => JSON.stringify(claims({ iat, exp }));
    expect(grund(roh(HEADER, c(JETZT_S - 60, JETZT_S + 61)))).toBe('CLAIMS');
    expect(grund(roh(HEADER, c(JETZT_S, JETZT_S)))).toBe('CLAIMS');
    expect(grund(roh(HEADER, c(JETZT_S + 10, JETZT_S + 5)))).toBe('CLAIMS');
  });

  it('weist ungültige Werte ab (UUID, jti, nam, Typen)', () => {
    const c = claims() as Record<string, unknown>;
    for (const over of [
      { tnt: 'nicht-uuid' },
      { sub: `${PERSON}x` },
      { jti: 'kurz' },
      { jti: 'a'.repeat(65) },
      { jti: 'abcdefghijklmnopqrstu=' },
      { nam: '   ' },
      { nam: 'x'.repeat(201) },
      { iat: JETZT_S + 0.5 },
      { exp: String(JETZT_S + 60) },
      { knd: 'ADMIN' },
      { knd: 'system' },
    ]) {
      expect(grund(roh(HEADER, JSON.stringify({ ...c, ...over }))), JSON.stringify(over)).toBe(
        'CLAIMS',
      );
    }
  });
});

describe('pruefeAkteur – Zeitfenster', () => {
  it('weist abgelaufene Bestätigungen ab (exp = jetzt gilt als abgelaufen)', () => {
    expect(grund(token(claims({ iat: JETZT_S - 60, exp: JETZT_S })))).toBe('ABGELAUFEN');
    expect(grund(token(claims({ iat: JETZT_S - 61, exp: JETZT_S - 1 })))).toBe('ABGELAUFEN');
    expect(grund(token(), {}, new Date(JETZT.getTime() + 55_000))).toBe('ABGELAUFEN');
  });

  it('weist iat mehr als 30 s in der Zukunft ab', () => {
    expect(grund(token(claims({ iat: JETZT_S + 31, exp: JETZT_S + 90 })))).toBe('IAT_ZUKUNFT');
  });

  it('weist eine ungültige Uhr ab (fail closed)', () => {
    for (const jetzt of [new Date(Number.NaN), undefined, null, JETZT.getTime()]) {
      const e = pruefeAkteur(token(), {
        schluessel: SCHLUESSEL,
        jetzt: jetzt as unknown as Date,
        anfrage: anfrage(),
      });
      expect(e).toEqual({ ok: false, grund: 'UHR' });
    }
  });
});

describe('pruefeAkteur – Anfragebindung', () => {
  it('weist eine andere Methode ab (ohne Umwandlung der Schreibweise)', () => {
    expect(grund(token(), { methode: 'PUT' })).toBe('REQ_METHODE');
    expect(grund(token(), { methode: 'post' })).toBe('REQ_METHODE');
  });

  it('weist einen anderen Pfad ab', () => {
    const anderer = PFAD.replace(MANDANT, '44444444-4444-4444-8444-444444444444');
    expect(grund(token(), { pfad: anderer })).toBe('REQ_PFAD');
    expect(grund(token(), { pfad: PFAD.replace('/risiken', '/risiken/') })).toBe('REQ_PFAD');
    expect(grund(token(), { pfad: PFAD.toUpperCase() })).toBe('REQ_PFAD');
  });

  it('weist eine andere, fehlende oder vertauschte Query ab', () => {
    const [pfad, query] = PFAD.split('?') as [string, string];
    expect(grund(token(), { pfad })).toBe('REQ_PFAD');
    expect(grund(token(), { pfad: `${pfad}?stand=2026-10-15&art=offen` })).toBe('REQ_PFAD');
    const vertauscht = `${pfad}?${query.split('&').reverse().join('&')}`;
    expect(vertauscht).not.toBe(PFAD);
    expect(grund(token(), { pfad: vertauscht })).toBe('REQ_PFAD');
  });

  it('weist einen anderen Body ab', () => {
    expect(grund(token(), { bodySha256: bodySha256(new TextEncoder().encode('{}')) })).toBe(
      'REQ_BODY',
    );
    expect(grund(token(), { bodySha256: LEER_HASH })).toBe('REQ_BODY');
  });
});

describe('signiereAkteur', () => {
  it('weist ungeeignete Schlüssel ab', () => {
    const rsa = RSA;
    expect(() => token(claims(), 'kk-a', rsa.privateKey)).toThrow(/Ed25519/);
    expect(() => token(claims(), 'kk-a', a.publicKey)).toThrow(/Ed25519/);
  });

  it('weist ungültige Claims und kid ab', () => {
    expect(() => token(claims({ exp: JETZT_S + 500 }))).toThrow();
    expect(() => token({ ...claims(), extra: 1 } as AkteurClaims)).toThrow();
    expect(() => token(claims(), 'kid mit leerzeichen')).toThrow();
  });

  it('weist Ergebnisse über 4 KiB ab', () => {
    const p = `/v1/${'x'.repeat(2040)}`;
    const c = claims({ nam: '€'.repeat(200), req: { m: 'POST', p, b: bodySha256(BODY) } });
    expect(() => token(c)).toThrow(/4 KiB/);
  });
});

describe('parseSchluesselListe', () => {
  const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');

  it('liest mehrere Ed25519-Schlüssel', () => {
    const liste = parseSchluesselListe(`kk-a=${spki(a.publicKey)}, kk-b=${spki(b.publicKey)}`);
    expect([...liste.keys()]).toEqual(['kk-a', 'kk-b']);
    expect(pruefeAkteur(token(), { schluessel: liste, jetzt: JETZT, anfrage: anfrage() }).ok).toBe(
      true,
    );
  });

  it('weist RSA-, EC- und X25519-Schlüssel ab', () => {
    const rsa = RSA.publicKey;
    const ec = EC.publicKey;
    const x = X25519.publicKey;
    for (const k of [rsa, ec, x]) {
      expect(() => parseSchluesselListe(`kk-a=${spki(a.publicKey)},kk-x=${spki(k)}`)).toThrow(
        /Eintrag 2 ist kein Ed25519-Schlüssel/,
      );
    }
  });

  it('weist leere Listen und leere Einträge ab', () => {
    expect(() => parseSchluesselListe('')).toThrow(/leer/);
    expect(() => parseSchluesselListe('  ')).toThrow(/leer/);
    expect(() => parseSchluesselListe(`kk-a=${spki(a.publicKey)},`)).toThrow(/Eintrag 2 ist leer/);
    expect(() => parseSchluesselListe(`,kk-a=${spki(a.publicKey)}`)).toThrow(/Eintrag 1 ist leer/);
  });

  it('weist doppelte kid und doppelte Schlüssel ab', () => {
    expect(() =>
      parseSchluesselListe(`kk-a=${spki(a.publicKey)},kk-a=${spki(b.publicKey)}`),
    ).toThrow(/doppelt/);
    expect(() =>
      parseSchluesselListe(`kk-a=${spki(a.publicKey)},kk-b=${spki(a.publicKey)}`),
    ).toThrow(/bereits/);
  });

  it('weist ungültige kid, fehlendes = und nicht kanonisches base64 ab', () => {
    const k = spki(a.publicKey);
    // Je nach Zufallsschlüssel scheitert das an der Form, am kid oder am base64.
    expect(() => parseSchluesselListe(k)).toThrow(/Schlüsselliste: Eintrag 1/);
    expect(() => parseSchluesselListe(`=${k}`)).toThrow(/Form/);
    expect(() => parseSchluesselListe(`kk a=${k}`)).toThrow(/kid/);
    expect(() => parseSchluesselListe(`kk-a=${k.replace(/=+$/, '')}`)).toThrow(/base64/);
    expect(() => parseSchluesselListe(`kk-a=_${k.slice(1)}`)).toThrow(/base64/);
    expect(() => parseSchluesselListe(`kk-a=${k.slice(0, -3)}A==`)).toThrow();
    expect(() => parseSchluesselListe(`kk-a=`)).toThrow(/base64/);
  });

  it('weist eine nicht kanonische base64-Schreibweise derselben Schlüsselbytes ab', () => {
    // 44 Bytes SPKI → 60 Zeichen mit einem '='; das letzte Datenzeichen trägt 2 ungenutzte Bits.
    const k = spki(a.publicKey);
    expect(k.endsWith('=') && !k.endsWith('==')).toBe(true);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const letztes = alphabet.indexOf(k.at(-2)!);
    const variante = `${k.slice(0, -2)}${alphabet[letztes | 1]}=`;
    expect(variante).not.toBe(k);
    expect(Buffer.from(variante, 'base64').equals(Buffer.from(k, 'base64'))).toBe(true);
    expect(() => parseSchluesselListe(`kk-a=${variante}`)).toThrow(/kanonisches base64/);
  });

  it('weist privaten Schlüssel und angehängte Bytes ab', () => {
    const pkcs8 = a.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    expect(() => parseSchluesselListe(`kk-a=${pkcs8}`)).toThrow();
    const der = Buffer.concat([
      a.publicKey.export({ format: 'der', type: 'spki' }),
      Buffer.from([0, 0, 0]),
    ]);
    expect(() => parseSchluesselListe(`kk-a=${der.toString('base64')}`)).toThrow();
  });

  it('nennt nie den kid: auch nicht, wenn dort versehentlich Schlüsselmaterial steht', () => {
    // PKCS8 ohne '+' und '/' passt auf das kid-Muster.
    let privat = '';
    for (let i = 0; i < 200 && !/^[A-Za-z0-9]+$/.test(privat); i++) {
      privat = generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
    }
    expect(privat).toMatch(/^[A-Za-z0-9]{64}$/);
    for (const liste of [
      `${privat}=`,
      `${privat}=x`,
      `kk-a=${spki(a.publicKey)},${privat}=${spki(b.publicKey)},${privat}=${spki(b.publicKey)}`,
    ]) {
      try {
        parseSchluesselListe(liste);
        expect.unreachable();
      } catch (e) {
        expect(String(e)).not.toContain(privat.slice(16, 48));
      }
    }
  });

  it('nennt in Fehlermeldungen kein Schlüsselmaterial', () => {
    const rsa = spki(RSA.publicKey);
    try {
      parseSchluesselListe(`kk-r=${rsa}`);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(rsa.slice(0, 20));
    }
  });
});

describe('parsePrivatenSchluessel', () => {
  it('liest PKCS8-Ed25519 und signiert prüfbar', () => {
    const b64 = a.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const k = parsePrivatenSchluessel(b64);
    expect(pruefe(token(claims(), 'kk-a', k)).ok).toBe(true);
  });

  it('weist andere Schlüssel und ungültiges base64 ab, ohne Material zu nennen', () => {
    const rsa = RSA.privateKey;
    const b64 = rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    expect(() => parsePrivatenSchluessel(b64)).toThrow(/kein Ed25519/);
    expect(() => parsePrivatenSchluessel('nicht base64!')).toThrow(/base64/);
    const spkiB64 = a.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    try {
      parsePrivatenSchluessel(spkiB64);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(spkiB64.slice(0, 20));
    }
  });
});

describe('akteurAusClaims', () => {
  it('bildet Kanzlei, Mandant und System auf je eine eigene Variante ab', () => {
    expect(akteurAusClaims(claims())).toEqual({
      art: 'KANZLEI',
      tenantId: TENANT,
      id: PERSON,
      name: 'StB Dr. Anna Roth',
      istAdmin: true,
      istBerufstraeger: true,
      mandant: { id: MANDANT, zustaendigBerufstraeger: true, hauptbearbeitung: false },
    });
    const kontakt = claims({ knd: 'MANDANT', cli: { id: MANDANT, bt: false, hb: false } });
    delete kontakt.rol;
    expect(akteurAusClaims(kontakt)).toEqual({
      art: 'MANDANT',
      tenantId: TENANT,
      id: PERSON,
      name: 'StB Dr. Anna Roth',
      mandantId: MANDANT,
    });
    const system = claims({ knd: 'SYSTEM', nam: 'Zustellung kanzleikonsole' });
    delete system.rol;
    delete system.cli;
    // Nur Art, Tenant, ID und Name: keine Rollen, kein Mandantenbezug.
    expect(akteurAusClaims(system)).toEqual({
      art: 'SYSTEM',
      tenantId: TENANT,
      id: PERSON,
      name: 'Zustellung kanzleikonsole',
    });
  });

  it('weist eine unbekannte Akteursart ab (fail closed)', () => {
    expect(() => akteurAusClaims({ ...claims(), knd: 'ADMIN' } as unknown as AkteurClaims)).toThrow(
      /unbekannte Akteursart/,
    );
  });
});
