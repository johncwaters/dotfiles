# shellcheck shell=bash

testRepoRoot="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../script/lib/platform.sh
source "$testRepoRoot/script/lib/platform.sh"

# Suites run in this interpreter but their stubs and topic installers resolve bash from PATH; either at macOS /bin/bash 3.2 fails dozens of checks for no real defect.
requireModernBash() {
  local pathBash pathBashVersion="missing"
  pathBash="$(type -P bash || true)"
  if [[ -n "$pathBash" ]]; then
    pathBashVersion="$("$pathBash" -c 'printf %s "$BASH_VERSION"' || true)"
  fi
  if ((BASH_VERSINFO[0] >= 4)) && [[ -n "$pathBash" ]] && "$pathBash" -c '((BASH_VERSINFO[0] >= 4))'; then
    return 0
  fi
  printf 'test harness: Bash 4 or newer required for both the interpreter (got %s) and the first bash on PATH (%s, got %s); run: PATH="%s/bin:$PATH" bash %s\n' \
    "$BASH_VERSION" "${pathBash:-none}" "$pathBashVersion" "$(homebrewPrefix || true)" "$0" >&2
  exit 2
}
requireModernBash

: "${DOTFILES_PLATFORM:=linux}"
export DOTFILES_PLATFORM

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
  if ((${#sandboxHomePaths[@]} == 0)); then
    registerCleanup removeSandboxHomes
  fi
  sandboxHomePaths+=("$1")
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

stageTopicWithLinuxAccountLookup() {
  [[ ! -x /usr/bin/getent ]] || return 0
  local stagedRepo="$sandbox/repo"
  local topicName="${topicDir##*/}"
  local accountLookupStub="$sandbox/getent"
  mkdir -p "$stagedRepo"
  cp -R "$repoRoot/script" "$repoRoot/packages" "$repoRoot/profiles" "$repoRoot/README.md" "$stagedRepo/"
  if [[ "$topicName" != packages ]]; then
    cp -R "$topicDir" "$stagedRepo/"
  fi
  printf '#!/usr/bin/env bash\nprintf "fixture:x:1000:1000::/non-sandbox-account:/bin/bash\\n"\n' > "$accountLookupStub"
  chmod +x "$accountLookupStub"
  sed "s|/usr/bin/getent|$accountLookupStub|g" "$repoRoot/script/lib/platform.sh" > "$stagedRepo/script/lib/platform.sh"
  repoRoot="$stagedRepo"
  topicDir="$stagedRepo/$topicName"
  rm "$sandbox/.dotfiles"
  ln -s "$stagedRepo" "$sandbox/.dotfiles"
}

# XDG_STATE_HOME is pinned into the sandbox: inheriting the runner's would write converge state into the real home.
runInStubbedSandbox() {
  local sandboxHome="$1"
  local sandboxPlatform
  shift
  sandboxPlatform="$(platformName)"
  env HOME="$sandboxHome" \
    PATH="$stubBin:$coreBin" \
    XDG_STATE_HOME="$sandboxHome/.local/state" \
    DOTFILES_PLATFORM="$sandboxPlatform" \
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
    "$realHomeOutsideTheSandbox/.glimmervoid" "$realHomeOutsideTheSandbox/Projects" \
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

runTopicInstall() {
  env HOME="$sandbox" DOTFILES_PROFILE="${2-personal}" NO_COLOR=1 bash "$1/install.sh"
}

runTopicInstallWithoutProfile() {
  env -u DOTFILES_PROFILE HOME="$sandbox" NO_COLOR=1 bash "$1/install.sh"
}

checkRerunIsQuiet() {
  check "$1" reportsNoChanges "$2"
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
  local destinationDirectory="$coreBin"
  local utilityName
  local utilityPath
  if [[ "${1:-}" == "--into" ]]; then
    destinationDirectory="$2"
    shift 2
  fi
  for utilityName in "$@"; do
    utilityPath="$(type -P "$utilityName" 2>/dev/null || true)"
    if [[ -n "$utilityPath" ]]; then
      ln -sf "$utilityPath" "$destinationDirectory/$utilityName"
    fi
  done
}

# Every darwin override asks directory services whose home this is, so a darwin sandbox needs a dscl that answers for an account living elsewhere.
writeDarwinDirectoryServiceStub() {
  local stubDirectory="$1"
  printf '%s\n' "${2:-/Users/the-account-this-sandbox-is-not}" > "$stubDirectory/.dscl-account-home"
  printf '%s\n' "${3:-/bin/zsh}" > "$stubDirectory/.dscl-login-shell"
  cat > "$stubDirectory/dscl" <<'STUB'
#!/usr/bin/env bash
stubDirectory="${0%/*}"
answer=""
if [[ "${4:-}" == "UserShell" ]]; then
  IFS= read -r answer < "$stubDirectory/.dscl-login-shell"
  printf 'UserShell: %s\n' "$answer"
  exit 0
fi
IFS= read -r answer < "$stubDirectory/.dscl-account-home"
printf 'NFSHomeDirectory: %s\n' "$answer"
STUB
  chmod +x "$stubDirectory/dscl"
}

setStubbedDarwinLoginShell() {
  printf '%s\n' "$2" > "$1/.dscl-login-shell"
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

fileModeOf() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f %Lp "$1"
    return
  fi
  stat -c %a "$1"
}

removeMatchingLines() {
  local pattern="$1"
  local filePath="$2"
  local rewrittenPath
  rewrittenPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-rewrite.XXXXXX")"
  sed "/$pattern/d" "$filePath" > "$rewrittenPath"
  mv -- "$rewrittenPath" "$filePath"
}
