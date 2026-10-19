import { describe, expect, it } from 'vitest';
import { parseJsonObjektStrikt, parseJsonStrikt } from '../json';

const bytes = (s: string) => new TextEncoder().encode(s);
const lies = (s: string) => parseJsonStrikt(bytes(s));

describe('parseJsonStrikt', () => {
  it('liest gültiges JSON aller Arten', () => {
    expect(lies('{"a":[1,{"b":null}],"c":"x"}')).toEqual({
      ok: true,
      wert: { a: [1, { b: null }], c: 'x' },
    });
    expect(lies('[1,2]')).toEqual({ ok: true, wert: [1, 2] });
    expect(lies('"x"')).toEqual({ ok: true, wert: 'x' });
  });

  it('trennt gleichnamige Schlüssel verschiedener Objekte', () => {
    expect(lies('[{"a":1},{"a":2}]').ok).toBe(true);
    expect(lies('{"a":{"a":{"a":1}},"b":{"a":2}}').ok).toBe(true);
  });

  it('lässt sich von Anführungszeichen, Doppelpunkten und Klammern in Strings nicht täuschen', () => {
    expect(lies('{"a":"x\\":{\\"a\\":1","b":"}{[","c":"\\\\"}').ok).toBe(true);
    expect(lies('{"a":"\\\\","a":1}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies('{"a" : 1, "a"\n:\t2}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
  });

  it('weist doppelte Schlüssel ab, auch verschachtelt und escaped', () => {
    expect(lies('{"a":1,"a":2}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies('{"x":[{"a":1,"b":2,"a":3}]}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies(String.raw`{"sub":1,"s\u0075b":2}`)).toEqual({ ok: false, grund: 'SCHLUESSEL' });
  });

  it('weist __proto__ als Schlüssel ab, auch escaped und verschachtelt', () => {
    expect(lies('{"__proto__":{}}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies(String.raw`{"\u005f_proto__":1}`)).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies('{"a":[{"__proto__":null}]}')).toEqual({ ok: false, grund: 'SCHLUESSEL' });
    expect(lies('{"a":"__proto__"}').ok).toBe(true);
  });

  it('weist ungültiges UTF-8 und ein BOM ab', () => {
    expect(parseJsonStrikt(new Uint8Array([0x22, 0xc3, 0x22]))).toEqual({
      ok: false,
      grund: 'UTF8',
    });
    expect(lies('\ufeff{}')).toEqual({ ok: false, grund: 'JSON' });
  });

  it('übersteht tiefe Verschachtelung bis 256 KiB ohne Stack-Überlauf', () => {
    const n = 128 * 1024;
    expect(lies('['.repeat(n) + ']'.repeat(n)).ok).toBe(true);
    expect(lies('{"a":'.repeat(40_000) + '1' + '}'.repeat(40_000)).ok).toBe(true);
  });
});

describe('parseJsonObjektStrikt', () => {
  it('verlangt ein Objekt', () => {
    expect(parseJsonObjektStrikt(bytes('{"a":1}'))).toEqual({ a: 1 });
    for (const s of ['[]', 'null', '1', '"x"', '{"a":1,"a":1}']) {
      expect(parseJsonObjektStrikt(bytes(s)), s).toBeNull();
    }
  });
});
