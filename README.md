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

| Befehl                | Zweck                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`            | Entwicklungsserver der Demo auf Port 3100                                 |
| `pnpm build`          | Builds von `apps/web` (Next.js) und `apps/api` (Bundle `dist/server.mjs`) |
| `pnpm start`          | Produktionsserver der Demo                                                |
| `pnpm api`            | Dienst in der Entwicklung (tsx); Produktion: Image `tcms-api`             |
| `pnpm typecheck`      | TypeScript in allen Paketen                                               |
| `pnpm test`           | Fachlogik- und Rechtetests (Vitest)                                       |
| `pnpm db:migrate`     | neue Migration aus Schemaänderung (Entwicklung)                           |
| `pnpm db:deploy`      | Migrationen einspielen                                                    |
| `pnpm db:seed`        | Datenbank leeren und Demodaten laden                                      |
| `pnpm image:pruefen`  | Dockerfile und Build-Kontext statisch prüfen                              |
| `pnpm vertrag:export` | Commit und SHA-256 der Vertrags- bzw. Domain-Dateien (`VENDOR.json`)      |

## Datenbank

Mandantentrennung nach ADR 0001 §4: Jede Tabelle trägt `tenant_id`, PostgreSQL-RLS ist auf allen
Tabellen aktiv und erzwungen (`FORCE`), die Policy vergleicht `tenant_id` mit dem
Transaktionskontext `tcms.tenant_id`. Fremdschlüssel laufen über `(tenant_id, id)`, ein Verweis
auf ein Objekt eines anderen Tenants scheitert also schon in der Datenbank.

| Rolle        | Zweck                                         | Rechte                                                                                           |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tcms_owner` | Eigentümer der Tabellen, Migrationen und Seed | kein Superuser, kein `BYPASSRLS` (auch der Seed arbeitet im Tenant-Kontext)                      |
| `tcms_app`   | Laufzeit (Dienst und Demo)                    | `NOBYPASSRLS`, nur DML; Audit nur `SELECT`/`INSERT`; `akteur_jti` nur `SELECT`/`INSERT`/`DELETE` |

- `packages/db/prisma/init/01_bootstrap.sql` legt beide Rollen idempotent an (als Superuser mit psql,
  vor der ersten Migration; Compose bindet das Verzeichnis als Init-Skript ein). Feste Passwörter =
  Rollenname, nur für Entwicklung und Tests. Attribute und Rechte stehen nur in `rollen.psql`, das auch
  der Produktions-Bootstrap des Images `tcms-migrate` einbindet (siehe „Betrieb").
- Verbindungen: `DATABASE_URL` (Laufzeit, `tcms_app`), `DATABASE_OWNER_URL` (Migration und Seed).
  `mitTenant` weist eine Laufzeitverbindung ab, deren Rolle Superuser ist, `BYPASSRLS` hat oder
  Tabellen besitzt; `pruefeLaufzeitverbindung()` prüft das beim Start des Dienstes.
- Zugriff nur über `mitTenant(tenantId, fn)` aus `@tcms/db`: prüft die UUID, öffnet eine Transaktion
  und setzt `tcms.tenant_id` transaktionslokal. Ohne Kontext sieht `tcms_app` keine Zeile. Ist der
  Kontext vor dem Commit umgesetzt, rollt `mitTenant` zurück (`TenantFehler`, Log ohne Details).
- RLS schützt nicht gegen beliebiges SQL der Laufzeitrolle (bekanntes Restrisiko, ADR 0001 §10).
  Raw-SQL daher nur als parametrisiertes Tagged Template; der statische Test
  `packages/db/src/__tests__/roh-sql.test.ts` verbietet `…RawUnsafe`, `Prisma.raw`, zusammengesetzte
  SQL-Texte und `set_config` außerhalb von `tenant.ts`.
- Audit: Hashkette je Tenant (Kettenversion 2), Advisory-Lock je Tenant, `(tenant_id, prevHash)`
  eindeutig. `schreibeAudit(tx, …)` nimmt den Tenant aus dem Kontext und vergibt unter der Sperre
  die Position `pos` (je Tenant lückenlos 1, 2, 3, …, `(tenant_id, pos)` eindeutig). Alle Ausgaben
  (Audit-Liste, Cursor, Kettenkopf, Kettenprüfung, Verläufe) nennen `pos`; der globale Schlüssel
  `seq` verlässt den Dienst nicht, weil Lücken darin fremde Audit-Aktivität verrieten (RT-03). Die
  Kettenprüfung verlangt zusätzlich lückenlose Positionen.
- Die Migrationshistorie beginnt mit `20261019000000_init` neu (kein Bestandsschutz).
  `20261019120000_welle2_nachtraege` ergänzt Spalten, Teilindizes, den Einfrier-Trigger der
  CMS-Beschreibung und den Schlüssel `(tenant_id, id)` für `Mandant` (keine neuen Tabellen; setzt
  eine Datenbank ohne Bestandsdaten voraus und scheitert sonst an NOT NULL/CHECK).
  `20261019200000_audit_pos` ergänzt die Audit-Position `pos` je Tenant (RT-03; ebenfalls ohne
  Bestandsdaten). `20261019230000_nachrichten_strukturiert` ergänzt den Postausgang um Mandant
  (Fremdschlüssel), Empfängerart, Vorlagendaten, Code und `verworfenAm` samt CHECKs (Stufe 4, ohne
  Bestandsdaten). `20261019234500_nachricht_unzustellbar` ergänzt `unzustellbarAm`/`unzustellbarGrund`
  (Enum) mit CHECKs: Grund genau bei „unzustellbar", zugestellt und unzustellbar schließen sich aus,
  kein Klartext danach.

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

Die Web-DB-Tests (`DB_TESTS=1 pnpm --filter @tcms/web test`) laufen gegen eine geseedete Datenbank
mit `DATABASE_URL` und `DATABASE_OWNER_URL`. Sie legen ihre Fixtures selbst an bzw. räumen
verbrauchte Demodaten ab (Bergkamm wird vor dem Einrichtungstest über die Eigentümerrolle auf „ohne
Tax-CMS" zurückgesetzt) und sind damit wiederholbar.

## Aufbau

```
packages/domain   Fachlogik ohne I/O: Katalog E-Commerce, Bewertung, Häufigkeitsmatrix,
                  Statusmodelle, Phasen, Grundelemente, Formatierung (mit Tests)
packages/contract Vertrag mit der kanzleikonsole: Akteursbestätigung, Fehlercodes,
                  Endpunktregister mit allen Schemas (ADR 0001)
packages/db       Prisma-Schema, Migrationen (Init mit RLS), Rollen-Bootstrap, mitTenant,
                  Audit-Hashkette je Tenant, Seed, Migrationsläufer des Betriebs (betrieb/)
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
| `TCMS_LOG_LEVEL`         | optional `info` (Standard), `warn` oder `error`; andere Werte verhindern den Start         |

Der Dienst prüft die Konfiguration beim Start und startet nicht bei fehlenden Werten, Platzhaltern
(`.env.example`), doppelten Einträgen oder anderen Schlüsseltypen; mit `NODE_ENV=production` auch
nicht mit bekannten Standardpasswörtern. Danach prüft er mit `pruefeLaufzeitverbindung()` aus
`@tcms/db`, dass `DATABASE_URL` weder Superuser noch `BYPASSRLS` noch Tabelleneigentümer ist. Den
Mandantenkontext setzt nur `mitTenant` aus `@tcms/db`; der Dienst nutzt `pg` direkt nur für
`akteur_jti` und den Ping von `/v1/health` (ohne Tenant). `TCMS_DEMO_TODAY` wirkt im Dienst nicht.

Start fehlgeschlagen heißt Exit 1 mit einer JSON-Zeile ohne Werte. Auf `SIGTERM` nimmt der Dienst
keine Verbindungen mehr an, lässt laufende Anfragen höchstens 20 s zu Ende laufen und endet dann
(Exit 0; nach Fristablauf Exit 1).

**Endpunktregister.** Jeder Endpunkt steht genau einmal in `packages/contract/src/endpunkte.ts`
(`ENDPUNKTE`: Methode, Pfadmuster, zugelassene Akteursarten `akteure`, `mandantenbezogen`, Schemas für
Pfadparameter, Query, Body und Antwort, Erfolgsstatus; `portal` ist aus `akteure` abgeleitet). Jede nicht
zugelassene Akteursart erhält `404` (ADR 0001 §3.4); Portal-Endpunkte (`…/portal/…`) lassen nur
Mandantenkontakte zu, `/v1/ich` beide Personenarten. Die Routen in `apps/api/src/routen/*` liefern nur Handler
(`r.endpunkt(ENDPUNKTE.risikoLesen, …)`); beim Start vergleicht der Dienst seine Routentabelle mit dem
Register und startet bei jeder Abweichung nicht. Die API-Tests prüfen jede Antwort gegen den Vertrag
(`apps/api/src/__tests__/vertrag.ts`). Die kanzleikonsole kann ihren Client direkt aus einem Eintrag
speisen.

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

Antworten: `{ ok: true, daten }` bzw. `{ ok: false, fehler: { code, meldung?, felder?, grund? } }`;
`grund` steht genau bei `403 NICHT_BERECHTIGT` (feste Liste `VERWEIGERUNG_GRUENDE`, je Wert eine
Rechtefunktion, nie bei `404`). Jeder
Fehler bei Token, Bestätigung oder `jti` ergibt dieselbe Antwort `401 NICHT_AUTHENTIFIZIERT` (mit
`Connection: close`); der Grund steht nur im Log (JSON-Zeilen auf stdout, mit Request-ID, ohne
Header-Werte und Bodys). Fremde Mandanten und nicht kanonische Pfade ergeben `404`.
`GET /v1/health` braucht nur das Dienst-Token, `GET /v1/ich` liefert den abgeleiteten Akteur
(Vertragstest; nur Personen).

**Systemakteur (Stufe 4).** Für Arbeit ohne Person (Zustell-Worker) signiert die kanzleikonsole
`knd: 'SYSTEM'` mit `sub` = feste UUID des Dienstnutzers je Tenant und `nam` = Bezeichnung, ohne `rol`
und ohne `cli`. Er erreicht ausschließlich die drei Nachrichten-Endpunkte (`akteure: ['SYSTEM']`); jeder
andere Endpunkt antwortet `404`, und keine Person – auch kein Admin – erreicht die Nachrichten-Endpunkte.
Im Audit steht er als `System: <nam>` mit `detail.systemakteur: true`.

**Endpunkte Lesepfade und Verwaltung** (Rechte prüft `packages/service`; Personen nur als IDs, Namen
und Zuständigkeit ergänzt die kanzleikonsole):

| Methode | Pfad                                                         | Recht                                                                  |
| ------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| GET     | `/v1/mandanten/:mandantId/kontext?stand=`                    | Kanzleiperson mit `cli`; vertrauliche Feststellungen maskiert (RT-01)  |
| POST    | `/v1/portfolio`                                              | Kanzleiperson; Body `{ mandantIds, bt?, hb? }` (≤ 5 000, ADR §3.3)     |
| POST    | `/v1/arbeitskorb`                                            | wie Portfolio; Zuständigkeit nur aus `bt`/`hb` der Liste               |
| GET     | `/v1/mandanten/:mandantId/portal/uebersicht`                 | Mandantenkontakt mit aktiver Rolle (`portal: true`)                    |
| PUT     | `/v1/mandanten/:mandantId`                                   | `kannBearbeiten`; Anker anlegen/aktualisieren, auditiert               |
| GET     | `/v1/mandanten/:mandantId/kontakte`                          | Kanzleiperson mit `cli`; `rechte.bearbeiten` wie PUT                   |
| PUT     | `/v1/mandanten/:mandantId/kontakte`                          | `kannBearbeiten`; Rollen eines Kontakts setzen/deaktivieren, auditiert |
| GET     | `/v1/audit?programmId=&mandantId=&aktion=&nach=&vor=&limit=` | Admin/Partner; höchstens 500 je Seite; Cursor = Position `pos`         |
| POST    | `/v1/audit/pruefen`                                          | Admin/Partner; Kette seitenweise, Zeitbudget 20 s, Fortsetzung `ab`    |

Der Kontext rechnet die Zahlen der Prüfungsvorbereitung (`zeitraum`, nur mit Wirksamkeitszeitraum):
Durchführungen zählen, wenn ihre Fälligkeit im Zeitraum liegt (mit 60 Tagen Nachlauf); dazu
`ohneDurchfuehrung` (Codes wiederkehrender Kontrollen ohne jede – auch geplante – nicht entfallene
Durchführung; leer, solange der Zeitraum zum Stand nicht begonnen hat), `nachweise` (Nachweise
abgeschlossener Durchführungen) und `entfallen`. Feststellungen gehen nicht ein.

Rechte-Kennzeichen für die Oberfläche berechnet der Dienst mit denselben Rechtefunktionen wie die
Schreiboperationen: Kontext `rechte` (`bearbeiten`, `wuerdigen`) und `mandant.rechte.bearbeiten` (Anker
pflegen), beide im historischen Stand `false`; `GET …/kontakte` liefert `rechte.bearbeiten` (Rollen setzen).
Rollen gelten je Mandant: `PUT …/kontakte` prüft nicht, ob die Kontakt-ID bei einem anderen Mandanten
Rollen hat (früher `409`, ein Existenz-Orakel, RT4-T-07); die Bindung Kontakt → Mandant hält die
kanzleikonsole (`cli`), und Rollen bei einem anderen Mandanten verleihen nichts.
Risikoinventar (`GET …/risiken`), Kontrollmatrix (`GET …/kontrollen`) und Länder-Monitor (`GET …/laender`)
tragen `rechte: { bearbeiten }` aus derselben Quelle wie ihre Schreiboperationen (`kannBearbeiten`), im
historischen Stand und ohne Programm `false`.
Die Durchführung (Kanzlei und Portal-Aufgabe) liefert je Handlung `{ erlaubt, grund, verweigerung }`:
`verweigerung` ist der `grund` des `403`, den die Operation liefern würde, `null` bei Erlaubnis oder wenn
nur der Zustand entgegensteht (`409`).

**Endpunkte Kontrolldurchführung** (`durchfuehrung`, Pfade unter `/v1/mandanten/:mandantId/`;
Rechte prüft `@tcms/service`, nicht Sichtbares ergibt `404`, fehlendes Recht `403` mit Grund, ein
nicht erlaubter oder gleichzeitig geänderter Status `409`, Mängel beim Einreichen `400` mit
`felder.maengel`):

| Methode | Pfad                                                                                         | Recht                                                                   |
| ------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET     | `durchfuehrungen/:id?stand=`                                                                 | Kanzlei mit Bezug (`kannLesen`); Rechte als Flags (Text und Grund)      |
| POST    | `durchfuehrungen/:id/beginnen`, `…/speichern`, `…/einreichen`                                | zugewiesene Person oder Vertretung                                      |
| POST    | `durchfuehrungen/:id/nachweise` (201), `…/nachweise/:n/entfernen`                            | zugewiesene Person; Entfernen nur vor der Einreichung                   |
| POST    | `durchfuehrungen/:id/zurueckweisen`, `…/gegenzeichnen`                                       | Gegenzeichnung bzw. zuständige BT, nie Beteiligte (Vier-Augen)          |
| POST    | `durchfuehrungen/:id/entfallen/beantragen`                                                   | zugewiesen oder `kannBearbeiten`                                        |
| POST    | `…/entfallen/freigeben`, `…/entfallen/ablehnen`                                              | `kannWuerdigen`, nie die antragstellende Person (zurückziehen darf sie) |
| POST    | `durchfuehrungen/:id/nachtrag` (201)                                                         | zugewiesen oder `kannBearbeiten`, nur abgeschlossene                    |
| GET     | `nachweise/:n`                                                                               | Kanzlei mit Bezug                                                       |
| GET     | `nachweise?dokumentId=` (Abgleich der kanzleikonsole; auch entfernte, nur ID/Durchführung)   | Kanzlei mit Bezug (Leserecht); fremde/unbekannte Dokument-ID: leer      |
| GET     | `portal/aufgaben`, `portal/aufgaben/:id?stand=`, `portal/anlagen/:n`                         | Kontakt: GV/TCB alle Mandanten-Aufgaben, sonst zugewiesene              |
| POST    | `portal/aufgaben/:id/speichern`, `…/einreichen`, `…/anlagen` (201), `…/anlagen/:n/entfernen` | zugewiesene Person oder Vertretung                                      |
| POST    | `portal/aufgaben/:id/zurueckgeben`, `…/bestaetigen`                                          | zweite Person beim Mandanten, nicht beteiligt                           |

Nachweise sind Verweise der kanzleikonsole (`{ verweis: { dokumentId (UUID), dateiname, mime,
groesse, sha256 } }`); eine Dokument-ID gehört zu genau einem Mandanten und einem Inhalt.
Einzeilige Texte (`einzeilig`: Mandantenname, Rechtsform, Kontaktfunktion, alle Titel und Namen
einschließlich der Vorlagendaten von Nachrichten und der Namen eingefrorener Beschreibungen,
Teilbereich und Bezeichnungen des Geschäftsprofils – RT4-T-03) und Dateinamen
(Nachweis, Ereignis-Anlage) folgen einer Zeichenregel (`UNZULAESSIGE_ZEICHEN`,
`DATEINAME_UNZULAESSIG` in `packages/contract/src/bereiche/lesepfade.ts`), gebildet aus
Unicode-Eigenschaften (`UNZULAESSIG_KLASSE`: `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cs}`,
RT4-T-01): abgewiesen werden Steuerzeichen (auch TAB, CR, LF), alle Formatzeichen (Richtung,
Nullbreite, weiches Trennzeichen, Tag-Zeichen), Zeilen-/Absatztrenner, alles standardmäßig
Unsichtbare (Füller, Variantenselektoren, unsichtbare kombinierende Zeichen) und einzelne Surrogate;
in Dateinamen zusätzlich `/` und `\`. Derselbe Ausdruck prüft im statischen Repo-Test die
versionierten Dateien (dort TAB und LF erlaubt). Der Dienst prüft Dateinamen mit derselben Regel. Antworten
mit gespeicherten Ereignis-Anlagen (Detail `anlagen`, `ereignisAnlageLesen`) prüfen nur die frühere
Regel (`DATEINAME_GESPEICHERT_UNZULAESSIG`: Steuerzeichen, Pfadtrenner, Einbettung/Überschreibung,
Isolierung), damit früher gemeldete Anlagen lesbar bleiben; Anzeigen behandeln Dateinamen immer als
reinen Text.
Die Prüfung einer Durchführung (`pruefung`, Kanzlei-Detail, Portal-Aufgabe, Speichern) liefert je
Kennzahl die vom Dienst berechneten Werte (`kennzahlen`: erfasster Wert bzw. Differenz a − b, Abweichung
gegen Soll, Toleranzlage) – dieselbe Rechnung wie beim Einreichen.

**Risikoinventar, Kontrollmatrix, Geschäftsprofil** (`apps/api/src/routen/risiken-kontrollen.ts`,
nur Kanzleipersonen mit `cli.id` = Mandant; Lesen mit `?stand=YYYY-MM-DD`, Schreiben ohne Stichtag):

| Methode | Pfad unter `/v1/mandanten/:mandantId`                                                           | Recht                                   |
| ------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET     | `/risiken`, `/risiken/:risikoId`                                                                | Lesen                                   |
| POST    | `/risiken/:risikoId/neu-bewerten`, `…/bewertung-bestaetigen`                                    | Bearbeiten, gesehener Stand (`standId`) |
| POST    | `/risiken/:risikoId/uebersteuerungen` (201)                                                     | Bearbeiten                              |
| POST    | `/uebersteuerungen/:uebersteuerungId/entscheiden`                                               | Bearbeiten, zweite Person               |
| POST    | `/risiken-freigabe/einreichen`, `/risiken-freigabe/freigeben`                                   | Bearbeiten; Freigabe zweite Person      |
| POST    | `/risiken/:risikoId/zurueckweisen`                                                              | Bearbeiten, zweite Person               |
| POST    | `/risiken/:risikoId/akzeptanz-anfordern` (201)                                                  | Bearbeiten; Empfänger aktive GV         |
| GET     | `/kontrollen`, `/kontrollen/:kontrolleId`                                                       | Lesen                                   |
| POST    | `/kontrollen/:kontrolleId/design`, `…/abweichung`, `…/abweichung/aufheben`, `…/verantwortliche` | Bearbeiten, `standId`                   |
| POST    | `/kontrollen/:kontrolleId/abweichung/entscheiden`                                               | Bearbeiten, zweite Person, `standId`    |
| GET     | `/profil`                                                                                       | Lesen                                   |
| POST    | `/profil` (`profilStandId`), `/profil/risiko-aufnehmen` (201)                                   | Bearbeiten                              |

Versionierte Änderungen beruhen auf dem gesehenen Stand: Ist inzwischen ein anderer Stand gültig,
antwortet der Dienst mit `409 KONFLIKT`; gleichzeitige Entscheidungen wirken genau einmal.
Kontrollen (Kontrollmatrix, Kontrolldetail und Kontext) tragen neben `pflichtattributeOk` die Liste
`pflichtattributeLuecken` (feste Texte `PFLICHTATTRIBUT_LUECKEN`: Ziel, Schritte, Nachweisanforderung,
durchführende Person, verschiedene Vertretung, Gegenzeichnung bei Schlüsselkontrollen); beide Felder
kommen aus derselben Regel, `pflichtattributeOk` ist genau bei leerer Liste `true`.
`…/verantwortliche` nimmt zusätzlich die gesehene Seite `partei` (`KANZLEI`/`MANDANT`): Die Personen
werden gegen sie geprüft, und unter der Zeilensperre muss sie zum Kontrollstand passen (sonst `409`);
`gegenzeichnungMandant` nur bei `partei: 'MANDANT'` (sonst `400`).

**Feststellungen, Ereignisse, Portal-Meldung, Länder-Monitor** (Pfade unter
`/v1/mandanten/{mandantId}`; Vertrag in `packages/contract/src/bereiche/feststellungen-ereignisse.ts`).
Lesende Endpunkte nehmen `?stand=YYYY-MM-DD`, schreibende nie (TS-07). Vertrauliche Feststellungen
liefert der Dienst für Nicht-Beteiligte nur maskiert (`maskiert: true`, Nummer und Status) – in jeder
Antwort gleich (Feststellungen, Kontext, Kontrollen, Durchführung, Ereignis): keine Steuerwirkung,
keine §-153-Angaben, keine Schwere. Kennzahlen (Portfolio, Lücken) zählen vertrauliche Feststellungen
nur, wo die Zahl aus Sichtbarem folgt (Status, Zahl der Maßnahmen); §-153 und Schwere zählen nur
lesbare (RT-01).

| Methode | Pfad                                                                      | Recht                                                                                           |
| ------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET     | `feststellungen`, `feststellungen/{id}`                                   | Kanzlei mit Bezug (`kannLesen`)                                                                 |
| POST    | `feststellungen` (201), `…/{id}/weiter` (`von`), `…/{id}/wuerdigung`      | `kannBearbeiten`; „NEIN" nur `kannWuerdigen`                                                    |
| POST    | `…/{id}/erklaerungen`, `…/{id}/massnahmen`, `…/{id}/nachkontrolle`        | `kannBearbeiten` (201)                                                                          |
| POST    | `…/{id}/p153` (`entscheidung`, `bisher`), `…/{id}/vertraulich`            | `kannWuerdigen`                                                                                 |
| POST    | `…/{id}/verwerfen/beantragen` · `bestaetigen` · `ablehnen`                | `kannBearbeiten`, Bestätigung zweite Person; bei Auswirkung ≠ „NEIN" zusätzlich `kannWuerdigen` |
| POST    | `massnahmen/{id}/erledigen`                                               | `kannBearbeiten` oder verantwortlich                                                            |
| GET     | `ereignisse`, `ereignisse/{id}`, `ereignisse/{id}/anlagen/{sha256}`       | Kanzlei mit Bezug                                                                               |
| POST    | `ereignisse` (201), `…/{id}/in-pruefung`, `…/{id}/folgen` (201)           | `kannBearbeiten`                                                                                |
| POST    | `…/{id}/folgen/anlegen`, `…/folgen/{folgeId}/verwerfen`, `…/abschliessen` | `kannBearbeiten`                                                                                |
| POST    | `…/folgen/{folgeId}/erledigen`                                            | `kannBearbeiten` oder zuständig                                                                 |
| POST    | `…/{id}/verwerfen/beantragen` · `bestaetigen` · `ablehnen`                | `kannBearbeiten`, Bestätigung zweite Person                                                     |
| GET     | `portal/ereignisse` (Portal)                                              | aktive Rolle beim eigenen Mandanten; GV/TCB alle Meldungen, sonst nur eigene (RT4-T-04)         |
| POST    | `portal/ereignisse` (Portal, 201, Anlagen nur als Verweise)               | GV oder TCB des eigenen Mandanten                                                               |
| GET     | `laender`                                                                 | Kanzlei mit Bezug                                                                               |
| POST    | `laender` (201), `laender/staende` (201)                                  | `kannBearbeiten`                                                                                |

`POST …/{id}/weiter` antwortet `409` nur, wenn der Status inzwischen ein anderer als `von` ist
(gleichzeitige Änderung); ist der Schritt auf dem gesehenen Stand fachlich gesperrt (abgeschlossen, kein
weiterer Schritt, §-153-Würdigung offen, Maßnahme fehlt oder offen, Nachkontrolle fehlt), `400 UNGUELTIG`
mit dem Grund in `felder.von`.

`GET ereignisse/{id}` trägt `rechte` für `abschliessen` und `verwerfen.beantragen`/`verwerfen.bestaetigen`,
je `{ erlaubt, verweigerung }`: `verweigerung` ist der Grund des `403`, den die Operation jetzt liefern
würde (dieselbe Vorbedingung `hindernisEreignis` wie die Operation), `null` bei Erlaubnis oder wenn nur der
Zustand entgegensteht (`409`); im historischen Stand nie erlaubt. `GET portal/ereignisse` liefert `melden`
(Melderecht wie `POST portal/ereignisse`: GV oder TCB) und `programmVorhanden`.

`GET laender` liefert je Land im Monitor `bezuege` (jüngster Stand bis zum Stichtag, deterministisch
aus seinen Merkmalen): aktive Risiken mit Länderbezug (Code und Grund: Fernverkäufe, Steuersätze, OSS,
Lager, ZM), Codes der aktiven Kontrollen an diesen Risiken und IDs der Ereignisse bis zum Stichtag, die
das Land (Code oder Name) in Titel oder Beschreibung nennen. Feststellungen gehen in die Bezüge nicht
ein; `feststellungen` enthält nur nicht vertrauliche (RT-01).

**Endpunkte Programm, Beschreibung, Freigaben, Postausgang** (`…` = `/v1/mandanten/:mandantId`;
Rechte prüft `packages/service`, Eingaben und Antworten in
`packages/contract/src/bereiche/programm-beschreibung.ts`):

| Methode | Pfad                                                   | Recht (sonst `404` bzw. `403` mit Grund)                                                                 |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET     | `/v1/nachrichten/offen?limit=`                         | nur Systemakteur (tenantweit); verfallene Codes nicht ausgeliefert, geleert                              |
| POST    | `/v1/nachrichten/:nachrichtId/zugestellt`              | nur Systemakteur; idempotent, leert Text und Code; fremde ID `404`; nie ausgeliefert und verworfen `409` |
| POST    | `/v1/nachrichten/:nachrichtId/unzustellbar`            | nur Systemakteur; `{ grund }`, idempotent je Grund, leert Text und Code                                  |
| GET     | `…/einrichtung?berufstraegerId=&bearbeitungId=&…`      | `kannLesen`                                                                                              |
| POST    | `…/einrichtung/entwurf`, `…/einrichtung/anlegen`       | `kannBearbeiten`; ein Programm je Mandant                                                                |
| GET     | `…/beschreibung?stand=`                                | `kannLesen`                                                                                              |
| POST    | `…/beschreibung/versionen`, `…/versionen/:id/…`        | `kannBearbeiten`; Review-Abschluss: 2. Person                                                            |
| POST    | `…/freigaben/:freigabeId/neuadressierung`              | `kannBearbeiten` (TS-06, auditiert)                                                                      |
| GET     | `…/kommunikation/freigaben?stand=`                     | `kannLesen`                                                                                              |
| GET     | `…/portal/freigaben`                                   | Mandantenkontakt mit aktiver Rolle                                                                       |
| POST    | `…/portal/freigaben/:freigabeId/code` bzw. `freigeben` | adressierte gesetzliche Vertretung; Code höchstens 5-mal je Stunde (`409`)                               |
| POST    | `…/portal/freigaben/:freigabeId/kenntnisnahme`         | adressierte Person                                                                                       |

Die lebenden Bausteine der Beschreibung (`bausteine`, Portal `live`) sind streng (`BausteinSatzSchema`:
jedes Feld Pflicht, keine Zusatzfelder); neue Snapshots friert der Dienst nur in dieser Form ein.
Eingefrorene Inhalte liest der Vertrag tolerant (`BausteinSatzSnapshotSchema`), weil ihr SHA-256 sie
festschreibt. Baustein VERANTWORTUNG: `gegenzeichnung` ist nur der Name, `gegenzeichnungMandant` sagt,
ob beim Mandanten gegengezeichnet wird; ältere Snapshots ohne das Feld tragen „ (Mandant)" im Namen.

`GET …/einrichtung` liefert in beiden Zuständen (Assistent offen oder eingerichtet) `heute`: den
Kalendertag der Uhr des Dienstes (Europe/Berlin), mit dem auch die Prüfung beim Speichern rechnet.

Bestätigungscodes erreichen die Empfänger nur über den Postausgang (Adresse = Personen-ID); keine
andere Antwort, kein Log und kein Audit enthält einen Code. Eine offene Nachricht ist nach `zweck`
diskriminiert (`OffeneNachrichtSchema`) und trägt `mandantId`, `empfaengerArt` (`KONTAKT` bzw. `KANZLEI`
bei `EREIGNIS_GEMELDET`) und Vorlagendaten `daten`; `betreff`/`text` bleiben Rückfall. Der Code steht nur
in der offenen Nachricht und wird bei Zustellung bzw. Verwerfen (Freigabe erledigt, Code abgelaufen,
ersetzt, gesperrt oder neu adressiert) geleert. Ein falscher Code ergibt `200` mit
`freigegeben: false` (der Fehlversuch bleibt gezählt und protokolliert).

Kann die kanzleikonsole eine Nachricht nicht zustellen, meldet ihr Systemakteur sie als unzustellbar
(`grund`: `EMPFAENGER_UNGUELTIG`, `KEIN_PORTALZUGANG`, `ABGELAUFEN`, `SONSTIGES`); die Nachricht ist
damit abgeschlossen wie bei der Zustellung (Audit `tcms.nachricht.unzustellbar` ohne Inhalte).
Freigabenhistorie, CMS-Beschreibung (`freigaben`) und Risikoakzeptanzen tragen je Freigabe
`zustellung`: Status der jüngsten Nachricht an den aktuellen Empfänger (`OFFEN`, `ZUGESTELLT`,
`UNZUSTELLBAR` mit `grund`, `VERWORFEN`), mit Zweck und Zeitpunkten, ohne Inhalte; `null` ohne Nachricht
und im historischen Stand. Bei „unzustellbar" adressiert die Kanzlei neu.

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

## Betrieb: Images, Migration, CI (Stufe 2)

Die kanzleikonsole betreibt das Tax-CMS mit zwei Images aus diesem Repository (Schnittstelle in
ADR 0001 §8). Basisimages sind per Digest gepinnt; Docker-Daemon und Registry braucht nur der Build.

```bash
docker build --target api --build-arg TCMS_VERSION=1.2.3 -t <praefix>/tcms-api:1.2.3 .
docker build --target migrate -t <praefix>/tcms-migrate:1.2.3 .
```

| Image          | Inhalt und Verhalten                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tcms-api`     | Node 24 Alpine, `dist/server.mjs`, Produktionsabhängigkeiten, erzeugter Prisma-Client; kein pnpm/npm/tsx/esbuild, keine Prisma-CLI, keine Seeds/Demo/Tests. UID/GID 10001, Port 3200, Healthcheck `node /app/healthcheck.mjs`. Umgebung wie unter „Dienst (headless)". |
| `tcms-migrate` | PostgreSQL 18 Alpine (psql), ohne Node. Ohne Argumente: Bootstrap der Rollen, Migrationen mit Ledger `_prisma_migrations` (SHA-256), Prüfung von Rollen und RLS. UID 70.                                                                                               |

`tcms-migrate` (`packages/db/betrieb/migrate.sh`) braucht `TCMS_DB_SUPERUSER_URL`, `TCMS_DB_OWNER_URL`
(Rolle `tcms_owner`, Passwort darf fehlen), `TCMS_DB_OWNER_PASSWORD` und `TCMS_DB_APP_PASSWORD`. Er ist
idempotent und bricht ab, wenn eine angewandte Migration eine andere Prüfsumme hat, eine Migration
unvollständig ist, die Datenbank Migrationen kennt, die das Image nicht kennt, oder die Prüfung scheitert
(Exit 64 Konfiguration, 2 Bootstrap, 3 Migration, 4 Prüfung). Passwörter gehen nur über die Umgebung an
psql, nie in eine Kommandozeile oder die Ausgabe. Lokal genügt dafür psql ≥ 15:

```bash
TCMS_DB_SUPERUSER_URL=postgresql://postgres@localhost:5433/tcms \
  TCMS_DB_OWNER_URL=postgresql://tcms_owner@localhost:5433/tcms \
  TCMS_DB_OWNER_PASSWORD=… TCMS_DB_APP_PASSWORD=… bash packages/db/betrieb/migrate.sh
```

Ohne Docker prüfbar: `pnpm image:pruefen` (Regeln für Dockerfile und `.dockerignore`) und
`DATABASE_URL=<tcms_app> scripts/simuliere-image.sh <verzeichnis>` (Build-Schritte auf dem
Build-Kontext, Start des Bundles mit `node`, Health, signierte Anfrage, `SIGTERM`). Die Tests des
Läufers setzen clusterweite Rollenpasswörter und laufen daher nur auf Anforderung gegen eine
Testinstanz: `TCMS_MIGRATE_TESTS=1 TCMS_MIGRATE_TEST_SUPERUSER_URL=<superuser>/postgres pnpm --filter
@tcms/db exec vitest run src/__tests__/migrate.db.test.ts`.

CI (`.forgejo/workflows/ci.yml`): Lieferketten-Prüfung (`scripts/pruefe-lieferkette.sh`) vor jeder
Installation, frozen Lockfile, Format, Typecheck, Tests ohne und mit PostgreSQL 18 (Datenbank aus
`tcms-migrate`, zweimal), Laufzeit-Simulation, gitleaks, `pnpm audit --prod`, Build beider Images; auf
Tags `v*` (gleich der Version von `apps/api`) Trivy-Gate, SBOM und Push nach
`${REGISTRY}/taxtronik/tcms-api` bzw. `…/tcms-migrate` mit Digests in der Zusammenfassung. Forgejo:
Variable `REGISTRY`, Secrets `REGISTRY_USER` und `REGISTRY_TOKEN`.

`pnpm vertrag:export` gibt bei sauberem Baum Commit und SHA-256 je Datei von `packages/contract/src`
(ohne Tests) im Format von `packages/tcms-contract/VENDOR.json` der kanzleikonsole aus;
`pnpm vertrag:export --paket domain` dasselbe für `packages/domain/src` ohne Tests und ohne
`audit.ts` (`packages/tcms-domain/VENDOR.json`, Oberflächen der kanzleikonsole ab Stufe 3). Alle
Dateien eines vendorten Pakets müssen normale Dateien sein (Modus 100644). Das gilt im ganzen
Repository außer für die drei direkt gestarteten Shell-Skripte (`repo-dateimodus.test.ts`, AGENTS.md).

## Grenzen dieses Stands

- **Anmeldung:** Die Demo-Oberfläche kennt nur die Personenauswahl (nie in Produktion). Im
  Zielbild meldet die kanzleikonsole an und ruft das Tax-CMS mit Dienst-Token und signierter
  Akteursbestätigung auf (ADR 0001 §3).
- **E-Mail:** kein Versand; Nachrichten und Bestätigungscodes stehen im Postausgang (Demo:
  Entwicklungs-Postausgang; Dienst: Abholung durch den Systemakteur der kanzleikonsole über
  `/v1/nachrichten`, Zustellung mit deren Vorlagen).
- **Nachweisablage:** Demo: Dateisystem unter `.data/nachweise`, Pfad nur in der Form
  `<2 Hex>/<SHA-256>`, beim Lesen gegen den SHA-256 geprüft. Kein WORM-Speicher, kein Virenscan.
  Der Dienst speichert nur Verweise; Dateien nimmt die kanzleikonsole an (ADR 0001 §6). Die Demo
  spielt dabei die kanzleikonsole (Ablage, Dokument-ID als UUID) und reicht nur den Verweis weiter.
- **Audit:** SHA-256-Hashkette je Tenant (Kettenversion 2), ohne qualifizierten Zeitstempel.
- **Demo-Lader:** lesen über die Service-Lader bzw. `db` aus `apps/web/src/server/demo.ts` (je
  Aufruf eine Transaktion im Demo-Tenant, nur lesende Methoden). Actions sind dünne Hüllen um die
  Operationen aus `packages/service` (Prüfung und Änderung in derselben Transaktion, TS-05); die
  Demo selbst schreibt nicht.
- **Katalog:** Risiken, Kontrollen, Normanker und Matrix-Startwerte sind ungeprüfte Entwürfe und vom
  Berufsträger zu kalibrieren.
- **Prio-B-Bereiche schlank:** Kontrollkalender, Kommunikation, Prüfungsvorbereitung und Katalog nur
  lesend; Kontrolle bearbeiten (S7), Nachweispaket-Export sowie PDF/DOCX-Export der Beschreibung fehlen.

Eine Lizenz ist noch nicht festgelegt.
