#!/usr/bin/env bash
# =============================================================================
# Simuliert das Image tcms-api ohne Docker (ADR 0001 §8): Build-Kontext nach
# .dockerignore (scripts/docker-kontext.mjs), dieselben Schritte wie der Stage
# `bau` des Dockerfiles, Zusammenstellen von /app wie im Stage `api`, Prüfung
# des Laufzeitbaums, Start mit `node` aus einem fremden Arbeitsverzeichnis,
# Health, signierte Anfrage, Container-Healthcheck und geordnetes Beenden.
#
# Zwei Arten, die Datenbank zu wählen (genau eine):
#
#   DATABASE_URL=postgresql://tcms_app:…@host/db scripts/simuliere-image.sh <arbeitsverzeichnis>
#
#     Laufzeitrolle tcms_app einer mit tcms-migrate aufgebauten Datenbank, mit
#     starkem Passwort (der Dienst läuft mit NODE_ENV=production).
#
#   TCMS_SIM_PGHOST=127.0.0.1 TCMS_SIM_PGPORT=55433 TCMS_SIM_PGUSER=postgres \
#     [TCMS_SIM_PGPASSWORD=…] [TCMS_SIM_PASSWOERTER_DANACH=entwicklung] \
#     scripts/simuliere-image.sh <arbeitsverzeichnis>
#
#     Eigener Cluster (tcms-s9, scripts/sim-datenbank.sh): Das Skript legt eine
#     eigene Datenbank `tcms_sim_<zufall>` an, baut sie mit tcms-migrate auf
#     (starke Einmalpasswörter für tcms_owner und tcms_app, nur in der
#     Prozessumgebung), startet den Dienst dagegen und löscht sie am Ende, auch
#     nach einem Fehler. Fremde Datenbanken bleiben unberührt; die Rollen sind
#     aber clusterweit – nur auf einem eigenen Test-Cluster und nie gleichzeitig
#     mit anderen Läufen, die Rollenpasswörter setzen (z. B. unter `flock`).
#     TCMS_SIM_PASSWOERTER_DANACH=entwicklung setzt danach die
#     Entwicklungspasswörter (= Rollenname) wieder.
#
# Dienst-Token und Schlüssel erzeugt das Skript je Lauf; Geheimnisse gehen nur
# über die Umgebung an Kindprozesse, nie in Kommandozeilen oder die Ausgabe.
# =============================================================================

set -euo pipefail
umask 077
WURZEL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARBEIT="${1:?Aufruf: simuliere-image.sh <arbeitsverzeichnis>}"
VERSION="${TCMS_VERSION:-0.0.0-sim}"
# Genau eine Datenbankwahl; alles geprüft, bevor etwas gebaut oder angelegt wird.
SIM_MODUS=0
if [[ -n ${TCMS_SIM_PGHOST:-}${TCMS_SIM_PGPORT:-}${TCMS_SIM_PGUSER:-} ]]; then SIM_MODUS=1; fi
if ((SIM_MODUS)); then
  [[ -z ${DATABASE_URL:-} ]] || {
    echo 'simuliere-image: entweder DATABASE_URL oder TCMS_SIM_PG* setzen, nicht beides' >&2
    exit 64
  }
  SIM_WURZEL=$WURZEL
  # shellcheck source=scripts/sim-datenbank.sh
  source "$WURZEL/scripts/sim-datenbank.sh"
  sim_db_pruefen || exit $?
else
  [[ -n ${DATABASE_URL:-} ]] || {
    echo 'simuliere-image: DATABASE_URL (tcms_app) oder TCMS_SIM_PG* fehlt' >&2
    exit 64
  }
fi
[[ ! -e $ARBEIT ]] || {
  echo "simuliere-image: $ARBEIT existiert bereits" >&2
  exit 64
}
schritt() { printf '\n== %s\n' "$*"; }

# Beim Beenden (auch nach einem Fehler): Dienst stoppen, eigene Datenbank löschen.
DIENST=''
aufraeumen() {
  local status=$?
  if [[ -n $DIENST ]]; then kill "$DIENST" 2>/dev/null || true; fi
  if ((SIM_MODUS)); then
    sim_db_entfernen || status=1
  fi
  exit "$status"
}
trap aufraeumen EXIT

# Zuerst die eigene Datenbank: Ein Fehler hier bricht vor dem langen Build ab,
# ein Fehler danach löscht sie wieder (aufraeumen).
if ((SIM_MODUS)); then
  schritt 'Eigene Datenbank mit tcms-migrate (eigener Cluster)'
  sim_db_anlegen || exit $?
  DATABASE_URL=$SIM_DB_URL
fi

schritt 'Build-Kontext nach .dockerignore'
node "$WURZEL/scripts/docker-kontext.mjs" --kopiere "$ARBEIT/kontext"
cd "$ARBEIT/kontext"

schritt 'Stage bau: install, generate, build, deploy, Laufzeitbaum'
pnpm install --frozen-lockfile --filter @tcms/api... --reporter=silent
pnpm --filter @tcms/db generate >/dev/null
TCMS_VERSION="$VERSION" pnpm --filter @tcms/api build
pnpm --filter @tcms/api deploy --prod --no-optional "$ARBEIT/deploy" --reporter=silent
node apps/api/scripts/laufzeit.mjs "$ARBEIT/deploy" \
  --prisma-client node_modules/.prisma/client --bundle apps/api/dist
mkdir -p "$ARBEIT/app/dist"
cp apps/api/dist/server.mjs apps/api/dist/server.mjs.map "$ARBEIT/app/dist/"
cp apps/api/healthcheck.mjs "$ARBEIT/app/healthcheck.mjs"
mv "$ARBEIT/deploy/node_modules" "$ARBEIT/app/node_modules"
chmod -R u=rwX,go=rX "$ARBEIT/app"
cd /

schritt 'Laufzeitbaum: keine Werkzeuge, keine Quelltexte des Repos'
for p in tsx esbuild prisma @prisma/engines typescript vitest @tcms .bin; do
  if [[ -e $ARBEIT/app/node_modules/$p ]]; then
    echo "verboten im Laufzeitbaum: $p" >&2
    exit 1
  fi
done
if find "$ARBEIT/app" -name '*.ts' -path '*/packages/*' | grep -q .; then
  echo 'Quelltexte des Repos im Laufzeitbaum' >&2
  exit 1
fi
printf 'Pakete (oberste Ebene): %s, Größe: %s\n' \
  "$(find "$ARBEIT/app/node_modules" -mindepth 1 -maxdepth 1 | wc -l)" "$(du -sh "$ARBEIT/app" | cut -f1)"

schritt 'Start mit node (NODE_ENV=production, Arbeitsverzeichnis /)'
PORT="$(node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
# Schlüsselpaar, Token und Code-Schlüssel nur als Dateien im Arbeitsverzeichnis (0600).
node -e "
  const c=require('node:crypto'),f=require('node:fs');
  const k=c.generateKeyPairSync('ed25519');
  f.writeFileSync(process.argv[1]+'/token', c.randomBytes(32).toString('base64url'));
  f.writeFileSync(process.argv[1]+'/codeschluessel', c.randomBytes(32).toString('base64url'));
  f.writeFileSync(process.argv[1]+'/privat', k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'));
  f.writeFileSync(process.argv[1]+'/oeffentlich', 'sim='+k.publicKey.export({format:'der',type:'spki'}).toString('base64'));
" "$ARBEIT"
(
  # shellcheck disable=SC2030 # Umgebung nur für diesen Kindprozess
  export NODE_ENV=production HOST=127.0.0.1 PORT TCMS_LOG_LEVEL=info
  TCMS_SERVICE_TOKENS="$(cat "$ARBEIT/token")"
  TCMS_CODE_SCHLUESSEL="$(cat "$ARBEIT/codeschluessel")"
  TCMS_ACTOR_PUBLIC_KEYS="$(cat "$ARBEIT/oeffentlich")"
  export TCMS_SERVICE_TOKENS TCMS_CODE_SCHLUESSEL TCMS_ACTOR_PUBLIC_KEYS DATABASE_URL
  exec node --enable-source-maps "$ARBEIT/app/dist/server.mjs"
) >"$ARBEIT/dienst.log" 2>&1 &
DIENST=$!

healthcheck() {
  (
    # shellcheck disable=SC2031 # Umgebung nur für diesen Kindprozess
    export PORT HOST=127.0.0.1
    TCMS_SERVICE_TOKENS="$(cat "$ARBEIT/token")"
    export TCMS_SERVICE_TOKENS
    exec node "$ARBEIT/app/healthcheck.mjs"
  )
}
for _ in $(seq 1 100); do
  if healthcheck 2>/dev/null; then break; fi
  kill -0 $DIENST 2>/dev/null || {
    cat "$ARBEIT/dienst.log" >&2
    exit 1
  }
  sleep 0.1
done
healthcheck && echo 'healthcheck.mjs: Exit 0'

schritt 'GET /v1/health mit Token und signierte Anfrage GET /v1/ich'
(
  export PORT SIM_ARBEIT="$ARBEIT"
  exec node --input-type=module -e "
    import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    const a = process.env.SIM_ARBEIT, basis = 'http://127.0.0.1:' + process.env.PORT;
    const token = readFileSync(a + '/token', 'utf8');
    const h = await fetch(basis + '/v1/health', { headers: { authorization: 'Bearer ' + token } });
    const hj = await h.json();
    console.log('health', h.status, JSON.stringify(hj));
    if (h.status !== 200 || hj.daten.datenbank !== 'ok' || hj.daten.version !== '$VERSION') process.exit(1);
    const ohne = await fetch(basis + '/v1/health');
    console.log('health ohne Token', ohne.status);
    if (ohne.status !== 401) process.exit(1);
    const key = createPrivateKey({ key: Buffer.from(readFileSync(a + '/privat', 'utf8'), 'base64'), format: 'der', type: 'pkcs8' });
    const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
    const jetzt = Math.floor(Date.now() / 1000);
    const claims = { iss: 'kanzleikonsole', aud: 'tcms', iat: jetzt, exp: jetzt + 60,
      jti: randomBytes(16).toString('base64url'), tnt: randomUUID(), sub: randomUUID(),
      knd: 'KANZLEI', nam: 'Simulation', rol: { adm: false, bt: true },
      req: { m: 'GET', p: '/v1/ich', b: createHash('sha256').update('').digest('base64url') } };
    const kopf = b64({ alg: 'EdDSA', typ: 'tcms-akteur+jwt', kid: 'sim' }) + '.' + b64(claims);
    const jws = kopf + '.' + sign(null, Buffer.from(kopf), key).toString('base64url');
    const anfrage = () => fetch(basis + '/v1/ich', { headers: { authorization: 'Bearer ' + token, 'x-tcms-akteur': jws } });
    const ich = await anfrage();
    const ij = await ich.json();
    console.log('ich', ich.status, ij.daten?.art, ij.daten?.name);
    if (ich.status !== 200 || ij.daten.art !== 'KANZLEI') process.exit(1);
    const wieder = await anfrage();
    console.log('ich wiederholt (jti)', wieder.status);
    if (wieder.status !== 401) process.exit(1);
  "
)

schritt 'SIGTERM: geordnetes Ende'
kill -TERM "$DIENST"
code=0
wait "$DIENST" || code=$?
DIENST=''
echo "Exit-Code nach SIGTERM: $code"
[[ $code -eq 0 ]]
if healthcheck 2>/dev/null; then
  echo 'healthcheck.mjs meldet nach dem Ende noch gesund' >&2
  exit 1
fi
echo 'healthcheck.mjs nach dem Ende: Exit 1'
# Muster aus der Datei (-f), damit das Token in keiner Kommandozeile steht.
if grep -qFf "$ARBEIT/token" "$ARBEIT/dienst.log"; then
  echo 'Dienst-Token im Log des Dienstes' >&2
  exit 1
fi
if grep -qFf "$ARBEIT/codeschluessel" "$ARBEIT/dienst.log"; then
  echo 'Code-Schlüssel im Log des Dienstes' >&2
  exit 1
fi
# Einmalpasswörter der eigenen Datenbank: Vergleich in der Shell (kein grep-Argument).
if ((SIM_MODUS)); then
  log=$(<"$ARBEIT/dienst.log")
  if [[ $log == *"$SIM_APP_PW"* || $log == *"$SIM_OWNER_PW"* ]]; then
    echo 'Rollenpasswort im Log des Dienstes' >&2
    exit 1
  fi
fi
grep -o '"ereignis":"[a-z_]*"' "$ARBEIT/dienst.log" | sort | uniq -c
schritt 'Simulation erfolgreich'
