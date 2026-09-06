#!/usr/bin/env bash

set -uo pipefail

selfDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$selfDirectory/.." && pwd)"
failedSuites=()

runSuite() {
  local suiteName="$1"
  shift
  printf '\n=== %s ===\n' "$suiteName"
  if "$@"; then
    return 0
  fi
  failedSuites+=("$suiteName")
}

for topicSuite in "$repoRoot"/*/test.sh; do
  if [[ ! -f "$topicSuite" ]]; then
    continue
  fi
  runSuite "$(basename -- "$(dirname -- "$topicSuite")")" bash "$topicSuite"
done

runSuite "bootstrap" bash "$repoRoot/test/bootstrap.sh"
runSuite "packages-lib" bash "$repoRoot/test/packages-lib.sh"
runSuite "dot" bash "$repoRoot/test/dot.sh"
runSuite "repo-wiring" bash "$repoRoot/test/repo-wiring.sh"

if command -v bwrap >/dev/null 2>&1; then
  runSuite "cutover" "$repoRoot/test/run-sandbox.sh" bash "$repoRoot/test/cutover.sh"
fi
if ! command -v bwrap >/dev/null 2>&1; then
  printf '\n=== cutover ===\n  skipped, bubblewrap is not installed\n'
fi

if ((${#failedSuites[@]} > 0)); then
  printf '\nfailing suites: %s\n' "${failedSuites[*]}"
  exit 1
fi
printf '\nall suites passed\n'
