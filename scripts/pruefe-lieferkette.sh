#!/usr/bin/env sh
# =============================================================================
# Prüft die Lieferketten-Einstellungen von pnpm, bevor irgendetwas installiert
# wird (CI, Images). Ohne npm-Abhängigkeiten, damit ein vergifteter Paketbaum
# die Prüfung nicht beeinflussen kann (Vorbild: kanzleikonsole,
# scripts/check-pnpm-supply-chain.sh).
# =============================================================================
set -eu

WURZEL="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$WURZEL"
FEHLER=0

fehlt() {
  echo "FEHLER: $*" >&2
  FEHLER=1
}

zeile() {
  datei="$1"
  muster="$2"
  meldung="$3"
  grep -Eq "$muster" "$datei" || fehlt "$meldung"
}

# Optional mit Integritäts-Suffix (Corepack/pnpm: `+sha512.<128 Hex-Zeichen>`).
zeile package.json '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@12\.14\.0(\+sha512\.[0-9a-f]{128})?"' \
  'packageManager muss auf pnpm@12.14.0 gepinnt sein.'
W=pnpm-workspace.yaml
zeile $W '^minimumReleaseAge:[[:space:]]*10080([[:space:]]*#.*)?$' 'minimumReleaseAge muss 10080 (7 Tage) sein.'
zeile $W '^minimumReleaseAgeStrict:[[:space:]]*true$' 'minimumReleaseAgeStrict muss true sein.'
zeile $W '^minimumReleaseAgeIgnoreMissingTime:[[:space:]]*false$' 'minimumReleaseAgeIgnoreMissingTime muss false sein.'
zeile $W '^trustLockfile:[[:space:]]*false$' 'trustLockfile muss false sein.'
zeile $W '^trustPolicy:[[:space:]]*no-downgrade$' 'trustPolicy muss no-downgrade sein.'
zeile $W '^blockExoticSubdeps:[[:space:]]*true$' 'blockExoticSubdeps muss true sein.'
zeile $W '^strictDepBuilds:[[:space:]]*true$' 'strictDepBuilds muss true sein.'
zeile $W '^dangerouslyAllowAllBuilds:[[:space:]]*false$' 'dangerouslyAllowAllBuilds muss false sein.'
zeile $W '^sideEffectsCache:[[:space:]]*false$' 'sideEffectsCache muss false sein.'
zeile $W '^verifyDepsBeforeRun:[[:space:]]*error$' 'verifyDepsBeforeRun muss error sein.'
zeile $W "^savePrefix:[[:space:]]*''$" 'savePrefix muss leer sein (exakte Versionen).'

# Keine Ausnahmen von der Release-Sperre oder der Vertrauensregel ohne Prüfung.
if grep -Eq '^(minimumReleaseAgeExclude|trustPolicyExclude):' $W; then
  fehlt 'Ausnahmen (minimumReleaseAgeExclude/trustPolicyExclude) brauchen eine Prüfung im Review; Guard anpassen.'
fi

# Abhängigkeiten nur mit exakten Versionen – als Positivliste: jeder Eintrag
# der Abhängigkeitsblöcke ist `"name": "X.Y.Z[-pre]"` oder `"name":
# "workspace:*"` auf einer eigenen Zeile (wie Prettier formatiert). Bereiche
# (4, 4.x, >=4, ^, ~, *), Tags (latest, next), Aliase (npm:), Git, URLs,
# GitHub-Kurzformen, catalog:, workspace:^ und leere Werte scheitern; ebenso
# ein Block, der nicht so formatiert ist.
# Ohne Backslash: awk -v verarbeitet Escapes im Wert.
VERSION='[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?'
for paket in package.json apps/*/package.json packages/*/package.json; do
  [ -f "$paket" ] || continue # Muster ohne Treffer
  if ! awk -v version="$VERSION" '
    BEGIN { block = 0; fehler = 0 }
    block == 0 && /"(dependencies|devDependencies|peerDependencies|optionalDependencies)"[[:space:]]*:/ {
      kopf = "^[[:space:]]*\"[A-Za-z]+\"[[:space:]]*:[[:space:]]*[{][[:space:]]*"
      if ($0 ~ (kopf "[}],?[[:space:]]*$")) next
      if ($0 !~ (kopf "$")) { fehler = 1; next }
      block = 1
      next
    }
    block == 1 {
      if ($0 ~ /^[[:space:]]*\},?[[:space:]]*$/) { block = 0; next }
      if ($0 !~ ("^[[:space:]]*\"[^\"]+\"[[:space:]]*:[[:space:]]*\"(" version "|workspace:[*])\",?[[:space:]]*$")) fehler = 1
    }
    END { exit (fehler || block) }
  ' "$paket"; then
    fehlt "$paket: Abhängigkeit ohne exakte Version (X.Y.Z oder workspace:*)"
  fi
  # Versionsangaben außerhalb der Blöcke (pnpm.overrides, resolutions, overrides)
  # gehören nur geprüft in pnpm-workspace.yaml.
  if grep -Eq '"(overrides|resolutions|pnpm)"[[:space:]]*:' "$paket"; then
    fehlt "$paket: overrides/resolutions/pnpm nur in pnpm-workspace.yaml"
  fi
done

# overrides in pnpm-workspace.yaml: jeder Eintrag mit exakter Version.
if ! awk -v version="$VERSION" -v q="'" '
  BEGIN { block = 0; fehler = 0 }
  /^overrides:[[:space:]]*$/ { block = 1; next }
  /^overrides:/ { fehler = 1; next }
  block == 1 && /^[^[:space:]#]/ { block = 0 }
  block == 1 && /^[[:space:]]*(#.*)?$/ { next }
  block == 1 {
    if ($0 !~ ("^[[:space:]]+[^[:space:]#][^#]*:[[:space:]]*(" q version q "|\"" version "\"|" version ")[[:space:]]*(#.*)?$")) fehler = 1
  }
  END { exit fehler }
' $W; then
  fehlt 'overrides in pnpm-workspace.yaml nur mit exakter Version (X.Y.Z).'
fi
# Weitere Wege zu Versionsbereichen brauchen eine Prüfung im Review; Guard anpassen.
if grep -Eq '^(catalog|catalogs|packageExtensions):' $W; then
  fehlt 'catalog/catalogs/packageExtensions in pnpm-workspace.yaml: Guard anpassen.'
fi

[ "$FEHLER" -eq 0 ] || exit 1
echo 'pruefe-lieferkette: pnpm-Einstellungen in Ordnung'
