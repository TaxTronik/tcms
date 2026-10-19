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

| Feld  | Typ                                                          | Bedeutung                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss` | `"kanzleikonsole"`                                           |                                                                                                                                                                                                                                                                                              |
| `aud` | `"tcms"`                                                     |                                                                                                                                                                                                                                                                                              |
| `iat` | Sekunden                                                     | nicht mehr als 30 s in der Zukunft                                                                                                                                                                                                                                                           |
| `exp` | Sekunden                                                     | `exp > now`, `exp - iat ≤ 120`                                                                                                                                                                                                                                                               |
| `jti` | 22–64 Zeichen base64url                                      | Einmal-ID; das Tax-CMS speichert sie bis `exp` und weist Wiederholungen ab (`409 WIEDERHOLT`, intern 401)                                                                                                                                                                                    |
| `tnt` | UUID                                                         | Tenant (Kanzlei) der kanzleikonsole                                                                                                                                                                                                                                                          |
| `sub` | UUID                                                         | Person: Mitarbeiter-ID bzw. Mandantenkontakt-ID der kanzleikonsole; Systemakteur: feste ID des Dienstnutzers je Tenant                                                                                                                                                                       |
| `knd` | `"KANZLEI"` \| `"MANDANT"` \| `"SYSTEM"`                     | Akteursart (3.4)                                                                                                                                                                                                                                                                             |
| `nam` | String 1–200                                                 | Anzeigename zum Zeitpunkt der Anfrage (für Audit und Nachrichten); beim Systemakteur seine Bezeichnung                                                                                                                                                                                       |
| `rol` | `{ adm: boolean, bt: boolean }`                              | nur `KANZLEI` (dort Pflicht): Admin/Partner der Kanzlei; Berufsträger:in                                                                                                                                                                                                                     |
| `cli` | `{ id: UUID, bt: boolean, hb: boolean }`                     | optional bei `KANZLEI`, Pflicht bei `MANDANT`, verboten bei `SYSTEM`: Mandant, auf den sich die Anfrage bezieht. Die kanzleikonsole setzt `cli` nur, wenn die Person Zugriff auf den Mandanten hat. `bt`: zuständige:r Berufsträger:in, `hb`: Hauptbearbeitung (bei `MANDANT` beide `false`) |
| `req` | `{ m: Methode, p: Pfad+Query, b: base64url(SHA-256(Body)) }` | bindet die Bestätigung an genau diese Anfrage; leerer Body → Hash des leeren Strings                                                                                                                                                                                                         |

Prüfreihenfolge im Dienst je Anfrage: Request-ID → Methode und Pfad bekannt
(rohes Target, sonst `404`/`405`) → `Content-Length` vorab gegen die
Body-Grenze (`413`, ohne zu lesen) → Dienst-Token (vor dem ersten Body-Byte:
ohne gültiges Token puffert der Dienst nichts, die Verbindung wird
geschlossen) → Body roh lesen mit gestreamter Grenze (`413`) →
Akteursbestätigung: Größe (≤ 4 KiB) → Struktur → `kid` bekannt → Signatur →
Claims (zod, strikt) → Zeitfenster → `req` gegen die tatsächliche Anfrage
(Hash des rohen Bodys) → `jti` einmalig → Akteursart der Route und
Mandantenbindung (3.3, 3.4). Erst danach wird der Body geparst.

### 3.3 Mandantenbindung

- Jeder Pfad unter `/v1/mandanten/{mandantId}/…` verlangt `cli.id == mandantId`.
  Abweichung → `404` (nicht `403`, damit keine Existenz verraten wird).
- Jeder Endpunkt nennt im Endpunktregister die zugelassenen Akteursarten
  (`akteure`, Abschnitt 7). Jede andere Art erhält `404` wie ein unbekannter
  Pfad – vor jeder Auswertung der Eingaben.
- `MANDANT`-Personen erreichen nur Pfade ihres eigenen Mandanten und nur die
  Portal-Endpunkte (und `/v1/ich`); die Portal-Endpunkte erreichen nur sie
  (Stufe 5).
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

### 3.4 Akteursarten und Systemakteur (Stufe 4)

| Art       | Wer                                                                                                 | Rechte                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `KANZLEI` | Mitarbeiter:in der Kanzlei (`rol`, optional `cli`)                                                  | Abschnitt 5; Mandantenpfade nur mit `cli`                                                                                     |
| `MANDANT` | Mandantenkontakt (`cli` Pflicht, ohne Rollen)                                                       | nur Portal-Endpunkte des eigenen Mandanten, Rollen aus `MandantKontaktRolle`                                                  |
| `SYSTEM`  | Dienstnutzer der kanzleikonsole je Tenant, z. B. der Worker, der Nachrichten zustellt (kein Mensch) | **nur** `GET /v1/nachrichten/offen`, `POST /v1/nachrichten/:id/zugestellt` bzw. `…/unzustellbar`; jeder andere Endpunkt `404` |

Der Systemakteur hat weder `rol` noch `cli` (sonst `401`), `sub` ist eine von
der kanzleikonsole je Tenant fest vergebene UUID, `nam` seine Bezeichnung
(1–200 Zeichen). Eine erfundene Admin-Person wäre eine viel breitere Identität
(Abschnitt 5: Admin liest den ganzen Tenant). Der Ausschluss gilt in drei
Schichten, jede für sich getestet über alle Einträge des Endpunktregisters:

1. Routentabelle: Akteursart nicht in `akteure` → `404`, ohne Handler und ohne
   Tenant-Transaktion.
2. Kontexte: Operationen für Personen bekommen nur einen `DienstKontext`
   (`personAkteur`: Systemakteur → `404`, bevor die Transaktion benutzt
   wird); die Systemoperationen (abholen, Zustellung bzw. Unzustellbarkeit
   melden) nur einen `SystemKontext`
   (`systemAkteur`: jede Person → `404`, auch Admins).
3. Operationen und Rechte: Die Nachrichten-Operationen prüfen die Art vor
   ihrer Eingabe erneut; jede Rechtefunktion (Abschnitt 5) verweigert dem
   Systemakteur jedes Recht.

Im Audit ist ein Systemakteur erkennbar: `actorName` beginnt mit `System: `,
`detail.systemakteur` ist `true` (diesen Schlüssel setzt nur `mitAudit`);
beides liegt im Hash der Kette. Logs nennen `akteurArt`.

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
  `{ ok: true, daten }` bzw. `{ ok: false, fehler: { code, meldung?, felder?, grund? } }`.
- Codes: `400 UNGUELTIG` (zod, mit `felder`), `401 NICHT_AUTHENTIFIZIERT`,
  `403 NICHT_BERECHTIGT` (mit fachlichem Grund, z. B. Vier-Augen),
  `404 NICHT_GEFUNDEN` (auch fremder Tenant/Mandant), `409 KONFLIKT`
  (Status hat sich geändert, Doppelentscheidung), `413 ZU_GROSS`.
- `grund` (Stufe 5) steht genau bei `403` und dort immer: ein Wert aus
  `VERWEIGERUNG_GRUENDE` (`BEARBEITEN`, `WUERDIGEN`, `VIER_AUGEN`,
  `VERWALTUNG`, `VERTRAULICH`, `DURCHFUEHREN`, `GEGENZEICHNEN`, `PARTEI`,
  `PORTAL_ROLLE`, `PORTAL_ZUGEORDNET`), je Wert eine Rechtefunktion des
  Dienstes; die kanzleikonsole wählt danach ihre feste Meldung. Erst nach der
  Sichtbarkeitsprüfung, nie an `404` (kein Existenz-Orakel). Die
  Rechte-Kennzeichen der Kontrolldurchführung tragen denselben Wert als
  `verweigerung` (`{ erlaubt, grund, verweigerung }`, `null` bei Erlaubnis oder
  wenn nur der Zustand entgegensteht – dann `409`); Kennzeichen und
  Schreiboperation rechnen mit derselben Rechtefunktion. `DienstFehler`
  erzwingt das (Typ und Konstruktor; ein 403 ohne Grund wird `500 INTERN`),
  `FehlerSchema` ebenso, ein statischer Test hält jede Stelle mit ihrem Grund
  fest (`packages/service/src/__tests__/verweigerung.test.ts`).
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

**Endpunktregister (Stufe 2).** `packages/contract/src/endpunkte.ts` (`ENDPUNKTE`)
führt jeden Endpunkt genau einmal: Name, Methode, Pfadmuster, `akteure`
(zugelassene Akteursarten, Stufe 4), `portal`, `mandantenbezogen`, `akteur`
(nur `health` ohne Bestätigung), `paramsSchema`, `querySchema`/`bodySchema`
(oder `null`), `antwortSchema` (Schema von `daten`) und `erfolgStatus`. Der
Dienst registriert jede Route aus dem Register (`Routen.endpunkt`) und prüft
beim Start, dass Routentabelle und Register genau übereinstimmen (auch die
Akteursarten); sonst startet er nicht.

`akteure` ist die einzige Quelle der Zulassung: Standard `['KANZLEI']`,
`['KANZLEI', 'MANDANT']` nur für `/v1/ich`, `['MANDANT']` für alle
Portal-Endpunkte (`…/portal/…`, seit Stufe 5: Kanzleipersonen lesen und
schreiben über ihre eigenen Endpunkte, ein Portal-Endpunkt antwortet ihnen
`404`), `['SYSTEM']` nur für die drei Nachrichten-Endpunkte, leer nur bei
`health`. `pruefeAkteure` weist beim Laden des Vertrags unbekannte oder
doppelte Arten ab, ebenso `SYSTEM` neben einer Person oder auf einem
Mandantenpfad; `pruefePortal` weist jeden Registereintrag ab, der einen
Portal-Pfad nicht genau `MANDANT` öffnet oder `MANDANT` außerhalb des Portals
und `/v1/ich` zulässt. `portal` ist abgeleitet (`akteure` enthält `MANDANT`) und bleibt
nur für bestehende Aufrufer (Client der kanzleikonsole); entschieden wurde
gegen zwei Felder mit eigener Bedeutung, damit eine Definition sich nicht
widersprechen kann.

**Postausgang (Stufe 4).** Der Zustell-Worker der kanzleikonsole holt mit dem
Systemakteur `GET /v1/nachrichten/offen?limit=` (1–100, Standard 50, älteste
zuerst) und meldet `POST /v1/nachrichten/:nachrichtId/zugestellt` (idempotent
für Nachrichten des eigenen Tenants; unbekannte und fremde IDs `404`). Kann er
eine Nachricht nicht zustellen (Empfänger gehört nicht zum Mandanten, kein
bestätigter Portalzugang, Frist abgelaufen), meldet er
`POST /v1/nachrichten/:nachrichtId/unzustellbar` mit `{ grund }`
(`EMPFAENGER_UNGUELTIG`, `KEIN_PORTALZUGANG`, `ABGELAUFEN`, `SONSTIGES`): Das
setzt `unzustellbarAm`/`unzustellbarGrund`, leert `code` und `text` wie die
Zustellung, die Nachricht wird nicht mehr ausgeliefert, Audit
`tcms.nachricht.unzustellbar` (Zweck, Empfänger-ID, Grund, keine Inhalte).
Idempotent mit demselben Grund; ein anderer Grund → `409`. Zugestellt und
unzustellbar schließen sich aus (`409` in beide Richtungen, unter Zeilensperre
geprüft, zusätzlich CHECK). Wo die Kanzlei Freigaben sieht
(Freigabenhistorie, CMS-Beschreibung, Risikoakzeptanz), trägt jede Freigabe
`zustellung`: Status der jüngsten Nachricht an den aktuellen Empfänger
(`OFFEN`, `ZUGESTELLT`, `UNZUSTELLBAR` mit `grund`, `VERWORFEN`; Zweck und
Zeitpunkte, keine Inhalte; `null` ohne Nachricht und im historischen Stand),
damit sie bei „unzustellbar" neu adressieren kann. Eine
offene Nachricht ist nach `zweck` diskriminiert und trägt `mandantId`,
`empfaengerId`, `empfaengerArt` (`KONTAKT` für die drei Freigabe-Zwecke,
`KANZLEI` für `EREIGNIS_GEMELDET`), `daten` (Vorlagendaten: `freigabeId`,
`art`, `titel`, `version`; beim Code zusätzlich `code`, `gueltigBis`,
`sha256`; beim Ereignis `ereignisId`, `nummer`, `titel`, `typ`,
`gemeldetVonId`) und `betreff`/`text` als Rückfall. Ein Code steht im Klartext
nur in der offenen Nachricht (Spalte `code`, nie in `daten`, nie in Antworten,
Logs oder Audit). Zustellung leert `code` und `text`; gilt ein Code nicht mehr
(Freigabe erledigt, Code abgelaufen, ersetzt, gesperrt, neu adressiert,
Freigabe eines anderen Mandanten), liefert der Abruf die Nachricht nicht mehr
aus und leert sie (`verworfenAm`, Audit `tcms.nachricht.verworfen` mit Grund).
Ausgeliefert wird nur, was geprüft ist (Kandidaten und je Abruf die ältesten
1 000 offenen Code-Nachrichten). CHECKs in der Datenbank erzwingen
Empfängerart je Zweck, Codeformat, leeren Klartext nach Zustellung,
Unzustellbarkeit oder Verwerfen, den Grund genau bei „unzustellbar" und den
Ausschluss von zugestellt und unzustellbar. Pfadparameter prüft er nach der
Mandantenbindung mit `paramsSchema` (`400`). Die API-Tests prüfen jede Antwort
gegen `antwortSchema` bzw. `FehlerSchema`. Antwortschemas sind streng
(unbekannte Felder abgewiesen), außer dem Inhalt eingefrorener
CMS-Beschreibungen (Snapshot). Die kanzleikonsole speist ihren Client direkt
aus einem Eintrag.

## 8. Betrieb (Stufe 2, in der kanzleikonsole)

Wie Signal (`TCMS_DEPLOYMENT=managed|external|disabled`, Compose-Profil,
Modulschalter `tcms`), mit diesen Abweichungen von Signal: internes Netz
(`internal: true`) zwischen App und Tax-CMS, eigene Datenbank und eigene Rollen,
Image per Digest gepinnt plus Signaturprüfung, Antwortgrößen begrenzt,
Token- und Schlüsselrotation mit Überlappung, ein Vertragstest gegen den echten
Dienst.

Produktions-Images (RT-04, Advisories in Werkzeugen; Betriebsschnittstelle
Stufe 2). Ein `Dockerfile` mit zwei Zielen, Basisimages per Digest gepinnt
(dieselben wie in der kanzleikonsole), ohne `# syntax=`-Zeile:

- **`tcms-api`** (Node 24 Alpine): Der Build-Schritt bündelt `apps/api` mit allen
  Workspace-Paketen zu `dist/server.mjs` (esbuild, nur dort), erzeugt den
  Prisma-Client und stellt mit `pnpm deploy --prod --no-optional` die
  Laufzeitabhängigkeiten zusammen; `apps/api/scripts/laufzeit.mjs` bricht ab,
  wenn `tsx`, `esbuild`, die Prisma-CLI oder -Engines, TypeScript, Vitest,
  Workspace-Kopien (Seeds, Demo) oder eine `.env` im Baum liegen. Das Image
  enthält weder pnpm, npm, Corepack noch Yarn, läuft als UID/GID 10001 mit
  schreibgeschützten Dateien (Root-Dateisystem schreibgeschützt möglich), lauscht
  auf 3200 und bringt `node /app/healthcheck.mjs` mit (Token aus der Umgebung,
  Exit 0/1, keine Werte). `TCMS_VERSION` (Image-Tag) ist die Version von
  `/v1/health`. Der Start bricht bei ungültiger Konfiguration oder unsicherer
  Laufzeitverbindung (`pruefeLaufzeitverbindung`) ab und nennt keine Werte;
  `SIGTERM` lässt laufende Anfragen höchstens 20 s zu Ende laufen.
  `TCMS_LOG_LEVEL` (`info|warn|error`) ist optional. `pnpm api` startet in der
  Entwicklung weiter über `tsx` (devDependency).
- **`tcms-migrate`** (`postgres:18-alpine`, ohne Node und Prisma-CLI, UID 70):
  `packages/db/betrieb/migrate.sh` ohne Argumente, idempotent, Abbruch bei jedem
  Fehler. (1) Bootstrap als Superuser (`TCMS_DB_SUPERUSER_URL`) aus
  `prisma/init/rollen.psql` – derselben Datei, die `01_bootstrap.sql` in der
  Entwicklung einbindet; psql liest `TCMS_DB_OWNER_PASSWORD` und
  `TCMS_DB_APP_PASSWORD` selbst (`\getenv`) und setzt sie mit `format('%L')`,
  nachdem die Transaktion Anweisungsprotokoll und `pg_stat_statements`
  abgeschaltet hat. (2) Migrationen als `tcms_owner` (`TCMS_DB_OWNER_URL`) in
  einer psql-Sitzung unter Advisory-Lock, Ledger `_prisma_migrations` mit den
  Spalten von Prisma und SHA-256 der `migration.sql`; abweichende Prüfsumme,
  unvollständige oder dem Image unbekannte Migration → Abbruch; jede Migration
  mit ihrem Ledger-Eintrag in einer Transaktion, Migrationsdateien ohne
  jeden Backslash (psql führt Metabefehle wie `\!` auch mitten in einer Zeile
  aus; Backslash in Literalen über `chr(92)`, RT2-T-01) und ohne eigene
  Transaktionssteuerung. Jeder psql-Aufruf erbt eine geleerte Umgebung: nur
  PATH, Locale und die PG*-Werte seiner Rolle, der Bootstrap zusätzlich die
  beiden Rollenpasswörter; die Migrationssitzung sieht weder die
  Superuser-URL noch fremde Passwörter. (3) Prüfung
  (`betrieb/pruefung.sql`): `tcms_app` kein Superuser, NOBYPASSRLS, keine
  Mitgliedschaft, besitzt nichts, kein TRUNCATE/REFERENCES/TRIGGER, Audit nur
  anhängen; ENABLE+FORCE RLS mit Policy auf allen Tabellen außer Ledger und
  `akteur_jti`. Kein Passwort steht je in einer Kommandozeile (URLs werden in der
  Shell zerlegt und als `PG*`-Umgebung übergeben) oder in der Ausgabe. Kein Seed.

Migrationen laufen damit in einem getrennten, kurzlebigen Schritt als
`tcms_owner`; der laufende Dienst kennt nur `DATABASE_URL` der Rolle
`tcms_app`. CI (`.forgejo/workflows/ci.yml`): Lieferketten-Prüfung vor jeder
Installation, frozen Lockfile, Typecheck, Tests (mit PostgreSQL 18 zweimal auf
derselben Datenbank, aufgebaut mit `tcms-migrate`), Laufzeit-Simulation des
Images, gitleaks, `pnpm audit --prod`, Build beider Ziele; nur auf Tags
Trivy-Gate, SBOM, Push nach `${REGISTRY}/taxtronik/tcms-{api,migrate}` und
Ausgabe der Digests für das signierte Release-Manifest der kanzleikonsole.
`scripts/vertrag-export.mjs` liefert Commit und SHA-256 je Vertragsdatei im
Format von `VENDOR.json` der kanzleikonsole, mit `--paket domain` ebenso für
`packages/domain/src` ohne `audit.ts` (Labels, Formatierung und Katalog für die
Oberflächen der kanzleikonsole, Stufe 3).

Bekannte Grenzen der Images: Das Migrations-Image erbt vom PostgreSQL-Image
dessen Server-Programme und dessen `VOLUME` (eine anonyme Volume je Container,
ohne Inhalt). Der Laufzeitbaum des Dienstes ist rund 100 MB groß, überwiegend
die Laufzeit von `@prisma/client` für alle Datenbanktypen. Antworten prüft zur
Laufzeit nur der Bereich `lesepfade` gegen den Vertrag; für alle übrigen
sichern die API-Tests die Übereinstimmung.

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
  Eine eingefrorene CMS-Beschreibung (Snapshot, unveränderlich) behält eine
  Feststellung, die erst nach dem Einfrieren vertraulich wurde; neue Versionen
  nehmen vertrauliche Feststellungen nie auf. Admins/Partner gehören nach
  Fachkonzept §13 zum Kreis der Beteiligten und sehen im tenantweiten Audit alle
  Details.
