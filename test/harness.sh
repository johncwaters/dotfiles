# shellcheck shell=bash

testRepoRoot="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

failures=0
sandbox=""
stubBin=""
coreBin=""
stubState=""
commandLog=""

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

outputHas() {
  grep -qF -- "$2" <<< "$1"
}

outputLacks() {
  ! grep -qF -- "$2" <<< "$1"
}

outputMatches() {
  grep -qE -- "$2" <<< "$1"
}

changeMarkerPattern='\[ (ok|\+\+) \]'

# grep -E prints the offending lines, so a failure names the change it saw.
reportsNoChanges() {
  ! grep -E -- "$changeMarkerPattern" <<< "$1"
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

# The marker is what opens the stub seam in production code, so it is written where only this account can: inside the sandbox home.
startSandboxHome() {
  local topicName="$1"
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-$topicName-test.XXXXXX")"
  trackSandboxHome "$sandbox"
  ln -s "$testRepoRoot" "$sandbox/.dotfiles"
  : > "$sandbox/.dotfiles-test-sandbox"
  export DOTFILES_MARKER_PATH="$sandbox/.machine-profile"
}

startStubbedSandbox() {
  startSandboxHome "$1"
  stubBin="$sandbox/stub-bin"
  coreBin="$sandbox/core-bin"
  stubState="$sandbox/stub-state"
  commandLog="$stubState/commands.log"
  mkdir -p "$stubBin" "$coreBin" "$stubState/available"
  : > "$commandLog"
}

# XDG_STATE_HOME is pinned into the sandbox: inheriting the runner's would write converge state into the real home.
runInStubbedSandbox() {
  local sandboxHome="$1"
  shift
  env HOME="$sandboxHome" \
    PATH="$stubBin:$coreBin" \
    XDG_STATE_HOME="$sandboxHome/.local/state" \
    DOTFILES_TEST_LOG="$commandLog" \
    DOTFILES_TEST_STATE="$stubState" \
    DOTFILES_TEST_STUB_BIN="$stubBin" \
    DOTFILES_TEST_CORE_BIN="$coreBin" \
    "$@"
}

# Whatever a stub logged is the only record of a sandboxed run reaching out of its home, so every stubbed suite is read before it reports.
realHomeOutsideTheSandbox="$HOME"
suiteSkipsTheRealHomeCheck=0
realHomePathsNoStubMayName=()

realHomePathsToGuard() {
  printf '%s\n' "$realHomeOutsideTheSandbox/.config" "$realHomeOutsideTheSandbox/.local" \
    "$realHomeOutsideTheSandbox/.glissa" "$realHomeOutsideTheSandbox/Projects" \
    "$realHomeOutsideTheSandbox/.gitconfig"
  if ((${#realHomePathsNoStubMayName[@]} == 0)); then
    return 0
  fi
  printf '%s\n' "${realHomePathsNoStubMayName[@]}"
}

checkTheCommandLogLeftTheRealHomeAlone() {
  local guardedPaths=()
  if ((suiteSkipsTheRealHomeCheck == 1)); then
    return 0
  fi
  if [[ -z "$commandLog" || ! -f "$commandLog" ]]; then
    return 0
  fi
  mapfile -t guardedPaths < <(realHomePathsToGuard)
  check "no path in the real home is ever named" \
    commandLogNamesNoPathUnder "${guardedPaths[@]}"
}

reportTopicResults() {
  local topicName="$1"
  checkTheCommandLogLeftTheRealHomeAlone
  if ((failures > 0)); then
    printf '\n%s failing check(s)\n' "$failures"
    exit 1
  fi
  printf '\nall %s checks passed\n' "$topicName"
}

# type -P, not command -v: the latter answers with a builtin name that symlinks nowhere.
linkCoreUtilities() {
  local utilityName
  local utilityPath
  for utilityName in "$@"; do
    utilityPath="$(type -P "$utilityName" 2>/dev/null || true)"
    if [[ -n "$utilityPath" ]]; then
      ln -sf "$utilityPath" "$coreBin/$utilityName"
    fi
  done
}

writeStub() {
  local stubName="$1"
  cat > "$stubState/available/$stubName"
  chmod +x "$stubState/available/$stubName"
}

provideCommand() {
  cp "$stubState/available/$1" "$stubBin/$1"
}

withdrawCommand() {
  rm -f "$stubBin/$1"
}

# One sudo per suite: it runs only what the sandbox put on PATH and records anything else as refused, so a reach for the real root fails a check.
writeContainedSudoStub() {
  writeStub sudo <<'STUB'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-n" ]]; then
  shift
fi
resolvedCommand="$(type -P "$1" 2>/dev/null || true)"
case "$resolvedCommand" in
  "$DOTFILES_TEST_STUB_BIN"/* | "${DOTFILES_TEST_CORE_BIN:-/nowhere}"/*) exec "$@" ;;
esac
case "$(basename -- "$1")" in
  bash | sh) exec "$@" ;;
esac
printf 'sudo refused %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exit 1
STUB
  provideCommand sudo
}

# Every suite shares this apt-get stub except vscodium, whose package file behavior needs its own deliberate stub.
writeAptStubThatInstallsMappedCommands() {
  mkdir -p "$stubState/package-commands"
  writeStub apt-get <<'STUB'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$DOTFILES_TEST_LOG"
packageNames=()
for argument in "$@"; do
  case "$argument" in
    -o | -y | --* | -*) continue ;;
    update | install | remove | check) continue ;;
    DPkg::Lock::Timeout=*) continue ;;
  esac
  packageNames+=("$argument")
done
for packageName in ${packageNames[@]+"${packageNames[@]}"}; do
  mappingFile="$DOTFILES_TEST_STATE/package-commands/$packageName"
  if [[ ! -f "$mappingFile" ]]; then
    continue
  fi
  for commandName in $(cat "$mappingFile"); do
    cp "$DOTFILES_TEST_STATE/available/$commandName" "$DOTFILES_TEST_STUB_BIN/$commandName"
  done
done
exit 0
STUB
}

mapPackageToCommands() {
  mkdir -p "$stubState/package-commands"
  printf '%s\n' "$2" > "$stubState/package-commands/$1"
}

logHas() {
  grep -qF -- "$1" "$commandLog"
}

# A stub naming a path under the real home is the only proof a sandboxed run reached out of its home.
commandLogNamesNoPathUnder() {
  local realHomePath
  for realHomePath in "$@"; do
    if grep -qF -- "$realHomePath" "$commandLog"; then
      printf '  command log names %s\n' "$realHomePath"
      return 1
    fi
  done
  return 0
}

logLacks() {
  ! grep -qF -- "$1" "$commandLog"
}

countLogLines() {
  grep -cE -- "$1" "$commandLog" || true
}
