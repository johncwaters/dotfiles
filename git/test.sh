#!/usr/bin/env bash
set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "git"

# XDG_CONFIG_HOME is unset so git config --global reads the sandbox and nothing else.
runInstallWithoutIdentityEnvironment() {
  runInStubbedSandbox "$sandbox" PATH="$PATH" env -u GIT_USER_NAME -u GIT_USER_EMAIL -u XDG_CONFIG_HOME \
    DOTFILES_PROFILE=personal NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

runInstall() {
  runInStubbedSandbox "$sandbox" PATH="$PATH" env -u XDG_CONFIG_HOME DOTFILES_PROFILE=personal NO_COLOR=1 \
    GIT_USER_NAME="Test Carbon Unit" GIT_USER_EMAIL="test@example.com" \
    bash "$topicDir/install.sh"
}

fileModeIs() {
  [[ "$(stat -c %a "$1")" == "$2" ]]
}

printf '\ngit topic\n'

printf '[user]\n\tname = Existing Carbon Unit\n' > "$sandbox/.gitconfig"
installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
check "gitconfig is a symlink" test -L "$sandbox/.gitconfig"
check "gitconfig links through the alias" \
  test "$(readlink -- "$sandbox/.gitconfig")" = "$sandbox/.dotfiles/git/.gitconfig"
check "gitconfig resolves" test -e "$sandbox/.gitconfig"
check "pre-existing gitconfig was backed up" test -f "$sandbox/.gitconfig.pre-dotfiles.bak"
check "backup keeps the old content" \
  grep -q 'Existing Carbon Unit' "$sandbox/.gitconfig.pre-dotfiles.bak"
check "identity config comes from the environment" \
  grep -q 'Test Carbon Unit' "$sandbox/.gitconfig.local"
check "identity config is private" fileModeIs "$sandbox/.gitconfig.local" 600

secondRunOutput="$(runInstall)"
check "second run reports no changes" reportsNoChanges "$secondRunOutput"

check "the tracked gitconfig keeps the gh credential helper" \
  grep -q 'gh auth git-credential' "$topicDir/.gitconfig"
check "the credential helper is reachable through the link" \
  grep -q 'gh auth git-credential' "$sandbox/.gitconfig"

startStubbedSandbox "git-existing-identity"
printf '[user]\n\tname = Machine Carbon Unit\n\temail = machine@example.com\n' \
  > "$sandbox/.gitconfig"
carriedOverStatus=0
carriedOverOutput="$(runInstallWithoutIdentityEnvironment)" || carriedOverStatus=$?
check "an install with no identity environment exits clean" test "$carriedOverStatus" -eq 0
check "the existing name survives the cutover" \
  grep -q 'Machine Carbon Unit' "$sandbox/.gitconfig.local"
check "the existing email survives the cutover" \
  grep -q 'machine@example.com' "$sandbox/.gitconfig.local"
check "the carried identity says where it came from" \
  outputHas "$carriedOverOutput" 'already on this machine'
check "the carried identity is private" fileModeIs "$sandbox/.gitconfig.local" 600
check "the second run carries nothing over again" \
  reportsNoChanges "$(runInstallWithoutIdentityEnvironment)"

startStubbedSandbox "git-half-identity"
printf '[user]\n\tname = Half Configured Carbon Unit\n' > "$sandbox/.gitconfig.local"
chmod 600 "$sandbox/.gitconfig.local"
printf '[user]\n\tname = Machine Carbon Unit\n\temail = machine@example.com\n' \
  > "$sandbox/.gitconfig"
halfIdentityStatus=0
halfIdentityOutput="$(runInstallWithoutIdentityEnvironment)" || halfIdentityStatus=$?
check "a local config missing the email exits clean" test "$halfIdentityStatus" -eq 0
check "the missing email is filled in from the machine" \
  grep -q 'machine@example.com' "$sandbox/.gitconfig.local"
check "the name already in the local config is kept" \
  grep -q 'Half Configured Carbon Unit' "$sandbox/.gitconfig.local"
check "the name is not written a second time" \
  test "$(grep -c 'name =' "$sandbox/.gitconfig.local")" -eq 1
check "filling a field in is reported" \
  outputHas "$halfIdentityOutput" 'user.email filled in'
check "the second run fills nothing in again" \
  reportsNoChanges "$(runInstallWithoutIdentityEnvironment)"

startStubbedSandbox "git-half-identity-unterminated"
printf '[user]\n\tname = Unterminated Carbon Unit' > "$sandbox/.gitconfig.local"
chmod 600 "$sandbox/.gitconfig.local"
printf '[user]\n\tname = Machine Carbon Unit\n\temail = machine@example.com\n' \
  > "$sandbox/.gitconfig"
unterminatedStatus=0
runInstallWithoutIdentityEnvironment > /dev/null || unterminatedStatus=$?
check "a local config with no trailing newline exits clean" test "$unterminatedStatus" -eq 0
check "the name that ended the file is left intact" \
  grep -qx $'\tname = Unterminated Carbon Unit' "$sandbox/.gitconfig.local"
check "the appended section starts on its own line" \
  grep -qx '\[user\]' "$sandbox/.gitconfig.local"
check "the filled in email is readable by git" \
  grep -qx $'\temail = machine@example.com' "$sandbox/.gitconfig.local"

startStubbedSandbox "git-half-identity-uncapturable"
printf '[user]\n\tname = Only A Name\n' > "$sandbox/.gitconfig.local"
chmod 600 "$sandbox/.gitconfig.local"
uncapturableStatus=0
uncapturableOutput="$(runInstallWithoutIdentityEnvironment)" || uncapturableStatus=$?
check "a field that cannot be filled in warns" test "$uncapturableStatus" -eq 1
check "the warning names the field the local config lacks" \
  outputHas "$uncapturableOutput" 'declares no user.email'
check "a field that cannot be filled in is not invented" \
  bash -c '! grep -q "email" "$1"' _ "$sandbox/.gitconfig.local"

startStubbedSandbox "git-symlinked-identity"
outsideIdentityPath="$sandbox/an-identity-file-this-topic-never-chose"
printf 'a file this topic never chose\n' > "$outsideIdentityPath"
ln -s "$outsideIdentityPath" "$sandbox/.gitconfig.local"
symlinkedIdentityStatus=0
symlinkedIdentityOutput="$(runInstall)" || symlinkedIdentityStatus=$?
check "a symlinked local config warns" \
  outputMatches "$symlinkedIdentityOutput" '\[warn\].*local config is a symlink'
check "a symlinked local config exits non-zero" test "$symlinkedIdentityStatus" -eq 1
check "a symlinked local config is never appended through" \
  grep -qx 'a file this topic never chose' "$outsideIdentityPath"
check "nothing outside the home gains an identity" \
  bash -c '! grep -q "Test Carbon Unit" "$1"' _ "$outsideIdentityPath"
check "a symlinked local config is left where it was" test -L "$sandbox/.gitconfig.local"

startStubbedSandbox "git-foreign-section"
printf '[github]\n\tname = not the identity\n\temail = not@the.identity\n' \
  > "$sandbox/.gitconfig.local"
chmod 600 "$sandbox/.gitconfig.local"
foreignSectionStatus=0
foreignSectionOutput="$(runInstall)" || foreignSectionStatus=$?
check "a name under another section is not read as the identity" \
  outputHas "$foreignSectionOutput" 'user.name filled in'
check "an email under another section is not read as the identity" \
  outputHas "$foreignSectionOutput" 'user.email filled in'
check "the identity is written under [user]" \
  grep -q 'Test Carbon Unit' "$sandbox/.gitconfig.local"
check "the other section keeps its own keys" \
  grep -qx $'\tname = not the identity' "$sandbox/.gitconfig.local"
check "filling in past another section exits clean" test "$foreignSectionStatus" -eq 0
check "the run after filling in past another section changes nothing" \
  reportsNoChanges "$(runInstall)"

startStubbedSandbox "git-user-subsection"
printf '[user "work"]\n\tname = not the identity\n\temail = not@the.identity\n' \
  > "$sandbox/.gitconfig.local"
chmod 600 "$sandbox/.gitconfig.local"
userSubsectionStatus=0
userSubsectionOutput="$(runInstall)" || userSubsectionStatus=$?
check "a name under a [user] subsection is not read as the identity" \
  outputHas "$userSubsectionOutput" 'user.name filled in'
check "an email under a [user] subsection is not read as the identity" \
  outputHas "$userSubsectionOutput" 'user.email filled in'
check "the identity is written under the plain user section" \
  grep -qx $'\tname = Test Carbon Unit' "$sandbox/.gitconfig.local"
check "the subsection keeps its own keys" \
  grep -qx $'\tname = not the identity' "$sandbox/.gitconfig.local"
check "filling in past a [user] subsection exits clean" test "$userSubsectionStatus" -eq 0
check "the run after filling in past a subsection changes nothing" \
  reportsNoChanges "$(runInstall)"

startStubbedSandbox "git-missing-identity"
missingIdentityStatus=0
missingIdentityOutput="$(runInstallWithoutIdentityEnvironment)" || missingIdentityStatus=$?
check "missing identity exits with a warning" test "$missingIdentityStatus" -eq 1
check "missing identity explains how to configure it" \
  grep -q 'GIT_USER_NAME and GIT_USER_EMAIL' <<< "$missingIdentityOutput"

reportTopicResults "git"
