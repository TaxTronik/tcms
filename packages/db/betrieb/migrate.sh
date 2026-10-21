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
#      zusammen mit ihrem Ledger-Eintrag.
#   3. Prüfung als tcms_owner (betrieb/pruefung.sql): Rollen, RLS, Rechte.
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
        *) abbruch "$name: nur der Parameter sslmode ist erlaubt" 64 ;;
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
# `-f -` von stdin. psql erbt eine geleerte Umgebung: nur PATH, Locale, die
# PG*-Werte der Rolle und ausdrücklich genannte Variablen (Bootstrap: die
# beiden Rollenpasswörter für `\getenv`). Selbst ein Metabefehl, der an der
# Migrationsprüfung vorbeikäme, sähe so weder die Superuser-URL noch fremde
# Passwörter (Red Team RT2-T-01, Verteidigung in der Tiefe). Werte gehen nie
# über argv (kein `env -i NAME=WERT`), nur über die Umgebung der Subshell.
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
    for name in "${!extra[@]}"; do
      export "$name=${extra[$name]}"
    done
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
    psql --version 2>/dev/null || true
  ) | sed -n 's/^psql (PostgreSQL) \([0-9][0-9]*\).*/\1/p'
}

pruefe_passwort() {
  local name=$1 wert=${!1}
  [[ ${#wert} -ge 1 && ${#wert} -le 1024 ]] || abbruch "$name: Länge 1 bis 1024 Zeichen" 64
  [[ ! $wert =~ [[:cntrl:]] ]] || abbruch "$name: Steuerzeichen nicht erlaubt" 64
}

# Migrationsdateien: nur die erwarteten Namen, kein Backslash (psql führt
# Metabefehle wie \! oder \getenv nicht nur am Zeilenanfang aus, sondern auch
# mitten in einer Zeile nach gepuffertem SQL – Red Team RT2-T-01; ein Backslash
# in einem Literal lässt sich mit chr(92) schreiben) und keine eigene
# Transaktionssteuerung (jede Migration läuft in genau einer Transaktion mit
# ihrem Ledger-Eintrag).
pruefe_migration() {
  local name=$1 datei=$2
  [[ $name =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || abbruch "Migration mit unzulässigem Namen: $name" 65
  [[ -f $datei && ! -L $datei ]] || abbruch "Migration $name: migration.sql fehlt" 65
  # shellcheck disable=SC1003 # gesucht ist ein wörtlicher Backslash, kein Escape
  if grep -qF '\' "$datei"; then
    abbruch "Migration $name enthält einen Backslash (psql-Metabefehle sind ausgeschlossen)" 65
  fi
  if grep -Eiq '^[[:space:]]*(BEGIN([[:space:]]+(WORK|TRANSACTION))?|START[[:space:]]+TRANSACTION|COMMIT|ROLLBACK|ABORT)[[:space:]]*;' "$datei"; then
    abbruch "Migration $name steuert Transaktionen selbst" 65
  fi
  if grep -Eiq '(^|[^a-z0-9_])concurrently([^a-z0-9_]|$)' "$datei"; then
    abbruch "Migration $name nutzt CONCURRENTLY (nicht in einer Transaktion möglich)" 65
  fi
}

[[ $# -eq 0 ]] || abbruch 'keine Argumente erwartet' 64
for v in TCMS_DB_SUPERUSER_URL TCMS_DB_OWNER_URL TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
  [[ -n ${!v:-} ]] || abbruch "$v fehlt" 64
done
pruefe_passwort TCMS_DB_OWNER_PASSWORD
pruefe_passwort TCMS_DB_APP_PASSWORD
[[ $TCMS_DB_OWNER_PASSWORD != "$TCMS_DB_APP_PASSWORD" ]] ||
  abbruch 'TCMS_DB_OWNER_PASSWORD und TCMS_DB_APP_PASSWORD müssen verschieden sein' 64
[[ $BASIS != *"'"* ]] || abbruch 'Installationspfad enthält ein Hochkomma' 64
command -v psql >/dev/null || abbruch 'psql fehlt' 69
# bootstrap.sql liest die Rollenpasswörter mit \getenv (psql >= 15). Ein
# älteres psql bräche erst im Bootstrap mit „invalid command“ ab; hier vor
# jeder Verbindung und mit klarer Ursache.
PSQL_MAJOR=$(psql_hauptversion)
[[ $PSQL_MAJOR =~ ^[0-9]+$ ]] || abbruch 'psql-Version nicht erkennbar (psql >= 15 nötig)' 69
((10#$PSQL_MAJOR >= 15)) || abbruch "psql $PSQL_MAJOR ist zu alt: \\getenv braucht psql >= 15" 69

declare -A SU OW
zerlege_url "$TCMS_DB_SUPERUSER_URL" SU TCMS_DB_SUPERUSER_URL
zerlege_url "$TCMS_DB_OWNER_URL" OW TCMS_DB_OWNER_URL
[[ ${OW[user]} == tcms_owner ]] || abbruch 'TCMS_DB_OWNER_URL muss die Rolle tcms_owner verwenden' 64
if [[ ${SU[host]} != "${OW[host]}" || ${SU[port]} != "${OW[port]}" || ${SU[db]} != "${OW[db]}" ]]; then
  abbruch 'TCMS_DB_SUPERUSER_URL und TCMS_DB_OWNER_URL müssen dieselbe Datenbank nennen' 64
fi
# Eine Quelle für das Eigentümerpasswort: die Variable. Ein abweichendes
# Passwort in der URL wäre ein Konfigurationsfehler.
if [[ -n ${OW[pass]} && ${OW[pass]} != "$TCMS_DB_OWNER_PASSWORD" ]]; then
  abbruch 'TCMS_DB_OWNER_URL und TCMS_DB_OWNER_PASSWORD nennen verschiedene Passwörter' 64
fi
OW[pass]=$TCMS_DB_OWNER_PASSWORD
[[ -d $MIGRATIONEN ]] || abbruch 'Migrationsverzeichnis fehlt' 65

# --- 1. Bootstrap ---------------------------------------------------------------
melde "Bootstrap der Rollen in Datenbank ${SU[db]}"
psql_als SU --env TCMS_DB_OWNER_PASSWORD --env TCMS_DB_APP_PASSWORD -f "$BOOTSTRAP" ||
  abbruch "Bootstrap fehlgeschlagen (psql $?)" 2

# --- 2. Migrationen -------------------------------------------------------------
namen=()
summen=()
for verzeichnis in "$MIGRATIONEN"/*/; do
  [[ -d $verzeichnis ]] || continue
  name=${verzeichnis%/}
  name=${name##*/}
  datei="$MIGRATIONEN/$name/migration.sql"
  pruefe_migration "$name" "$datei"
  summe=$(sha256sum "$datei")
  summe=${summe%% *}
  [[ $summe =~ ^[0-9a-f]{64}$ ]] || abbruch "Prüfsumme von $name nicht berechenbar" 65
  namen+=("$name")
  summen+=("$summe")
done
((${#namen[@]} > 0)) || abbruch 'keine Migrationen gefunden' 65
liste=$(printf "'%s'," "${namen[@]}")
liste=${liste%,}

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
BEGIN;
SELECT pg_catalog.txid_current() AS tcms_txid \\gset
SQL
    cat "$MIGRATIONEN/${namen[$i]}/migration.sql"
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
