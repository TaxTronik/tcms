// Der gemeinsame Vertragshelfer (vertrag.ts) selbst: Er muss ungeplante
// Felder, falsche Typen, falschen Status und kaputte Umschläge erkennen,
// sonst wären die Prüfungen in allen API-Tests wirkungslos.

import { ENDPUNKTE } from '@tcms/contract';
import { describe, expect, it } from 'vitest';
import { pruefeAntwortGegenVertrag, VertragsVerletzung } from './vertrag';
import { aufbau, bestaetigtSenden, json } from './hilfen';

const health = ENDPUNKTE.health;
const gut = { ok: true, daten: { version: '0.1.0', datenbank: 'ok' } };

describe('Vertragsprüfung der Antworten', () => {
  it('lässt eine vertragsgemäße Antwort durch', () => {
    expect(() => pruefeAntwortGegenVertrag(health, 200, gut, 'GET /v1/health')).not.toThrow();
  });

  it('erkennt ungeplante Felder, falsche Typen und falschen Status', () => {
    const extra = { ok: true, daten: { ...gut.daten, intern: 'x' } };
    expect(() => pruefeAntwortGegenVertrag(health, 200, extra, 'w')).toThrow(VertragsVerletzung);
    const typ = { ok: true, daten: { version: 1, datenbank: 'ok' } };
    expect(() => pruefeAntwortGegenVertrag(health, 200, typ, 'w')).toThrow(/version: invalid_type/);
    expect(() => pruefeAntwortGegenVertrag(health, 201, gut, 'w')).toThrow(/Status 201 statt 200/);
  });

  it('prüft die Umschläge von Erfolg und Fehler', () => {
    expect(() => pruefeAntwortGegenVertrag(health, 200, { ...gut, x: 1 }, 'w')).toThrow(
      /Erfolgsumschlag/,
    );
    const fehler = { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } };
    expect(() => pruefeAntwortGegenVertrag(health, 404, fehler, 'w')).not.toThrow();
    const unbekannt = { ok: false, fehler: { code: 'GEHEIM', stack: 'x' } };
    expect(() => pruefeAntwortGegenVertrag(health, 500, unbekannt, 'w')).toThrow(/Fehlerumschlag/);
  });

  it('meldet keine Werte, nur Pfade und Codes', () => {
    const geheim = 'sehr-geheimer-wert-123';
    try {
      pruefeAntwortGegenVertrag(health, 200, { ok: true, daten: { version: 1, geheim } }, 'w');
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(geheim);
    }
  });

  it('greift in jeder Test-App über aufbau() (eingebaute Route ich)', async () => {
    const t = aufbau();
    const r = await bestaetigtSenden(t.app, { ziel: '/v1/ich' });
    expect(r.status).toBe(200);
    expect((await json(r))['ok']).toBe(true);
    // Eine Route, deren Ergebnis nicht zum Register passt, fällt im Test auf.
    const kaputt = aufbau({
      routen: (r) =>
        r.endpunkt(ENDPUNKTE.kontakteLesen, async () => ({ kontakte: 'falsch' }) as never),
    });
    await expect(
      bestaetigtSenden(kaputt.app, {
        ziel: '/v1/mandanten/3c3c3c3c-3333-4333-8333-33333333abcd/kontakte',
      }),
    ).rejects.toThrow(/antwortSchema von kontakteLesen/);
  });
});
