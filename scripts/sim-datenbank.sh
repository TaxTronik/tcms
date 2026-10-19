# shellcheck shell=bash
# =============================================================================
# Eigene Datenbank für die Image-Simulation (scripts/simuliere-image.sh,
# tcms-s9) auf einem eigenen PostgreSQL-Cluster, aufgebaut wie in Produktion
# mit tcms-migrate (packages/db/betrieb/migrate.sh). Nur zum Einbinden
# (`source`), setzt SIM_WURZEL (Repo-Wurzel) voraus.
#
#   TCMS_SIM_PGHOST, TCMS_SIM_PGPORT, TCMS_SIM_PGUSER  Superuser des Clusters (Pflicht)
#   TCMS_SIM_PGPASSWORD                               dessen Passwort (optional)
#   TCMS_SIM_PGDATABASE                               Wartungsdatenbank (Standard postgres)
#   TCMS_SIM_PASSWOERTER_DANACH=entwicklung           am Ende die Entwicklungspasswörter
#                                                      (= Rollenname) wieder setzen
#
# Je Lauf entsteht die Datenbank `tcms_sim_<12 hex>`; sim_db_entfernen löscht
# sie (simuliere-image.sh ruft es beim Beenden, auch nach einem Fehler). Rollen
# sind clusterweit: tcms-migrate setzt die Passwörter von tcms_owner und
# tcms_app auf starke Einmalwerte (je 32 Zufallsbytes). Sie stehen nur in
# Variablen dieser Shell und erreichen Kindprozesse nur über deren Umgebung –
# nie über eine Kommandozeile, eine Datei oder eine Ausgabe. Danach kennt
# niemand die Passwörter der Rollen (fail closed), außer mit
# TCMS_SIM_PASSWOERTER_DANACH=entwicklung. Deshalb nur auf einem eigenen
# Test-Cluster und nie gleichzeitig mit anderen Läufen, die Rollenpasswörter
# setzen (z. B. unter `flock`).
# =============================================================================

SIM_DB=''
SIM_OWNER_PW=''
SIM_APP_PW=''
SIM_DB_URL=''

sim_meldung() { printf 'simuliere-image: %s\n' "$1" >&2; }

# Konfiguration prüfen, bevor irgendetwas gebaut oder angelegt wird (Exit 64/69).
sim_db_pruefen() {
  local LC_ALL=C
  if [[ -z ${TCMS_SIM_PGHOST:-} || -z ${TCMS_SIM_PGPORT:-} || -z ${TCMS_SIM_PGUSER:-} ]]; then
    sim_meldung 'TCMS_SIM_PGHOST, TCMS_SIM_PGPORT und TCMS_SIM_PGUSER sind Pflicht'
    return 64
  fi
  if [[ ! $TCMS_SIM_PGHOST =~ ^[A-Za-z0-9.-]+$ ]]; then
    sim_meldung 'TCMS_SIM_PGHOST ungültig (Name oder IPv4)'
    return 64
  fi
  if [[ ! $TCMS_SIM_PGPORT =~ ^[0-9]{1,5}$ ]] || ((10#$TCMS_SIM_PGPORT < 1 || 10#$TCMS_SIM_PGPORT > 65535)); then
    sim_meldung 'TCMS_SIM_PGPORT ungültig'
    return 64
  fi
  local name
  for name in TCMS_SIM_PGUSER TCMS_SIM_PGDATABASE; do
    if [[ -n ${!name:-} && ! ${!name} =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
      sim_meldung "$name ungültig"
      return 64
    fi
  done
  if [[ ${TCMS_SIM_PGPASSWORD:-} == *[^[:print:]]* ]]; then
    sim_meldung 'TCMS_SIM_PGPASSWORD: nur druckbare ASCII-Zeichen'
    return 64
  fi
  case ${TCMS_SIM_PASSWOERTER_DANACH:-} in
    '' | entwicklung) ;;
    *)
      sim_meldung 'TCMS_SIM_PASSWOERTER_DANACH: nur „entwicklung“ oder leer'
      return 64
      ;;
  esac
  command -v psql >/dev/null || {
    sim_meldung 'psql fehlt'
    return 69
  }
}

# psql als Superuser; Verbindungswerte nur über die Umgebung der Subshell.
sim_su_psql() {
  (
    export PGHOST="$TCMS_SIM_PGHOST" PGPORT="$TCMS_SIM_PGPORT" PGUSER="$TCMS_SIM_PGUSER"
    export PGDATABASE="${TCMS_SIM_PGDATABASE:-postgres}" PGPASSWORD="${TCMS_SIM_PGPASSWORD:-}"
    # Keine Passwortdatei (ein Pfad unter /dev/null existiert nie; /dev/null selbst warnt).
    export PGPASSFILE=/dev/null/tcms-sim PGAPPNAME=tcms-sim PGCONNECT_TIMEOUT=10
    exec psql -X -q -v ON_ERROR_STOP=1 "$@"
  )
}

# Prozentkodierung für die URL an tcms-migrate (nur Builtins; druckbares ASCII).
sim_kodiere() {
  local LC_ALL=C s=$1 i c out=''
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9._~-]) out+=$c ;;
      *)
        printf -v c '%%%02X' "'$c"
        out+=$c
        ;;
    esac
  done
  printf '%s' "$out"
}

sim_zufall() { node -e "process.stdout.write(require('node:crypto').randomBytes(${1:-32}).toString('${2:-base64url}'))"; }

# tcms-migrate gegen SIM_DB mit den Rollenpasswörtern $1 (tcms_owner) und $2
# (tcms_app). Die Ausgabe wird vor dem Zeigen auf die Einmalpasswörter geprüft
# (die Entwicklungspasswörter sind die Rollennamen und stehen ohnehin darin).
sim_migrate() {
  local su ausgabe status=0
  su="postgresql://$(sim_kodiere "$TCMS_SIM_PGUSER")"
  if [[ -n ${TCMS_SIM_PGPASSWORD:-} ]]; then su+=":$(sim_kodiere "$TCMS_SIM_PGPASSWORD")"; fi
  su+="@${TCMS_SIM_PGHOST}:${TCMS_SIM_PGPORT}/${SIM_DB}"
  ausgabe=$(
    TCMS_DB_SUPERUSER_URL="$su" \
      TCMS_DB_OWNER_URL="postgresql://tcms_owner@${TCMS_SIM_PGHOST}:${TCMS_SIM_PGPORT}/${SIM_DB}" \
      TCMS_DB_OWNER_PASSWORD="$1" TCMS_DB_APP_PASSWORD="$2" \
      bash "$SIM_WURZEL/packages/db/betrieb/migrate.sh" 2>&1
  ) || status=$?
  if [[ ${#1} -ge 32 && $ausgabe == *"$1"* ]] || [[ ${#2} -ge 32 && $ausgabe == *"$2"* ]]; then
    sim_meldung 'tcms-migrate hat ein Rollenpasswort ausgegeben (Ausgabe unterdrückt)'
    return 1
  fi
  if [[ -n ${TCMS_SIM_PGPASSWORD:-} && $ausgabe == *"$TCMS_SIM_PGPASSWORD"* ]]; then
    sim_meldung 'tcms-migrate hat das Superuser-Passwort ausgegeben (Ausgabe unterdrückt)'
    return 1
  fi
  printf '%s\n' "$ausgabe"
  return "$status"
}

# Legt SIM_DB an und baut sie mit tcms-migrate auf; setzt SIM_DB_URL (tcms_app).
sim_db_anlegen() {
  SIM_DB="tcms_sim_$(sim_zufall 6 hex)"
  [[ $SIM_DB =~ ^tcms_sim_[0-9a-f]{12}$ ]] || return 70
  SIM_OWNER_PW=$(sim_zufall)
  SIM_APP_PW=$(sim_zufall)
  if [[ ${#SIM_OWNER_PW} -ne 43 || ${#SIM_APP_PW} -ne 43 || $SIM_OWNER_PW == "$SIM_APP_PW" ]]; then
    return 70
  fi
  printf 'Datenbank %s auf %s:%s\n' "$SIM_DB" "$TCMS_SIM_PGHOST" "$TCMS_SIM_PGPORT"
  sim_su_psql -c "CREATE DATABASE \"$SIM_DB\"" || return
  sim_migrate "$SIM_OWNER_PW" "$SIM_APP_PW" || return
  SIM_DB_URL="postgresql://tcms_app:${SIM_APP_PW}@${TCMS_SIM_PGHOST}:${TCMS_SIM_PGPORT}/${SIM_DB}"
}

# Stellt auf Wunsch die Entwicklungspasswörter wieder her und löscht SIM_DB.
# Idempotent; Status ≠ 0, wenn ein Schritt scheitert.
sim_db_entfernen() {
  local status=0
  [[ -n $SIM_DB ]] || return 0
  if [[ ${TCMS_SIM_PASSWOERTER_DANACH:-} == entwicklung ]]; then
    if sim_migrate tcms_owner tcms_app >/dev/null; then
      printf 'Entwicklungspasswörter von tcms_owner und tcms_app wiederhergestellt\n'
    else
      sim_meldung 'Entwicklungspasswörter nicht wiederhergestellt'
      status=1
    fi
  fi
  if sim_su_psql -c "DROP DATABASE IF EXISTS \"$SIM_DB\" WITH (FORCE)"; then
    printf 'Datenbank %s gelöscht\n' "$SIM_DB"
  else
    sim_meldung "Datenbank $SIM_DB nicht gelöscht"
    status=1
  fi
  SIM_DB=''
  SIM_OWNER_PW=''
  SIM_APP_PW=''
  SIM_DB_URL=''
  return "$status"
}
