# Arbeitsregeln Tax-CMS

Diese Regeln gelten für alle Änderungen in diesem Repository – für Menschen und
für KI-Werkzeuge.

## Architektur

- `packages/domain` – reine Fachlogik ohne I/O: Katalog E-Commerce (Risiken,
  Kontrollen, Ereignistypen, Profilregeln), Bewertung Brutto/Netto,
  Häufigkeitsmatrix Governance-Typ × Bruttoklasse, Statusmodelle, Phasen,
  Grundelemente, Prüflast, Formatierung. Änderungen hier brauchen Tests
  (`pnpm --filter @tcms/domain test`).
- `packages/db` – Prisma-Schema, Client (Prisma 7 mit `@prisma/adapter-pg`),
  Audit-Hashkette (`schreibeAudit`), Dateiablage der Nachweise, Seed.
- `apps/web` – Next.js 16 (App Router, Server Components, Server Actions).
  - `src/server/kontext.ts` lädt den vollständigen Tax-CMS-Kontext eines
    Mandanten zu einem Stichtag. Screens im Mandantenkontext lesen daraus.
  - `src/server/seite.ts` (`ladeStaffSeite`) liefert Kontext, Rechte und
    Stichtag für Staff-Seiten.
  - `src/server/actions/*.ts` – Server Actions je Bereich.
  - `src/server/aktion.ts` – `mitAudit` (Transaktion + Audit-Eintrag) und
    `aktualisiereMandant` (Revalidierung).
  - `src/server/rechte.ts` – reine Rechtefunktionen.
  - `src/components/ui/*` – gemeinsame Bausteine (Badges, Heatmap, Drawer,
    Begründungsdialog, Stichtag-Selektor, Visualisierungen).

## Fachliche Regeln (verbindlich)

1. Jede fachliche Änderung läuft über `mitAudit` und erzeugt ein
   Audit-Ereignis (`tcms.<bereich>.<aktion>`). Keine Änderung ohne Protokoll.
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
   Optionen sind gleichrangig, ohne Vorauswahl und ohne Empfehlung.
6. Historische Stichtage (`?stand=YYYY-MM-DD`) sind schreibgeschützt.
   Mutationen sind dort deaktiviert.
7. Keine KI-Entscheidungen. Vorschläge (z. B. Risikovorschlag aus dem
   Geschäftsprofil) sind deterministisch und nennen ihren Grund.
8. Normanker, Katalogwerte und Startwerte der Matrix sind ungeprüfte Entwürfe.
   Rechtsquellen und Norminhalte nie erfinden.

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
pnpm build
```
