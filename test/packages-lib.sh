#!/usr/bin/env bash

set -euo pipefail

testDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$testDirectory/.." && pwd)"
# shellcheck source=./harness.sh
source "$repoRoot/test/harness.sh"
# The state and link assertions reach past packages.sh, so the whole context is what it gets.
# shellcheck source=../script/lib/context.sh
source "$repoRoot/script/lib/context.sh"
# shellcheck source=../script/lib/packages.sh
source "$repoRoot/script/lib/packages.sh"
# shellcheck source=../script/lib/systemd.sh
source "$repoRoot/script/lib/systemd.sh"

printf '\npackages library\n'

packageNamesAre() {
  local manager="$1"
  local toolKey="$2"
  local wantedNames="$3"
  local resolvedNames
  resolvedNames="$(packageNamesForTool "$manager" "$toolKey" | tr '\n' ' ')"
  [[ "${resolvedNames% }" == "$wantedNames" ]]
}

check "apt-get installs python3 with its pip" packageNamesAre apt-get python "python3 python3-pip"
check "pacman installs python with its pip" packageNamesAre pacman python "python python-pip"
check "apt-get installs node with npm beside it" packageNamesAre apt-get node "nodejs npm"
check "pacman calls the GitHub CLI github-cli" packageNamesAre pacman gh "github-cli"
check "apt-get calls the GitHub CLI gh" packageNamesAre apt-get gh "gh"

unmappedToolResolvesToNothing() {
  ! packageNamesForTool apt-get nosuchtool >/dev/null 2>&1
}

check "an unmapped tool returns nothing" unmappedToolResolvesToNothing

aptUpdated=1
forgetPackageIndexRefresh
check "forgetting the package index refresh resets its shared state" test "$aptUpdated" -eq 0

startSandboxHome "packages-lib"

virtualEnvironmentBin="$sandbox/virtual-environment-bin"
mkdir -p "$virtualEnvironmentBin"
printf '#!/usr/bin/env bash\nexit 99\n' > "$virtualEnvironmentBin/python3"
chmod +x "$virtualEnvironmentBin/python3"

pythonOutsideVirtualEnvironmentIsChosen() {
  local pythonPath
  pythonPath="$(VIRTUAL_ENV="$sandbox/venv" PATH="$virtualEnvironmentBin:$PATH" pythonCommandName)"
  [[ "$pythonPath" == /usr/local/bin/python3 || "$pythonPath" == /usr/bin/python3 || "$pythonPath" == /bin/python3 ]]
}

check "a virtual environment cannot choose the Python used for package checks" \
  pythonOutsideVirtualEnvironmentIsChosen

packagesLibraryLoadsItsContextWhenNeeded() (
  unset dotfilesRepo libDirectory
  HOME="$sandbox" DOTFILES_MARKER_PATH="$sandbox/.machine-profile" source "$repoRoot/script/lib/packages.sh"
  [[ "$dotfilesRepo" == "$repoRoot" ]]
)

check "the packages library loads context when sourced on its own" \
  packagesLibraryLoadsItsContextWhenNeeded
check "the packages library states its context prerequisite" \
  grep -q '^# Requires context.sh' "$repoRoot/script/lib/packages.sh"

bashrcHolds() {
  grep -qF -- "$1" "$sandbox/.bashrc"
}

lastBashrcLineIsWhole() {
  [[ "$(tail -n 1 -- "$sandbox/.bashrc")" == "$1" ]]
}

printf 'no trailing newline here' > "$sandbox/.bashrc"
HOME="$sandbox" appendLineToBashrc "probe" 'export PATH="$HOME/probe:$PATH"'
check "an appended line does not splice onto an unterminated one" \
  bashrcHolds 'no trailing newline here'
check "the appended line stands on its own" \
  lastBashrcLineIsWhole 'export PATH="$HOME/probe:$PATH"'

foreignBashrc="$sandbox/foreign/.bashrc"
mkdir -p "$sandbox/foreign"
printf 'someone elses file\n' > "$foreignBashrc"
outsideHome="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-outside-home.XXXXXX")"
trackSandboxHome "$outsideHome"
mv "$foreignBashrc" "$outsideHome/.bashrc"
rm -f "$sandbox/.bashrc"
ln -s "$outsideHome/.bashrc" "$sandbox/.bashrc"

appendThroughForeignSymlink() {
  HOME="$sandbox" NO_COLOR=1 appendLineToBashrc "probe" 'export PATH="$HOME/probe:$PATH"'
}

foreignAppendOutput="$(appendThroughForeignSymlink 2>&1)" || true
check "a ~/.bashrc symlinked out of home is refused" \
  outputHas "$foreignAppendOutput" 'resolves outside the home directory'
check "the file outside home is left alone" \
  bash -c 'grep -qx "someone elses file" "$1" && test "$(wc -l < "$1")" -eq 1' _ "$outsideHome/.bashrc"

probeBin="$sandbox/probe-bin"
mkdir -p "$probeBin"

writeProbeSudo() {
  local exitStatus="$1"
  printf '#!/usr/bin/env bash\nexit %s\n' "$exitStatus" > "$probeBin/sudo"
  chmod +x "$probeBin/sudo"
}

askForSystemPackages() {
  passwordlessSudoProbe=unknown
  PATH="$probeBin:$PATH" NO_COLOR=1 canInstallSystemPackages > /dev/null
}

sudoThatWantsAPasswordIsRefused() {
  ! askForSystemPackages
}

reportWhenSudoAsksForAPassword() {
  passwordlessSudoProbe=unknown
  PATH="$probeBin:$PATH" NO_COLOR=1 bash -c '
    source "$1/script/lib/log.sh"
    source "$1/script/lib/packages.sh"
    canInstallSystemPackages || true
    canInstallSystemPackages || true
  ' _ "$repoRoot" 2>&1
}

writeProbeSudo 0
check "a sudo that needs no password can install" askForSystemPackages

writeProbeSudo 1
check "a sudo that wants a password cannot install" sudoThatWantsAPasswordIsRefused
sudoRefusalOutput="$(reportWhenSudoAsksForAPassword)"
check "a sudo that wants a password says so" \
  outputHas "$sudoRefusalOutput" 'sudo needs a password, run sudo -v first'
check "the password warning is emitted once, not once per package" \
  test "$(grep -c 'sudo needs a password' <<< "$sudoRefusalOutput")" -eq 1

hostileSystemBin="$sandbox/hostile-system-bin"
mkdir -p "$hostileSystemBin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$hostileSystemBin/true"
chmod +x "$hostileSystemBin/true"
printf '#!/usr/bin/env bash\nprintf "an-account-the-passwd-database-lacks\\n"\n' \
  > "$hostileSystemBin/id"
chmod +x "$hostileSystemBin/id"

resolvesTheSystemCopyRatherThanThePathCopy() {
  local resolvedPath
  resolvedPath="$(PATH="$hostileSystemBin:$PATH" DOTFILES_TEST_STUB_BIN="" resolveSystemCommand true)"
  [[ -n "$resolvedPath" && "$resolvedPath" != "$hostileSystemBin/true" ]]
}

resolvesTheStubDirectoryTheSandboxNames() {
  [[ "$(HOME="$sandbox" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" resolveSystemCommand true)" \
    == "$hostileSystemBin/true" ]]
}

ignoresTheStubDirectoryOutsideAMarkedSandboxHome() {
  local resolvedPath
  resolvedPath="$(HOME="$outsideHome" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" resolveSystemCommand true)"
  [[ -n "$resolvedPath" && "$resolvedPath" != "$hostileSystemBin/true" ]]
}

theStubSeamOpensInAMarkedSandboxHome() {
  [[ "$(HOME="$sandbox" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" sandboxStubBinDirectory)" \
    == "$hostileSystemBin" ]]
}

theStubSeamStaysShutWithoutTheMarker() {
  ! HOME="$outsideHome" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" sandboxStubBinDirectory
}

check "a command bound for sudo is resolved from the system path, not the caller's" \
  resolvesTheSystemCopyRatherThanThePathCopy
check "the stub seam opens inside a home the harness marked" \
  theStubSeamOpensInAMarkedSandboxHome
check "the stub seam stays shut in a home with no sandbox marker" \
  theStubSeamStaysShutWithoutTheMarker

theAccountsOwnHomeIsRecognisedFromThePasswdDatabase() {
  local passwdHome
  passwdHome="$(accountPasswdHome)"
  [[ -n "$passwdHome" ]] || return 1
  HOME="$passwdHome" homeIsTheAccountsOwnHome
}

aSandboxHomeIsNotTheAccountsOwnHome() {
  ! HOME="$sandbox" homeIsTheAccountsOwnHome
}

theStubSeamStaysShutInTheAccountsOwnHome() {
  local passwdHome
  passwdHome="$(accountPasswdHome)"
  [[ -n "$passwdHome" ]] || return 1
  ! HOME="$passwdHome" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" sandboxStubBinDirectory
}

hostileIdCannotChooseThePasswdAccount() {
  [[ "$(PATH="$hostileSystemBin:$PATH" accountPasswdHome)" == "$(accountPasswdHome)" ]]
}

check "the account's own home is read from the passwd database" \
  theAccountsOwnHomeIsRecognisedFromThePasswdDatabase
check "a hostile id on PATH cannot choose the passwd account" \
  hostileIdCannotChooseThePasswdAccount
check "a sandbox home is never mistaken for the account's own home" \
  aSandboxHomeIsNotTheAccountsOwnHome
check "the stub seam stays shut in the account's own home" \
  theStubSeamStaysShutInTheAccountsOwnHome
check "the sandbox stub directory is still resolvable inside a marked sandbox home" \
  resolvesTheStubDirectoryTheSandboxNames
check "the stub directory an environment variable names is ignored outside a sandbox home" \
  ignoresTheStubDirectoryOutsideAMarkedSandboxHome

redirectHonouredInsideAMarkedSandboxHome() {
  [[ "$(HOME="$sandbox" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" \
    sandboxRedirectedPath "$sandbox/redirected-rules" /etc/udev/rules.d/70-headset.rules)" \
    == "$sandbox/redirected-rules" ]]
}

redirectIgnoredOutsideAMarkedSandboxHome() {
  [[ "$(HOME="$outsideHome" DOTFILES_TEST_STUB_BIN="$hostileSystemBin" \
    sandboxRedirectedPath "$outsideHome/redirected-rules" /etc/udev/rules.d/70-headset.rules)" \
    == "/etc/udev/rules.d/70-headset.rules" ]]
}

redirectIgnoredWithNoStubDirectoryNamed() {
  [[ "$(HOME="$sandbox" DOTFILES_TEST_STUB_BIN="" \
    sandboxRedirectedPath "$sandbox/redirected-rules" /etc/udev/rules.d/70-headset.rules)" \
    == "/etc/udev/rules.d/70-headset.rules" ]]
}

check "a redirected root write target is honoured inside a marked sandbox home" \
  redirectHonouredInsideAMarkedSandboxHome
check "a redirected root write target is ignored outside a sandbox home" \
  redirectIgnoredOutsideAMarkedSandboxHome
check "a redirected root write target is ignored when no stub directory is named" \
  redirectIgnoredWithNoStubDirectoryNamed

sudoArgumentLog="$sandbox/sudo-arguments.log"
cat > "$probeBin/sudo" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$sudoArgumentLog"
exit 0
STUB
chmod +x "$probeBin/sudo"

: > "$sudoArgumentLog"
PATH="$probeBin:$PATH" runPackageManagerCommand true --version || true
check "sudo is handed the absolute path of what it runs, not a bare name" \
  grep -qE -- '^-n /[^ ]*/true --version$' "$sudoArgumentLog"

: > "$sudoArgumentLog"
unresolvableCommandNeverReachesSudo() {
  ! PATH="$probeBin:$PATH" runPackageManagerCommand nosuchcommand-the-system-path-lacks
}
check "a command missing from the system path fails rather than running" \
  unresolvableCommandNeverReachesSudo
check "a command missing from the system path is never handed to sudo" \
  test ! -s "$sudoArgumentLog"

gitProbeBin="$sandbox/git-probe-bin"
mkdir -p "$gitProbeBin"
gitEnvironmentLog="$sandbox/git-environment.log"
cat > "$gitProbeBin/git" <<STUB
#!/usr/bin/env bash
printf 'GIT_TERMINAL_PROMPT=%s\nGIT_SSH_COMMAND=%s\n' \
  "\${GIT_TERMINAL_PROMPT:-unset}" "\${GIT_SSH_COMMAND:-unset}" > "$gitEnvironmentLog"
exit 0
STUB
chmod +x "$gitProbeBin/git"

PATH="$gitProbeBin:$PATH" runGitNetworkCommand ls-remote origin
check "a git network command cannot sit on a credential prompt" \
  grep -qx 'GIT_TERMINAL_PROMPT=0' "$gitEnvironmentLog"
check "a git network command cannot sit on an ssh prompt either" \
  grep -qx 'GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
    "$gitEnvironmentLog"

PATH="$gitProbeBin:$PATH" GIT_SSH_COMMAND="ssh -i /a/key/of/its/own" \
  runGitNetworkCommand ls-remote origin
check "an ssh command the caller set retains batch controls" \
  grep -qx 'GIT_SSH_COMMAND=ssh -i /a/key/of/its/own -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
    "$gitEnvironmentLog"

batchProbeBin="$sandbox/batch-probe-bin"
mkdir -p "$batchProbeBin"
batchEnvironmentLog="$sandbox/batch-environment.log"
cat > "$batchProbeBin/npm" <<STUB
#!/usr/bin/env bash
printf 'GIT_TERMINAL_PROMPT=%s\nGIT_SSH_COMMAND=%s\n' \
  "\${GIT_TERMINAL_PROMPT:-unset}" "\${GIT_SSH_COMMAND:-unset}" > "$batchEnvironmentLog"
if IFS= read -r -t 1 promptAnswer; then
  printf 'read stdin %s\n' "\$promptAnswer" >> "$batchEnvironmentLog"
fi
exit 0
STUB
chmod +x "$batchProbeBin/npm"

printf 'y\n' | PATH="$batchProbeBin:$PATH" runBatchNetworkCommand npm install
check "a package manager install cannot sit on a credential prompt" \
  grep -qx 'GIT_TERMINAL_PROMPT=0' "$batchEnvironmentLog"
check "a package manager install cannot sit on an ssh prompt either" \
  grep -qx 'GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
    "$batchEnvironmentLog"
check "a package manager install never reads the converge's stdin" \
  bash -c '! grep -q "^read stdin" "$1"' _ "$batchEnvironmentLog"

npmOperationsLog="$sandbox/npm-operations.log"
cat > "$batchProbeBin/npm" <<STUB
#!/usr/bin/env bash
printf '%s|%s|%s\n' "\$*" "\${GIT_TERMINAL_PROMPT:-unset}" "\${GIT_SSH_COMMAND:-unset}" >> "$npmOperationsLog"
if [[ "\${1:-}" == "pack" ]]; then
  : > package.tgz
fi
if IFS= read -r -t 1 promptAnswer; then
  printf 'read stdin %s\n' "\$promptAnswer" >> "$npmOperationsLog"
fi
STUB
chmod +x "$batchProbeBin/npm"
PATH="$batchProbeBin:$PATH" installGlobalNpmPackage registry-package
PATH="$batchProbeBin:$PATH" installGlobalNpmPackage github:owner/package
check "every global npm network operation uses batch controls" \
  bash -c 'test "$(grep -c "|0|ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new$" "$1")" -eq 3' \
    _ "$npmOperationsLog"
check "no global npm network operation reads the converge stdin" \
  bash -c '! grep -q "^read stdin" "$1"' _ "$npmOperationsLog"

stateHome="$sandbox/.local/state"
stateRecordDirectory="$stateHome/dotfiles"
mkdir -p "$stateRecordDirectory"

firstCollidingStateName="$(HOME="$sandbox" repoDepsPendingStateNameForPath "$sandbox/Projects/glimmervoid")"
secondCollidingStateName="$(HOME="$sandbox" repoDepsPendingStateNameForPath "$sandbox/Projects-glimmervoid")"
check "repo dependency records include the full path hash" \
  test "$firstCollidingStateName" != "$secondCollidingStateName"
check "a repo dependency record name is stable" \
  test "$firstCollidingStateName" = "$(HOME="$sandbox" repoDepsPendingStateNameForPath "$sandbox/Projects/glimmervoid")"

longRepoPathSegment="$(printf 'a%.0s' {1..300})"
longRepoStateName="$(HOME="$sandbox" repoDepsPendingStateNameForPath "$sandbox/$longRepoPathSegment")"
longRepoStateSlug="${longRepoStateName#repos-}"
longRepoStateSlug="${longRepoStateSlug%-*-deps-pending}"
longRepoStateHash="${longRepoStateName#repos-$longRepoStateSlug-}"
longRepoStateHash="${longRepoStateHash%-deps-pending}"
longRepoExpectedHash="$(printf '%s' "$longRepoPathSegment" | cksum)"
longRepoExpectedHash="${longRepoExpectedHash%% *}"
if [[ -x /usr/bin/sha256sum ]]; then
  longRepoExpectedHash="$(printf '%s' "$longRepoPathSegment" | /usr/bin/sha256sum)"
  longRepoExpectedHash="${longRepoExpectedHash%% *}"
  longRepoExpectedHash="${longRepoExpectedHash:0:12}"
fi
check "a repo dependency record slug is capped at 80 bytes" \
  test "${#longRepoStateSlug}" -eq 80
check "a bounded repo dependency record keeps its full hash suffix" \
  test "$longRepoStateHash" = "$longRepoExpectedHash"
check "the shared repo dependency key names glimmervoid's gate" \
  grep -q 'shared with glimmervoid' "$repoRoot/script/lib/state.sh"

stateTargetPath="$sandbox/a-file-the-state-writer-never-chose"
printf 'a file the state writer never chose\n' > "$stateTargetPath"
ln -s "$stateTargetPath" "$stateRecordDirectory/probe-record"

writeProbeState() {
  HOME="$sandbox" XDG_STATE_HOME="$stateHome" NO_COLOR=1 writeDotfilesState "$1" "$2"
}

symlinkedStateOutput="$(writeProbeState probe-record "the value this run owes" 2>&1)" || true
check "a state record symlinked elsewhere is refused" \
  outputHas "$symlinkedStateOutput" 'is not a regular file'
check "the file the state record pointed at is untouched" \
  grep -qx 'a file the state writer never chose' "$stateTargetPath"
check "the symlinked state record is left where it was" \
  test -L "$stateRecordDirectory/probe-record"

writeProbeState plain-record "the value this run owes" > /dev/null
check "a plain state record is written" \
  grep -qx 'the value this run owes' "$stateRecordDirectory/plain-record"
check "the staged copy is never left behind" \
  bash -c '! compgen -G "$1/.dotfiles-state.*" > /dev/null' _ "$stateRecordDirectory"

markProbeStatePending() {
  HOME="$sandbox" XDG_STATE_HOME="$stateHome" NO_COLOR=1 markDotfilesStatePending "$1"
}

probeStateIsPending() {
  HOME="$sandbox" XDG_STATE_HOME="$stateHome" dotfilesStateIsPending "$1"
}

markProbeStatePending pending-record > /dev/null
check "a pending record reads as pending" probeStateIsPending pending-record

symlinkedPendingOutput="$(markProbeStatePending probe-record 2>&1)" || true
check "a pending marker never truncates what a symlink points at" \
  grep -qx 'a file the state writer never chose' "$stateTargetPath"
check "a pending marker on a symlinked record is refused" \
  outputHas "$symlinkedPendingOutput" 'is not a regular file'
symlinkedPendingReadOutput="$(NO_COLOR=1 probeStateIsPending probe-record 2>&1)"
check "a symlinked record reads as pending" probeStateIsPending probe-record
check "a symlinked pending record warns" \
  outputHas "$symlinkedPendingReadOutput" 'is not a regular file, treating it as pending'

clearProbeState() {
  HOME="$sandbox" XDG_STATE_HOME="$stateHome" NO_COLOR=1 clearDotfilesState "$1"
}

clearProbeState plain-record > /dev/null
check "clearing a regular state record removes it" test ! -e "$stateRecordDirectory/plain-record"

symlinkedClearStatus=0
symlinkedClearOutput="$(clearProbeState probe-record 2>&1)" || symlinkedClearStatus=$?
check "clearing a symlinked state record returns success" test "$symlinkedClearStatus" -eq 0
check "clearing a symlinked state record warns" \
  outputHas "$symlinkedClearOutput" 'is not a regular file'
check "clearing a symlinked state record preserves the link" \
  test -L "$stateRecordDirectory/probe-record"
check "clearing a symlinked state record preserves its target" \
  grep -qx 'a file the state writer never chose' "$stateTargetPath"

mkdir -p "$stateRecordDirectory/directory-record"
directoryClearStatus=0
directoryClearOutput="$(clearProbeState directory-record 2>&1)" || directoryClearStatus=$?
check "clearing a directory state record returns success" test "$directoryClearStatus" -eq 0
check "clearing a directory state record warns" \
  outputHas "$directoryClearOutput" 'is not a regular file'
check "clearing a directory state record preserves it" \
  test -d "$stateRecordDirectory/directory-record"
directoryPendingOutput="$(NO_COLOR=1 probeStateIsPending directory-record 2>&1)"
check "a directory record reads as pending" probeStateIsPending directory-record
check "a directory pending record warns" \
  outputHas "$directoryPendingOutput" 'is not a regular file, treating it as pending'

readSymlinkedStateStatus=0
readSymlinkedStateOutput="$(HOME="$sandbox" XDG_STATE_HOME="$stateHome" \
  readDotfilesState probe-record)" || readSymlinkedStateStatus=$?
check "a symlinked state record returns no value" test -z "$readSymlinkedStateOutput"
check "a symlinked state record returns failure" test "$readSymlinkedStateStatus" -eq 1

savedStateRecordDirectory="$sandbox/saved-state-record-directory"
redirectedStateDirectoryTarget="$sandbox/redirected-state-directory-target"
mv "$stateRecordDirectory" "$savedStateRecordDirectory"
mkdir -p "$redirectedStateDirectoryTarget"
printf 'outside state value\n' > "$redirectedStateDirectoryTarget/redirected-record"
ln -s "$redirectedStateDirectoryTarget" "$stateRecordDirectory"

redirectedWriteOutput="$(writeProbeState redirected-record changed 2>&1)"
check "a symlinked state directory refuses writes" \
  outputHas "$redirectedWriteOutput" 'is not a plain directory'
check "a refused state directory write leaves outside state untouched" \
  grep -qx 'outside state value' "$redirectedStateDirectoryTarget/redirected-record"

redirectedReadStatus=0
redirectedReadOutput="$(HOME="$sandbox" XDG_STATE_HOME="$stateHome" NO_COLOR=1 \
  readDotfilesState redirected-record 2>&1)" || redirectedReadStatus=$?
check "a symlinked state directory refuses reads" test "$redirectedReadStatus" -eq 1
check "a refused state directory read returns no outside value" \
  outputLacks "$redirectedReadOutput" 'outside state value'

redirectedPendingStatus=1
redirectedPendingOutput="$(NO_COLOR=1 probeStateIsPending redirected-record 2>&1)" \
  && redirectedPendingStatus=0
check "an unreadable state directory keeps work pending" test "$redirectedPendingStatus" -eq 0
check "an unreadable state directory pending read warns" \
  outputHas "$redirectedPendingOutput" 'is not a plain directory'

redirectedClearOutput="$(clearProbeState redirected-record 2>&1)"
check "a symlinked state directory refuses clears" \
  outputHas "$redirectedClearOutput" 'is not a plain directory'
check "a refused state directory clear leaves outside state untouched" \
  grep -qx 'outside state value' "$redirectedStateDirectoryTarget/redirected-record"

stateDirectoryRefusalMakesTopicFail() {
  local refusedStateHome="$1"
  local topicOutput
  local topicStatus=0
  topicOutput="$(HOME="$sandbox" XDG_STATE_HOME="$refusedStateHome" NO_COLOR=1 bash -c '
    set -euo pipefail
    source "$1/script/lib/log.sh"
    source "$1/script/lib/state.sh"
    markDotfilesStatePending probe-record
    printf "state write returned\n"
    finishTopic
  ' _ "$repoRoot" 2>&1)" || topicStatus=$?
  [[ "$topicStatus" -eq 1 ]] || return 1
  outputHas "$topicOutput" 'state write returned'
}

unwritableStateHome="$sandbox/unwritable-state-home"
mkdir -p "$unwritableStateHome/dotfiles"
chmod 500 "$unwritableStateHome/dotfiles"
check "an unwritable state directory makes finishTopic report failure" \
  stateDirectoryRefusalMakesTopicFail "$unwritableStateHome"
chmod 700 "$unwritableStateHome/dotfiles"

symlinkedStateHome="$sandbox/symlinked-state-home"
symlinkedStateTarget="$sandbox/symlinked-state-target"
mkdir -p "$symlinkedStateHome" "$symlinkedStateTarget"
ln -s "$symlinkedStateTarget" "$symlinkedStateHome/dotfiles"
check "a symlinked state directory makes finishTopic report failure" \
  stateDirectoryRefusalMakesTopicFail "$symlinkedStateHome"

rm "$stateRecordDirectory"
mv "$savedStateRecordDirectory" "$stateRecordDirectory"

unitPath="$sandbox/probe.service"
unitRecordName="$(linkedUnitContentStateName "$unitPath")"
unitRecordPath="$stateRecordDirectory/$unitRecordName"
unitRecordTarget="$sandbox/unit-record-target"
printf 'current unit content\n' > "$unitPath"
printf 'current unit content\n' > "$unitRecordTarget"
ln -s "$unitRecordTarget" "$unitRecordPath"
check "a symlinked unit content record counts as changed" linkedUnitContentChanged "$unitPath"
check "checking a symlinked unit content record leaves its target alone" \
  grep -qx 'current unit content' "$unitRecordTarget"

# state.sh is sourced before render.sh and on its own by systemd.sh, so it carries its own plain file check.
refusesASymlinkedRecordWithoutTakingTheTopicWithIt() {
  local survivorOutput
  survivorOutput="$(HOME="$sandbox" XDG_STATE_HOME="$stateHome" NO_COLOR=1 bash -c '
    set -euo pipefail
    source "$1/script/lib/log.sh"
    source "$1/script/lib/state.sh"
    markDotfilesStatePending "$2"
    writeDotfilesState "$2" "the value this run owes"
    printf "the topic kept going\n"
  ' _ "$repoRoot" probe-record 2>&1)" || return 1
  outputHas "$survivorOutput" 'the topic kept going'
}

check "a refused state record warns instead of aborting the topic under set -e" \
  refusesASymlinkedRecordWithoutTakingTheTopicWithIt

linkProbeDirectory="$sandbox/link-outcomes"
mkdir -p "$linkProbeDirectory"

eachLinkReportsItsOwnOutcome() {
  local firstOutcome=""
  local secondOutcome=""
  linkEntry "probe one" "README.md" "$linkProbeDirectory/first" firstOutcome > /dev/null
  linkEntry "probe two" "README.md" "$linkProbeDirectory/second" secondOutcome > /dev/null
  [[ "$firstOutcome" == "changed" && "$secondOutcome" == "changed" ]] || return 1
  linkEntry "probe one" "README.md" "$linkProbeDirectory/first" firstOutcome > /dev/null
  [[ "$firstOutcome" == "current" && "$secondOutcome" == "changed" ]]
}

aLinkWithNoOutcomeVariableStillLinks() {
  linkEntry "probe three" "README.md" "$linkProbeDirectory/third" > /dev/null
  [[ -L "$linkProbeDirectory/third" ]]
}

check "each link reports its own outcome instead of a shared one" \
  eachLinkReportsItsOwnOutcome
check "a caller that wants no outcome still gets its link" \
  aLinkWithNoOutcomeVariableStillLinks
check "the refused record still left the file it pointed at alone" \
  grep -qx 'a file the state writer never chose' "$stateTargetPath"

aptRemovalRefusesDependents() (
  local probeLog="$sandbox/nodesource-removal.log"
  local actualRemovalMarker="$sandbox/nodesource-removed"
  : > "$probeLog"
  runPackageManagerCommand() {
    if [[ "$*" == *' -s remove npm' ]]; then
      printf 'Remv npm [1.0]\nRemv npm-dependent [1.0]\n'
      return 0
    fi
    : > "$actualRemovalMarker"
  }
  ! removeAptPackageWithoutDependents npm "$probeLog" \
    && [[ ! -e "$actualRemovalMarker" ]] \
    && grep -q 'would also remove: npm-dependent' "$probeLog"
)

check "NodeSource refuses an npm removal plan that includes dependents" \
  aptRemovalRefusesDependents

reportTopicResults "packages library"
