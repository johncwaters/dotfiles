#!/usr/bin/env bash

set -euo pipefail

testDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$testDirectory/.." && pwd)"
# shellcheck source=./harness.sh
source "$repoRoot/test/harness.sh"

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-bootstrap-test.XXXXXX")"
trackSandboxHome "$sandbox"

fakeRepo="$sandbox/repo"
fakeHome="$sandbox/home"
markerPath="$fakeHome/.machine-profile"
mkdir -p "$fakeRepo" "$fakeHome"
cp -R "$repoRoot/script" "$fakeRepo/script"
mkdir -p "$fakeRepo/profiles/personal" "$fakeRepo/profiles/work" \
  "$fakeRepo/profiles/collector" "$fakeRepo/profiles/any-platform" \
  "$fakeRepo/profiles/bad-platform" "$fakeRepo/trapping" "$fakeRepo/platform-probe"
printf '{ "topics": ["trapping"] }\n' > "$fakeRepo/profiles/personal/profile.json"
printf '{ "platform": "darwin", "topics": ["platform-probe"] }\n' \
  > "$fakeRepo/profiles/work/profile.json"
printf '{ "topics": ["platform-probe"] }\n' > "$fakeRepo/profiles/any-platform/profile.json"
printf '{ "platform": "windows", "topics": ["platform-probe"] }\n' \
  > "$fakeRepo/profiles/bad-platform/profile.json"
ln -s "$fakeRepo" "$fakeHome/.dotfiles"
git -C "$fakeRepo" init -q
git -C "$fakeRepo" -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m 'seed'

cat > "$fakeRepo/platform-probe/install.sh" <<'TOPIC'
#!/usr/bin/env bash
printf '%s\n' ran >> "$HOME/platform-topic-runs"
TOPIC

cat > "$fakeRepo/trapping/install.sh" <<'TOPIC'
#!/usr/bin/env bash
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
scratchFile="$(mktemp "${TMPDIR:-/tmp}/dotfiles-trapping.XXXXXX")"
trap 'rm -f -- "$scratchFile"' EXIT
noteApplied "trapping" "took the EXIT trap"
noteWarned "trapping" "and warned anyway"
TOPIC

mkdir -p "$fakeRepo/vandal" "$fakeRepo/profiles/vandal"
printf '{ "topics": ["trapping", "vandal"] }\n' > "$fakeRepo/profiles/vandal/profile.json"
cat > "$fakeRepo/vandal/install.sh" <<'TOPIC'
#!/usr/bin/env bash
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
noteWarned "vandal" "a real convergence failure"
rm -f -- "${DOTFILES_COUNTS_FILE:-}"
finishTopic
TOPIC

runFakeBootstrap() {
  local selectedProfile="$1"
  local selectedPlatform="${2:-linux}"
  local selectedMarkerPath="${3:-$markerPath}"
  env HOME="$fakeHome" XDG_STATE_HOME="$fakeHome/.local/state" \
    DOTFILES_MARKER_PATH="$selectedMarkerPath" DOTFILES_PROFILE="$selectedProfile" \
    DOTFILES_PLATFORM="$selectedPlatform" NO_COLOR=1 \
    bash "$fakeRepo/script/bootstrap"
}

printf '\nbootstrap\n'

workOnLinuxStatus=0
workOnLinuxOutput="$(runFakeBootstrap work 2>&1)" || workOnLinuxStatus=$?
check "a darwin profile is refused on linux" test "$workOnLinuxStatus" -eq 1
check "the platform refusal names the profile, declaration and detection" \
  outputHas "$workOnLinuxOutput" 'profile work declares platform darwin, but detected linux'
check "a refused platform runs no topic" test ! -e "$fakeHome/platform-topic-runs"
check "a refused platform writes no marker" test ! -e "$markerPath"

darwinMarkerPath="$fakeHome/.darwin-machine-profile"
runFakeBootstrap work darwin "$darwinMarkerPath" > /dev/null
check "a darwin profile proceeds on darwin" grep -qx 'ran' "$fakeHome/platform-topic-runs"
check "a darwin profile writes its marker after the platform check" grep -qx 'work' "$darwinMarkerPath"

anyPlatformLinuxMarkerPath="$fakeHome/.any-platform-linux-machine-profile"
anyPlatformDarwinMarkerPath="$fakeHome/.any-platform-darwin-machine-profile"
runFakeBootstrap any-platform linux "$anyPlatformLinuxMarkerPath" > /dev/null
runFakeBootstrap any-platform darwin "$anyPlatformDarwinMarkerPath" > /dev/null
check "a profile without a platform proceeds on linux and darwin" \
  test "$(grep -cx ran "$fakeHome/platform-topic-runs")" -eq 3

badPlatformMarkerPath="$fakeHome/.bad-platform-machine-profile"
badPlatformStatus=0
badPlatformOutput="$(runFakeBootstrap bad-platform linux "$badPlatformMarkerPath" 2>&1)" \
  || badPlatformStatus=$?
check "an unknown declared platform is refused" test "$badPlatformStatus" -eq 1
check "the unknown platform refusal names the profile, declaration and detection" \
  outputHas "$badPlatformOutput" 'profile bad-platform declares platform windows, but detected linux'
check "an unknown declared platform writes no marker" test ! -e "$badPlatformMarkerPath"
check "an unknown declared platform runs no topic" \
  test "$(grep -cx ran "$fakeHome/platform-topic-runs")" -eq 3

bootstrapStatus=0
bootstrapOutput="$(runFakeBootstrap personal)" || bootstrapStatus=$?

check "a topic owning the EXIT trap still reports its change" outputHas "$bootstrapOutput" '2 changed'
check "a topic owning the EXIT trap still reports its warning" outputHas "$bootstrapOutput" '1 warnings'
check "a warning from a trapping topic still fails the run" test "$bootstrapStatus" -eq 1
check "the marker was written on the first run" grep -qx 'personal' "$markerPath"

convergedRecord="$fakeHome/.local/state/dotfiles/converged"
check "a run records the commit, profile, time and outcome it converged" \
  outputMatches "$(cat "$convergedRecord")" "^$(git -C "$fakeRepo" rev-parse HEAD) personal [0-9T:-]+Z warned$"

runFakeBootstrap work darwin > /dev/null
check "a one off profile does not repoint the machine" grep -qx 'personal' "$markerPath"

vandalStatus=0
bootstrapOutput="$(runFakeBootstrap vandal)" || vandalStatus=$?
check "a topic that deletes the counts file cannot erase an earlier warning" \
  outputHas "$bootstrapOutput" '2 warnings'
check "a lost tally is reported" outputHas "$bootstrapOutput" 'the shared tally was lost mid run'
check "a lost tally still fails the run" test "$vandalStatus" -eq 1

: > "$markerPath"
runFakeBootstrap personal > /dev/null 2>&1 || true
check "an empty marker is rewritten rather than refused" grep -qx 'personal' "$markerPath"

decoyPath="$sandbox/decoy.json"
printf '{"token":"keep-me"}\n' > "$decoyPath"
decoyRunErrors="$(env HOME="$fakeHome" DOTFILES_COUNTS_FILE="$decoyPath" NO_COLOR=1 \
  bash "$fakeRepo/trapping/install.sh" 2>&1 > /dev/null)"
check "a caller named counts file is left alone" grep -qx '{"token":"keep-me"}' "$decoyPath"
check "a refused counts file says so on stderr" outputHas "$decoyRunErrors" 'ignoring $DOTFILES_COUNTS_FILE'

profileNameStatus=0
env HOME="$fakeHome" profileName='../../whatever' NO_COLOR=1 \
  bash "$fakeRepo/trapping/install.sh" > /dev/null 2>&1 || profileNameStatus=$?
check "an inherited profileName is validated" test "$profileNameStatus" -eq 1

symlinkMarkerStatus=0
ln -s "$decoyPath" "$fakeHome/.machine-profile-link"
env HOME="$fakeHome" XDG_STATE_HOME="$fakeHome/.local/state" \
  DOTFILES_MARKER_PATH="$fakeHome/.machine-profile-link" \
  DOTFILES_PROFILE=personal NO_COLOR=1 bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 \
  || symlinkMarkerStatus=$?
check "a symlinked marker path is refused" test "$symlinkMarkerStatus" -eq 1

foreignMarkerStatus=0
foreignMarker="$sandbox/foreign-marker"
printf '{"token":"keep-me"}\n' > "$foreignMarker"
env HOME="$fakeHome" XDG_STATE_HOME="$fakeHome/.local/state" DOTFILES_MARKER_PATH="$foreignMarker" \
  DOTFILES_PROFILE=personal NO_COLOR=1 bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 \
  || foreignMarkerStatus=$?
check "a marker path holding other content is refused" test "$foreignMarkerStatus" -eq 1
check "the refused marker paths kept their content" grep -qx '{"token":"keep-me"}' "$decoyPath"

mkdir -p "$fakeRepo/collecting"
printf '{ "topics": ["collecting", "trapping"] }\n' > "$fakeRepo/profiles/collector/profile.json"
printf '#!/usr/bin/env bash\nexit 0\n' > "$fakeRepo/collecting/install.sh"
cat > "$fakeRepo/collecting/collect.sh" <<'TOPIC'
#!/usr/bin/env bash
printf 'collecting ran\n'
TOPIC

refusedStateHome="$sandbox/refused-state-home"
mkdir -p "$refusedStateHome/.local/state" "$fakeRepo/profiles/recording"
ln -s "$sandbox/no-such-state" "$refusedStateHome/.local/state/dotfiles"
printf '{ "topics": ["collecting"] }\n' > "$fakeRepo/profiles/recording/profile.json"
refusedStateStatus=0
refusedStateOutput="$(env HOME="$refusedStateHome" XDG_STATE_HOME="$refusedStateHome/.local/state" \
  DOTFILES_MARKER_PATH="$refusedStateHome/.machine-profile" DOTFILES_PROFILE=recording NO_COLOR=1 \
  bash "$fakeRepo/script/bootstrap")" || refusedStateStatus=$?
check "a converge record that could not be written is named" \
  outputHas "$refusedStateOutput" 'is not a plain directory'
check "a converge record that could not be written reaches the summary" \
  outputHas "$refusedStateOutput" '1 warnings'
check "a converge record that could not be written fails the run" test "$refusedStateStatus" -eq 1

env HOME="$fakeHome" XDG_STATE_HOME="$fakeHome/.local/state" DOTFILES_MARKER_PATH="$markerPath" \
  DOTFILES_PROFILE=recording NO_COLOR=1 bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 || true
check "a converge of a dirty checkout records it as dirty" \
  outputMatches "$(cat "$convergedRecord")" \
  "^$(git -C "$fakeRepo" rev-parse HEAD) recording [0-9T:-]+Z dirty$"

collectStatus=0
collectOutput="$(env HOME="$fakeHome" DOTFILES_MARKER_PATH="$markerPath" \
  DOTFILES_PROFILE=collector NO_COLOR=1 bash "$fakeRepo/script/collect" 2>&1)" || collectStatus=$?
check "collect runs the profile's collectors" outputHas "$collectOutput" 'collecting ran'
check "collect skips a topic with no collector" outputHas "$collectOutput" '1 of 2 topics'
check "collect exits clean when every collector did" test "$collectStatus" -eq 0

mkdir -p "$fakeRepo/profiles/unknown-collector"
printf '{ "topics": ["missing-topic"] }\n' > "$fakeRepo/profiles/unknown-collector/profile.json"
unknownCollectStatus=0
unknownCollectOutput="$(env HOME="$fakeHome" DOTFILES_MARKER_PATH="$markerPath" \
  DOTFILES_PROFILE=unknown-collector NO_COLOR=1 bash "$fakeRepo/script/collect" 2>&1)" \
  || unknownCollectStatus=$?
check "collect fails when a profile names an unknown topic" test "$unknownCollectStatus" -eq 1
check "collect records an unknown topic in its failure receipt" \
  outputHas "$unknownCollectOutput" 'these topics failed: missing-topic'

collectSymlinkMarkerStatus=0
collectSymlinkMarkerOutput="$(env HOME="$fakeHome" \
  DOTFILES_MARKER_PATH="$fakeHome/.machine-profile-link" DOTFILES_PROFILE=collector NO_COLOR=1 \
  bash "$fakeRepo/script/collect" 2>&1)" || collectSymlinkMarkerStatus=$?
check "collect refuses a symlinked marker path as bootstrap does" \
  test "$collectSymlinkMarkerStatus" -eq 1
check "collect names the marker it refused" \
  outputHas "$collectSymlinkMarkerOutput" 'point $DOTFILES_MARKER_PATH at a real file'
check "collect runs no collector once the marker is refused" \
  outputLacks "$collectSymlinkMarkerOutput" 'collecting ran'
check "the marker collect refused kept its content" grep -qx '{"token":"keep-me"}' "$decoyPath"

collectUnsafeProfileStatus=0
collectUnsafeProfileOutput="$(env HOME="$fakeHome" DOTFILES_MARKER_PATH="$markerPath" \
  DOTFILES_PROFILE='../../whatever' NO_COLOR=1 bash "$fakeRepo/script/collect" 2>&1)" \
  || collectUnsafeProfileStatus=$?
check "collect refuses a profile name that is not a name" \
  test "$collectUnsafeProfileStatus" -eq 1
check "collect says what a profile name may hold" \
  outputHas "$collectUnsafeProfileOutput" 'expected lowercase letters, digits and dashes'

stubMarkerProbePath="$sandbox/stub-marker-probe.sh"
cat > "$stubMarkerProbePath" <<'PROBE'
#!/usr/bin/env bash
source "$1/script/lib/context.sh"
ensureStubFile "probe" "$2" "the marker line" <<< "a body that never mentions it"
PROBE

stubMarkerDestination="$fakeHome/.stub-marker-probe"
stubMarkerOutput="$(env HOME="$fakeHome" NO_COLOR=1 bash "$stubMarkerProbePath" "$fakeRepo" "$stubMarkerDestination")"
check "a stub body without its marker line warns" \
  bash -c '[[ "$1" == *"stub content lacks its marker line"* ]]' _ "$stubMarkerOutput"
check "a stub body without its marker line writes nothing" test ! -e "$stubMarkerDestination"

cleanupProbePath="$sandbox/cleanup-probe.sh"
cat > "$cleanupProbePath" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
source "$1/test/harness.sh"
printFirstHandler() {
  printf 'first\n'
  return 3
}
printSecondHandler() {
  printf 'second\n'
}
registerCleanup printFirstHandler
registerCleanup printSecondHandler
PROBE

cleanupProbeStatus=0
cleanupProbeOutput="$(bash "$cleanupProbePath" "$repoRoot")" || cleanupProbeStatus=$?
check "cleanup handlers unwind last in first out" \
  test "$cleanupProbeOutput" = "$(printf 'second\nfirst')"
check "a failing cleanup handler leaves the exit status alone" test "$cleanupProbeStatus" -eq 0

sandboxProbePath="$sandbox/sandbox-probe.sh"
cat > "$sandboxProbePath" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
source "$1/test/harness.sh"
startSandboxHome "probe-one"
printf '%s\n' "$sandbox"
startSandboxHome "probe-two"
printf '%s\n' "$sandbox"
PROBE

probeSandboxPaths=()
mapfile -t probeSandboxPaths < <(bash "$sandboxProbePath" "$repoRoot")
check "the first sandbox is removed as well as the second" test ! -d "${probeSandboxPaths[0]}"
check "the second sandbox is removed" test ! -d "${probeSandboxPaths[1]}"

stubEnvironmentIsComplete() {
  XDG_STATE_HOME="$sandbox/state-the-runner-inherited" bash -c '
    set -euo pipefail
    source "$1/test/harness.sh"
    startStubbedSandbox "environment"
    linkCoreUtilities bash
    runInStubbedSandbox "$sandbox" bash -c '\''
      [[ "$HOME" == "$1" ]]
      [[ "$PATH" == "$2:$3" ]]
      [[ "$DOTFILES_TEST_LOG" == "$4" ]]
      [[ "$DOTFILES_TEST_STATE" == "$5" ]]
      [[ "$DOTFILES_TEST_STUB_BIN" == "$2" ]]
      [[ "$DOTFILES_TEST_CORE_BIN" == "$3" ]]
      [[ "$XDG_STATE_HOME" == "$1/.local/state" ]]
    '\'' _ "$sandbox" "$stubBin" "$coreBin" "$commandLog" "$stubState"
  ' _ "$repoRoot"
}

realHomeProbePath="$sandbox/real-home-probe.sh"
cat > "$realHomeProbePath" <<'PROBE'
#!/usr/bin/env bash
set -uo pipefail
source "$1/test/harness.sh"
startStubbedSandbox "real-home-probe"
suiteSkipsTheRealHomeCheck="$2"
printf 'somecommand %s/.config/a-path-no-stub-may-name\n' "$HOME" >> "$commandLog"
reportTopicResults "real-home-probe"
PROBE

realHomeProbeStatus=0
realHomeProbeOutput="$(bash "$realHomeProbePath" "$repoRoot" 0)" || realHomeProbeStatus=$?
check "a stubbed suite naming a real home path fails without asking for the check" \
  test "$realHomeProbeStatus" -eq 1
check "the failure names the check that caught it" \
  outputHas "$realHomeProbeOutput" 'no path in the real home is ever named'

optedOutProbeStatus=0
bash "$realHomeProbePath" "$repoRoot" 1 > /dev/null || optedOutProbeStatus=$?
check "a suite that opts out of the real home check still reports clean" \
  test "$optedOutProbeStatus" -eq 0

check "the shared stub runner owns all sandbox paths and environment" stubEnvironmentIsComplete
check "a sandboxed run writes no state into the runner's own state directory" \
  test ! -d "$sandbox/state-the-runner-inherited"

check "the platform override pins darwin" test "$(DOTFILES_PLATFORM=darwin platformName)" = "darwin"
check "the platform override pins linux" test "$(DOTFILES_PLATFORM=linux platformName)" = "linux"
darwinOverrideIsRecognised() {
  DOTFILES_PLATFORM=darwin isDarwin
}
check "isDarwin recognises the darwin override" darwinOverrideIsRecognised

bashFourConstructPattern='mapfile|readarray|declare[[:space:]]+-A|\$\{[^}]*,,|\$\{[^}]*\^\^|\|&|;;&|coproc'
bootstrapPrelude="$(sed '/^# Bash 4 starts here\.$/,$d' "$repoRoot/script/bootstrap")"
check "the bootstrap prelude stays bash 3.2 clean" \
  bash -c '! grep -Eq "$1" <<< "$2"' _ "$bashFourConstructPattern" "$bootstrapPrelude"
check "the platform library the prelude sources stays bash 3.2 clean" \
  bash -c '! grep -Eq "$1" "$2"' _ "$bashFourConstructPattern" "$repoRoot/script/lib/platform.sh"
check "the profile library the prelude sources stays bash 3.2 clean" \
  bash -c '! grep -Eq "$1" "$2"' _ "$bashFourConstructPattern" "$repoRoot/script/lib/profile.sh"
check "dot stays bash 3.2 clean" \
  bash -c '! grep -Eq "$1" "$2"' _ "$bashFourConstructPattern" "$repoRoot/bin/dot"

homebrewPrefixProbe="$sandbox/homebrew-prefix-probe"
mkdir -p "$homebrewPrefixProbe/silicon/bin" "$homebrewPrefixProbe/intel/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$homebrewPrefixProbe/intel/bin/brew"
chmod +x "$homebrewPrefixProbe/intel/bin/brew"
check "the Homebrew prefix is the first candidate that holds brew" \
  test "$(firstHomebrewPrefixHoldingBrew "$homebrewPrefixProbe/silicon" "$homebrewPrefixProbe/intel")" \
  = "$homebrewPrefixProbe/intel"
check "a machine holding no brew keeps the first candidate" \
  test "$(firstHomebrewPrefixHoldingBrew "$homebrewPrefixProbe/silicon" "$homebrewPrefixProbe/missing")" \
  = "$homebrewPrefixProbe/silicon"

modernBashHome="$sandbox/modern-bash-home"
modernBashPrefix="$modernBashHome/homebrew"
modernBashLog="$modernBashHome/exec.log"
mkdir -p "$modernBashPrefix/bin"
: > "$modernBashHome/.dotfiles-test-sandbox"
modernBashStubBin="$modernBashHome/stub-bin"
mkdir -p "$modernBashStubBin"
writeDarwinDirectoryServiceStub "$modernBashStubBin"
cat > "$modernBashPrefix/bin/bash" <<'MODERN_BASH'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" ]]; then
  exit 0
fi
printf '%s\n' "$*" >> "$DOTFILES_TEST_MODERN_BASH_LOG"
MODERN_BASH
chmod +x "$modernBashPrefix/bin/bash"
env HOME="$modernBashHome" DOTFILES_PLATFORM=darwin DOTFILES_TEST_BASH_MAJOR=3 \
  DOTFILES_TEST_STUB_BIN="$modernBashStubBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$modernBashPrefix" \
  DOTFILES_TEST_MODERN_BASH_LOG="$modernBashLog" \
  bash "$repoRoot/script/bootstrap" --profile work
check "bootstrap re-execs an existing Homebrew bash with the same arguments" \
  grep -qx "$repoRoot/script/bootstrap --profile work" "$modernBashLog"

brewInstallHome="$sandbox/brew-install-home"
brewInstallPrefix="$brewInstallHome/homebrew"
brewInstallBin="$brewInstallHome/bin"
brewInstallLog="$brewInstallHome/brew.log"
brewExecLog="$brewInstallHome/exec.log"
brewInstallStubBin="$brewInstallHome/stub-bin"
mkdir -p "$brewInstallBin" "$brewInstallStubBin"
writeDarwinDirectoryServiceStub "$brewInstallStubBin"
: > "$brewInstallHome/.dotfiles-test-sandbox"
cat > "$brewInstallBin/brew" <<'BREW'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOTFILES_TEST_BREW_LOG"
mkdir -p "$DOTFILES_TEST_HOMEBREW_PREFIX/bin"
cp "$DOTFILES_TEST_MODERN_BASH_SOURCE" "$DOTFILES_TEST_HOMEBREW_PREFIX/bin/bash"
chmod +x "$DOTFILES_TEST_HOMEBREW_PREFIX/bin/bash"
BREW
chmod +x "$brewInstallBin/brew"
env HOME="$brewInstallHome" PATH="$brewInstallBin:/usr/bin:/bin" DOTFILES_PLATFORM=darwin \
  DOTFILES_TEST_BASH_MAJOR=3 DOTFILES_TEST_STUB_BIN="$brewInstallStubBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$brewInstallPrefix" \
  DOTFILES_TEST_BREW_LOG="$brewInstallLog" \
  DOTFILES_TEST_MODERN_BASH_LOG="$brewExecLog" \
  DOTFILES_TEST_MODERN_BASH_SOURCE="$modernBashPrefix/bin/bash" \
  bash "$repoRoot/script/bootstrap" --profile work
check "bootstrap asks Homebrew for bash when darwin has no modern bash" \
  grep -qx 'install bash' "$brewInstallLog"
check "bootstrap re-execs the bash Homebrew installed" \
  grep -qx "$repoRoot/script/bootstrap --profile work" "$brewExecLog"

platformGateHome="$sandbox/platform-gate-home"
platformGateBin="$platformGateHome/bin"
platformGateStubBin="$platformGateHome/stub-bin"
platformGateLog="$platformGateHome/installer.log"
mkdir -p "$platformGateBin" "$platformGateStubBin"
: > "$platformGateHome/.dotfiles-test-sandbox"
writeDarwinDirectoryServiceStub "$platformGateStubBin"
for interceptedCommand in brew curl; do
  cat > "$platformGateBin/$interceptedCommand" <<STUB
#!/usr/bin/env bash
printf '$interceptedCommand %s\n' "\$*" >> "$platformGateLog"
STUB
  chmod +x "$platformGateBin/$interceptedCommand"
done
platformGateStatus=0
platformGateOutput="$(env HOME="$platformGateHome" PATH="$platformGateBin:/usr/bin:/bin" \
  DOTFILES_PLATFORM=darwin DOTFILES_TEST_BASH_MAJOR=3 \
  DOTFILES_MARKER_PATH="$platformGateHome/.machine-profile" \
  DOTFILES_TEST_STUB_BIN="$platformGateStubBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$platformGateHome/missing" \
  bash "$repoRoot/script/bootstrap" --profile server 2>&1)" || platformGateStatus=$?
check "a linux profile is refused on a bash 3 darwin machine" test "$platformGateStatus" -eq 1
check "the bash 3 refusal names the profile, declaration and detection" \
  outputHas "$platformGateOutput" 'profile server declares platform linux, but detected darwin'
check "a refused profile reaches neither the Homebrew installer nor brew" \
  test ! -e "$platformGateLog"

mkdir -p "$fakeRepo/interpreter" "$fakeRepo/profiles/interpreter"
printf '{ "topics": ["interpreter"] }\n' > "$fakeRepo/profiles/interpreter/profile.json"
cat > "$fakeRepo/interpreter/install.sh" <<'TOPIC'
#!/usr/bin/env bash
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
printf '%s\n' "$BASH" > "$HOME/topic-interpreter"
printf '%s\n' "$(command -v bash)" > "$HOME/topic-path-bash"
notePresent "interpreter" "recorded"
finishTopic
TOPIC

interpreterHome="$sandbox/interpreter-home"
interpreterPrefix="$interpreterHome/homebrew"
interpreterStubBin="$interpreterHome/stub-bin"
mkdir -p "$interpreterPrefix/bin" "$interpreterStubBin"
: > "$interpreterHome/.dotfiles-test-sandbox"
ln -s "$fakeRepo" "$interpreterHome/.dotfiles"
writeDarwinDirectoryServiceStub "$interpreterStubBin"
ln -s "$(type -P bash)" "$interpreterPrefix/bin/bash-4"
# The re-exec carries the forced major with it, so the stub drops it rather than looping through the prelude forever.
cat > "$interpreterPrefix/bin/bash" <<'HOMEBREW_BASH'
#!/usr/bin/env bash
exec /usr/bin/env -u DOTFILES_TEST_BASH_MAJOR "${0%/*}/bash-4" "$@"
HOMEBREW_BASH
chmod +x "$interpreterPrefix/bin/bash"

env HOME="$interpreterHome" XDG_STATE_HOME="$interpreterHome/.local/state" \
  DOTFILES_MARKER_PATH="$interpreterHome/.machine-profile" DOTFILES_PROFILE=interpreter \
  DOTFILES_PLATFORM=darwin DOTFILES_TEST_BASH_MAJOR=3 \
  DOTFILES_TEST_STUB_BIN="$interpreterStubBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$interpreterPrefix" NO_COLOR=1 \
  bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 || true
check "a topic runs under the interpreter the prelude re-execed into" \
  test "$(cat "$interpreterHome/topic-interpreter")" = "$interpreterPrefix/bin/bash-4"
check "a topic asking PATH for bash gets that interpreter's directory first" \
  test "$(cat "$interpreterHome/topic-path-bash")" = "$interpreterPrefix/bin/bash"

brewFailureHome="$sandbox/brew-failure-home"
brewFailureBin="$brewFailureHome/bin"
brewFailureStubBin="$brewFailureHome/stub-bin"
mkdir -p "$brewFailureBin" "$brewFailureStubBin"
: > "$brewFailureHome/.dotfiles-test-sandbox"
writeDarwinDirectoryServiceStub "$brewFailureStubBin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$brewFailureBin/brew"
chmod +x "$brewFailureBin/brew"
brewFailureStatus=0
brewFailureOutput="$(env HOME="$brewFailureHome" PATH="$brewFailureBin:/usr/bin:/bin" \
  DOTFILES_PLATFORM=darwin DOTFILES_TEST_BASH_MAJOR=3 \
  DOTFILES_MARKER_PATH="$brewFailureHome/.machine-profile" \
  DOTFILES_TEST_STUB_BIN="$brewFailureStubBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$brewFailureHome/missing" \
  bash "$repoRoot/script/bootstrap" 2>&1)" || brewFailureStatus=$?
check "a refused brew install bash stops the bootstrap" test "$brewFailureStatus" -eq 1
check "a refused brew install bash names the install that failed" \
  outputHas "$brewFailureOutput" 'brew install bash failed'
check "a refused brew install bash does not blame the search that never ran" \
  outputLacks "$brewFailureOutput" 'no bash 4 or newer was found'

failedDownloadHome="$sandbox/failed-download-home"
failedDownloadBin="$failedDownloadHome/stub-bin"
mkdir -p "$failedDownloadBin"
: > "$failedDownloadHome/.dotfiles-test-sandbox"
writeDarwinDirectoryServiceStub "$failedDownloadBin"
printf '#!/usr/bin/env bash\nexit 22\n' > "$failedDownloadBin/curl"
chmod +x "$failedDownloadBin/curl"
failedDownloadStatus=0
failedDownloadOutput="$(env HOME="$failedDownloadHome" PATH="$failedDownloadBin:/usr/bin:/bin" \
  DOTFILES_PLATFORM=darwin DOTFILES_TEST_BASH_MAJOR=3 \
  DOTFILES_MARKER_PATH="$failedDownloadHome/.machine-profile" \
  DOTFILES_TEST_STUB_BIN="$failedDownloadBin" \
  DOTFILES_TEST_HOMEBREW_PREFIX="$failedDownloadHome/missing" \
  bash "$repoRoot/script/bootstrap" 2>&1)" || failedDownloadStatus=$?
check "a failed Homebrew installer download stops the bootstrap" test "$failedDownloadStatus" -eq 1
check "a failed Homebrew installer download names what it could not fetch" \
  outputHas "$failedDownloadOutput" 'downloading the Homebrew installer'
check "a failed Homebrew installer download never asks brew for bash" \
  outputLacks "$failedDownloadOutput" 'no bash 4 or newer was found'

linuxBashFloorStatus=0
linuxBashFloorOutput="$(env HOME="$brewInstallHome" PATH="/usr/bin:/bin" DOTFILES_PLATFORM=linux \
  DOTFILES_TEST_BASH_MAJOR=3 DOTFILES_TEST_HOMEBREW_PREFIX="$brewInstallHome/missing" \
  DOTFILES_MARKER_PATH="$brewInstallHome/.machine-profile" \
  bash "$repoRoot/script/bootstrap" 2>&1)" || linuxBashFloorStatus=$?
check "bootstrap refuses bash 3 on linux when no modern bash exists" test "$linuxBashFloorStatus" -eq 1
check "the linux refusal names the bash floor" outputHas "$linuxBashFloorOutput" 'bash 4 or newer is required'

portableModePath="$sandbox/portable-mode"
printf 'mode probe\n' > "$portableModePath"
chmod 600 "$portableModePath"
linuxStatBin="$sandbox/linux-stat-bin"
mkdir -p "$linuxStatBin"
cat > "$linuxStatBin/stat" <<'STAT'
#!/usr/bin/env bash
[[ "$1" == "-c" && "$2" == "%a" ]] || exit 1
printf '600\n'
STAT
chmod +x "$linuxStatBin/stat"
printf '#!/usr/bin/env bash\nprintf "Linux\\n"\n' > "$linuxStatBin/uname"
chmod +x "$linuxStatBin/uname"
check "fileModeOf uses GNU stat on a linux host" \
  test "$(PATH="$linuxStatBin:$PATH" fileModeOf "$portableModePath")" = "600"

darwinStatBin="$sandbox/darwin-stat-bin"
mkdir -p "$darwinStatBin"
cat > "$darwinStatBin/stat" <<'STAT'
#!/usr/bin/env bash
[[ "$1" == "-f" && "$2" == "%Lp" ]] || exit 1
printf '600\n'
STAT
chmod +x "$darwinStatBin/stat"
printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "$darwinStatBin/uname"
chmod +x "$darwinStatBin/uname"
check "fileModeOf uses BSD stat on a darwin host" \
  test "$(PATH="$darwinStatBin:$PATH" fileModeOf "$portableModePath")" = "600"

rewriteProbe="$sandbox/rewrite-probe"
printf 'keep\nremove\nkeep-too\n' > "$rewriteProbe"
removeMatchingLines '^remove$' "$rewriteProbe"
check "portable rewrites remove only matching lines" \
  test "$(cat "$rewriteProbe")" = "$(printf 'keep\nkeep-too')"

reportTopicResults "bootstrap"
