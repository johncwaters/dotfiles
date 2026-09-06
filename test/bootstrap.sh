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
  "$fakeRepo/profiles/collector" "$fakeRepo/trapping"
printf '{ "topics": ["trapping"] }\n' > "$fakeRepo/profiles/personal/profile.json"
printf '{ "topics": ["trapping"] }\n' > "$fakeRepo/profiles/work/profile.json"
ln -s "$fakeRepo" "$fakeHome/.dotfiles"
git -C "$fakeRepo" init -q
git -C "$fakeRepo" -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m 'seed'

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
  env HOME="$fakeHome" XDG_STATE_HOME="$fakeHome/.local/state" \
    DOTFILES_MARKER_PATH="$markerPath" DOTFILES_PROFILE="$1" NO_COLOR=1 \
    bash "$fakeRepo/script/bootstrap"
}

printf '\nbootstrap\n'

bootstrapStatus=0
bootstrapOutput="$(runFakeBootstrap personal)" || bootstrapStatus=$?

check "a topic owning the EXIT trap still reports its change" outputHas "$bootstrapOutput" '2 changed'
check "a topic owning the EXIT trap still reports its warning" outputHas "$bootstrapOutput" '1 warnings'
check "a warning from a trapping topic still fails the run" test "$bootstrapStatus" -eq 1
check "the marker was written on the first run" grep -qx 'personal' "$markerPath"

convergedRecord="$fakeHome/.local/state/dotfiles/converged"
check "a run records the commit, profile, time and outcome it converged" \
  outputMatches "$(cat "$convergedRecord")" "^$(git -C "$fakeRepo" rev-parse HEAD) personal [0-9T:-]+Z warned$"

runFakeBootstrap work > /dev/null || true
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

reportTopicResults "bootstrap"
