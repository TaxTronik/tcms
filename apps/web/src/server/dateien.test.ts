import { describe, expect, it } from 'vitest';
import { AnlageVerweisSchema, gueltigerNachweisDateiname } from '@tcms/contract';
import {
  auslieferungsTyp,
  dateinameBereinigt,
  dispositionsname,
  downloadAntwort,
  downloadMeldung,
  mimeBereinigt,
} from './dateien';

// Dateinamen und MIME-Typen beim Annehmen (Nachweise und Portal-Anlagen, eine
// Regel) und die Antworten beider Download-Routen (Befunde 72 und 122).

const z = (...cps: number[]) => String.fromCodePoint(...cps);
const SHA = 'a'.repeat(64);

describe('dateinameBereinigt', () => {
  it.each([
    ['Rechnung.pdf', 'Rechnung.pdf'],
    ['C:\\Users\\x\\Bericht Q3.xlsx', 'Bericht Q3.xlsx'],
    ['../../etc/passwd', 'passwd'],
    ['  Vertrag "final".pdf  ', 'Vertrag final.pdf'],
    // Weicher Trennstrich (Cf), Variantenselektor (Default_Ignorable), Richtungszeichen.
    [`Rech${z(0xad)}nung ${z(0x2714, 0xfe0f)}.pdf`, `Rechnung ${z(0x2714)}.pdf`],
    [`Rechnung${z(0x202e)}fdp.exe`, 'Rechnungfdp.exe'],
    [`Ü${z(0x200b)}bersicht.xlsx`, 'Übersicht.xlsx'],
  ])('„%s“ → „%s“', (roh, sauber) => {
    expect(dateinameBereinigt(roh, 'Anlage')).toBe(sauber);
  });

  it('ohne gültigen Rest: Ersatzname', () => {
    expect(dateinameBereinigt('', 'Anlage')).toBe('Anlage');
    expect(dateinameBereinigt('..', 'Nachweis')).toBe('Nachweis');
    expect(dateinameBereinigt(`${z(0x200b)}${z(0x202e)}`, 'Anlage')).toBe('Anlage');
    expect(dateinameBereinigt('ordner/', 'Anlage')).toBe('Anlage');
  });

  it('kürzt nach Code Points: kein geteiltes Surrogatpaar, Ergebnis immer gültig', () => {
    const lang = `${'a'.repeat(179)}${z(0x1f600)}${'b'.repeat(50)}.pdf`;
    const sauber = dateinameBereinigt(lang, 'Anlage');
    expect(Array.from(sauber)).toHaveLength(180);
    expect(sauber.endsWith(z(0x1f600))).toBe(true);
    expect(gueltigerNachweisDateiname(sauber)).toBe(true);
  });

  it('jedes Ergebnis besteht das Vertragsschema der Anlagen', () => {
    for (const roh of [
      `x${z(0xfeff)}.pdf`,
      `${z(0xd800)}.pdf`,
      `a${z(0x2066)}b${z(0x2069)}.pdf`,
      'x'.repeat(400),
      'normal.pdf',
    ]) {
      const dateiname = dateinameBereinigt(roh, 'Anlage');
      const v = AnlageVerweisSchema.safeParse({
        dokumentId: `${SHA.slice(0, 2)}/${SHA}`,
        dateiname,
        mime: 'application/pdf',
        groesse: 1,
        sha256: SHA,
      });
      expect(v.success, dateiname).toBe(true);
    }
  });
});

describe('mimeBereinigt und auslieferungsTyp', () => {
  it('gültige Typen bleiben (klein geschrieben), ungültige werden octet-stream', () => {
    expect(mimeBereinigt('Application/PDF')).toBe('application/pdf');
    expect(mimeBereinigt('')).toBe('application/octet-stream');
    expect(mimeBereinigt('text/plain; charset=utf-8')).toBe('application/octet-stream');
    expect(mimeBereinigt('x'.repeat(130))).toBe('application/octet-stream');
  });

  it.each([
    'text/html',
    'TEXT/HTML',
    'text/html; charset=utf-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
    'application/javascript',
    'text/javascript',
    '',
    'kaputt',
  ])('liefert „%s“ nur als application/octet-stream aus', (mime) => {
    expect(auslieferungsTyp(mime)).toBe('application/octet-stream');
  });

  it('harmlose Typen unverändert', () => {
    expect(auslieferungsTyp('application/pdf')).toBe('application/pdf');
    expect(auslieferungsTyp('image/png')).toBe('image/png');
  });
});

describe('Download-Antworten (beide Routen)', () => {
  it('Content-Disposition immer attachment, ASCII-Ersatz und RFC 5987', () => {
    expect(dispositionsname('Übersicht "Q3".pdf')).toBe(
      `attachment; filename="_bersicht _Q3_.pdf"; filename*=UTF-8''%C3%9Cbersicht%20%22Q3%22.pdf`,
    );
    expect(dispositionsname('a\\b\r\n.pdf')).toMatch(/^attachment; filename="a_b__\.pdf";/);
  });

  it('Erfolg: Sandbox-CSP, nosniff, no-store, attachment, Hash', async () => {
    const r = downloadAntwort(
      Buffer.from('<svg onload="alert(1)"/>'),
      { dateiname: 'bild.svg', mime: 'image/svg+xml', sha256: SHA },
      'X-Nachweis-SHA256',
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(r.headers.get('content-length')).toBe('24');
    expect(r.headers.get('x-nachweis-sha256')).toBe(SHA);
    expect(await r.text()).toBe('<svg onload="alert(1)"/>');
  });

  it('Fehlermeldungen tragen dieselben Schutz-Kopfzeilen', async () => {
    const r = downloadMeldung(404, 'Nicht gefunden.');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await r.text()).toBe('Nicht gefunden.');
  });
});
