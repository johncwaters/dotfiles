# shellcheck shell=bash
# Shared plumbing for per-topic test.sh files: assertions and a throwaway HOME whose
# ~/.dotfiles alias points at this checkout.

testRepoRoot="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

failures=0

fail() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}

pass() {
  printf '  ok   %s\n' "$1"
}

check() {
  local description="$1"
  shift
  if "$@"; then
    pass "$description"
    return 0
  fi
  fail "$description"
}

cleanupHandlerNames=()
sandboxHomePaths=()

# Teardown unwinds last in first out, and a failing handler takes neither the rest nor the exit status.
runCleanupHandlers() {
  local handlerIndex
  for ((handlerIndex = ${#cleanupHandlerNames[@]} - 1; handlerIndex >= 0; handlerIndex--)); do
    "${cleanupHandlerNames[handlerIndex]}" || true
  done
}

registerCleanup() {
  cleanupHandlerNames+=("$1")
  trap runCleanupHandlers EXIT
}

removeSandboxHomes() {
  local sandboxPath
  for sandboxPath in ${sandboxHomePaths[@]+"${sandboxHomePaths[@]}"}; do
    rm -rf -- "$sandboxPath"
  done
}

trackSandboxHome() {
  sandboxHomePaths+=("$1")
  registerCleanup removeSandboxHomes
}

startSandboxHome() {
  local topicName="$1"
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-$topicName-test.XXXXXX")"
  trackSandboxHome "$sandbox"
  ln -s "$testRepoRoot" "$sandbox/.dotfiles"
  export DOTFILES_MARKER_PATH="$sandbox/.machine-profile"
}

changeMarkerPattern='\[ (ok|\+\+) \]'

runTopicInstall() {
  env HOME="$sandbox" DOTFILES_PROFILE="${2-personal}" NO_COLOR=1 bash "$1/install.sh"
}

runTopicInstallWithoutProfile() {
  env -u DOTFILES_PROFILE HOME="$sandbox" NO_COLOR=1 bash "$1/install.sh"
}

checkRerunIsQuiet() {
  local description="$1"
  local output="$2"
  if ! printf '%s\n' "$output" | grep -qE "$changeMarkerPattern"; then
    pass "$description"
    return 0
  fi
  fail "$description"
  printf '%s\n' "$output" | grep -E "$changeMarkerPattern"
}

reportTopicResults() {
  local topicName="$1"
  if ((failures > 0)); then
    printf '\n%s failing check(s)\n' "$failures"
    exit 1
  fi
  printf '\nall %s checks passed\n' "$topicName"
}
