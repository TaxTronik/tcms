# Arbeitsregeln Tax-CMS

Diese Regeln gelten für alle Änderungen in diesem Repository – für Menschen und
für KI-Werkzeuge.

## Architektur

- `packages/domain` – reine Fachlogik ohne I/O: Katalog E-Commerce (Risiken,
  Kontrollen, Ereignistypen, Profilregeln), Bewertung Brutto/Netto,
  Häufigkeitsmatrix Governance-Typ × Bruttoklasse, Statusmodelle, Phasen,
  Grundelemente, Prüflast, Formatierung. Änderungen hier brauchen Tests
  (`pnpm --filter @tcms/domain test`).
- `packages/db` – Prisma-Schema, Migrationen (Init mit RLS je Tabelle, danach
  Nachträge von Hand im Prisma-Format), Rollen-Bootstrap
  (`prisma/init/01_bootstrap.sql`), `mitTenant` (Prisma 7 mit `@prisma/adapter-pg`),
  Audit-Hashkette je Tenant (`schreibeAudit`, Position `pos` je Tenant lückenlos;
  der globale Schlüssel `seq` verlässt den Dienst nie – RT-03), Seed. Jeder Laufzeitzugriff läuft in
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
  Feststellungen), Nummernkreise je Tenant, reine Stichtag-Helfer, das Lesen
  des Geschäftsprofils (`kern/profil.ts`, Profilregeln in `@tcms/domain`) und
  die Kontrollvorlagen für neue Kontrollen aus dem Katalog
  (`kern/kontroll-vorlage.ts`: Vorbelegung der Zuständigkeit, erster Stand,
  geplante Durchführungen). Regeln, die mehrere Bereiche brauchen, gibt es nur
  einmal. Änderungen hier brauchen Tests (`pnpm --filter @tcms/service test`).
  Bereiche unter `src/bereiche/<bereich>` (z. B. `risiken-kontrollen`: Risiken,
  Kontrollen, Geschäftsprofil). TS-05 dort: Zeile in der Transaktion sperren
  (Reihenfolge Programm → Risiko → Kontrolle → Durchführung, je nach ID),
  Zustand unter der Sperre lesen, versionierte Änderungen nur auf dem
  gesehenen Stand (`standId`/`profilStandId`, sonst `KONFLIKT`), bedingte
  Updates; Neuplanung löscht nur unberührte geplante Durchführungen.
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
    Stichtag für Staff-Seiten (Leserecht und Maskierung im Service).
  - Portfolio, Arbeitskorb, Portal-Start und Audit der Demo lesen über die
    Service-Lader (`ladePortfolio`, `ladeArbeitskorb`, `ladePortalUebersicht`,
    `ladeAudit`/`pruefeAudit`); die Demo ergänzt nur Namen und Zuständigkeit
    aus ihrem Verzeichnis (`mandantenListe`, `demoAkteur`).
  - `src/server/actions/*.ts` – Server Actions je Bereich.
  - `src/server/aktion.ts` – `aktualisiereMandant` (Revalidierung) und
    Meldungstexte; die Demo hat keinen eigenen Schreibweg, Actions rufen nur
    Operationen aus `@tcms/service` (`imDienst(demoAkteur(…), DEMO_PORTS, …)`).
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
   „unklar" (`auswirkungBeimAnlegen`, TS-04). Im Service entsteht jede
   Feststellung über `legeFeststellungAn` (manuell, Ereignisfolge,
   Gegenzeichnung), das diese Regel anwendet; die §-153-Entscheidung hat keinen
   Standardwert und nennt die bisher gesehene Entscheidung (`bisher`).
   Ebenso beendet das Verwerfen einer Feststellung, deren steuerliche
   Auswirkung nicht „NEIN" ist, den §-153-Pfad: Die Bestätigung braucht neben
   der zweiten Person `kannWuerdigen` (`kannVerwerfenBestaetigen`).
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
- Vertrauliche Feststellungen (Fachkonzept §13): Für Personen ohne
  `kannVertraulichLesen` ist jede Ausgabe eine eigene Variante
  `maskiert: true` mit genau den Feldern des dedizierten Lesepfads (Nummer,
  Status, Erfassung, Wiedervorlagen) – als Positivliste gebaut, nie durch
  Überschreiben einzelner Felder. Kennzahlen dürfen vertrauliche
  Feststellungen nur zählen, wo die Zahl aus Sichtbarem folgt (Status, Zahl
  der Maßnahmen); Steuerwirkung, §-153 und Schwere zählen nur lesbare (RT-01).
- `TCMS_DEMO_TODAY` wirkt nur über die Demo-Uhr in `apps/web`; Audit-
  Zeitstempel und Sicherheitsfristen (Codes) sind immer echte Zeit.
- Objekt-IDs aus Pfad oder Body gehören nur dann zur Anfrage, wenn das Objekt
  zum Programm des Mandanten der Anfrage gehört (RLS trennt nur Tenants);
  sonst „nicht gefunden". Prüfung und Änderung laufen unter Zeilensperre
  (`SELECT … FOR UPDATE`) in derselben Transaktion, Änderungen als bedingtes
  Update (TS-05).
- Nachweise sind Verweise der kanzleikonsole (Dokument-ID als UUID, SHA-256):
  eine Dokument-ID gehört zu genau einem Mandanten und einem Inhalt (auch nach
  dem Entfernen). Entfernen markiert den Verweis (`entferntAm`/`entferntVon`);
  jeder Lesezugriff filtert `entferntAm IS NULL`, der vollständige Verweis
  steht zusätzlich im Audit.
- Mandanten-IDs der kanzleikonsole sind nur je Tenant eindeutig (Schlüssel
  `(tenant_id, id)`): Anlegen und Lesen verraten nie, ob es eine ID in einem
  anderen Tenant gibt. Mandanten nur mit `findFirst`/Tenant-Schlüssel lesen.

## Freigaben und Postausgang (verbindlich)

- Freigaben erteilt nur die adressierte Person (Vergleich der IDs), Freigaben mit Code nur eine
  aktive gesetzliche Vertretung. Eine andere Person zieht keine Anforderung an sich; die Kanzlei
  adressiert neu (eigene, auditierte Aktion, setzt Code und Fehlversuche zurück) – TS-06.
- Bestätigungscodes: 6 Ziffern aus `randomInt`, nur ein an die Freigabe gebundener SHA-256 wird
  gespeichert (`codeHash`, CHECK hex), 7 Tage gültig (echte Zeit), höchstens 5 Fehlversuche je
  Freigabe (`codeFehlversuche`, CHECK 0–5, gezählt unter Zeilensperre mit bedingtem Update, nie
  aus dem Audit), einmal verwendbar, Vergleich mit `timingSafeEqual`. Codes stehen in keiner
  Antwort, keinem Log und keinem Audit-Detail – nur im Postausgang.
- Nachrichten adressieren Empfänger nur über die Personen-ID (`empfaengerId`, UUID) mit einem
  Zweck aus `NACHRICHT_ZWECKE`, nie über Namen. „Zugestellt" setzt `zugestelltAm` und leert den
  Text (er kann einen Code enthalten).
- Freigegeben wird nur ein eingefrorener Inhalt, dessen SHA-256 zum gespeicherten Hash passt. Ab
  dem Einfrieren (beim Mandanten, freigegeben, abgelöst) verhindert der Trigger
  `BeschreibungVersion_eingefroren` jede Änderung außer den Statusübergängen zu „freigegeben"
  (mit Person und Zeitpunkt) bzw. „abgelöst" und jedes Löschen – für jede Rolle.
- Höchstens eine offene Risikoakzeptanz je Risiko, eine beantragte Übersteuerung je (Risiko,
  Sicht) und ein offener Nachtrag je Durchführung: unter Zeilensperre geprüft und zusätzlich als
  eindeutiger Teilindex (Verletzung → `KONFLIKT`).

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
