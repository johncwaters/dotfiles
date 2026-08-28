#!/usr/bin/env bash
# Runs script/bootstrap against a throwaway copy of this repo: a topic that owns the
# EXIT trap still reports, and no caller supplied path is written through.

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
mkdir -p "$fakeRepo/profiles/personal" "$fakeRepo/profiles/work" "$fakeRepo/trapping"
printf '{ "topics": ["trapping"] }\n' > "$fakeRepo/profiles/personal/profile.json"
printf '{ "topics": ["trapping"] }\n' > "$fakeRepo/profiles/work/profile.json"
ln -s "$fakeRepo" "$fakeHome/.dotfiles"

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
  env HOME="$fakeHome" DOTFILES_MARKER_PATH="$markerPath" DOTFILES_PROFILE="$1" NO_COLOR=1 \
    bash "$fakeRepo/script/bootstrap"
}

outputHolds() {
  printf '%s\n' "$bootstrapOutput" | grep -q -- "$1"
}

printf '\nbootstrap\n'

bootstrapStatus=0
bootstrapOutput="$(runFakeBootstrap personal)" || bootstrapStatus=$?

check "a topic owning the EXIT trap still reports its change" outputHolds '2 changed'
check "a topic owning the EXIT trap still reports its warning" outputHolds '1 warnings'
check "a warning from a trapping topic still fails the run" test "$bootstrapStatus" -eq 1
check "the marker was written on the first run" grep -qx 'personal' "$markerPath"

runFakeBootstrap work > /dev/null || true
check "a one off profile does not repoint the machine" grep -qx 'personal' "$markerPath"

vandalStatus=0
bootstrapOutput="$(runFakeBootstrap vandal)" || vandalStatus=$?
check "a topic that deletes the counts file cannot erase an earlier warning" \
  outputHolds '2 warnings'
check "a lost tally is reported" outputHolds 'the shared tally was lost mid run'
check "a lost tally still fails the run" test "$vandalStatus" -eq 1

: > "$markerPath"
runFakeBootstrap personal > /dev/null 2>&1 || true
check "an empty marker is rewritten rather than refused" grep -qx 'personal' "$markerPath"

decoyPath="$sandbox/decoy.json"
printf '{"token":"keep-me"}\n' > "$decoyPath"
decoyRunErrors="$(env HOME="$fakeHome" DOTFILES_COUNTS_FILE="$decoyPath" NO_COLOR=1 \
  bash "$fakeRepo/trapping/install.sh" 2>&1 > /dev/null)"
errorsHold() {
  printf '%s\n' "$decoyRunErrors" | grep -q -- "$1"
}
check "a caller named counts file is left alone" grep -qx '{"token":"keep-me"}' "$decoyPath"
check "a refused counts file says so on stderr" errorsHold 'ignoring \$DOTFILES_COUNTS_FILE'

profileNameStatus=0
env HOME="$fakeHome" profileName='../../whatever' NO_COLOR=1 \
  bash "$fakeRepo/trapping/install.sh" > /dev/null 2>&1 || profileNameStatus=$?
check "an inherited profileName is validated" test "$profileNameStatus" -eq 1

symlinkMarkerStatus=0
ln -s "$decoyPath" "$fakeHome/.machine-profile-link"
env HOME="$fakeHome" DOTFILES_MARKER_PATH="$fakeHome/.machine-profile-link" \
  DOTFILES_PROFILE=personal NO_COLOR=1 bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 \
  || symlinkMarkerStatus=$?
check "a symlinked marker path is refused" test "$symlinkMarkerStatus" -eq 1

foreignMarkerStatus=0
foreignMarker="$sandbox/foreign-marker"
printf '{"token":"keep-me"}\n' > "$foreignMarker"
env HOME="$fakeHome" DOTFILES_MARKER_PATH="$foreignMarker" \
  DOTFILES_PROFILE=personal NO_COLOR=1 bash "$fakeRepo/script/bootstrap" > /dev/null 2>&1 \
  || foreignMarkerStatus=$?
check "a marker path holding other content is refused" test "$foreignMarkerStatus" -eq 1
check "the refused marker paths kept their content" grep -qx '{"token":"keep-me"}' "$decoyPath"

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

aliaslessHome="$sandbox/no-alias-home"
mkdir -p "$aliaslessHome"
dotWithoutAliasStatus=0
dotWithoutAliasOutput="$(env HOME="$aliaslessHome" bash "$repoRoot/bin/dot" 2>&1)" \
  || dotWithoutAliasStatus=$?
check "dot refuses to run without the alias" test "$dotWithoutAliasStatus" -eq 1
check "the refusal says how to create the alias" \
  bash -c '[[ "$1" == *"run script/bootstrap from the clone first"* ]]' _ "$dotWithoutAliasOutput"

plainDirHome="$sandbox/plain-dir-home"
mkdir -p "$plainDirHome/.dotfiles/script"
cp "$repoRoot/script/bootstrap" "$plainDirHome/.dotfiles/script/bootstrap"
dotOnPlainDirStatus=0
env HOME="$plainDirHome" bash "$repoRoot/bin/dot" > /dev/null 2>&1 || dotOnPlainDirStatus=$?
check "dot refuses a plain directory at the alias" test "$dotOnPlainDirStatus" -eq 1

pullFailHome="$sandbox/pull-fail-home"
pullFailRepo="$sandbox/pull-fail-repo"
mkdir -p "$pullFailHome" "$pullFailRepo/script"
printf '#!/usr/bin/env bash\nprintf "converged anyway\\n"\n' > "$pullFailRepo/script/bootstrap"
chmod +x "$pullFailRepo/script/bootstrap"
git -C "$pullFailRepo" init -q
ln -s "$pullFailRepo" "$pullFailHome/.dotfiles"
pullFailStatus=0
pullFailOutput="$(env HOME="$pullFailHome" bash "$repoRoot/bin/dot" 2>&1)" || pullFailStatus=$?
check "a failing pull still converges the machine" \
  bash -c '[[ "$1" == *"converged anyway"* ]]' _ "$pullFailOutput"
check "a failing pull says so without failing the run" test "$pullFailStatus" -eq 0

reportTopicResults "bootstrap"
