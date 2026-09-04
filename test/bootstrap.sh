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

gitAsTester() {
  git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main "$@"
}

# A repo with the real script/ tree, one quiet topic, and a bare origin whose HEAD names main.
makeConvergeableRepo() {
  local repoPath="$1"
  local originPath="$2"
  mkdir -p "$repoPath/profiles/personal" "$repoPath/quiet"
  cp -R "$repoRoot/script" "$repoPath/script"
  printf '{ "topics": ["quiet"] }\n' > "$repoPath/profiles/personal/profile.json"
  printf '.machine-profile\n' > "$repoPath/.gitignore"
  cat > "$repoPath/quiet/install.sh" <<'TOPIC'
#!/usr/bin/env bash
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
notePresent "quiet" "converged $(git -C "$dotfilesRepo" rev-parse --short HEAD)"
finishTopic
TOPIC
  gitAsTester -C "$repoPath" init -q
  gitAsTester -C "$repoPath" add -A
  gitAsTester -C "$repoPath" commit -q -m 'seed'
  gitAsTester init -q --bare "$originPath"
  gitAsTester -C "$repoPath" remote add origin "$originPath"
  gitAsTester -C "$repoPath" push -q -u origin main
  gitAsTester -C "$repoPath" remote set-head origin main
}

runDot() {
  local home="$1"
  shift
  env HOME="$home" XDG_STATE_HOME="$home/.local/state" DOTFILES_PROFILE=personal NO_COLOR=1 \
    bash "$repoRoot/bin/dot" "$@"
}

printf '\ndot\n'

freshHome="$sandbox/fresh-home"
freshOrigin="$sandbox/fresh-origin.git"
freshSeed="$sandbox/fresh-seed"
mkdir -p "$freshHome"
makeConvergeableRepo "$freshSeed" "$freshOrigin"
freshStatus=0
freshOutput="$(DOTFILES_CLONE_URL="$freshOrigin" DOTFILES_CLONE_PATH="$freshHome/Projects/dotfiles" \
  runDot "$freshHome" 2>&1)" || freshStatus=$?
check "a fresh machine clones the repo" test -f "$freshHome/Projects/dotfiles/script/bootstrap"
check "a fresh machine points the alias at the clone" \
  test "$(readlink "$freshHome/.dotfiles")" = "$freshHome/Projects/dotfiles"
check "a fresh machine converges in the same run" outputHas "$freshOutput" 'converged'
check "a fresh machine run exits clean" test "$freshStatus" -eq 0

mv "$freshHome/Projects/dotfiles" "$freshHome/Projects/dotfiles-moved"
movedCloneStatus=0
movedCloneOutput="$(DOTFILES_CLONE_URL="$freshOrigin" \
  DOTFILES_CLONE_PATH="$freshHome/Projects/dotfiles-moved" \
  runDot "$freshHome" 2>&1)" || movedCloneStatus=$?
check "a moved clone repoints the dangling alias" \
  test "$(readlink "$freshHome/.dotfiles")" = "$freshHome/Projects/dotfiles-moved"
check "a moved clone converges in the same run" outputHas "$movedCloneOutput" 'converged'
check "a moved clone run exits clean" test "$movedCloneStatus" -eq 0

plainDirHome="$sandbox/plain-dir-home"
mkdir -p "$plainDirHome/.dotfiles/script"
cp "$repoRoot/script/bootstrap" "$plainDirHome/.dotfiles/script/bootstrap"
dotOnPlainDirStatus=0
runDot "$plainDirHome" > /dev/null 2>&1 || dotOnPlainDirStatus=$?
check "dot refuses a plain directory at the alias" test "$dotOnPlainDirStatus" -eq 1

statusOnlyHome="$sandbox/status-only-home"
mkdir -p "$statusOnlyHome"
statusOnlyStatus=0
statusOnlyOutput="$(DOTFILES_CLONE_URL="$freshOrigin" \
  DOTFILES_CLONE_PATH="$statusOnlyHome/Projects/dotfiles" \
  runDot "$statusOnlyHome" status 2>&1)" || statusOnlyStatus=$?
check "status without a clone exits 1" test "$statusOnlyStatus" -eq 1
check "status without a clone says the alias points nowhere" \
  outputHas "$statusOnlyOutput" 'does not point at a clone'
check "status without a clone clones nothing" test ! -e "$statusOnlyHome/Projects"
check "status without a clone creates no alias" test ! -L "$statusOnlyHome/.dotfiles"

dotHome="$sandbox/dot-home"
dotRepo="$dotHome/Projects/dotfiles"
dotOrigin="$sandbox/dot-origin.git"
mkdir -p "$dotHome"
makeConvergeableRepo "$dotRepo" "$dotOrigin"
ln -s "$dotRepo" "$dotHome/.dotfiles"

dotStatusDrift=0
dotStatusOutput="$(runDot "$dotHome" status 2>&1)" || dotStatusDrift=$?
check "status reports drift before the first converge" test "${dotStatusDrift:-0}" -eq 1
check "status names the missing converge" outputHas "$dotStatusOutput" 'last converge was not this commit'

gitAsTester -C "$dotRepo" checkout -q -b feature
offMainStatus=0
offMainOutput="$(runDot "$dotHome" 2>&1)" || offMainStatus=$?
check "dot refuses a checkout off mainline" test "$offMainStatus" -eq 1
check "the refusal names the branch" outputHas "$offMainOutput" 'is on feature, not main'
check "the refusal does not converge" outputLacks "$offMainOutput" 'converged'
asIsOutput="$(runDot "$dotHome" --as-is 2>&1)"
check "dot --as-is converges the checkout regardless" outputHas "$asIsOutput" 'converged'
gitAsTester -C "$dotRepo" checkout -q main

printf 'edited\n' >> "$dotRepo/quiet/install.sh"
dirtyStatus=0
dirtyOutput="$(runDot "$dotHome" 2>&1)" || dirtyStatus=$?
check "dot refuses a dirty checkout" test "$dirtyStatus" -eq 1
check "the refusal counts the changed paths" outputHas "$dirtyOutput" 'has 1 changed paths'
gitAsTester -C "$dotRepo" checkout -q -- quiet/install.sh

publisher="$sandbox/publisher"
gitAsTester clone -q "$dotOrigin" "$publisher"
printf 'newer\n' > "$publisher/newer.txt"
gitAsTester -C "$publisher" add -A
gitAsTester -C "$publisher" commit -q -m 'newer'
gitAsTester -C "$publisher" push -q origin main
publishedHead="$(gitAsTester -C "$publisher" rev-parse HEAD)"

pullStatus=0
pullOutput="$(runDot "$dotHome" 2>&1)" || pullStatus=$?
check "dot fast-forwards mainline from origin" \
  test "$(gitAsTester -C "$dotRepo" rev-parse HEAD)" = "$publishedHead"
check "dot converges the pulled commit" outputHas "$pullOutput" "converged $(gitAsTester -C "$dotRepo" rev-parse --short HEAD)"
check "a converge with nothing to warn exits clean" test "$pullStatus" -eq 0

convergeLockDirectory="$dotHome/.local/state/dotfiles"
if command -v flock > /dev/null 2>&1; then
  exec 8< "$convergeLockDirectory"
  flock -n 8
  lockedRunStatus=0
  lockedRunOutput="$(runDot "$dotHome" 2>&1)" || lockedRunStatus=$?
  exec 8<&-
  check "a converge refuses while another run holds the state directory" \
    test "$lockedRunStatus" -eq 1
  check "the locked out run names the directory it waited on" \
    outputHas "$lockedRunOutput" "another dot run holds $convergeLockDirectory"
  check "the locked out run converges nothing" outputLacks "$lockedRunOutput" 'converged'
fi

dotStatusDrift=0
dotStatusOutput="$(runDot "$dotHome" status 2>&1)" || dotStatusDrift=$?
check "status reports no drift after a converge" outputHas "$dotStatusOutput" 'drift        none'
check "status exits clean when nothing drifted" test "$dotStatusDrift" -eq 0
check "status shows the converge record" outputMatches "$dotStatusOutput" "converged    $publishedHead personal [0-9T:-]+Z clean"

: > "$dotHome/.local/state/dotfiles/quiet-pending"
dotStatusDrift=0
dotStatusOutput="$(runDot "$dotHome" status 2>&1)" || dotStatusDrift=$?
check "status lists owed work" outputHas "$dotStatusOutput" 'pending      quiet-pending'
check "owed work counts as drift" test "$dotStatusDrift" -eq 1
rm -f "$dotHome/.local/state/dotfiles/quiet-pending"

convergedRecordPath="$convergeLockDirectory/converged"
mv "$convergeLockDirectory" "$convergeLockDirectory-aside"
: > "$convergeLockDirectory"
unusableStateStatus=0
unusableStateOutput="$(runDot "$dotHome" status 2>&1)" || unusableStateStatus=$?
check "status reports no record when the state directory is unusable" \
  outputHas "$unusableStateOutput" 'converged    never'
check "status keeps the warning out of the record it renders" \
  outputLacks "$unusableStateOutput" '[warn]'
check "status counts an unreadable record as drift" test "$unusableStateStatus" -eq 1
rm -f "$convergeLockDirectory"
mv "$convergeLockDirectory-aside" "$convergeLockDirectory"

printf '%s personal 2026-01-01T00:00:00Z warned\n' "$publishedHead" > "$convergedRecordPath"
warnedRecordStatus=0
warnedRecordOutput="$(runDot "$dotHome" status 2>&1)" || warnedRecordStatus=$?
check "status names a converge that warned" outputHas "$warnedRecordOutput" 'last converge was warned'
check "a converge that warned counts as drift" test "$warnedRecordStatus" -eq 1
printf '%s personal 2026-01-01T00:00:00Z clean\n' "$publishedHead" > "$convergedRecordPath"

printf 'edited\n' >> "$dotRepo/quiet/install.sh"
runDot "$dotHome" --as-is > /dev/null 2>&1 || true
gitAsTester -C "$dotRepo" checkout -q -- quiet/install.sh
dirtyConvergeStatus=0
dirtyConvergeOutput="$(runDot "$dotHome" status 2>&1)" || dirtyConvergeStatus=$?
check "status names a converge that ran on a dirty checkout" \
  outputHas "$dirtyConvergeOutput" 'last converge was dirty'
check "a discarded edit still leaves the converge record as drift" test "$dirtyConvergeStatus" -eq 1

gitAsTester -C "$dotRepo" commit -q --allow-empty -m 'local only'
printf 'diverged\n' > "$publisher/diverged.txt"
gitAsTester -C "$publisher" add -A
gitAsTester -C "$publisher" commit -q -m 'diverged'
gitAsTester -C "$publisher" push -q origin main
divergedStatus=0
divergedOutput="$(runDot "$dotHome" 2>&1)" || divergedStatus=$?
check "dot refuses a mainline that has diverged from origin" test "$divergedStatus" -eq 1
check "the refusal names the divergence" outputHas "$divergedOutput" 'has diverged from origin/main'
check "a diverged mainline converges nothing" outputLacks "$divergedOutput" 'converged'

aheadHome="$sandbox/ahead-home"
aheadRepo="$aheadHome/Projects/dotfiles"
mkdir -p "$aheadHome"
makeConvergeableRepo "$aheadRepo" "$sandbox/ahead-origin.git"
ln -s "$aheadRepo" "$aheadHome/.dotfiles"
gitAsTester -C "$aheadRepo" commit -q --allow-empty -m 'local only'
aheadStatus=0
aheadOutput="$(runDot "$aheadHome" 2>&1)" || aheadStatus=$?
check "dot refuses a mainline ahead of origin" test "$aheadStatus" -eq 1
check "the refusal counts the commits origin lacks" \
  outputHas "$aheadOutput" 'has 1 commits origin/main does not'
check "a mainline ahead of origin converges nothing" outputLacks "$aheadOutput" 'converged'

emptyOriginHome="$sandbox/empty-origin-home"
emptyOriginRepo="$emptyOriginHome/Projects/dotfiles"
mkdir -p "$emptyOriginHome"
makeConvergeableRepo "$emptyOriginRepo" "$sandbox/empty-origin-seed.git"
ln -s "$emptyOriginRepo" "$emptyOriginHome/.dotfiles"
gitAsTester -C "$emptyOriginRepo" remote remove origin
gitAsTester init -q --bare "$sandbox/empty-origin.git"
gitAsTester -C "$emptyOriginRepo" remote add origin "$sandbox/empty-origin.git"
emptyOriginStatus=0
emptyOriginOutput="$(runDot "$emptyOriginHome" 2>&1)" || emptyOriginStatus=$?
check "an origin holding no mainline still converges" outputHas "$emptyOriginOutput" 'converged'
check "an origin holding no mainline names what it skipped" \
  outputHas "$emptyOriginOutput" 'origin has no main to pull'
check "an origin holding no mainline exits clean" test "$emptyOriginStatus" -eq 0

gitAsTester -C "$dotRepo" remote remove origin
noOriginStatusDrift=0
noOriginStatusOutput="$(runDot "$dotHome" status 2>&1)" || noOriginStatusDrift=$?
check "status names an origin it could not reach" \
  outputHas "$noOriginStatusOutput" 'origin unreachable, HEAD not compared'
check "an origin that was never compared counts as drift" test "$noOriginStatusDrift" -eq 1

noOriginStatus=0
noOriginOutput="$(runDot "$dotHome" 2>&1)" || noOriginStatus=$?
check "a failing fetch still converges the machine" outputHas "$noOriginOutput" 'converged'
check "a failing fetch says so without failing the run" test "$noOriginStatus" -eq 0
check "a failing fetch is named" outputHas "$noOriginOutput" 'fetch failed'

requireOriginStatus=0
requireOriginOutput="$(DOTFILES_REQUIRE_ORIGIN=1 runDot "$dotHome" 2>&1)" || requireOriginStatus=$?
check "a run requiring origin fails when origin is unreachable" test "$requireOriginStatus" -eq 1
check "a run requiring origin names why it refused" \
  outputHas "$requireOriginOutput" 'origin unreachable and DOTFILES_REQUIRE_ORIGIN=1'
check "a run requiring origin converges nothing" outputLacks "$requireOriginOutput" 'converged'

reportTopicResults "bootstrap"
