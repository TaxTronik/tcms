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
  Tabellen besitzt.
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
apps/web          Next.js 16 (App Router, Server Components, Server Actions)
```

Verbindliche Arbeitsregeln (Audit, Vier-Augen, §-153, Stichtage, UI-Sprache): `AGENTS.md`.

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
