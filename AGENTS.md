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
  Nachträge von Hand im Prisma-Format; ohne jeden Backslash – auch nicht in
  Literalen, dort `chr(92)` – und ohne eigene Transaktionssteuerung, der Läufer
  `betrieb/migrate.sh` weist sie ab),
  Rollen-Bootstrap (Attribute und Rechte nur in `prisma/init/rollen.psql`, eingebunden
  von `01_bootstrap.sql` und vom Produktions-Bootstrap `betrieb/bootstrap.sql`),
  Migrationsläufer des Images `tcms-migrate` (`betrieb/`, psql, ADR 0001 §8),
  `mitTenant` (Prisma 7 mit `@prisma/adapter-pg`),
  Audit-Hashkette je Tenant (`schreibeAudit`/`schreibeAuditFolge`, Position `pos` je Tenant lückenlos;
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
  geplante Durchführungen) und der Zustellstatus der Nachrichten zu Freigaben
  (`kern/zustellung.ts`). Regeln, die mehrere Bereiche brauchen, gibt es nur
  einmal. Änderungen hier brauchen Tests (`pnpm --filter @tcms/service test`).
  Bereiche unter `src/bereiche/<bereich>` (z. B. `risiken-kontrollen`: Risiken,
  Kontrollen, Geschäftsprofil). TS-05 dort: Zeile in der Transaktion sperren
  (Reihenfolge Programm → Risiko → Kontrolle → Durchführung, je nach ID),
  Zustand unter der Sperre lesen, versionierte Änderungen nur auf dem
  gesehenen Stand (`standId`/`profilStandId`, sonst `KONFLIKT`), bedingte
  Updates; Neuplanung löscht nur unberührte geplante Durchführungen.
  Reihenfolge: Jede Listenabfrage (`findMany`) und jede Listenrelation in
  `include`/`select` trägt ein `orderBy` (fachlich, z. B. Code, Version,
  Nummer, Zeitpunkt) mit der `id` als letzter Stufe (Verknüpfungstabellen: ihr
  Schlüssel), damit Antworten, Vergleiche und eingefrorene Snapshots nicht vom
  Abfrageplan abhängen; `src/__tests__/reihenfolge.test.ts` prüft das statisch
  gegen das Prisma-Schema (Ausnahmen nur begründet in der Allowlist dort).
- `packages/contract` – gemeinsamer Vertrag mit der kanzleikonsole (ADR 0001
  §3, §7): Claims-Schema und `Akteur`, Signieren und Prüfen der
  Akteursbestätigung (`signiereAkteur`, `pruefeAkteur`, nur `node:crypto`),
  strenges JSON (`parseJsonStrikt`), Fehlercodes und Antwortumschlag,
  Endpunktregister `ENDPUNKTE` (`endpunkte.ts`: je Endpunkt Methode, Muster,
  zugelassene Akteursarten `akteure` (daraus abgeleitet `portal`), Schemas für
  Pfadparameter, Query, Body und Antwort, Status). Beide
  Seiten nutzen denselben Code; Änderungen hier brauchen Positiv- und
  Negativtests (`pnpm --filter @tcms/contract test`).
- `apps/api` – interner HTTP-Dienst (Hono auf Node 24) für die kanzleikonsole:
  `erzeugeApp(deps)` mit Authentifizierungskette, Routentabelle
  (`routen.ts`, Mandantenbindung, Abgleich mit dem Endpunktregister),
  `erzeugeDienst` (`dienst.ts`, alle Routen wie in Produktion), jti-Speicher
  (`jti.ts`), Konfiguration (`konfiguration.ts`), Start (`server.ts`),
  geordnetes Beenden (`beenden.ts`), Container-Healthcheck (`healthcheck.mjs`),
  Bundle (`scripts/build.mjs`) und Laufzeitbaum (`scripts/laufzeit.mjs`) des
  Images `tcms-api`. Keine Fachregeln: Routen rufen `packages/service`. Tests
  ohne Netz über `app.request(...)`, dazu Socket- und DB-Tests; jede Antwort
  einer Test-App aus `aufbau()` wird gegen den Vertrag geprüft
  (`__tests__/vertrag.ts`).
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
  `mitTenant` rollt zurück, wenn der Kontext bis zum Commit umgesetzt wurde.
- RLS schützt nicht gegen beliebiges SQL derselben Rolle (ADR 0001 §10, RT-02):
  Raw-SQL nur als parametrisiertes Tagged Template (`$queryRaw`/`$executeRaw`),
  nie `$queryRawUnsafe`/`$executeRawUnsafe`, `Prisma.raw` oder zusammengesetzte
  Texte; `pg` nur mit festem SQL-Text. Der statische Test
  `packages/db/src/__tests__/roh-sql.test.ts` erzwingt das; Ausnahmen nur für
  Tests und Seed, mit Begründung.
- Rechte nur über die Funktionen aus `@tcms/service` mit dem `Akteur`;
  Kanzleipersonen handeln nur mit bestätigtem Mandantenbezug (`cli`),
  Mandantenkontakte nur mit aktiver `MandantKontaktRolle`.
- Fremde Mandanten und Objekte: `404` bzw. „nicht gefunden", nie ein Hinweis
  auf ihre Existenz.
- Fehlendes Recht auf einem sichtbaren Objekt nur über
  `nichtBerechtigt(grund, meldung)` (`@tcms/contract`): `403` mit
  maschinenlesbarem `grund` aus `VERWEIGERUNG_GRUENDE`, passend zur abgelehnten
  Rechtefunktion (Rechtefunktionen mit Ergebnisobjekt liefern ihn als
  `verweigerung`, ebenso die Rechte-Flags der Durchführung für die Oberfläche;
  Kennzeichen und Operation rechnen mit derselben Funktion). Eine neue Stelle
  gehört mit ihrem Grund ins Inventar von
  `packages/service/src/__tests__/verweigerung.test.ts`.
- Ein `409` in einem Ablauf, dessen Endpunkt im Register `konflikte` nennt (Code anfordern,
  Freigeben, Portal-Meldung), entsteht nur über `konfliktMitGrund(grund, meldung)` mit einem Grund aus
  `KONFLIKT_GRUENDE`, und der Registereintrag nennt genau die Gründe seines Ablaufs (tcms-s10). Ein
  `409` ohne Grund oder mit einem nicht genannten Grund beantwortet der Dienst mit `500 INTERN`. Eine
  neue Stelle gehört mit ihrem Grund ins Inventar von
  `packages/service/src/__tests__/konflikt.test.ts`; fremde und unbekannte Objekte bleiben `404` ohne
  Grund.
- Vertrauliche Feststellungen (Fachkonzept §13): Für Personen ohne
  `kannVertraulichLesen` ist jede Ausgabe eine eigene Variante
  `maskiert: true` mit genau den Feldern des dedizierten Lesepfads (Nummer,
  Status, Erfassung, Wiedervorlagen) – als Positivliste gebaut, nie durch
  Überschreiben einzelner Felder. Kennzahlen dürfen vertrauliche
  Feststellungen nur zählen, wo die Zahl aus Sichtbarem folgt (Status, Zahl
  der Maßnahmen); Steuerwirkung, §-153 und Schwere zählen nur lesbare (RT-01).
  Die Kanzleileitung (Admins/Partner, `rol.adm`) liest alles: Für sie ist
  `kannVertraulichLesen` immer wahr (`liestAlleVertraulichen`,
  Produktentscheidung vom 21.10.2026, tcms-s12, ADR 0001 §5) – auf jedem
  Lesepfad, ohne Beteiligung und ohne Mandantenbezug. Zugriff auf Mandantenpfade
  (`cli`) und Schreibrechte ändern sich dadurch nicht. Pfade ohne maskierte
  Variante (Feststellungen im Länder-Monitor, Titel und Begründung vertraulicher
  Verwerfen-Anträge im Arbeitskorb) zeigen vertrauliche Inhalte nur der
  Kanzleileitung, allen anderen nie; die CMS-Beschreibung nimmt vertrauliche
  Feststellungen für niemanden auf.
  Das gilt auch für das tenantweite Audit (ADR 0001 §5.1, tcms-s11, tcms-s12):
  Einträge zu einer vertraulichen Feststellung und ihren Maßnahmen sind für
  Personen ohne `kannVertraulichLesen` (mit dem `cli` der Anfrage) die Variante
  `maskiert: true` (Position, Zeitpunkt, Aktion, Objekt, Mandant, `akteurArt`,
  `vertraulich`), und ab der ersten maskierten Position gibt die Liste keine
  Hashes aus (sie ließen maskierte Inhalte bestätigen). Heute liest nur die
  Kanzleileitung das Audit und sieht alles; die Maskierung bleibt für einen
  künftigen Lesepfad anderer Personen und wird über `leseAuditSeite` (ohne
  Verwaltungsprüfung, nicht exportiert) getestet. Hashes und Kettenprüfung
  rechnen über die vollständigen Einträge. Beteiligte bestimmt nur
  `beteiligteVon`, die Kanzleileitung nur `liestAlleVertraulichen` (beide in
  `rechte.ts`); kein Lesepfad hat eine eigene Kopie dieser Regeln.
- `TCMS_DEMO_TODAY` wirkt nur über die Demo-Uhr in `apps/web`; Audit-
  Zeitstempel und Sicherheitsfristen (Codes) sind immer echte Zeit.
- Objekt-IDs aus Pfad oder Body gehören nur dann zur Anfrage, wenn das Objekt
  zum Programm des Mandanten der Anfrage gehört (RLS trennt nur Tenants);
  sonst „nicht gefunden". Prüfung und Änderung laufen unter Zeilensperre
  (`SELECT … FOR UPDATE`) in derselben Transaktion, Änderungen als bedingtes
  Update (TS-05).
- Nachweise sind Verweise der kanzleikonsole (Dokument-ID als UUID, SHA-256):
  eine Dokument-ID gehört je Mandant zu genau einem Inhalt (auch nach
  dem Entfernen). Ob ein Dokument zum Mandanten gehört, prüft die
  kanzleikonsole; Verweise anderer Mandanten zählen beim Anhängen nicht, eine
  dort verwendete Dokument-ID gilt wie eine unbekannte (kein Orakel, Hinweis
  H3 aus RT4). Entfernen markiert den Verweis (`entferntAm`/`entferntVon`);
  jeder Lesezugriff filtert `entferntAm IS NULL`, der vollständige Verweis
  steht zusätzlich im Audit. Einzige Ausnahme ist der Abgleichspfad
  „Nachweise je Dokument" (`GET …/nachweise?dokumentId=`, nur Kanzlei mit
  Leserecht): Er nennt auch entfernte Verweise, aber nur mit ID, Durchführung
  und `entfernt: true`, und nur die des Mandanten der Anfrage. Gegenstück für
  Anlagen von Ereignis-Meldungen (Verweise im Meldungs-Audit) ist
  „Ereignis-Anlagen je Dokument" (`GET …/ereignis-anlagen?dokumentId=`, nur
  Kanzlei mit Leserecht, nur UUIDs, tcms-s11): Ereignis-ID, Nummer, Status und
  SHA-256 je Anlage, nur Meldungen des Mandanten der Anfrage; der Vergleich der
  Dokument-ID ignoriert Groß-/Kleinschreibung (ein verpasster Treffer gäbe ein
  gebundenes Dokument frei). Die kanzleikonsole gibt eine ungeklärte Anlage nur
  bei leerer Liste frei.
- Mandanten-IDs der kanzleikonsole sind nur je Tenant eindeutig (Schlüssel
  `(tenant_id, id)`): Anlegen und Lesen verraten nie, ob es eine ID in einem
  anderen Tenant gibt. Mandanten nur mit `findFirst`/Tenant-Schlüssel lesen.

## Freigaben und Postausgang (verbindlich)

- Freigaben erteilt nur die adressierte Person (Vergleich der IDs), Freigaben mit Code nur eine
  aktive gesetzliche Vertretung. Eine andere Person zieht keine Anforderung an sich; die Kanzlei
  adressiert neu (eigene, auditierte Aktion, setzt Code und Fehlversuche zurück) – TS-06.
- Rollen der Mandantenseite ändern sich nur unter `sperreRollenZumAendern` (Mandantenzeile FOR
  UPDATE); Freigabe-Operationen lesen und prüfen Rollen erst nach der Zeilensperre ihres Objekts
  und `halteRollenFest` (dieselbe Zeile FOR KEY SHARE, `src/rollen.ts`) – TS-05, RT4-T-05. Das
  gilt für Erteilen, Code anfordern, Kenntnisnahme, Neuadressieren und jedes Anlegen einer Freigabe
  (Ziele mit Version 1, Beschreibung, Risikoakzeptanz): Entfernen der letzten GV und Adressieren an
  sie laufen so nacheinander (kein Write Skew, RT4-T-06).
- Bestätigungscodes: 6 Ziffern aus `randomInt`, nur ein an die Freigabe gebundener HMAC-SHA-256 mit
  dem Schlüssel aus `TCMS_CODE_SCHLUESSEL` wird gespeichert (`codeHash`, CHECK hex, dazu die
  abgeleitete Schlüsselkennung `codeSchluesselId`; der Schlüssel steht nie in der Datenbank, Hash
  ohne bekannte Kennung gilt als abgelaufen – H5), 7 Tage gültig (echte Zeit), höchstens 5 Fehlversuche je
  Freigabe (`codeFehlversuche`, CHECK 0–5, gezählt unter Zeilensperre mit bedingtem Update, nie
  aus dem Audit), einmal verwendbar, Vergleich mit `timingSafeEqual`. Codes stehen in keiner
  Antwort, keinem Log und keinem Audit-Detail – nur im Postausgang. Höchstens 5 ausgestellte Codes
  je Freigabe und Kontakt in einer Stunde (gezählt an den Code-Nachrichten unter der Zeilensperre,
  echte Zeit; darüber `409`, Hinweis H1 aus RT4).
- Nachrichten adressieren Empfänger nur über die Personen-ID (`empfaengerId`, UUID) mit einem
  Zweck aus `NACHRICHT_ZWECKE`, nie über Namen; jede trägt `mandantId`, die aus dem Zweck folgende
  `empfaengerArt` und Vorlagendaten `daten` (geprüft gegen den Vertrag, ohne Namen und ohne Code).
  Neue Nachrichten nur über `legeNachrichtAn`. Der Code steht nur in der Spalte `code` der offenen
  Nachricht. Der Abruf hält die erste Auslieferung fest (`abgerufenAm`); eine verworfene, nie
  ausgelieferte Nachricht lässt sich weder als zugestellt noch als unzustellbar melden (`409`, CHECK,
  H2). „Zugestellt" setzt `zugestelltAm` und leert `code` und Text; „unzustellbar" (Meldung der
  kanzleikonsole mit Grund aus `NACHRICHT_UNZUSTELLBAR_GRUENDE`) setzt `unzustellbarAm` und
  `unzustellbarGrund` und leert ebenso; beide schließen sich aus (`409` unter Zeilensperre, CHECK) und
  sind idempotent (unzustellbar nur mit demselben Grund). Gilt ein Code nicht mehr, verwirft der
  nächste Abruf die Nachricht (`verworfenAm`, leert `code` und Text) und liefert sie nicht aus;
  ebenso eine Nachricht, deren gespeicherte Vorlagendaten den Vertrag verletzen (Grund
  `DATEN_UNGUELTIG`, etwa Titel aus der Zeit vor RT4-T-03).
  Abholen, Zustellung und Unzustellbarkeit melden darf ausschließlich der Systemakteur (Stufe 4).
- Die Kanzlei sieht an Freigaben (Historie, Beschreibung, Risikoakzeptanz) den Zustellstatus
  `zustellung` der jüngsten Nachricht an den aktuellen Empfänger (`kern/zustellung.ts`): nur
  Nachrichten des Mandanten der Anfrage und dieser Freigabe, nur Zweck, Status, Zeitpunkte und Grund
  (nie Text, Betreff, Vorlagendaten oder Code), im historischen Stand `null`.
- Freigegeben wird nur ein eingefrorener Inhalt, dessen SHA-256 zum gespeicherten Hash passt. Ab
  dem Einfrieren (beim Mandanten, freigegeben, abgelöst) verhindert der Trigger
  `BeschreibungVersion_eingefroren` jede Änderung außer den Statusübergängen zu „freigegeben"
  (mit Person und Zeitpunkt) bzw. „abgelöst" und jedes Löschen – für jede Rolle. Neue Versionen
  entstehen nur als Entwurf ohne Review-, Freigabe- und Snapshot-Angaben (Trigger
  `BeschreibungVersion_neu`), und aus Entwurf oder Kanzlei-Review führt kein Übergang direkt nach
  „freigegeben" oder „abgelöst": Freigegeben wird nur über „beim Mandanten" (Hinweis H4 aus RT4;
  Seed und Tests legen Versionen über diese Übergänge an).
- Portal-Meldungen mit `idempotenzSchluessel` (tcms-s10): Rechte zuerst, dann unter der Sperre
  `tenantSperre(tx, 'portal-meldung|<mandant>|<person>|<schlüssel>')` die Bindung lesen; innerhalb von
  24 h (echte Zeit) gleicher Inhalt (SHA-256 der geprüften Eingabe) → dieselbe Antwort ohne Ereignis,
  Nachricht oder Audit, anderer Inhalt → `IDEMPOTENZ_ABWEICHUNG`. Der Schlüssel gilt nur für die
  Person, die ihn verwendet hat (nie die Antwort einer anderen); `PortalMeldungIdempotenz` hat kein
  UPDATE für `tcms_app`.
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
- Fachrouten nur über `Routen.endpunkt(ENDPUNKTE.<name>, handler)`; Methode,
  Muster, `portal`, Schemas und Erfolgsstatus stehen nur im Endpunktregister
  (`packages/contract/src/endpunkte.ts`). Ein neuer Endpunkt entsteht zuerst
  dort; weichen Routentabelle und Register ab, startet der Dienst nicht. Jede
  Fachroute verlangt Token und Bestätigung. Jede Route lässt nur die
  Akteursarten aus `akteure` zu (sonst 404): `MANDANT`-Personen nur `/v1/ich`
  und `…/portal/…`, die Portal-Endpunkte nur `MANDANT`-Personen
  (`NUR_MANDANT`, beim Laden von `pruefePortal` erzwungen), der Systemakteur (`knd: SYSTEM`, ohne `rol`/`cli`) nur die
  drei Nachrichten-Endpunkte, nie neben einer Person und nie auf
  Mandantenpfaden. Pfade unter `/v1/mandanten/:mandantId/…` sind an `cli.id`
  gebunden. Pfadparameter werden nach Body und Query eingesetzt.
- Operationen für Personen bekommen nur einen `DienstKontext` (Akteur
  `PersonAkteur`; `personAkteur`/`imDienst` weisen den Systemakteur mit 404 ab),
  Systemoperationen nur einen `SystemKontext` (`systemAkteur`/`imSystemdienst`).
  Eine neue Systemoperation braucht einen Registereintrag `akteure: NUR_SYSTEM`,
  eine eigene Artprüfung in der Operation und den registerweiten Test
  (`apps/api/src/__tests__/systemakteur*.test.ts`) angepasst.
- Jeder Text einer Eingabe weist NUL und einzelne Surrogate ab (`mitTextBasis`, `freitext`,
  `einzeilig`; RT4-T-08), ebenso die expliziten Richtungssteuerzeichen U+202A–U+202E und
  U+2066–U+2069 (Anzeigefälschung in Inhalten mit Beweiswert, tcms-s9); ZWJ,
  Variantenselektoren und LRM/RLM/ALM bleiben in mehrzeiligen Texten erlaubt (Meldung
  „Unzulässige Zeichen“). Scheitert trotzdem ein Text an der Datenbank (22021, 22P05,
  22P02, `eingabeFehlercode` aus `@tcms/db`), antworten Dienst (`fehlerAntwort`) und
  Dienstkern (`imDienst`, `imSystemdienst`) `UNGUELTIG`; ins Log nur der Code (`dbFehler`).
- Logs: JSON-Zeilen ohne Header-Werte, Bodys, Namen und rohe Pfade, nur IDs
  und Codes. Keine Secrets in Logs, Fehlermeldungen, Tests oder Commits.
- Jede Sicherheitsannahme hat einen Negativtest, der ohne die Schutzmaßnahme
  scheitert.
- Abweisungen der Datenbank (Trigger, RLS, CHECK, eindeutige Schlüssel, Rechte) prüfen Tests nur
  über `dbAbgewiesen(aufruf, regel.…)` aus `@tcms/db/testhilfe`: SQLSTATE und Meldung des Servers
  mit dem Namen der Regel, gelesen aus den strukturierten Feldern. Nie `toThrow(/Muster/)` oder ein
  Abgleich gegen die `message` eines Fehlers, der von Prisma stammen kann – Prisma hängt einen
  Codeausschnitt der aufrufenden Stelle an, und ein allgemeines Muster trifft auch jede andere Regel
  derselben Art (tcms-s10). Eigene Fehler mit Datenbankbezug über Typ und Code (`DienstFehler`) oder
  `abgewiesenOhneDb`. `packages/db/src/__tests__/fehlerabgleich.test.ts` prüft alle Tests statisch;
  Ausnahmen nur für Tests ohne Datenbank, je Datei und Regel begründet.

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

## Betrieb und Lieferkette (verbindlich, ADR 0001 §8)

- Images nur aus dem `Dockerfile` (Ziele `api`, `migrate`), Basisimages per
  Digest; der Laufzeit-Stage enthält keine Werkzeuge (pnpm, npm, tsx, esbuild,
  Prisma-CLI) und läuft nicht als root. Was in den Build-Kontext darf, regelt
  die Positivliste `.dockerignore`; `pnpm image:pruefen` prüft beides.
- Passwörter und Tokens nie als Kommandozeilenargument, nie in Logs oder
  Ausgaben (auch nicht in Skripten, Tests und CI).
- Lokale Geheimnisse der Entwicklung (`SESSION_SECRET`, `TCMS_CODE_SCHLUESSEL`) erzeugt nur
  `pnpm env:lokal` (`scripts/lokale-env.mjs`): `.env` im Repo-Root, Modus 0600, atomar
  geschrieben, Werte nie ausgegeben, vorhandene gültige Werte unverändert, Abbruch bei
  Symlink, `NODE_ENV=production` oder wenn git `.env` versioniert bzw. nicht ignoriert.
- Neue Abhängigkeiten nur mit exakter Version; `pnpm-workspace.yaml` bleibt so
  streng, wie `scripts/pruefe-lieferkette.sh` verlangt.
- Keine rohen unsichtbaren oder bidirektionalen Zeichen in versionierten Dateien
  („Trojan Source"): Richtungs- und Formatzeichen, Zeilentrenner U+2028/U+2029,
  Steuerzeichen außer TAB/LF, unsichtbare Füller, unsichtbare kombinierende
  Zeichen und Variantenselektoren stehen im Quelltext nur als Escape; alle Dateien
  UTF-8 ohne BOM. Der statische Test
  `packages/contract/src/__tests__/repo-zeichen.test.ts` prüft Index und
  Arbeitsbaum mit derselben Zeichenregel wie die Eingaben (`UNZULAESSIG_KLASSE`,
  ohne TAB und LF, RT4-T-02); Ausnahmen nur je Datei und Zeichen mit Begründung.
- Einzeilige Texte und Dateinamen in Eingaben prüfen nur über die eine Regel
  `UNZULAESSIGE_ZEICHEN` bzw. `DATEINAME_UNZULAESSIG`
  (`packages/contract/src/bereiche/lesepfade.ts`); keine eigenen Zeichenklassen
  in Vertrag, Dienst oder Demo. Jeder Titel und jeder Name einer Eingabe (auch
  Vorlagendaten der Nachrichten, Namen eingefrorener Beschreibungen,
  Teilbereich und Bezeichnungen des Geschäftsprofils, Steuerart, Land und Zeitraum
  betroffener Erklärungen, Quellangabe einer Feststellung) nutzt `einzeilig(min, max)`
  (RT4-T-03, tcms-s10); `__tests__/eingabetexte.test.ts` prüft das für jedes Feld des
  Endpunktregisters: Jedes freie Textfeld ist einzeilig, außer den ausdrücklich
  mehrzeiligen Freitexten der Liste `MEHRZEILIG` (Begründungen, Kommentare, Sachverhalte,
  Beschreibungen); ein neues mehrzeiliges Feld wird dort bewusst eingetragen. Gespeicherte Texte in Antworten prüfen nur die Länge
  (Altbestände, z. B. `ProfilAntwortenGespeichertSchema`, `SetupEntwurfSchema`,
  `BeschreibungAbschnittSchema`); der Dienst liest gespeicherte Entwürfe und Abschnitte mit
  denselben Schemas, damit Altbestand weder unlesbar wird noch beim Speichern verloren geht
  (`eingabetexte.test.ts` prüft jedes Antwortschema). Einzige Ausnahme: gespeicherte Ereignis-Anlagen
  in Antworten (`DATEINAME_GESPEICHERT_UNZULAESSIG`, frühere Regel, weil das
  Meldungs-Audit unveränderlich ist). Die Regel folgt aus Unicode-Eigenschaften
  (`UNZULAESSIG_KLASSE`: Cc, Cf, Zl, Zp, Default_Ignorable_Code_Point, Cs), nie
  aus einer Liste (RT4-T-01). `richtungszeichen.test.ts` (Vertrag) prüft sie für
  jeden Code Point gegen die einzeln abgefragten Eigenschaften und eine
  Pflichtliste, `packages/service/src/__tests__/ablage.test.ts` die BMP, die
  Tag-Zeichen und die unsichtbaren Bereiche außerhalb der BMP.
- Versionierte Dateien sind normale Dateien (Modus 100644), keine Symlinks oder
  Submodule. Ausführbar (100755) sind nur die direkt gestarteten Skripte
  `packages/db/betrieb/migrate.sh`, `scripts/pruefe-lieferkette.sh` und
  `scripts/simuliere-image.sh`; `.mjs`-Skripte laufen über `node …`. Die
  Positivliste mit Begründung steht in
  `packages/contract/src/__tests__/repo-dateimodus.test.ts` (prüft
  `git ls-files -s`).

## Prüfen vor Abschluss

```
sh scripts/pruefe-lieferkette.sh
pnpm typecheck
pnpm test
DB_TESTS=1 DATABASE_URL=… DATABASE_OWNER_URL=… pnpm --filter @tcms/db test
DB_TESTS=1 DATABASE_URL=… DATABASE_OWNER_URL=… pnpm --filter @tcms/api test
pnpm build
pnpm image:pruefen
```

Änderungen am Migrationsläufer zusätzlich mit
`TCMS_MIGRATE_TESTS=1 TCMS_MIGRATE_TEST_SUPERUSER_URL=…` gegen eine Testinstanz
(setzt clusterweite Rollenpasswörter). Die Image-Simulation läuft ohne fremde
Datenbank mit `TCMS_SIM_PGHOST/PGPORT/PGUSER` gegen einen eigenen Test-Cluster
(eigene Datenbank je Lauf, danach gelöscht; `TCMS_SIM_PASSWOERTER_DANACH=entwicklung`),
Änderungen daran zusätzlich mit `TCMS_SIM_TESTS=1` (`apps/api/src/__tests__/simulation.test.ts`)
– beides nie parallel zu anderen Läufen auf demselben Cluster.
