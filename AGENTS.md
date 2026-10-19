# Arbeitsregeln Tax-CMS

Diese Regeln gelten für alle Änderungen in diesem Repository – für Menschen und
für KI-Werkzeuge.

## Architektur

- `packages/domain` – reine Fachlogik ohne I/O: Katalog E-Commerce (Risiken,
  Kontrollen, Ereignistypen, Profilregeln), Bewertung Brutto/Netto,
  Häufigkeitsmatrix Governance-Typ × Bruttoklasse, Statusmodelle, Phasen,
  Grundelemente, Prüflast, Formatierung. Änderungen hier brauchen Tests
  (`pnpm --filter @tcms/domain test`).
- `packages/db` – Prisma-Schema, Init-Migration mit RLS je Tabelle, Rollen-Bootstrap
  (`prisma/init/01_bootstrap.sql`), `mitTenant` (Prisma 7 mit `@prisma/adapter-pg`),
  Audit-Hashkette je Tenant (`schreibeAudit`), Seed. Jeder Laufzeitzugriff läuft in
  `mitTenant`; einen ungebundenen Client gibt es nicht. Neue Tabellen brauchen
  `tenant_id`, RLS, die Policy `tcms_tenant`, Grants für `tcms_app` und einen
  Eintrag in der Tabellenliste der Migration – der generische DB-Test
  (`rls.db.test.ts`) prüft das für jede Tabelle des Katalogs.
- `packages/service` – Kern der Fachoperationen (ADR 0001 §2): `DienstKontext`
  (Transaktion, Akteur, Uhr, Personenverzeichnis, Nachweis-Ablage), `imDienst`,
  `mitAudit`, Rechte über den `Akteur` (`rechte.ts`, ADR 0001 §5). Gemeinsamer
  Kern aller Bereiche in `src/kern/` (Export über `bereiche/lesepfade.ts`):
  `ladeKontext(ctx, { mandantId, stand? })` lädt den Tax-CMS-Kontext eines
  Mandanten zu einem Stichtag (prüft `kannLesen`, maskiert vertrauliche
  Feststellungen), Nummernkreise je Tenant, reine Stichtag-Helfer. Änderungen
  hier brauchen Tests (`pnpm --filter @tcms/service test`).
- `packages/contract` – gemeinsamer Vertrag mit der kanzleikonsole (ADR 0001
  §3, §7): Claims-Schema und `Akteur`, Signieren und Prüfen der
  Akteursbestätigung (`signiereAkteur`, `pruefeAkteur`, nur `node:crypto`),
  strenges JSON (`parseJsonStrikt`), Fehlercodes und Antwortumschlag. Beide
  Seiten nutzen denselben Code; Änderungen hier brauchen Positiv- und
  Negativtests (`pnpm --filter @tcms/contract test`).
- `apps/api` – interner HTTP-Dienst (Hono auf Node 24) für die kanzleikonsole:
  `erzeugeApp(deps)` mit Authentifizierungskette, Routentabelle
  (`routen.ts`, Mandantenbindung), jti-Speicher (`jti.ts`), Konfiguration
  (`konfiguration.ts`), Start (`server.ts`). Keine Fachregeln: Routen rufen
  `packages/service`. Tests ohne Netz über `app.request(...)`, dazu Socket-
  und DB-Tests.
- `apps/web` – Next.js 16 (App Router, Server Components, Server Actions).
  - `src/server/kontext.ts` – dünne Hülle um `ladeKontext` aus
    `@tcms/service` (im Dienstkontext der angemeldeten Person, `demoAkteur`)
    plus Personenangaben und Zuständigkeit aus dem Demo-Verzeichnis. Screens im
    Mandantenkontext lesen daraus.
  - `src/server/seite.ts` (`ladeStaffSeite`) liefert Kontext, Rechte und
    Stichtag für Staff-Seiten.
  - `src/server/actions/*.ts` – Server Actions je Bereich.
  - `src/server/aktion.ts` – `mitAudit` der Demo (Dienstkontext aus
    `@tcms/service` im Tenant des Akteurs) und `aktualisiereMandant`.
  - `src/server/demo.ts` – Stellvertreterin der kanzleikonsole: Demo-Verzeichnis
    (Personen, Zuständigkeit, Tenant), Akteur je Mandant, Demo-Uhr, Ablage,
    `lies`/`db` für Lesezugriffe (nur lesend, je Aufruf im Demo-Tenant).
  - `src/server/berechtigung.ts` – bindet die Rechte aus `@tcms/service` an den
    Mandanten des Objekts (wie `cli`); Regeln stehen nur in `packages/service`.
  - `src/components/ui/*` – gemeinsame Bausteine (Badges, Heatmap, Drawer,
    Begründungsdialog, Stichtag-Selektor, Visualisierungen).

## Fachliche Regeln (verbindlich)

1. Jede fachliche Änderung läuft über `mitAudit` und erzeugt ein
   Audit-Ereignis (`tcms.<bereich>.<aktion>`). Keine Änderung ohne Protokoll;
   `mitAudit` weist ein leeres Protokoll ab.
2. Bewertungen und Frequenzen werden berechnet, nie gespeichert-überschrieben.
   Eine Übersteuerung ist ein eigenes Objekt mit Begründung (≥ 30 Zeichen) und
   Freigabe durch eine zweite Person; der berechnete Wert bleibt sichtbar.
3. Versionierte Objekte (Risiko-, Kontroll-, Profilstände) werden nicht
   geändert: aktuellen Stand mit `gueltigBis` schließen, neuen Stand anlegen.
   Abgeschlossene Durchführungen und freigegebene Beschreibungen sind
   unveränderlich; Korrekturen entstehen als Nachtrag bzw. neue Version.
4. Vier-Augen-Prinzip: Die durchführende Person zeichnet nie selbst gegen;
   Übersteuerungen, Verwerfen und Frequenzabweichungen bestätigt eine zweite
   Person. Rechte werden serverseitig in jeder Action geprüft, nie nur durch
   Ausblenden. Gesperrte Bedienelemente bleiben sichtbar und erklären per
   Tooltip, warum sie gesperrt sind.
5. Die §-153-Würdigung entscheidet ausschließlich ein Berufsträger. Die vier
   Optionen sind gleichrangig, ohne Vorauswahl und ohne Empfehlung. Auch die
   Einstufung „keine steuerliche Auswirkung" beim Anlegen ist eine
   Würdigungsentscheidung: ohne `kannWuerdigen` entsteht die Feststellung als
   „unklar" (`auswirkungBeimAnlegen`, TS-04).
6. Historische Stichtage (`?stand=YYYY-MM-DD`) sind schreibgeschützt.
   Mutationen sind dort deaktiviert.
7. Keine KI-Entscheidungen. Vorschläge (z. B. Risikovorschlag aus dem
   Geschäftsprofil) sind deterministisch und nennen ihren Grund.
8. Normanker, Katalogwerte und Startwerte der Matrix sind ungeprüfte Entwürfe.
   Rechtsquellen und Norminhalte nie erfinden.

## Mandantentrennung und Akteur (verbindlich, ADR 0001)

- Jeder Datenbankzugriff zur Laufzeit läuft in `mitTenant` (bzw. `imDienst`);
  der Tenant kommt aus dem Akteur, nie aus der Eingabe. Kein Code umgeht RLS.
- Genau eine Implementierung des Mandantenkontexts: `mitTenant` aus
  `@tcms/db`. Kein anderer Code setzt `tcms.tenant_id` oder öffnet eigene
  Tenant-Transaktionen. Ausnahmen ohne Tenant sind nur `akteur_jti` (ohne
  RLS, `tcms_app` nur SELECT/INSERT/DELETE) und der Ping von `/v1/health`.
- Rechte nur über die Funktionen aus `@tcms/service` mit dem `Akteur`;
  Kanzleipersonen handeln nur mit bestätigtem Mandantenbezug (`cli`),
  Mandantenkontakte nur mit aktiver `MandantKontaktRolle`.
- Fremde Mandanten und Objekte: `404` bzw. „nicht gefunden", nie ein Hinweis
  auf ihre Existenz.
- `TCMS_DEMO_TODAY` wirkt nur über die Demo-Uhr in `apps/web`; Audit-
  Zeitstempel und Sicherheitsfristen (Codes) sind immer echte Zeit.

## Dienst und Authentifizierung (verbindlich, ADR 0001 §3)

- Reihenfolge je Anfrage in `apps/api/src/app.ts`: Request-ID → Methode und
  Pfad bekannt (nur das rohe, kanonische Target; sonst 404/405) →
  `Content-Length` vorab (413) → Dienst-Token (konstante Zeit) → Body mit
  gestreamter Grenze (413) → Akteursbestätigung gegen Methode, rohes Target
  und Body-Hash → `jti` einmalig → Mandantenbindung (404) → erst dann Query
  und JSON → Route in genau einer `mitTenant`-Transaktion. Diese Reihenfolge
  nicht ändern, ohne ADR und Negativtests anzupassen.
- Ohne gültiges Dienst-Token wird kein Body-Byte gelesen. Jeder
  Authentifizierungsfehler ergibt dieselbe Antwort
  `401 NICHT_AUTHENTIFIZIERT` (mit `Connection: close`); der Grund steht nur
  im Log.
- Fachrouten nur über `Routen.route(...)`; jede verlangt Token und
  Bestätigung. Pfade unter `/v1/mandanten/:mandantId/…` sind an `cli.id`
  gebunden, `MANDANT`-Personen nur auf Routen mit `portal: true`.
- Logs: JSON-Zeilen ohne Header-Werte, Bodys, Namen und rohe Pfade, nur IDs
  und Codes. Keine Secrets in Logs, Fehlermeldungen, Tests oder Commits.
- Jede Sicherheitsannahme hat einen Negativtest, der ohne die Schutzmaßnahme
  scheitert.

## UI-Sprache (verbindlich)

| Nicht verwenden                                    | Stattdessen                                          |
| -------------------------------------------------- | ---------------------------------------------------- |
| „wirksam", „Kontrolle wirksam"                     | „abgeschlossen – ohne Befund"                        |
| „angemessen" als Systemaussage                     | „Designbeurteilung: angemessen" mit Person und Datum |
| „PS-980-konform", „zertifiziert", „prüfungssicher" | „Nachweis dokumentiert", „Nachweispaket"             |
| Compliance-Score, Reifegrad in Prozent             | „dokumentiert" oder „Lücken (n)"                     |
| „Risiko beseitigt"                                 | „Nettoklasse gering"                                 |
| Empfehlung oder Vorauswahl im §-153-Block          | gleichrangige Optionen ohne Default                  |
| „anonymisiert"                                     | „Platzhalter ersetzt"                                |

Keine Leistungsvergleiche von Personen. Staff-Texte knapp, Portal in Sie-Form,
de-DE-Formate über `@tcms/domain` (`fmtDatum`, `fmtEur` …).

## Design

Keine eigene Designsprache: ausschließlich die TaxTronik-Klassen aus
`apps/web/src/app/taxtronik.css` (aus dem abgestimmten Mockup übernommen) und
die Bausteine unter `src/components`. Neue Muster nur, wenn sie auf den
vorhandenen Tokens aufsetzen.

## Prüfen vor Abschluss

```
pnpm typecheck
pnpm test
DB_TESTS=1 DATABASE_URL=… DATABASE_OWNER_URL=… pnpm --filter @tcms/db test
DB_TESTS=1 DATABASE_URL=… DATABASE_OWNER_URL=… pnpm --filter @tcms/api test
pnpm build
```
