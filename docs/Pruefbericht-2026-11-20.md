# Technische und fachliche Prüfung des Tax-CMS am 20. November 2026

Ausgangspunkt war Commit `14e2050` auf `main`. Geprüft wurden Fachlogik, Dienst und Demo, Datenbankbetrieb, Lieferkette und Laufzeit. Die Datenbankprüfungen liefen mit synthetischen Mandanten in eigenen PostgreSQL-18-Instanzen.

## Fachliche Ergebnisse

| Bereich                    | Befund und Korrektur                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Historische Feststellungen | Eine spätere Änderung der steuerlichen Auswirkung auf „nein“ ließ den damals offenen §-153-Vorgang rückwirkend verschwinden. Die historischen Lesepfade rekonstruieren die frühere Würdigung aus dem Audit. Abgedeckt sind auch spätere Folgeentscheidungen und die in einer Durchführung verknüpfte Feststellung. |
| Gegenzeichnung             | Nach Zurückweisung und erneuter Einreichung konnte ein früherer Bestätigungszeitpunkt erscheinen. Die Anzeige ordnet die Bestätigung der betreffenden Einreichung zu.                                                                                                                                              |
| Kalender und Planung       | Der 31. Februar wurde in den März verschoben. Dienst, Aufbauvorschau und Demo prüfen eingegebene Stichtage auf tatsächliche Kalendertage. Unvollständige Altentwürfe bleiben bearbeitbar. Geprüft wurden Schaltjahre, Monatsnavigation und beide Berliner Zeitumstellungen.                                        |
| Seed                       | Der Seed leerte die Datenbank vor der ersten Verwendung des konfigurierten Datums. Ein ungültiger Stichtag beendet den Lauf jetzt vor dem ersten Datenbankzugriff. In einer eigens angelegten Testdatenbank waren nach der Abweisung des 31. Februar alle fünf Demomandanten vorhanden.                            |

## Betrieb und Lieferkette

- Die Simulation räumt eine Datenbank erst dann auf, wenn sie diese selbst erfolgreich angelegt hat. Ein fehlgeschlagenes Anlegen lässt eine bereits vorhandene Datenbank unangetastet.
- Die Betriebsprüfung kontrolliert die Lese- und Schreibbedingungen der Mandantenrichtlinie auf den 26 RLS-Tabellen. Der Migrationsläufer wurde bei Erstinstallation und Wiederholung geprüft.
- Der Healthcheck verlangt den vereinbarten Antwortumschlag, den Datenbankstatus und eine gültige Versionsangabe. Der Image-Build begrenzt die Versionslänge wie der API-Vertrag.
- Der Paketmanager prüfte die Produktionsabhängigkeiten und den vollständigen Lockfile-Baum einschließlich Entwicklungswerkzeugen. Beide Audits meldeten am Prüftag keine bekannten Schwachstellen.
- Trivy meldete im bisherigen Migrationsimage 70 hohe und zwei kritische behebbare Paketbefunde. Das Image, die Entwicklungsdatenbank und die CI verwenden jetzt PostgreSQL 18.7. Für den API-Dienst und die CI wurde Node 24.22.1 auf das Sicherheitsrelease 24.22.3 aktualisiert. Die PostgreSQL-Versionshinweise nennen zusätzliche Prüfungen für bestehende Indizes und inkrementelle Backups. [PostgreSQL 18.7](https://www.postgresql.org/docs/release/18.7/) · [Node-Sicherheitsmitteilung](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/)

Der abschließende Scan mit Trivy 0.71.0 und der Datenbank vom 20. November 2026 ergab folgende Paketbefunde mit verfügbarem Fix.

| Image (linux/amd64)                       | Hoch | Kritisch |
| ----------------------------------------- | ---: | -------: |
| TCMS-API                                  |    0 |        0 |
| TCMS-Migrationswerkzeug                   |    1 |        0 |
| PostgreSQL-Serverimage für Compose und CI |   26 |        1 |

Der verbliebene hohe Befund im Migrationsimage betrifft `libxml2` (CVE-2026-86144). Das Paket stammt aus dem PostgreSQL-Serverimage. Der Migrationsläufer verwendet `psql`, das nicht gegen diese Bibliothek gelinkt ist. Das dort entbehrliche Werkzeug `gosu` wurde aus dem Migrationsimage entfernt. Im unveränderten Serverimage entfallen 25 hohe und der kritische Befund auf die Go-Laufzeit von `gosu`. Für beide ausgelieferten TCMS-Images bestanden die Release-Prüfungen auf kritische Befunde, und es wurden CycloneDX-Stücklisten erstellt.

## Fachliche Gegenproben

Ein separater Rechenabgleich prüfte alle 36 Bruttobewertungen, 41.472 Kombinationen aus Design- und Betriebsbeurteilungen zweier Kontrollen sowie 4.608 Frequenzableitungen. Die Ergebnisse stimmten mit den hinterlegten Regeln überein. Diese Gegenprobe prüft die Implementierung der Regeln. Sie ersetzt keine Freigabe der Regeln für einen konkreten Mandanten.

## Lastmessungen

Der bestehende Lasttest scheiterte beim Aufbau seiner Daten, weil er bereits freigegebene CMS-Beschreibungen direkt einfügte. Test und Seed benutzen jetzt denselben Erstellungsablauf. Die Datenbankregeln bleiben auch während der Lastmessung aktiv.

Mit 500 Mandanten, 499 Programmen, 61.303 Durchführungen, 1.489 Feststellungen und 26.494 Nachweisen lieferte das Portfolio alle 500 Zeilen in 4,007 Sekunden. Der Arbeitskorb brauchte 3,966 Sekunden. Beide lagen unter der Testgrenze von 25 Sekunden je Anfrage. Gemessen wurde ein lokaler Durchlauf auf PostgreSQL 18.7 mit Node 24.22.3.

Für 500 verschiedene Zeitstempel sank der Median der deutschen Datums- und Uhrzeitformatierung unter Node 24.22.1 von 30,21 auf 0,53 ms. Neun Messläufe folgten jeweils auf einen Aufwärmlauf. Der SHA-256-Wert über sämtliche formatierten Texte blieb identisch.

## Prüfläufe

| Prüfung                                   | Ergebnis                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests aller sechs Pakete ohne Datenbank   | 1.100 bestanden, 973 bedingt übersprungen                                                                                                                                                                                                                                                                                                                |
| Zwei vollständige Testläufe mit Datenbank | Auf derselben migrierten und geseedeten PostgreSQL-18.7-Instanz bestanden in beiden Läufen je 2.046 Tests, je 27 bedingt übersprungen                                                                                                                                                                                                                    |
| Separate Betriebsprüfungen                | 15 Migrationen bei Erstinstallation und Wiederholung bestätigt, 18 von 21 optionalen Migrationsfällen ausgeführt und bestanden. Drei historische Angriffsszenarien blieben ausgelassen. Alle sechs optionalen Simulationstests bestanden.                                                                                                                |
| Lieferkette und Build                     | Installation mit festgeschriebener Lockdatei, Lieferkettenprüfung, Formatierung, Typprüfung, Lint, API- und Web-Produktionsbuild bestanden. Dockerfile, Compose und Shellskripte bestanden ihre statischen Prüfungen. Gitleaks meldete für den Quellstand und die Git-Historie keine Funde.                                                              |
| Laufende Dienste                          | Die API bestätigte den Datenbankstatus, wies eine Anfrage ohne Anmeldung ab und erkannte eine gültig signierte Identität. Nach SIGTERM endete der Prozess mit Status 0. Die Simulation entfernte ihre Testdatenbank. Die gebaute Web-Demo lieferte die Anmeldeseite mit HTTP 200 und leitete einen Portalaufruf ohne Sitzung mit HTTP 307 zur Anmeldung. |

Der PostgreSQL-Treiber `pg` 8 meldete im Lastlauf eine Abkündigung für überlappende Abfragen auf derselben Verbindung. Vor einem Wechsel auf `pg` 9 ist dieser Aufrufpfad zu prüfen.

## Einordnung für die Integration

Die kanzleikonsole führt eigene Kopien von Vertrag und Fachbibliothek. Ihre lokalen Manifeste verweisen auf `2cafc99` und bestehen die eigene Integritätsprüfung. Für die Übernahme der strengeren Datumsschemas und der Kalenderkorrekturen müssen diese Kopien mit dem vorgesehenen Synchronisierungswerkzeug aktualisiert werden. Der Testlauf arbeitete mit Demodaten. Die rechtliche und fachliche Freigabe der Kataloginhalte liegt außerhalb der technischen Prüfung.

## Nachprüfung vom 21. November 2026 zur gemeinsamen Fachlogik

Ausgangsstand war `40f5b6c7`. Die Erfassung und die Einreichprüfung von
Kontrolldurchführungen nutzen jetzt dieselbe Berechnung in `@tcms/domain`.
Das Paket liefert auch die Texte zur Mindestfrequenz für Demo und
Kanzleikonsole. Fünf Servicebereiche gruppieren Fehler des Vertragsschemas
über eine gemeinsame Funktion. Für die spätere Übernahme der neuen
Domain-Exporte in die Kanzleikonsole ist der Commit dieses Nachtrags über
deren Synchronisierungswerkzeug einzuspielen.

- [x] Für 3.000 Kombinationen aus erfassten und fehlenden Werten, Toleranzen,
      Erläuterungskennzeichen und Texten lieferten Editor und Einreichprüfung
      dieselben Beträge und Toleranzlagen. Die vollständigen Ergebnisse
      einschließlich der Einreichmängel hatten vor und nach der Umstellung
      denselben SHA-256-Wert. [Kennzahlen](../packages/domain/src/kennzahlen.ts) ·
      [Grenzwerttests](../packages/domain/src/__tests__/kennzahlen.test.ts)
- [x] Alle 48 Kombinationen aus Governance-Typ, Bruttoklasse und
      Erklärungsturnus ergaben dieselben Matrix- und Mindestfrequenztexte
      wie die Demo auf dem Ausgangsstand. [Matrixtests](../packages/domain/src/__tests__/frequenz.test.ts)
- [x] Bei 51 Feldmeldungen lieferte die Durchführung weiter alle 51,
      Feststellungen, Lesepfade, Programm und Risiken jeweils die ersten 50
      in Eingabereihenfolge. [Prüfung der fünf Einstiege](../packages/service/src/__tests__/eingabe.test.ts)
- [x] Linux-Installation mit festgeschriebener Lockdatei, Lieferkettenprüfung,
      Formatierung, Typprüfung, Lint, Image-Guard und beide Produktionsbuilds
      bestanden. Ohne Datenbank bestanden 1.114 Tests (973 bedingt übersprungen).
      Mit PostgreSQL 18.7 bestanden auf derselben frisch migrierten und geseedeten
      Datenbank zweimal je 2.062 Tests. Je 25 Fälle erfordern eigene Schalter für
      Migration, Lastprüfung oder Simulation und blieben in diesen Läufen offen.
      Der erste Versuch auf dem Docker-Datenträger überschritt Testzeitgrenzen.
      `pg_stat_activity` zeigte mehr als neun Sekunden Wartezeit beim Schreiben
      des Transaktionsprotokolls und Erweitern von Datendateien. Beide Wiederholungen
      liefen mit zwei Vitest-Workern und Datenbankdateien auf `tmpfs`.
