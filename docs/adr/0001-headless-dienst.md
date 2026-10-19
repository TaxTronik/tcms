# ADR 0001 – Tax-CMS als headless Dienst der kanzleikonsole

- **Status:** angenommen (2026-10-19, Rey Koxha)
- **Kontext-Repos:** `tcms` (dieses Repo), `kanzleikonsole` (TaxTronik)

## 1. Entscheidung

Das Tax-CMS wird wie Signal ein interner Dienst ohne eigene Oberfläche. Die
kanzleikonsole besitzt Anmeldung, Kanzleien (Tenants), Mandanten, Mitarbeiter
und Mandantenkontakte und rendert alle Screens. Sie ruft das Tax-CMS über eine
interne URL auf. Das Tax-CMS hält die fachlichen Daten des Tax-CMS (Programme,
Risiken, Kontrollen, Durchführungen, Feststellungen, Ereignisse, Beschreibungen,
Freigaben, Audit) in einer eigenen Datenbank.

Vom Produktverantwortlichen entschieden:

| Frage               | Entscheidung                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Aufrufer und Person | Dienst-Token **und** je Anfrage eine Ed25519-signierte Akteursbestätigung der kanzleikonsole (Abschnitt 3)                                 |
| Mandantentrennung   | `tenant_id` in jeder Tabelle, PostgreSQL-RLS, Laufzeitrolle ohne BYPASSRLS (Abschnitt 4)                                                   |
| Nachweis-Dateien    | Dokumentenpipeline der kanzleikonsole (Virenscan, Journal, WORM); das Tax-CMS speichert nur Verweis, Name, Größe und SHA-256 (Abschnitt 6) |
| Tax-CMS-Rollen      | im Tax-CMS, an IDs der kanzleikonsole; Login, Personen und Zuständigkeit der Kanzlei kommen aus der kanzleikonsole (Abschnitt 5)           |

## 2. Bausteine

| Paket               | Rolle                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`   | reine Fachlogik (unverändert in der Rolle)                                                                                                   |
| `packages/contract` | **neu**: zod-Schemas des HTTP-Vertrags (Anfragen, Antworten, Fehlercodes) und der Akteursbestätigung; wird von der kanzleikonsole importiert |
| `packages/db`       | Prisma-Schema, Mandantenkontext (`mitTenant`), Audit je Tenant                                                                               |
| `packages/service`  | **neu**: Fachoperationen und Lader als Funktionen `(ctx, eingabe)`; `ctx` enthält Transaktion, Akteur, Uhr, Ablage-Port                      |
| `apps/api`          | **neu**: HTTP-Dienst (Hono auf Node 24), nur interne Erreichbarkeit                                                                          |
| `apps/web`          | Demo-Oberfläche bis zur Portierung in die kanzleikonsole; nutzt `packages/service` mit Demo-Akteuren; wird nie produktiv ausgeliefert        |

Kein Code in `apps/api` oder `apps/web` enthält Fachregeln; beide rufen
`packages/service`.

## 3. Authentifizierung zwischen den Diensten

Jede Anfrage an `/v1/*` (außer `GET /v1/health`) trägt zwei Nachweise. Fehlt
einer oder ist er ungültig: `401` mit `{ ok: false, fehler: { code: 'NICHT_AUTHENTIFIZIERT' } }`,
ohne Detail, welcher Teil scheiterte (Detail nur im Server-Log).

### 3.1 Dienst-Token

`Authorization: Bearer <token>`. Konfiguration `TCMS_SERVICE_TOKENS`: eine
kommagetrennte Liste (mindestens ein Eintrag, jeder ≥ 32 Zeichen), damit eine
Rotation mit Überlappung möglich ist. Vergleich in konstanter Zeit gegen jeden
Eintrag (SHA-256 beider Seiten, dann `timingSafeEqual`).

### 3.2 Akteursbestätigung

Header `X-TCMS-Akteur`: kompakte JWS (`base64url(header).base64url(payload).base64url(signatur)`),
Ed25519, ausschließlich mit `node:crypto` erzeugt und geprüft.

Header: `{ "alg": "EdDSA", "typ": "tcms-akteur+jwt", "kid": "<schlüssel-id>" }`.
Andere `alg`/`typ` werden abgewiesen. `TCMS_ACTOR_PUBLIC_KEYS`: Liste
`kid=<base64 SPKI-DER>` (kommagetrennt, mehrere Schlüssel für die Rotation).

Payload (alle Felder Pflicht, wo nicht anders genannt; unbekannte Felder → abweisen):

| Feld  | Typ                                                          | Bedeutung                                                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss` | `"kanzleikonsole"`                                           |                                                                                                                                                                                                                                                                       |
| `aud` | `"tcms"`                                                     |                                                                                                                                                                                                                                                                       |
| `iat` | Sekunden                                                     | nicht mehr als 30 s in der Zukunft                                                                                                                                                                                                                                    |
| `exp` | Sekunden                                                     | `exp > now`, `exp - iat ≤ 120`                                                                                                                                                                                                                                        |
| `jti` | 22–64 Zeichen base64url                                      | Einmal-ID; das Tax-CMS speichert sie bis `exp` und weist Wiederholungen ab (`409 WIEDERHOLT`, intern 401)                                                                                                                                                             |
| `tnt` | UUID                                                         | Tenant (Kanzlei) der kanzleikonsole                                                                                                                                                                                                                                   |
| `sub` | UUID                                                         | Person: Mitarbeiter-ID bzw. Mandantenkontakt-ID der kanzleikonsole                                                                                                                                                                                                    |
| `knd` | `"KANZLEI"` \| `"MANDANT"`                                   | Art der Person                                                                                                                                                                                                                                                        |
| `nam` | String 1–200                                                 | Anzeigename zum Zeitpunkt der Anfrage (für Audit und Nachrichten)                                                                                                                                                                                                     |
| `rol` | `{ adm: boolean, bt: boolean }`                              | nur `KANZLEI`: Admin/Partner der Kanzlei; Berufsträger:in                                                                                                                                                                                                             |
| `cli` | `{ id: UUID, bt: boolean, hb: boolean }`                     | optional bei `KANZLEI`, Pflicht bei `MANDANT`: Mandant, auf den sich die Anfrage bezieht. Die kanzleikonsole setzt `cli` nur, wenn die Person Zugriff auf den Mandanten hat. `bt`: zuständige:r Berufsträger:in, `hb`: Hauptbearbeitung (bei `MANDANT` beide `false`) |
| `req` | `{ m: Methode, p: Pfad+Query, b: base64url(SHA-256(Body)) }` | bindet die Bestätigung an genau diese Anfrage; leerer Body → Hash des leeren Strings                                                                                                                                                                                  |

Prüfreihenfolge im Dienst je Anfrage: Request-ID → Methode und Pfad bekannt
(rohes Target, sonst `404`/`405`) → `Content-Length` vorab gegen die
Body-Grenze (`413`, ohne zu lesen) → Dienst-Token (vor dem ersten Body-Byte:
ohne gültiges Token puffert der Dienst nichts, die Verbindung wird
geschlossen) → Body roh lesen mit gestreamter Grenze (`413`) →
Akteursbestätigung: Größe (≤ 4 KiB) → Struktur → `kid` bekannt → Signatur →
Claims (zod, strikt) → Zeitfenster → `req` gegen die tatsächliche Anfrage
(Hash des rohen Bodys) → `jti` einmalig → Mandantenbindung (3.3). Erst danach
wird der Body geparst.

### 3.3 Mandantenbindung

- Jeder Pfad unter `/v1/mandanten/{mandantId}/…` verlangt `cli.id == mandantId`.
  Abweichung → `404` (nicht `403`, damit keine Existenz verraten wird).
- `MANDANT`-Personen erreichen nur Pfade ihres eigenen Mandanten und nur die
  Portal-Endpunkte.
- Mandantenübergreifende Lesepfade (Portfolio, Arbeitskorb) bekommen die Liste
  der zugänglichen Mandanten-IDs im Body (gebunden über `req.b`, höchstens
  5 000 IDs) und liefern nur diese.
- Dieselben Lesepfade tragen je Mandant die Zuständigkeit wie `cli`:
  `bt` (Mandanten, für die die Person zuständige:r Berufsträger:in ist) und
  `hb` (Hauptbearbeitung) als Teilmengen von `mandantIds` im selben Body,
  ebenfalls über `req.b` gebunden. Doppelte oder nicht in `mandantIds`
  enthaltene Einträge → `400`. Die Angaben steuern nur Auswahl und
  Zuständigkeitskennzeichen der Liste; Schreibrechte entstehen daraus nie
  (Schreiben nur mandantenbezogen mit `cli`).

## 4. Mandantentrennung in der Datenbank

- Jede Tabelle erhält `tenant_id uuid NOT NULL`; Indizes und eindeutige
  Schlüssel beginnen mit `tenant_id`, wo sie fachlich je Kanzlei gelten
  (z. B. Ereignisnummern, Feststellungsnummern, Wiedervorlagen).
- Rollen: `tcms_owner` (Eigentümer der Tabellen, nur Migrationen),
  `tcms_app` (Laufzeit, `NOBYPASSRLS`, kein Superuser, nur DML).
  `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` auf allen Tabellen; Policy
  `tenant_id = current_setting('tcms.tenant_id', true)::uuid` für alle Befehle.
- `mitTenant(tenantId, fn)` öffnet eine Transaktion und setzt
  `set_config('tcms.tenant_id', tenantId, true)`. Ohne gesetzten Tenant sieht
  die App-Rolle nichts. Jede API-Anfrage läuft vollständig in genau einer
  solchen Transaktion (Lesen wie Schreiben). Vor dem Commit prüft `mitTenant`,
  dass der Kontext unverändert ist; sonst Rollback (Abschnitt 10.1).
- Tabelle `akteur_jti (jti PK, exp)`: nicht mandantengebunden, nur INSERT und
  Löschen abgelaufener Einträge.
- Audit: Kette **je Tenant**; Advisory-Lock je Tenant (nicht global); der Hash
  umfasst zusätzlich `tenant_id`, `actorName` und `programmId` (Kettenversion 2).
  Nach außen zählt die Position `pos` je Tenant lückenlos (1, 2, 3, …, unter der
  Sperre vergeben, `(tenant_id, pos)` eindeutig); Liste, Cursor, Kettenkopf,
  Kettenprüfung und Verläufe nennen nur `pos`. Der globale technische Schlüssel
  `seq` verlässt den Dienst nie: Lücken darin verrieten die Audit-Aktivität
  anderer Kanzleien (RT-03). Die Kettenprüfung verlangt lückenlose Positionen.

Es gibt noch keinen Echtbetrieb und keine Bestandsdaten. Die Migrationshistorie
beginnt mit dieser Stufe neu (eine neue Init-Migration ersetzt die bisherige).

## 5. Personen und Rollen

- Die Tabelle `Person` entfällt. Alle Personenfelder (`durchfuehrendId`,
  `gegengezeichnetVon`, `erfasstVon`, …) enthalten IDs der kanzleikonsole
  (Mitarbeiter oder Mandantenkontakt). Anzeigenamen löst die kanzleikonsole auf;
  das Audit speichert zusätzlich `actorName` aus `nam`.
- `Mandant` wird zum Anker: `id` = Mandanten-ID der kanzleikonsole, dazu
  `tenant_id`, `name`, `rechtsform` (von der kanzleikonsole beim Einrichten
  übergeben und per Endpunkt aktualisierbar). Schlüssel ist `(tenant_id, id)`:
  Das Anlegen verrät nie, ob dieselbe ID in einem anderen Tenant besteht. `berufstraegerId` und
  `bearbeitungId` entfallen; Zuständigkeit kommt aus `cli.bt` / `cli.hb`.
- Neu `MandantKontaktRolle (tenant_id, mandant_id, kontakt_id, rolle, funktion, aktiv)`:
  Rollen der Mandantenseite (`GESETZLICHER_VERTRETER`,
  `TAX_COMPLIANCE_BEAUFTRAGTER`, `MITARBEITER`). Pflege durch Personen mit
  `kannBearbeiten`. Ein Mandantenkontakt ohne aktive Rolle hat keinen Zugriff.
- Rechte (bisher `apps/web/src/server/rechte.ts`) wandern als reine Funktionen
  über den `Akteur` nach `packages/service`:
  - `kannLesen`: `KANZLEI` mit `cli.id == mandantId`; `MANDANT` mit aktiver Rolle
    beim eigenen Mandanten (Portal-Lesen wie bisher: GV, TCB; Aufgaben über
    Zuweisung).
  - `kannBearbeiten`: `KANZLEI` und (`rol.adm` oder `cli.bt` oder `cli.hb`).
  - `kannWuerdigen` (§ 153): `rol.bt` und (`rol.adm` oder `cli.bt`).
  - Vier-Augen-Regeln unverändert (Personen-IDs verglichen).

## 6. Nachweise

Die kanzleikonsole nimmt Dateien an (Virenscan, Journal, WORM) und meldet dem
Tax-CMS nur `{ dokumentId, dateiname, mime, groesse, sha256 }`. Das Tax-CMS
speichert diesen Verweis (Tabelle `Nachweis`) und gibt ihn zurück; Downloads
laufen über die kanzleikonsole. Die Demo-Oberfläche nutzt einen Ablage-Port
mit lokaler Dateiablage, der Dienst einen Port, der nur Verweise annimmt.

## 7. HTTP-Vertrag

- Basis `/v1`. JSON, UTF-8. Body höchstens 256 KiB (`413`). Antworten
  `{ ok: true, daten }` bzw. `{ ok: false, fehler: { code, meldung?, felder? } }`.
- Codes: `400 UNGUELTIG` (zod, mit `felder`), `401 NICHT_AUTHENTIFIZIERT`,
  `403 NICHT_BERECHTIGT` (mit fachlichem Grund, z. B. Vier-Augen),
  `404 NICHT_GEFUNDEN` (auch fremder Tenant/Mandant), `409 KONFLIKT`
  (Status hat sich geändert, Doppelentscheidung), `413 ZU_GROSS`.
- Datumswerte als ISO-8601-Strings, keine `Map`/`Set`/`Date` im JSON.
- Lesen zu einem Stichtag: `?stand=YYYY-MM-DD`. Schreibende Endpunkte nehmen
  **keinen** Stichtag an und arbeiten immer auf dem aktuellen Stand.
- Personen-IDs der kanzleikonsole für Vorbelegung und Anzeige (nie für
  Rechte): Schreibende Endpunkte nehmen sie im Body, lesende als Query –
  `GET …/einrichtung?berufstraegerId=&bearbeitungId=&vertretungId=`
  (Vorbelegung der Zuständigkeiten) und
  `GET …/beschreibung?stand=&berufstraegerId=&bearbeitungId=` (Baustein
  „Verantwortung"). Die Query ist Teil von `req.p` und damit von der
  Akteursbestätigung gebunden; nur UUIDs, unbekannte oder doppelte Parameter
  → `400`. Rechte kommen ausschließlich aus der Akteursbestätigung.
- „Heute“ kommt aus einer injizierten Uhr; `TCMS_DEMO_TODAY` wirkt nur in der
  Demo-Oberfläche, nie im Dienst.
- Antwort-Header: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
  Keine CORS-Freigaben.
- `GET /v1/health`: nur Dienst-Token, liefert `{ ok, version, datenbank }`.

## 8. Betrieb (Stufe 2, in der kanzleikonsole)

Wie Signal (`TCMS_DEPLOYMENT=managed|external|disabled`, Compose-Profil,
Modulschalter `tcms`), mit diesen Abweichungen von Signal: internes Netz
(`internal: true`) zwischen App und Tax-CMS, eigene Datenbank und eigene Rollen,
Image per Digest gepinnt plus Signaturprüfung, Antwortgrößen begrenzt,
Token- und Schlüsselrotation mit Überlappung, ein Vertragstest gegen den echten
Dienst.

Produktions-Image (RT-04, Advisories in Werkzeugen): Das Image des Dienstes
enthält nur Laufzeitabhängigkeiten (`pnpm deploy --prod` o. ä. für
`@tcms/api`), keine Prisma-CLI (`prisma`), kein `tsx`/`esbuild` und keine
Test- oder Build-Werkzeuge. Der Prisma-Client wird im Build-Schritt erzeugt und
übernommen; der Dienst wird dort übersetzt (heute startet `pnpm api` noch über
`tsx`, das dafür in die devDependencies wandert). Migrationen laufen in einem
getrennten, kurzlebigen Schritt mit eigenem Image als `tcms_owner`
(`DATABASE_OWNER_URL` nur dort); der laufende Dienst kennt nur `DATABASE_URL`
der Rolle `tcms_app`. Damit erreichen Advisories in Entwicklungswerkzeugen
(CLI, Bundler, Testläufer) den Produktionsbetrieb nicht. Die Umsetzung des
Images folgt in Stufe 2.

## 9. Sicherheitsbefunde des Prototyps, die diese Stufe behebt

| ID    | Befund                                                                                                        | Behebung                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS-01 | Entwicklungs-Anmeldung auch in Produktion möglich (`TCMS_DEV_LOGIN=1` in `.env.example`)                      | Dienst kennt keine Anmeldung; Demo-Login nur in `apps/web`, verweigert mit `NODE_ENV=production`                                                                                        |
| TS-02 | Platzhalter-`SESSION_SECRET` erfüllt die Längenprüfung                                                        | entfällt im Dienst; Demo lehnt bekannte Platzhalter ab                                                                                                                                  |
| TS-03 | Jede Kanzleiperson liest jeden Mandanten und jeden Nachweis                                                   | Mandantenbindung (3.3), `kannLesen`                                                                                                                                                     |
| TS-04 | Feststellung mit Steuerwirkung „NEIN“ durch Nicht-Berufsträger umgeht § 153                                   | Anlegen mit „NEIN“ nur mit `kannWuerdigen`, sonst „OFFEN/zu würdigen“                                                                                                                   |
| TS-05 | Prüfungen vor der Transaktion, unbedingte Updates: Doppelentscheidungen, Versionsgabelung, doppelte Programme | Prüfung und Änderung in derselben Transaktion mit Zeilensperre bzw. bedingtem Update; eindeutige Schlüssel (`(kontrolle_id, version)`, `(risiko_id, version)`, ein Programm je Mandant) |
| TS-06 | Jede:r GV kann eine fremd adressierte Freigabe an sich ziehen; Nachrichten über Namen zugeordnet              | Freigabe nur durch den Empfänger; Neuadressierung als eigene, auditierte Aktion durch die Kanzlei; Zuordnung über IDs                                                                   |
| TS-07 | Historischer Stichtag nur teilweise serverseitig schreibgeschützt                                             | Schreibende Endpunkte ohne Stichtag (Abschnitt 7)                                                                                                                                       |
| TS-08 | Globaler Audit-Lock serialisiert alle Schreibvorgänge                                                         | Lock und Kette je Tenant                                                                                                                                                                |
| TS-09 | Anhang-Download von Ereignissen ohne Integritätsprüfung; Nachweis-Download nicht auditiert                    | Downloads laufen über die kanzleikonsole (Abschnitt 6)                                                                                                                                  |
| TS-10 | Audit-Hash deckt `actorName` und `programmId` nicht ab                                                        | Kettenversion 2 (Abschnitt 4)                                                                                                                                                           |
| TS-11 | Datenbank-Container mit Standardpasswort auf allen Schnittstellen                                             | Compose nur für Entwicklung, Port an `127.0.0.1` gebunden                                                                                                                               |

## 10. Bekannte Restrisiken

### 10.1 RLS schützt nicht gegen SQL-Injection derselben Rolle (RT-02)

Der Tenant-Kontext `tcms.tenant_id` ist ein gewöhnlicher GUC, den jede Rolle mit
`set_config` setzen kann. Wer beliebiges SQL als `tcms_app` ausführt – über eine
SQL-Injection oder mit den Zugangsdaten der Laufzeitrolle –, liest und schreibt
damit jeden Tenant; RLS hält das nicht auf. Eine konkrete Injection ist nicht
bekannt (Angriffsdurchlauf vom 2026-10-19). Entscheidung des
Produktverantwortlichen: das Restrisiko dokumentieren und die Voraussetzung
„keine Injection" maschinell absichern. Eine fälschungssichere Tenant-Bindung
(z. B. Bindung je Transaktion über eine `SECURITY DEFINER`-Funktion von
`tcms_owner` in eine für `tcms_app` nicht schreibbare Tabelle, oder eine Rolle je
Tenant) bleibt eine Option für Stufe 2.

Gegenmittel:

- **Parametrisierte Abfragen erzwungen.** Der statische Test
  `packages/db/src/__tests__/roh-sql.test.ts` prüft alle Quelltexte (Apps, Pakete,
  Seed, Skripte) mit dem TypeScript-Parser: kein `$queryRawUnsafe` oder
  `$executeRawUnsafe`, kein `Prisma.raw`, `sql.raw` oder `.raw(…)`;
  `$queryRaw`/`$executeRaw` nur als Tagged Template (Werte werden Parameter);
  `pg`-Abfragen nur mit festem SQL-Text; `set_config` und `tcms.tenant_id` nur in
  `packages/db/src/tenant.ts`. Ausnahmen nur für Tests und den Seed, je Datei und
  Regel begründet; Laufzeitcode kann nicht freigestellt werden.
- **Prüfung des Kontexts vor dem Commit.** `mitTenant` prüft nach dem Callback in
  derselben Transaktion, dass `tcms.tenant_id` noch genau der gesetzte Tenant ist;
  sonst Rollback, `TenantFehler` (Dienst: `500 INTERN`) und eine Log-Zeile
  `tenant_kontext_veraendert` ohne Details. Das Ergebnis des Callbacks verlässt
  die Transaktion nicht. Grenze: Beliebiges SQL kann den Kontext vor dem Commit
  zurücksetzen. Die Prüfung fängt ein versehentliches oder naives Umsetzen ab; eine
  Sicherheitsgrenze gegen einen Angreifer mit SQL ist sie nicht.
- **Audit nur anhängen.** `tcms_app` hat auf `AuditEvent` weder UPDATE noch
  DELETE: Auch mit SQL lässt sich die Kette weder umschreiben noch kürzen.
  Anhängen bleibt möglich; der Hash bindet Inhalte, er authentifiziert keine
  Person (Abschnitt 4).
- **Zugangsdaten und Netz.** `DATABASE_URL` nur im Dienst, Datenbank nur im
  internen Netz (Abschnitt 8).

Bekannte Restfälle (als solche gekennzeichnet in
`packages/service/src/__tests__/redteam/rls-tenant-pivot.db.test.ts`): reiner
SQL-Zugriff der Rolle außerhalb von `mitTenant`; Umsetzen und Zurücksetzen des
Kontexts innerhalb derselben Transaktion.

### 10.2 Weitere bekannte Grenzen

- **Audit-Position (RT-03).** `pos` gehört nicht zum Hash (Kettenversion 2); die
  Kettenprüfung verlangt sie lückenlos. Eine Änderung setzt UPDATE-Rechte voraus,
  die die Laufzeitrolle nicht hat. Der globale Schlüssel `seq` bleibt in der
  Datenbank lesbar (nur mit SQL, siehe 10.1).
- **Vertraulichkeit (RT-01)** gilt für die Feststellung selbst. Texte außerhalb der
  Feststellung bleiben für alle mit Leserecht sichtbar: Beschreibung und Folgetexte
  eines Ereignisses, aus dem eine Feststellung entstand, der Ergebniskommentar einer
  Durchführung mit Befund, die für eine Nachkontrolle gewählte Kontrolle.
  Admins/Partner gehören nach Fachkonzept §13 zum Kreis der Beteiligten und sehen im
  tenantweiten Audit alle Details.
