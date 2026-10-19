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

zeile package.json '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@12\.4\.1"' \
  'packageManager muss auf pnpm@12.4.1 gepinnt sein.'
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

# Abhängigkeiten nur mit exakten Versionen (keine ^, ~, *, latest, Git, URLs).
for paket in package.json apps/*/package.json packages/*/package.json; do
  if grep -Eq '"[^"]+"[[:space:]]*:[[:space:]]*"(\^|~|\*|latest|git|https?:|file:|link:)' "$paket"; then
    fehlt "$paket: Abhängigkeit ohne exakte Version"
  fi
done

[ "$FEHLER" -eq 0 ] || exit 1
echo 'pruefe-lieferkette: pnpm-Einstellungen in Ordnung'
