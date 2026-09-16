#!/usr/bin/env bash

set -euo pipefail

testDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$testDirectory/.." && pwd)"
# shellcheck source=./harness.sh
source "$repoRoot/test/harness.sh"

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-dot-test.XXXXXX")"
trackSandboxHome "$sandbox"

gitAsTester() {
  git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main "$@"
}

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
convergeLockPath="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/converge.lock"
if [[ -L "$convergeLockPath" ]]; then
  readlink "$convergeLockPath" > "$HOME/lock-holder-while-converging"
fi
if [[ -n "${DOTFILES_TEST_STEAL_LOCK_PID:-}" && -L "$convergeLockPath" ]]; then
  rm -f -- "$convergeLockPath"
  ln -s "$DOTFILES_TEST_STEAL_LOCK_PID" "$convergeLockPath"
fi
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
flockStubBin="$sandbox/flock-stub-bin"
flockStubLog="$sandbox/flock-stub.log"
flockHeldMarker="$sandbox/flock-held"
mkdir -p "$flockStubBin"
cat > "$flockStubBin/flock" <<'FLOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOTFILES_TEST_FLOCK_LOG"
[[ ! -f "$DOTFILES_TEST_FLOCK_HELD_MARKER" ]]
FLOCK
chmod +x "$flockStubBin/flock"
touch "$flockHeldMarker"
lockedRunStatus=0
lockedRunOutput="$(PATH="$flockStubBin:$PATH" DOTFILES_TEST_FLOCK_LOG="$flockStubLog" \
  DOTFILES_TEST_FLOCK_HELD_MARKER="$flockHeldMarker" runDot "$dotHome" 2>&1)" || lockedRunStatus=$?
check "a flock converge refuses while another run holds the state directory" \
  test "$lockedRunStatus" -eq 1
check "the flock refusal names the directory it waited on" \
  outputHas "$lockedRunOutput" "another dot run holds $convergeLockDirectory"
check "the flock path requests a nonblocking lock" grep -qx -- '-n 9' "$flockStubLog"
check "the flock-locked run converges nothing" outputLacks "$lockedRunOutput" 'converged'

noFlockBin="$sandbox/no-flock-bin"
mkdir -p "$noFlockBin"
linkCoreUtilities --into "$noFlockBin" awk bash basename cat chmod cmp cp cut date dirname env git \
  grep head ln mkdir mktemp mv node od readlink rm rmdir sed sort tail tr true
convergeLockPath="$convergeLockDirectory/converge.lock"
ln -s "$$" "$convergeLockPath"
liveLockStatus=0
liveLockOutput="$(PATH="$noFlockBin" runDot "$dotHome" 2>&1)" || liveLockStatus=$?
check "the fallback lock refuses a converge while a live run holds it" test "$liveLockStatus" -eq 1
check "the refusal names the process holding the lock" \
  outputHas "$liveLockOutput" "(pid $$)"
check "the locked-out run converges nothing" outputLacks "$liveLockOutput" 'converged'
check "a refused run leaves the lock where it found it" test -L "$convergeLockPath"
rm -f "$convergeLockPath"

bash -c 'exit 0' &
deadHolderPid=$!
wait "$deadHolderPid" 2>/dev/null || true
ln -s "$deadHolderPid" "$convergeLockPath"
staleLockStatus=0
staleLockOutput="$(PATH="$noFlockBin" runDot "$dotHome" 2>&1)" || staleLockStatus=$?
check "a lock no live process holds is reclaimed" test "$staleLockStatus" -eq 0
check "the reclaim says what it took over" \
  outputHas "$staleLockOutput" "reclaiming $convergeLockPath"
check "the reclaimed run converges" outputHas "$staleLockOutput" 'converged'
check "the reclaimed lock is removed when converge exits" test ! -e "$convergeLockPath"

# A lock is published with its holder's pid in one syscall, so a lock naming nobody was never a live run.
mkdir "$convergeLockPath"
namelessLockStatus=0
namelessLockOutput="$(PATH="$noFlockBin" runDot "$dotHome" 2>&1)" || namelessLockStatus=$?
check "a lock naming no holder is reclaimed rather than obeyed forever" test "$namelessLockStatus" -eq 0
check "the reclaim of a holderless lock is reported" \
  outputHas "$namelessLockOutput" "reclaiming $convergeLockPath"
check "a reclaimed holderless lock leaves the fallback lock behind it" test ! -e "$convergeLockPath"

lockHolderWhileConverging="$(cat "$dotHome/lock-holder-while-converging")"
check "a converge names its own process in the lock from the moment it holds it" \
  bash -c '[[ "$1" =~ ^[0-9]+$ ]]' _ "$lockHolderWhileConverging"

mkdirLockRunStatus=0
PATH="$noFlockBin" runDot "$dotHome" > /dev/null 2>&1 || mkdirLockRunStatus=$?
check "the fallback lock permits an uncontended converge" test "$mkdirLockRunStatus" -eq 0
check "the fallback lock is removed when converge exits" test ! -e "$convergeLockPath"

# Two runs finding the same stale lock must not both reclaim it, so the reclaim reads the lock again after moving it aside.
realReadlinkPath="$(type -P readlink)"
rm -f "$noFlockBin/readlink"
cat > "$noFlockBin/readlink" <<STUB
#!/usr/bin/env bash
if [[ "\${2:-}" == *".stale."* ]]; then
  printf '%s\n' "\$DOTFILES_TEST_LOCK_TARGET_AFTER_RENAME"
  exit 0
fi
exec "$realReadlinkPath" "\$@"
STUB
chmod +x "$noFlockBin/readlink"
ln -s "$deadHolderPid" "$convergeLockPath"
racedReclaimStatus=0
racedReclaimOutput="$(PATH="$noFlockBin" DOTFILES_TEST_LOCK_TARGET_AFTER_RENAME="$$" \
  runDot "$dotHome" 2>&1)" || racedReclaimStatus=$?
check "a lock that changed under the reclaim is not removed" \
  test "$(readlink "$convergeLockPath")" = "$deadHolderPid"
check "a reclaim that lost the race refuses rather than converging" test "$racedReclaimStatus" -eq 1
check "the lost reclaim says another run took the lock" \
  outputHas "$racedReclaimOutput" "another dot run took $convergeLockPath first"
check "a lost reclaim leaves no lock aside" \
  bash -c 'compgen -G "$1.stale.*" > /dev/null && exit 1; exit 0' _ "$convergeLockPath"
rm -f "$noFlockBin/readlink" "$convergeLockPath"
ln -sf "$realReadlinkPath" "$noFlockBin/readlink"

stolenLockStatus=0
PATH="$noFlockBin" DOTFILES_TEST_STEAL_LOCK_PID="$$" runDot "$dotHome" > /dev/null 2>&1 \
  || stolenLockStatus=$?
check "a converge whose lock was taken over exits clean" test "$stolenLockStatus" -eq 0
check "a converge leaves a lock naming another run alone" test -L "$convergeLockPath"
check "the lock the converge left behind still names the run that took it" \
  test "$(readlink "$convergeLockPath")" = "$$"
rm -f "$convergeLockPath"

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

reportTopicResults "dot"
