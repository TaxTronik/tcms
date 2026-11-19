#!/usr/bin/env bash
# =============================================================================
# tcms-migrate – Bootstrap, Migrationen und Prüfung der Tax-CMS-Datenbank
# (Betriebsschnittstelle Stufe 2, ADR 0001 §8). Einziger Inhalt des Images
# tcms-migrate neben psql; kein Node, keine Prisma-CLI, kein Seed.
#
# Ohne Argumente, idempotent, jeder Fehler beendet mit Exit != 0:
#   1. Bootstrap als Superuser (TCMS_DB_SUPERUSER_URL): Rollen tcms_owner und
#      tcms_app anlegen bzw. angleichen (prisma/init/rollen.psql, dieselbe Quelle
#      wie 01_bootstrap.sql), Passwörter aus TCMS_DB_OWNER_PASSWORD und
#      TCMS_DB_APP_PASSWORD (psql liest sie selbst per \getenv), Schema- und
#      Datenbankrechte.
#   2. Migrationen als tcms_owner (TCMS_DB_OWNER_URL) in einer psql-Sitzung
#      unter Advisory-Lock: Ledger `_prisma_migrations` mit den Spalten von
#      Prisma, Prüfsumme = SHA-256 der migration.sql (wie `prisma migrate` und
#      tt-migrate). Eine angewandte Migration mit anderer Prüfsumme, eine
#      unvollständige Migration oder eine angewandte Migration, die das Image
#      nicht kennt, bricht ab. Jede Migration läuft in einer Transaktion
#      zusammen mit ihrem Ledger-Eintrag. Jede Datei wird genau einmal gelesen:
#      geprüft, gehasht und ausgeführt werden dieselben Bytes.
#   3. Prüfung als tcms_owner (betrieb/pruefung.sql): Rollen, RLS, Rechte.
#
# TLS: `?sslmode=…` in beiden URLs; für verify-ca/verify-full nennt
# TCMS_DB_SSLROOTCERT die CA-Datei (absoluter Pfad) oder `system` (CA-Speicher
# des Systems, nur mit verify-full). psql erhält sie als PGSSLROOTCERT; ohne
# sie bricht der Läufer bei verify-* vor jeder Verbindung ab.
#
# Geheimnisse: Passwörter gehen nie in eine Kommandozeile (auch nicht als
# URL an psql) und nie in die Ausgabe. Die URLs werden in der Shell zerlegt;
# psql erhält Host, Port, Benutzer, Datenbank und Passwort als PG*-Umgebung
# einer Subshell (`export` ist ein Builtin, kein eigener Prozess).
# =============================================================================

set -euo pipefail
umask 077
export LC_ALL=C

BASIS="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MIGRATIONEN="$BASIS/prisma/migrations"
BOOTSTRAP="$BASIS/betrieb/bootstrap.sql"
PRUEFUNG="$BASIS/betrieb/pruefung.sql"
# Advisory-Lock der Migrationen: 'tcmsmigr' als int8.
SPERRE=8386667273618286450

melde() { printf 'tcms-migrate: %s\n' "$*"; }
abbruch() {
  printf 'tcms-migrate: FEHLER: %s\n' "$1" >&2
  exit "${2:-1}"
}

# Prozentkodierung einer URL-Komponente auflösen (nur Shell-Builtins: der Wert
# kann ein Passwort sein). Ungültige Kodierung und Steuerzeichen → Abbruch.
dekodiere() {
  local s=$1 name=$2 rest
  rest=${s//\%[0-9A-Fa-f][0-9A-Fa-f]/}
  [[ $rest != *%* ]] || abbruch "$name: ungültige Prozentkodierung" 64
  if [[ $s =~ %(0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff]) ]]; then
    abbruch "$name: Steuerzeichen nicht erlaubt" 64
  fi
  s=${s//\\/\\\\}
  printf -v s '%b' "${s//\%/\\x}"
  printf '%s' "$s"
}

# zerlege_url <url> <assoziatives-array> <variablenname>
# Form: postgres[ql]://benutzer[:passwort]@host[:port]/datenbank[?sslmode=…]
# shellcheck disable=SC2034 # `ziel` ist ein nameref auf das Array des Aufrufers
zerlege_url() {
  local url=$1 name=$3
  local -n ziel=$2
  local rest query authhost userinfo hostport pfad host port user pass db sslmode='' teil
  [[ ! $url =~ [[:cntrl:][:space:]] ]] || abbruch "$name: Leer- oder Steuerzeichen" 64
  case $url in
    postgresql://*) rest=${url#postgresql://} ;;
    postgres://*) rest=${url#postgres://} ;;
    *) abbruch "$name muss mit postgresql:// beginnen" 64 ;;
  esac
  [[ $rest != *'#'* ]] || abbruch "$name: Fragment nicht erlaubt" 64
  query=''
  if [[ $rest == *'?'* ]]; then
    query=${rest#*\?}
    rest=${rest%%\?*}
  fi
  [[ $rest == */* ]] || abbruch "$name: Datenbank fehlt" 64
  authhost=${rest%%/*}
  pfad=${rest#*/}
  [[ $authhost == *@* ]] || abbruch "$name: Benutzer fehlt" 64
  userinfo=${authhost%@*}
  hostport=${authhost##*@}
  if [[ $userinfo == *:* ]]; then
    user=${userinfo%%:*}
    pass=${userinfo#*:}
  else
    user=$userinfo
    pass=''
  fi
  if [[ $hostport =~ ^\[([0-9A-Fa-f:.]+)\](:([0-9]{1,5}))?$ ]]; then
    host=${BASH_REMATCH[1]}
    port=${BASH_REMATCH[3]:-5432}
  elif [[ $hostport =~ ^([A-Za-z0-9.-]+)(:([0-9]{1,5}))?$ ]]; then
    host=${BASH_REMATCH[1]}
    port=${BASH_REMATCH[3]:-5432}
  else
    abbruch "$name: Host oder Port ungültig" 64
  fi
  ((10#$port >= 1 && 10#$port <= 65535)) || abbruch "$name: Port ungültig" 64
  [[ -n $pfad && $pfad != */* ]] || abbruch "$name: Datenbankname ungültig" 64
  if [[ -n $query ]]; then
    local -a teile
    IFS='&' read -r -a teile <<<"$query"
    for teil in "${teile[@]}"; do
      case $teil in
        sslmode=disable | sslmode=allow | sslmode=prefer | sslmode=require | sslmode=verify-ca | sslmode=verify-full)
          sslmode=${teil#sslmode=}
          ;;
        *) abbruch "$name: nur der Parameter sslmode ist erlaubt (CA-Datei: TCMS_DB_SSLROOTCERT)" 64 ;;
      esac
    done
  fi
  user=$(dekodiere "$user" "$name") || exit $?
  pass=$(dekodiere "$pass" "$name") || exit $?
  db=$(dekodiere "$pfad" "$name") || exit $?
  [[ -n $user ]] || abbruch "$name: Benutzer fehlt" 64
  ziel[host]=$host
  ziel[port]=$port
  ziel[user]=$user
  ziel[pass]=$pass
  ziel[db]=$db
  ziel[sslmode]=$sslmode
}

# psql_als <assoziatives-array> [--env NAME]… <psql-argumente…>; liest bei
# `-f -` von stdin. psql erbt eine geleerte Umgebung (auch ohne Einträge,
# deren Name kein Shell-Bezeichner ist): nur PATH, Locale, die
# PG*-Werte der Rolle (dazu PGSSLROOTCERT aus TCMS_DB_SSLROOTCERT) und
# ausdrücklich genannte Variablen (Bootstrap: die beiden Rollenpasswörter für
# `\getenv`). Selbst ein Metabefehl, der an der Migrationsprüfung vorbeikäme,
# sähe so weder die Superuser-URL noch fremde Passwörter (Red Team RT2-T-01,
# Verteidigung in der Tiefe). Werte gehen nie über argv (kein `env -i
# NAME=WERT`), nur über die Umgebung der Subshell. Der Läufer selbst
# exportiert nichts (siehe „Umgebung“ unten), die Schleife hier ist die zweite
# Linie.
psql_als() {
  local -n v=$1
  shift
  local -A extra=()
  while [[ ${1:-} == --env ]]; do
    extra[$2]=${!2}
    shift 2
  done
  (
    local name
    for name in $(compgen -e); do
      case $name in
        PATH | LANG | LC_ALL) ;;
        *) unset "$name" ;;
      esac
    done
    export PGHOST="${v[host]}" PGPORT="${v[port]}" PGUSER="${v[user]}" PGDATABASE="${v[db]}"
    export PGPASSWORD="${v[pass]}" PGPASSFILE=/dev/null PGAPPNAME=tcms-migrate PGCONNECT_TIMEOUT=10
    if [[ -n ${v[sslmode]} ]]; then export PGSSLMODE="${v[sslmode]}"; fi
    if [[ -n $SSLROOTCERT ]]; then export PGSSLROOTCERT="$SSLROOTCERT"; fi
    for name in "${!extra[@]}"; do
      export "$name=${extra[$name]}"
    done
    if ((${#FREMDE_NAMEN[@]} > 0)); then
      exec env "${FREMDE_NAMEN[@]}" psql -X -q -v ON_ERROR_STOP=1 "$@"
    fi
    exec psql -X -q -v ON_ERROR_STOP=1 "$@"
  )
}

# Hauptversion von psql; dieselbe geleerte Umgebung wie psql_als, ohne PG*-Werte
# (auch die Versionsabfrage sieht keine URL und kein Passwort).
psql_hauptversion() {
  (
    local name
    for name in $(compgen -e); do
      case $name in
        PATH | LANG | LC_ALL) ;;
        *) unset "$name" ;;
      esac
    done
    if ((${#FREMDE_NAMEN[@]} > 0)); then
      env "${FREMDE_NAMEN[@]}" psql --version 2>/dev/null || true
    else
      psql --version 2>/dev/null || true
    fi
  ) | sed -n 's/^psql (PostgreSQL) \([0-9][0-9]*\).*/\1/p'
}

pruefe_passwort() {
  local name=$1 wert=${!1}
  [[ ${#wert} -ge 1 && ${#wert} -le 1024 ]] || abbruch "$name: Länge 1 bis 1024 Zeichen" 64
  [[ ! $wert =~ [[:cntrl:]] ]] || abbruch "$name: Steuerzeichen nicht erlaubt" 64
}

# Transaktionssteuerung auf oberster Ebene einer Migration (liest SQL von
# stdin). Ein kleiner Lexer wie der von psql: Kommentare (`--`, verschachtelte
# `/* */`), Literale ('…', "…", $tag$…$tag$) fallen weg; Anweisungen trennt
# `;` außerhalb von Klammern und außerhalb von BEGIN ATOMIC … END in
# CREATE [OR REPLACE] FUNCTION/PROCEDURE (dieselbe Heuristik wie psql). Jede
# Anweisung, die mit BEGIN, START, COMMIT, END, ROLLBACK, ABORT, SAVEPOINT,
# RELEASE oder PREPARE TRANSACTION beginnt, ist ein Treffer – auch hinter
# einem `;` in derselben Zeile und mit `;` erst auf der Folgezeile; plpgsql-
# Rümpfe (BEGIN … END; in $tag$) sind Literale und bleiben unberührt.
# Ausgabe genau eine Zeile: OK, TX <Anweisung> oder OFFEN <Art> (Literal oder
# Kommentar am Dateiende offen: der Läufer hängte sonst seinen
# Transaktionsvergleich und Ledger-Eintrag in das Literal). Liest immer bis
# zum Ende (kein vorzeitiges exit: der Schreiber der Pipe bekäme SIGPIPE).
# shellcheck disable=SC2016 # awk-Programm, keine Shell-Expansion gewollt
TX_AWK='
function anweisung(s,   t) {
  if (treffer != "") return
  t = toupper(s)
  gsub(/[[:space:]]+/, " ", t)
  sub(/^ /, "", t)
  if (match(t, /^PREPARE TRANSACTION( |$)/) || match(t, /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)( |$)/)) {
    treffer = substr(t, 1, RLENGTH)
    sub(/ $/, "", treffer)
  }
}
function kopf(s,   t) {
  t = toupper(s)
  gsub(/[[:space:]]+/, " ", t)
  sub(/^ /, "", t)
  return t
}
BEGIN { q = sprintf("%c", 39); dq = sprintf("%c", 34); z = "n"; stmt = ""; klammer = 0; atom = 0; treffer = ""; vor = " " }
{
  zeile = $0
  n = length(zeile)
  i = 1
  while (i <= n) {
    c = substr(zeile, i, 1)
    if (z == "n") {
      zwei = substr(zeile, i, 2)
      if (zwei == "--") { i = n + 1; continue }
      if (zwei == "/*") { z = "b"; tiefe = 1; stmt = stmt " "; vor = " "; i += 2; continue }
      if (c == q) { z = "q"; stmt = stmt "x"; vor = "x"; i++; continue }
      if (c == dq) { z = "i"; stmt = stmt "x"; vor = "x"; i++; continue }
      if (c == "$" && vor !~ /[A-Za-z0-9_$]/ && match(substr(zeile, i), /^[$]([A-Za-z_][A-Za-z0-9_]*)?[$]/)) {
        tag = substr(zeile, i, RLENGTH); z = "d"; stmt = stmt "x"; vor = "x"; i += RLENGTH; continue
      }
      if (c ~ /[A-Za-z_]/ && vor !~ /[A-Za-z0-9_$]/) {
        match(substr(zeile, i), /^[A-Za-z_][A-Za-z0-9_$]*/)
        wort = toupper(substr(zeile, i, RLENGTH))
        if (klammer == 0 && kopf(stmt) ~ /^CREATE (OR REPLACE )?(FUNCTION|PROCEDURE) /) {
          if (wort == "BEGIN") atom++
          else if (wort == "CASE" && atom > 0) atom++
          else if (wort == "END" && atom > 0) atom--
        }
        stmt = stmt wort; vor = "a"; i += RLENGTH; continue
      }
      if (c == "(") klammer++
      if (c == ")" && klammer > 0) klammer--
      if (c == ";" && klammer == 0 && atom == 0) { anweisung(stmt); stmt = ""; vor = " "; i++; continue }
      stmt = stmt c; vor = c; i++; continue
    }
    if (z == "q" || z == "i") {
      ende = (z == "q") ? q : dq
      if (c == ende && substr(zeile, i + 1, 1) == ende) { i += 2; continue }
      if (c == ende) z = "n"
      i++; continue
    }
    if (z == "d") {
      p = index(substr(zeile, i), tag)
      if (p == 0) { i = n + 1; continue }
      i += p - 1 + length(tag); z = "n"; continue
    }
    zwei = substr(zeile, i, 2)
    if (zwei == "/*") { tiefe++; i += 2; continue }
    if (zwei == "*/") { tiefe--; i += 2; if (tiefe == 0) z = "n"; continue }
    i++
  }
  if (z == "n") { stmt = stmt " "; vor = " " }
}
END {
  anweisung(stmt)
  if (treffer != "") print "TX " treffer
  else if (z != "n") print "OFFEN " z
  else print "OK"
}'

# Migrationsdateien: nur die erwarteten Namen, kein Backslash (psql führt
# Metabefehle wie \! oder \getenv nicht nur am Zeilenanfang aus, sondern auch
# mitten in einer Zeile nach gepuffertem SQL – Red Team RT2-T-01; ein Backslash
# in einem Literal lässt sich mit chr(92) schreiben), kein NUL und keine eigene
# Transaktionssteuerung (jede Migration läuft in genau einer Transaktion mit
# ihrem Ledger-Eintrag). Liest die Datei genau einmal; Prüfung, Prüfsumme und
# Ausführung nutzen diese Bytes (INHALT, SUMME).
lies_migration() {
  local name=$1 datei=$2 groesse tx
  [[ $name =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || abbruch "Migration mit unzulässigem Namen: $name" 65
  [[ -f $datei && ! -L $datei ]] || abbruch "Migration $name: migration.sql fehlt" 65
  # Anhängsel `x`: Die Befehlsersetzung entfernte sonst abschließende Zeilenumbrüche.
  INHALT=$(cat -- "$datei" && printf x) || abbruch "Migration $name nicht lesbar" 65
  INHALT=${INHALT%x}
  # NUL kann die Shell nicht halten (sie ließe es weg); die Länge in Bytes
  # (LC_ALL=C) muss der Dateigröße entsprechen.
  groesse=$(wc -c <"$datei") || abbruch "Migration $name nicht lesbar" 65
  ((${#INHALT} == 10#${groesse//[[:space:]]/})) ||
    abbruch "Migration $name enthält NUL oder änderte sich beim Lesen" 65
  # shellcheck disable=SC1003 # gesucht ist ein wörtlicher Backslash, kein Escape
  if [[ $INHALT == *'\'* ]]; then
    abbruch "Migration $name enthält einen Backslash (psql-Metabefehle sind ausgeschlossen)" 65
  fi
  tx=$(printf '%s' "$INHALT" | awk "$TX_AWK") || abbruch "Migration $name: Prüfung gescheitert" 70
  pruefe_transaktionssteuerung "$name" "$tx"
  shopt -s nocasematch
  if [[ $INHALT =~ (^|[^a-z0-9_])concurrently([^a-z0-9_]|$) ]]; then
    abbruch "Migration $name nutzt CONCURRENTLY (nicht in einer Transaktion möglich)" 65
  fi
  shopt -u nocasematch
  SUMME=$(printf '%s' "$INHALT" | sha256sum) || abbruch "Prüfsumme von $name nicht berechenbar" 65
  SUMME=${SUMME%% *}
  [[ $SUMME =~ ^[0-9a-f]{64}$ ]] || abbruch "Prüfsumme von $name nicht berechenbar" 65
}

pruefe_transaktionssteuerung() {
  case $2 in
    OK) ;;
    OFFEN*) abbruch "Migration $1 endet in einem offenen Literal oder Kommentar" 65 ;;
    TX*) abbruch "Migration $1 steuert Transaktionen selbst (${2#TX })" 65 ;;
    *) abbruch "Migration $1: Prüfung gescheitert" 70 ;;
  esac
}

# --- Umgebung -------------------------------------------------------------------
# Namen, die kein Shell-Bezeichner sind (etwa `A.B`, in Docker/Kubernetes
# zulässig), kann die Shell weder lesen noch löschen; bash reichte sie
# unverändert an psql weiter (RT2-T-01). psql startet deshalb über
# `env -u <name>` für jeden davon (nur Namen in argv, nie Werte). Gelesen aus
# der Startumgebung des Läufers (/proc, Linux wie im Image).
FREMDE_NAMEN=()
if [[ -r /proc/$$/environ ]]; then
  while IFS= read -r -d '' eintrag; do
    [[ ${eintrag%%=*} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || FREMDE_NAMEN+=(-u "${eintrag%%=*}")
  done </proc/$$/environ
  unset eintrag
fi
# Ab hier exportiert der Läufer nichts außer PATH und Locale: Eigene Variablen
# (SU, OW, …) erben so kein Export-Attribut einer gleichnamigen
# Umgebungsvariablen, und die Bereinigung in psql_als löscht nie eigene Werte.
for name in $(compgen -e); do
  case $name in
    PATH | LANG | LC_ALL) ;;
    *)
      # shellcheck disable=SC2163 # gemeint ist die Variable, deren Name in `name` steht
      export -n "$name"
      ;;
  esac
done
unset name

[[ $# -eq 0 ]] || abbruch 'keine Argumente erwartet' 64
for v in TCMS_DB_SUPERUSER_URL TCMS_DB_OWNER_URL TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
  [[ -n ${!v:-} ]] || abbruch "$v fehlt" 64
done
unset v
pruefe_passwort TCMS_DB_OWNER_PASSWORD
pruefe_passwort TCMS_DB_APP_PASSWORD
[[ $TCMS_DB_OWNER_PASSWORD != "$TCMS_DB_APP_PASSWORD" ]] ||
  abbruch 'TCMS_DB_OWNER_PASSWORD und TCMS_DB_APP_PASSWORD müssen verschieden sein' 64
[[ $BASIS != *"'"* ]] || abbruch 'Installationspfad enthält ein Hochkomma' 64
SSLROOTCERT=${TCMS_DB_SSLROOTCERT:-}
if [[ -n $SSLROOTCERT && $SSLROOTCERT != system ]]; then
  [[ $SSLROOTCERT == /* && ! $SSLROOTCERT =~ [[:cntrl:]] ]] ||
    abbruch 'TCMS_DB_SSLROOTCERT: absoluter Pfad der CA-Datei oder system' 64
  [[ -f $SSLROOTCERT && -r $SSLROOTCERT ]] || abbruch 'TCMS_DB_SSLROOTCERT: keine lesbare Datei' 64
fi
command -v psql >/dev/null || abbruch 'psql fehlt' 69
# bootstrap.sql liest die Rollenpasswörter mit \getenv (psql >= 15). Ein
# älteres psql bräche erst im Bootstrap mit „invalid command“ ab; hier vor
# jeder Verbindung und mit klarer Ursache.
PSQL_MAJOR=$(psql_hauptversion)
[[ $PSQL_MAJOR =~ ^[0-9]+$ ]] || abbruch 'psql-Version nicht erkennbar (psql >= 15 nötig)' 69
((10#$PSQL_MAJOR >= 15)) || abbruch "psql $PSQL_MAJOR ist zu alt: \\getenv braucht psql >= 15" 69

unset -v SU OW
declare -A SU OW
zerlege_url "$TCMS_DB_SUPERUSER_URL" SU TCMS_DB_SUPERUSER_URL
zerlege_url "$TCMS_DB_OWNER_URL" OW TCMS_DB_OWNER_URL
[[ ${OW[user]} == tcms_owner ]] || abbruch 'TCMS_DB_OWNER_URL muss die Rolle tcms_owner verwenden' 64
if [[ ${SU[host]} != "${OW[host]}" || ${SU[port]} != "${OW[port]}" || ${SU[db]} != "${OW[db]}" ]]; then
  abbruch 'TCMS_DB_SUPERUSER_URL und TCMS_DB_OWNER_URL müssen dieselbe Datenbank nennen' 64
fi
# Serverprüfung nur mit Zertifikatsquelle: libpq fände sonst nur den
# undokumentierten Standardpfad im Heimatverzeichnis (die Umgebung ist
# geleert) – und der naheliegende Ausweg wäre sslmode=require ohne Prüfung.
for modus in "${SU[sslmode]}" "${OW[sslmode]}"; do
  if [[ $modus == verify-* && -z $SSLROOTCERT ]]; then
    abbruch "sslmode=$modus braucht TCMS_DB_SSLROOTCERT (CA-Datei oder system)" 64
  fi
  if [[ $SSLROOTCERT == system && -n $modus && $modus != verify-full ]]; then
    abbruch 'TCMS_DB_SSLROOTCERT=system nur mit sslmode=verify-full' 64
  fi
done
unset modus
if [[ $SSLROOTCERT == system ]] && ((10#$PSQL_MAJOR < 16)); then
  abbruch 'TCMS_DB_SSLROOTCERT=system braucht psql >= 16' 69
fi
# Eine Quelle für das Eigentümerpasswort: die Variable. Ein abweichendes
# Passwort in der URL wäre ein Konfigurationsfehler.
if [[ -n ${OW[pass]} && ${OW[pass]} != "$TCMS_DB_OWNER_PASSWORD" ]]; then
  abbruch 'TCMS_DB_OWNER_URL und TCMS_DB_OWNER_PASSWORD nennen verschiedene Passwörter' 64
fi
OW[pass]=$TCMS_DB_OWNER_PASSWORD
[[ -d $MIGRATIONEN ]] || abbruch 'Migrationsverzeichnis fehlt' 65

# Migrationen vor jeder Verbindung lesen und prüfen (genau einmal je Datei).
namen=()
summen=()
inhalte=()
for verzeichnis in "$MIGRATIONEN"/*/; do
  [[ -d $verzeichnis ]] || continue
  name=${verzeichnis%/}
  name=${name##*/}
  lies_migration "$name" "$MIGRATIONEN/$name/migration.sql"
  namen+=("$name")
  summen+=("$SUMME")
  inhalte+=("$INHALT")
done
((${#namen[@]} > 0)) || abbruch 'keine Migrationen gefunden' 65
liste=$(printf "'%s'," "${namen[@]}")
liste=${liste%,}

# --- 1. Bootstrap ---------------------------------------------------------------
melde "Bootstrap der Rollen in Datenbank ${SU[db]}"
psql_als SU --env TCMS_DB_OWNER_PASSWORD --env TCMS_DB_APP_PASSWORD -f "$BOOTSTRAP" ||
  abbruch "Bootstrap fehlgeschlagen (psql $?)" 2

# --- 2. Migrationen -------------------------------------------------------------
# Außerhalb der Migrationstransaktionen ist die Sitzung schreibgeschützt
# (default_transaction_read_only): Verließe eine Migration ihre Transaktion
# doch (an der Prüfung oben vorbei), scheiterte jede weitere Änderung im
# Autocommit, und der txid-Vergleich bricht vor dem Ledger-Eintrag ab.
# Ausgegeben werden nur Builtins und die bereits gelesenen Inhalte: Ein
# Lesefehler kann hier nicht mehr eintreten (errexit wirkt in einer Funktion
# links von `||` nicht).
skript() {
  cat <<SQL
\\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET lock_timeout = '120s';
SELECT current_user = 'tcms_owner' AS tcms_ist_owner \\gset
\\if :tcms_ist_owner
\\else
  DO \$f\$ BEGIN RAISE EXCEPTION 'TCMS_DB_OWNER_URL meldet nicht die Rolle tcms_owner an'; END \$f\$;
\\endif
SELECT pg_catalog.pg_advisory_lock($SPERRE) AS tcms_sperre \\gset
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
SET default_transaction_read_only = on;
SELECT count(*) = 0 AS tcms_kein_haengen FROM "_prisma_migrations"
WHERE finished_at IS NULL AND rolled_back_at IS NULL \\gset
\\if :tcms_kein_haengen
\\else
  \\warn 'tcms-migrate: FEHLER: unvollständige Migration im Ledger (finished_at leer)'
  DO \$f\$ BEGIN RAISE EXCEPTION 'unvollständige Migration im Ledger'; END \$f\$;
\\endif
SELECT count(*) = 0 AS tcms_kein_fremd FROM "_prisma_migrations"
WHERE rolled_back_at IS NULL AND migration_name NOT IN ($liste) \\gset
\\if :tcms_kein_fremd
\\else
  \\warn 'tcms-migrate: FEHLER: Datenbank enthält Migrationen, die dieses Image nicht kennt'
  DO \$f\$ BEGIN RAISE EXCEPTION 'unbekannte Migration im Ledger'; END \$f\$;
\\endif
SQL
  local i
  for i in "${!namen[@]}"; do
    cat <<SQL
\\set tcms_name '${namen[$i]}'
\\set tcms_pruefsumme '${summen[$i]}'
SELECT coalesce(bool_or(checksum = :'tcms_pruefsumme'), false) AS tcms_angewandt,
       coalesce(bool_or(checksum <> :'tcms_pruefsumme'), false) AS tcms_abweichend
FROM "_prisma_migrations"
WHERE migration_name = :'tcms_name' AND finished_at IS NOT NULL AND rolled_back_at IS NULL \\gset
\\if :tcms_abweichend
  \\warn 'tcms-migrate: FEHLER: Prüfsumme weicht vom Ledger ab:' :tcms_name
  DO \$f\$ BEGIN RAISE EXCEPTION 'Prüfsumme einer angewandten Migration weicht ab'; END \$f\$;
\\elif :tcms_angewandt
  \\echo 'tcms-migrate: bereits angewandt:' :tcms_name
\\else
BEGIN READ WRITE;
SELECT pg_catalog.txid_current() AS tcms_txid \\gset
SQL
    printf '%s' "${inhalte[$i]}"
    cat <<SQL

;
SELECT pg_catalog.txid_current() = :tcms_txid AS tcms_gleiche_tx \\gset
\\if :tcms_gleiche_tx
\\else
  DO \$f\$ BEGIN RAISE EXCEPTION 'Migration hat die Transaktion verlassen'; END \$f\$;
\\endif
INSERT INTO "_prisma_migrations"
  (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES (gen_random_uuid()::text, :'tcms_pruefsumme', :'tcms_name', now(), clock_timestamp(), 1);
COMMIT;
  \\echo 'tcms-migrate: angewandt:' :tcms_name
\\endif
SQL
  done
  cat <<SQL
SELECT count(*) AS tcms_anzahl FROM "_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL \\gset
\\echo 'tcms-migrate: Ledger vollständig,' :tcms_anzahl 'Migrationen angewandt'
SELECT pg_catalog.pg_advisory_unlock($SPERRE) AS tcms_entsperrt \\gset
SQL
}

melde "Migrationen als tcms_owner (${#namen[@]} im Image)"
skript | psql_als OW -f - || abbruch "Migration fehlgeschlagen (psql $?)" 3

# --- 3. Prüfung -------------------------------------------------------------------
psql_als OW -f "$PRUEFUNG" || abbruch "Prüfung fehlgeschlagen (psql $?)" 4
melde 'fertig'
