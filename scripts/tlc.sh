#!/usr/bin/env bash
# Run TLC without Nix: locate a JRE, auto-fetch tla2tools.jar (2.2M) if absent.
# Usage: scripts/tlc.sh <config-basename>   e.g. scripts/tlc.sh scheduler-racy.cfg
set -euo pipefail

cfg="${1:?usage: tlc.sh <config-file-in-specs/tla>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
jar="$root/.tools/tla2tools.jar"

# Find java: PATH first, then a Homebrew openjdk keg.
java_bin="$(command -v java || true)"
if ! "$java_bin" -version >/dev/null 2>&1; then
  for cand in /opt/homebrew/opt/openjdk/bin/java /usr/local/opt/openjdk/bin/java; do
    [ -x "$cand" ] && java_bin="$cand" && break
  done
fi
if ! "$java_bin" -version >/dev/null 2>&1; then
  echo "No JRE found. Install one lightly:  brew install openjdk" >&2
  exit 1
fi

if [ ! -f "$jar" ]; then
  echo "fetching tla2tools.jar ..." >&2
  mkdir -p "$root/.tools"
  curl -fsSL -o "$jar" \
    https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar
fi

cd "$root/specs/tla"
exec "$java_bin" -XX:+UseParallelGC -cp "$jar" tlc2.TLC scheduler.tla \
  -config "$cfg" -workers auto
