# Tax-CMS

Eigenständige Anwendung für ein Tax Compliance Management System nach IDW PS 980 n.F.,
Stufe 1 mit dem Branchenpaket **E-Commerce**. Kanzlei und Mandant arbeiten im selben System:
Risikoinventar mit Brutto/Netto-Bewertung, Kontrollmatrix mit Häufigkeit aus Governance-Typ
× Bruttoklasse, Kontrolldurchführung mit Nachweisen und Vier-Augen-Gegenzeichnung,
Feststellungen mit §-153-Würdigung, Ereigniseingang, Länder-Monitor, CMS-Beschreibung mit
Freigabe per E-Mail-Code und ein Mandantenportal.

> Stand: Umbau zum headless Dienst der kanzleikonsole (ADR 0001, `docs/adr/0001-headless-dienst.md`).
> Mandantentrennung per PostgreSQL-RLS, Rechte über den signierten Akteur und der Service-Kern
> (`packages/service`) stehen; `apps/web` ist die Demo-Oberfläche bis zur Portierung in die
> kanzleikonsole und wird nie produktiv ausgeliefert (siehe „Grenzen").

## Voraussetzungen

- Node.js 24 (`.nvmrc`; mindestens 22.12)
- pnpm 12.4.1 – `corepack enable` oder `npm install -g pnpm@12.4.1`
- Docker Desktop (für PostgreSQL 16)

## Schnellstart (Windows, PowerShell)

```powershell
cd C:\Users\Rey\Documents\GitHub\tcms
docker compose up -d                 # PostgreSQL auf 127.0.0.1:5433, legt Rollen tcms_owner/tcms_app an
Copy-Item .env.example .env          # danach SESSION_SECRET setzen (openssl rand -hex 32)
pnpm install
pnpm db:generate                     # Prisma-Client erzeugen
pnpm db:deploy                       # Migration einspielen (als tcms_owner, DATABASE_OWNER_URL)
pnpm db:seed                         # Demodaten im Demo-Tenant (Stichtag 16.10.2026)
pnpm dev                             # http://localhost:3100
```

`pnpm db:seed` setzt die Datenbank jedes Mal vollständig zurück (alle Tenants) und bricht mit
`NODE_ENV=production` ab. Bestehende Volumes aus der Zeit vor dem Umbau einmal löschen
(`docker compose down -v`), damit das Init-Skript die Rollen anlegt.

## Anmelden in der Demo

`/anmelden` zeigt eine Personenauswahl aus dem statischen Demo-Verzeichnis
(`packages/db/seeds/demo.ts`, feste UUIDs, ein fester Demo-Tenant). Daraus bildet die Demo je
Anfrage einen `Akteur` wie aus der Akteursbestätigung der kanzleikonsole: Kanzleipersonen erhalten
den Bezug (`cli`) zum Mandanten, um den es geht, mit Zuständigkeit (BT, Hauptbearbeitung) aus dem
Verzeichnis; Rollen der Mandantenseite kommen aus `MandantKontaktRolle`. Mit `NODE_ENV=production`
ist die Demo-Anmeldung immer verweigert (TS-01); `SESSION_SECRET` muss ein eigener Zufallswert
sein, bekannte Platzhalter weist die Demo ab (TS-02).

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
Eine Freigabe erteilt nur die adressierte Person (TS-06); Codefristen laufen auf echter Zeit.

## Demodaten

| Mandant                      | Zustand                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Talwind Outdoor GmbH         | Phase 6, Wirksamkeitszeitraum Monat 4 von 6: Gegenzeichnungen offen, zwei überfällige Kontrollen, §-153-Würdigung F-2026-007 offen, neue Ereignisse, Beschreibung v1.2 beim Mandanten |
| Seestern Home & Living GmbH  | Phase 4: Beschreibung v1.0 im Kanzlei-Review                                                                                                                                          |
| Kleinwerk Manufaktur UG      | Phase 3: Kontrollen ohne Designbeurteilung, Lieferschwelle bei 84 %                                                                                                                   |
| Pixelhafen Electronics KG    | Phase 7: Wirksamkeitszeitraum 2025 abgeschlossen                                                                                                                                      |
| Bergkamm Kaffeerösterei GmbH | noch kein Tax-CMS – Einrichtungsassistent starten                                                                                                                                     |

`TCMS_DEMO_TODAY=2026-10-16` legt das fachliche „Heute" der Demo-Uhr fest (nur `apps/web`; der
Dienst nutzt immer die echte Uhr). Audit-Zeitstempel sind immer echte Zeit. Leer lassen, damit die
Demo mit dem echten Datum rechnet. Über den Stichtag-Selektor (`?stand=JJJJ-MM-TT`) lassen sich frühere Stände
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

## Datenbank

Mandantentrennung nach ADR 0001 §4: Jede Tabelle trägt `tenant_id`, PostgreSQL-RLS ist auf allen
Tabellen aktiv und erzwungen (`FORCE`), die Policy vergleicht `tenant_id` mit dem
Transaktionskontext `tcms.tenant_id`. Fremdschlüssel laufen über `(tenant_id, id)`, ein Verweis
auf ein Objekt eines anderen Tenants scheitert also schon in der Datenbank.

| Rolle        | Zweck                                         | Rechte                                                                                           |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tcms_owner` | Eigentümer der Tabellen, Migrationen und Seed | kein Superuser, kein `BYPASSRLS` (auch der Seed arbeitet im Tenant-Kontext)                      |
| `tcms_app`   | Laufzeit (Dienst und Demo)                    | `NOBYPASSRLS`, nur DML; Audit nur `SELECT`/`INSERT`; `akteur_jti` nur `SELECT`/`INSERT`/`DELETE` |

- `packages/db/prisma/init/01_bootstrap.sql` legt beide Rollen idempotent an (als Superuser, vor der
  ersten Migration; Compose bindet das Verzeichnis als Init-Skript ein). Feste Passwörter = Rollenname,
  nur für Entwicklung und Tests.
- Verbindungen: `DATABASE_URL` (Laufzeit, `tcms_app`), `DATABASE_OWNER_URL` (Migration und Seed).
  `mitTenant` weist eine Laufzeitverbindung ab, deren Rolle Superuser ist, `BYPASSRLS` hat oder
  Tabellen besitzt; `pruefeLaufzeitverbindung()` prüft das beim Start des Dienstes.
- Zugriff nur über `mitTenant(tenantId, fn)` aus `@tcms/db`: prüft die UUID, öffnet eine Transaktion
  und setzt `tcms.tenant_id` transaktionslokal. Ohne Kontext sieht `tcms_app` keine Zeile.
- Audit: Hashkette je Tenant (Kettenversion 2), Advisory-Lock je Tenant, `(tenant_id, prevHash)`
  eindeutig. `schreibeAudit(tx, …)` nimmt den Tenant aus dem Kontext.
- Die Migrationshistorie beginnt mit `20261019000000_init` neu (kein Bestandsschutz).

DB-Tests (RLS je Tabelle aus dem Katalog, Rechte, Tenantgrenzen, Audit-Kette bei parallelen
Schreibern) laufen gegen eine migrierte Datenbank:

```bash
psql -U postgres -d <db> -f packages/db/prisma/init/01_bootstrap.sql
DATABASE_OWNER_URL=postgresql://tcms_owner:tcms_owner@localhost:5433/<db> pnpm db:deploy
DB_TESTS=1 \
  DATABASE_URL=postgresql://tcms_app:tcms_app@localhost:5433/<db> \
  DATABASE_OWNER_URL=postgresql://tcms_owner:tcms_owner@localhost:5433/<db> \
  pnpm --filter @tcms/db test
```

`DATABASE_SUPERUSER_URL` (optional) prüft zusätzlich die Abweisung einer Superuser-Verbindung.

## Aufbau

```
packages/domain   Fachlogik ohne I/O: Katalog E-Commerce, Bewertung, Häufigkeitsmatrix,
                  Statusmodelle, Phasen, Grundelemente, Formatierung (mit Tests)
packages/contract Vertrag mit der kanzleikonsole: Akteursbestätigung, Fehlercodes (ADR 0001)
packages/db       Prisma-Schema, Init-Migration mit RLS, Rollen-Bootstrap, mitTenant,
                  Audit-Hashkette je Tenant, Seed
packages/service  Kern der Fachoperationen: Dienstkontext (Transaktion, Akteur, Uhr, Ports),
                  Rechte über den Akteur, mitAudit, Nachweis-Ablage des Dienstes
apps/api          HTTP-Dienst für die kanzleikonsole (Hono): Dienst-Token, Akteursbestätigung,
                  jti, Mandantenbindung, Routen über mitTenant (siehe „Dienst (headless)“)
apps/web          Next.js 16 (App Router, Server Components, Server Actions)
```

Verbindliche Arbeitsregeln (Audit, Vier-Augen, §-153, Stichtage, UI-Sprache): `AGENTS.md`.

## Dienst (headless)

`apps/api` ist der interne HTTP-Dienst für die kanzleikonsole (ADR 0001, Hono auf Node 24). Er hat
keine Anmeldung: Jede Anfrage an `/v1/*` trägt ein Dienst-Token und eine Ed25519-signierte
Akteursbestätigung (`X-TCMS-Akteur`), die an Methode, Pfad samt Query und Body-Hash gebunden ist.
Signieren und Prüfen liegen in `packages/contract` (`signiereAkteur`, `pruefeAkteur`), damit beide
Seiten denselben Code nutzen.

Reihenfolge je Anfrage (ADR 0001 §3.2): Methode und Pfad bekannt (sonst `404`/`405`) →
`Content-Length` vorab (`413`) → Dienst-Token → Body lesen mit gestreamter Grenze von 256 KiB
(`413`) → Akteursbestätigung → `jti` einmalig → Mandantenbindung → erst dann Query und JSON. Ohne
gültiges Dienst-Token liest der Dienst kein Body-Byte und schließt die Verbindung.

```bash
pnpm akteur:schluessel                 # Schlüsselpaar für die Akteursbestätigung (schreibt nichts)
pnpm api                               # Dienst auf HOST:PORT, Standard 0.0.0.0:3200
```

| Variable                 | Inhalt                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `TCMS_SERVICE_TOKENS`    | Dienst-Tokens, kommagetrennt, je ≥ 32 Zeichen (z. B. `openssl rand -base64 48`)            |
| `TCMS_ACTOR_PUBLIC_KEYS` | `kid=<base64 SPKI-DER>`, kommagetrennt, nur Ed25519 (Ausgabe von `pnpm akteur:schluessel`) |
| `DATABASE_URL`           | Laufzeitrolle `tcms_app`; Start verweigert bei Superuser, BYPASSRLS oder Tabelleneigentum  |
| `HOST`, `PORT`           | Bindung, Standard `0.0.0.0` und `3200`; nur im internen Netz erreichbar machen             |

Der Dienst prüft die Konfiguration beim Start und startet nicht bei fehlenden Werten, Platzhaltern
(`.env.example`), doppelten Einträgen oder anderen Schlüsseltypen; mit `NODE_ENV=production` auch
nicht mit bekannten Standardpasswörtern. Danach prüft er mit `pruefeLaufzeitverbindung()` aus
`@tcms/db`, dass `DATABASE_URL` weder Superuser noch `BYPASSRLS` noch Tabelleneigentümer ist. Den
Mandantenkontext setzt nur `mitTenant` aus `@tcms/db`; der Dienst nutzt `pg` direkt nur für
`akteur_jti` und den Ping von `/v1/health` (ohne Tenant). `TCMS_DEMO_TODAY` wirkt im Dienst nicht.

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
Fehler bei Token, Bestätigung oder `jti` ergibt dieselbe Antwort `401 NICHT_AUTHENTIFIZIERT` (mit
`Connection: close`); der Grund steht nur im Log (JSON-Zeilen auf stdout, mit Request-ID, ohne
Header-Werte und Bodys). Fremde Mandanten und nicht kanonische Pfade ergeben `404`.
`GET /v1/health` braucht nur das Dienst-Token, `GET /v1/ich` liefert den abgeleiteten Akteur
(Vertragstest).

Tests: `pnpm --filter @tcms/api test`. Die PostgreSQL-Tests laufen gegen eine Datenbank, die wie in
Produktion aufgebaut ist (Bootstrap und Migration wie oben unter „Datenbank“), ausschließlich als
Laufzeitrolle `tcms_app`:

```bash
DB_TESTS=1 \
  DATABASE_URL=postgresql://tcms_app:tcms_app@localhost:5433/<db> \
  DATABASE_OWNER_URL=postgresql://tcms_owner:tcms_owner@localhost:5433/<db> \
  pnpm --filter @tcms/api test
```

`DATABASE_OWNER_URL` und `DATABASE_SUPERUSER_URL` (beide optional) prüfen zusätzlich, dass der Dienst
mit diesen Rollen nicht startet.

## Grenzen dieses Stands

- **Anmeldung:** Die Demo-Oberfläche kennt nur die Personenauswahl (nie in Produktion). Im
  Zielbild meldet die kanzleikonsole an und ruft das Tax-CMS mit Dienst-Token und signierter
  Akteursbestätigung auf (ADR 0001 §3).
- **E-Mail:** kein Versand; Nachrichten und Bestätigungscodes stehen im Entwicklungs-Postausgang.
- **Nachweisablage:** Demo: Dateisystem unter `.data/nachweise`, Pfad nur in der Form
  `<2 Hex>/<SHA-256>`, beim Lesen gegen den SHA-256 geprüft. Kein WORM-Speicher, kein Virenscan.
  Der Dienst speichert nur Verweise; Dateien nimmt die kanzleikonsole an (ADR 0001 §6).
- **Audit:** SHA-256-Hashkette je Tenant (Kettenversion 2), ohne qualifizierten Zeitstempel.
- **Demo-Lader:** lesen über `db` aus `apps/web/src/server/demo.ts` (je Aufruf eine Transaktion im
  Demo-Tenant, nur lesende Methoden); Prüfung und Änderung vieler Actions liegen noch nicht in
  derselben Transaktion (TS-05 für die Fachoperationen folgt mit deren Umzug nach
  `packages/service`). Eindeutige Schlüssel und bedingte Updates fangen Gabelungen ab.
- **Katalog:** Risiken, Kontrollen, Normanker und Matrix-Startwerte sind ungeprüfte Entwürfe und vom
  Berufsträger zu kalibrieren.
- **Prio-B-Bereiche schlank:** Kontrollkalender, Kommunikation, Prüfungsvorbereitung und Katalog nur
  lesend; Kontrolle bearbeiten (S7), Nachweispaket-Export sowie PDF/DOCX-Export der Beschreibung fehlen.

Eine Lizenz ist noch nicht festgelegt.
