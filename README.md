# Tax-CMS

Eigenständige Anwendung für ein Tax Compliance Management System nach IDW PS 980 n.F.,
Stufe 1 mit dem Branchenpaket **E-Commerce**. Kanzlei und Mandant arbeiten im selben System:
Risikoinventar mit Brutto/Netto-Bewertung, Kontrollmatrix mit Häufigkeit aus Governance-Typ
× Bruttoklasse, Kontrolldurchführung mit Nachweisen und Vier-Augen-Gegenzeichnung,
Feststellungen mit §-153-Würdigung, Ereigniseingang, Länder-Monitor, CMS-Beschreibung mit
Freigabe per E-Mail-Code und ein Mandantenportal.

> Stand: lauffähiger Prototyp mit Demodaten. Vor einem Echtbetrieb fehlen u. a. eine echte
> Anmeldung, Mailversand und revisionssichere Ablage (siehe „Grenzen").

## Voraussetzungen

- Node.js 24 (`.nvmrc`; mindestens 22.12)
- pnpm 12.4.1 – `corepack enable` oder `npm install -g pnpm@12.4.1`
- Docker Desktop (für PostgreSQL 16)

## Schnellstart (Windows, PowerShell)

```powershell
cd C:\Users\Rey\Documents\GitHub\tcms
docker compose up -d                 # PostgreSQL auf Port 5433
Copy-Item .env.example .env          # danach SESSION_SECRET in .env ersetzen
pnpm install
pnpm db:generate                     # Prisma-Client erzeugen
pnpm db:deploy                       # Migration einspielen
pnpm db:seed                         # Demodaten (Stichtag 16.10.2026)
pnpm dev                             # http://localhost:3100
```

`pnpm db:seed` setzt die Datenbank jedes Mal vollständig zurück.

## Anmelden in der Demo

`/anmelden` zeigt eine Personenauswahl (Entwicklungs-Anmeldung, `TCMS_DEV_LOGIN=1`).

| Person            | Rolle                                                | gut für                                                                |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Leon Brandt       | Kanzlei, Bearbeitung (alle Mandanten)                | Durchführen, Einreichen, Triage – §-153 ist für ihn gesperrt           |
| StB Dr. Anna Roth | Berufsträgerin, Admin (Talwind, Kleinwerk, Bergkamm) | Gegenzeichnen, §-153-Würdigung, Freigaben als zweite Person, Audit-Log |
| StB Thomas Kern   | Berufsträger (Seestern, Pixelhafen)                  | Kanzlei-Review der Seestern-Beschreibung                               |
| Jana Weller       | Talwind, Geschäftsführerin                           | Freigaben mit E-Mail-Code im Portal                                    |
| Murat Aydin       | Talwind, Tax-Compliance-Beauftragter                 | Kontrollaufgaben, Ereignis melden, Kenntnisnahme                       |
| Sabine Kraus      | Talwind, Buchhaltung                                 | Bestätigung als zweite Person beim Mandanten                           |

Bestätigungscodes landen im **Postausgang (Entwicklung)** unter Administration; im Portal zeigt
die Freigaben-Seite im Entwicklungsmodus zusätzlich die letzte Nachricht an die angemeldete Person.

## Demodaten

| Mandant                      | Zustand                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Talwind Outdoor GmbH         | Phase 6, Wirksamkeitszeitraum Monat 4 von 6: Gegenzeichnungen offen, zwei überfällige Kontrollen, §-153-Würdigung F-2026-007 offen, neue Ereignisse, Beschreibung v1.2 beim Mandanten |
| Seestern Home & Living GmbH  | Phase 4: Beschreibung v1.0 im Kanzlei-Review                                                                                                                                          |
| Kleinwerk Manufaktur UG      | Phase 3: Kontrollen ohne Designbeurteilung, Lieferschwelle bei 84 %                                                                                                                   |
| Pixelhafen Electronics KG    | Phase 7: Wirksamkeitszeitraum 2025 abgeschlossen                                                                                                                                      |
| Bergkamm Kaffeerösterei GmbH | noch kein Tax-CMS – Einrichtungsassistent starten                                                                                                                                     |

`TCMS_DEMO_TODAY=2026-10-16` legt das fachliche „Heute" fest. Leer lassen, damit die App mit dem
echten Datum rechnet. Über den Stichtag-Selektor (`?stand=JJJJ-MM-TT`) lassen sich frühere Stände
schreibgeschützt ansehen.

## Befehle

| Befehl                      | Zweck                                           |
| --------------------------- | ----------------------------------------------- |
| `pnpm dev`                  | Entwicklungsserver auf Port 3100                |
| `pnpm build` / `pnpm start` | Produktionsbuild und -server                    |
| `pnpm typecheck`            | TypeScript in allen Paketen                     |
| `pnpm test`                 | Fachlogik- und Rechtetests (Vitest)             |
| `pnpm db:migrate`           | neue Migration aus Schemaänderung (Entwicklung) |
| `pnpm db:deploy`            | Migrationen einspielen                          |
| `pnpm db:seed`              | Datenbank leeren und Demodaten laden            |

## Aufbau

```
packages/domain   Fachlogik ohne I/O: Katalog E-Commerce, Bewertung, Häufigkeitsmatrix,
                  Statusmodelle, Phasen, Grundelemente, Formatierung (mit Tests)
packages/db       Prisma-Schema und Migration, Client, Audit-Hashkette, Dateiablage, Seed
apps/web          Next.js 16 (App Router, Server Components, Server Actions)
```

Verbindliche Arbeitsregeln (Audit, Vier-Augen, §-153, Stichtage, UI-Sprache): `AGENTS.md`.

## Dienst (headless)

`apps/api` ist der interne HTTP-Dienst für die kanzleikonsole (ADR 0001, Hono auf Node 24). Er hat
keine Anmeldung: Jede Anfrage an `/v1/*` trägt ein Dienst-Token und eine Ed25519-signierte
Akteursbestätigung (`X-TCMS-Akteur`), die an Methode, Pfad samt Query und Body-Hash gebunden ist.
Signieren und Prüfen liegen in `packages/contract` (`signiereAkteur`, `pruefeAkteur`), damit beide
Seiten denselben Code nutzen.

```bash
pnpm akteur:schluessel                 # Schlüsselpaar für die Akteursbestätigung (schreibt nichts)
pnpm api                               # Dienst auf HOST:PORT, Standard 0.0.0.0:3200
```

| Variable                 | Inhalt                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `TCMS_SERVICE_TOKENS`    | Dienst-Tokens, kommagetrennt, je ≥ 32 Zeichen (z. B. `openssl rand -base64 48`)            |
| `TCMS_ACTOR_PUBLIC_KEYS` | `kid=<base64 SPKI-DER>`, kommagetrennt, nur Ed25519 (Ausgabe von `pnpm akteur:schluessel`) |
| `DATABASE_URL`           | Laufzeitrolle `tcms_app`; Start verweigert bei Superuser oder BYPASSRLS                    |
| `HOST`, `PORT`           | Bindung, Standard `0.0.0.0` und `3200`; nur im internen Netz erreichbar machen             |

Der Dienst prüft die Konfiguration beim Start und startet nicht bei fehlenden Werten, Platzhaltern
(`apps/api/.env.example`), doppelten Einträgen oder anderen Schlüsseltypen; mit
`NODE_ENV=production` auch nicht mit bekannten Standardpasswörtern. `TCMS_DEMO_TODAY` wirkt im Dienst
nicht.

**Rotation mit Überlappung**

- Dienst-Token: neuen Token an `TCMS_SERVICE_TOKENS` anhängen und Dienst neu starten, kanzleikonsole
  auf den neuen Token umstellen, alten Token entfernen und Dienst erneut starten.
- Schlüssel: `pnpm akteur:schluessel`, öffentliche Zeile an `TCMS_ACTOR_PUBLIC_KEYS` anhängen und
  Dienst neu starten, kanzleikonsole mit neuem `kid` und privatem Schlüssel signieren lassen, nach
  mindestens 120 s (höchste Lebensdauer einer Bestätigung) den alten Eintrag entfernen.

**Beispiel einer Anfrage (kanzleikonsole, Platzhalter statt Werten)**

```ts
import { randomBytes } from 'node:crypto';
import { bodySha256, parsePrivatenSchluessel, signiereAkteur } from '@tcms/contract';

const schluessel = { kid: '<kid>', privateKey: parsePrivatenSchluessel('<PKCS8 base64>') };
const pfad = `/v1/mandanten/${mandantId}/<endpunkt>`; // kanonisch: keine `..`, `//`, `%2F`
const body = new TextEncoder().encode(JSON.stringify(eingabe)); // genau diese Bytes senden
const jetzt = Math.floor(Date.now() / 1000);
const akteur = signiereAkteur(
  {
    iss: 'kanzleikonsole',
    aud: 'tcms',
    iat: jetzt,
    exp: jetzt + 60,
    jti: randomBytes(16).toString('base64url'),
    tnt: tenantId,
    sub: mitarbeiterId,
    knd: 'KANZLEI',
    nam: anzeigename,
    rol: { adm: false, bt: true },
    cli: { id: mandantId, bt: true, hb: false },
    req: { m: 'POST', p: pfad, b: bodySha256(body) },
  },
  schluessel,
);
await fetch(`<interne-url>${pfad}`, {
  method: 'POST',
  headers: {
    authorization: 'Bearer <dienst-token>',
    'x-tcms-akteur': akteur,
    'content-type': 'application/json',
  },
  body,
});
```

Antworten: `{ ok: true, daten }` bzw. `{ ok: false, fehler: { code, meldung?, felder? } }`. Jeder
Fehler bei Token, Bestätigung oder `jti` ergibt dieselbe Antwort `401 NICHT_AUTHENTIFIZIERT`; der
Grund steht nur im Log (JSON-Zeilen auf stdout, mit Request-ID, ohne Header-Werte und Bodys). Fremde
Mandanten und nicht kanonische Pfade ergeben `404`. `GET /v1/health` braucht nur das Dienst-Token,
`GET /v1/ich` liefert den abgeleiteten Akteur (Vertragstest).

Tests: `pnpm --filter @tcms/api test`. Mit `TCMS_API_TEST_DATABASE_URL` (Superuser einer
Test-Datenbank) laufen zusätzlich die PostgreSQL-Tests; sie legen dort `akteur_jti` und die
NOLOGIN-Rolle `tcms_auth_test_app` an.

## Grenzen dieses Stands

- **Anmeldung:** nur die Entwicklungs-Anmeldung per Personenauswahl. Für jeden Betrieb außerhalb
  der Demo muss eine echte Authentifizierung ergänzt und `TCMS_DEV_LOGIN` entfernt werden.
- **E-Mail:** kein Versand; Nachrichten und Bestätigungscodes stehen im Entwicklungs-Postausgang.
- **Nachweisablage:** Dateisystem unter `.data/nachweise`, Schutz nur anwendungsseitig (Sperre nach
  Einreichung, SHA-256). Kein WORM-Speicher, kein Virenscan.
- **Audit:** SHA-256-Hashkette über alle Ereignisse, ohne qualifizierten Zeitstempel.
- **Katalog:** Risiken, Kontrollen, Normanker und Matrix-Startwerte sind ungeprüfte Entwürfe und vom
  Berufsträger zu kalibrieren.
- **Prio-B-Bereiche schlank:** Kontrollkalender, Kommunikation, Prüfungsvorbereitung und Katalog nur
  lesend; Kontrolle bearbeiten (S7), Nachweispaket-Export sowie PDF/DOCX-Export der Beschreibung fehlen.

Eine Lizenz ist noch nicht festgelegt.
