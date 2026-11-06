#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startSandboxHome "shell"
printf 'distro default bashrc\nexport MACHINE_ONLY_EXPORT=1\n' > "$sandbox/.bashrc"
touch "$sandbox/.hushlogin"

runInstall() {
  runTopicInstall "$topicDir"
}

interactiveShellIn() {
  env -i HOME="$1" PATH="/usr/bin:/bin" TERM=dumb DOTFILES_PLATFORM=linux "$BASH" -i -c "$2" 2>/dev/null
}

interactiveShell() {
  interactiveShellIn "$sandbox" "$1"
}


upgradeNoticeHome="$sandbox/upgrade-notice-home"
upgradeNoticeState="$upgradeNoticeHome/.local/state/dotfiles"
mkdir -p "$upgradeNoticeState"
printf 'formula git 2.1.0 3.0.0\n' > "$upgradeNoticeState/upgrades-held-packages"
printf 'plugin example 1.0.0 2.0.0\n' > "$upgradeNoticeState/upgrades-held-ai"
noticeStdout="$sandbox/notice.stdout"
noticeStderr="$sandbox/notice.stderr"
runUpgradeNotice() {
  env HOME="$upgradeNoticeHome" XDG_STATE_HOME="$upgradeNoticeHome/.local/state" \
    bash -c 'source "$1"; printf "unchanged\n"' _ "$repoRoot/packages/updates.bash" > "$noticeStdout" 2> "$noticeStderr"
}
runUpgradeNotice
check "held upgrades print one stderr line across topics" test "$(wc -l < "$noticeStderr")" -eq 1
check "upgrade notice names the approval command" grep -qF 'DOTFILES_UPGRADE=all dot' "$noticeStderr"
check "upgrade notice leaves stdout unaffected" grep -qx unchanged "$noticeStdout"
ln -s "$repoRoot" "$upgradeNoticeHome/.dotfiles"
mkdir -p "$upgradeNoticeHome/.config/dotfiles"
printf 'packages\n' > "$upgradeNoticeHome/.config/dotfiles/topics"
env -i HOME="$upgradeNoticeHome" PATH="/usr/bin:/bin" TERM=dumb \
  "$BASH" --noprofile --rcfile "$repoRoot/shell/bashrc" -i -c 'printf "unchanged\n"' > "$noticeStdout" 2> "$noticeStderr"
check "interactive topic loading prints one upgrade notice" test "$(grep -c '^dotfiles: upgrades' "$noticeStderr")" -eq 1
check "interactive upgrade notice leaves stdout unaffected" grep -qx unchanged "$noticeStdout"
rm -f "$upgradeNoticeState"/upgrades-held-*
printf 'formula git 2.1.0 2.2.0\n' > "$upgradeNoticeState/upgrades-failed-packages-pending"
runUpgradeNotice
check "failed upgrades print a stderr notice" test -s "$noticeStderr"
rm -f "$upgradeNoticeState/upgrades-failed-packages-pending"
runUpgradeNotice
check "a clean shell has no upgrade notice" test ! -s "$noticeStderr"
check "a clean shell stdout is unaffected" grep -qx unchanged "$noticeStdout"

printf '\nshell topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "replacing a real bashrc with no localrc fails the topic" test "$installStatus" -eq 1
check "the warning names the backups holding the machine env" \
  bash -c 'printf "%s\n" "$1" | grep -q ".pre-dotfiles.bak backups"' _ "$firstRunOutput"
check "the warning points at the tracked example" \
  bash -c 'printf "%s\n" "$1" | grep -q "shell/localrc.example"' _ "$firstRunOutput"
check "the example the warning names is tracked" test -f "$topicDir/localrc.example"
check ".bashrc is a real stub" bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$sandbox/.bashrc"
check ".bashrc sources the repo rc through the alias" grep -qF 'source "$HOME/.dotfiles/shell/bashrc"' "$sandbox/.bashrc"
check ".bash_profile sources the repo profile through the alias" \
  grep -qF 'source "$HOME/.dotfiles/shell/bash_profile"' "$sandbox/.bash_profile"
check "the displaced bashrc was backed up" grep -q 'distro default bashrc' "$sandbox/.bashrc.pre-dotfiles.bak"
check "the backup is not world readable" test "$(fileModeOf "$sandbox/.bashrc.pre-dotfiles.bak")" = "600"
personalTopicList="$(node -e 'const topics = require(process.argv[1]).topics; process.stdout.write(topics.join("\n"))' \
  "$repoRoot/profiles/personal/profile.json")"
check "the topic list was rendered from the profile" \
  test "$(cat "$sandbox/.config/dotfiles/topics")" = "$personalTopicList"

rerunStatus=0
runInstall > /dev/null || rerunStatus=$?
check "a rerun over the link exits clean" test "$rerunStatus" -eq 0

pathStartsWithDotfilesBin() {
  [[ "$(interactiveShell 'printf %s "$PATH"')" == "$sandbox/.dotfiles/bin:"* ]]
}
check "bin is on PATH" pathStartsWithDotfilesBin
check "dot resolves on PATH" test "$(interactiveShell 'command -v dot')" = "$sandbox/.dotfiles/bin/dot"
check "a second load leaves one copy of bin on PATH" \
  test "$(interactiveShell 'source "$HOME/.bashrc"; printf %s "$PATH"' | grep -o -F "$sandbox/.dotfiles/bin" | wc -l)" -eq 1
check "PROJECTS defaults under HOME" test "$(interactiveShell 'printf %s "$PROJECTS"')" = "$sandbox/Projects"
check "c is a function" test "$(interactiveShell 'type -t c')" = "function"
check "a nested login shell still loads the topics" \
  test "$(interactiveShell 'bash -ilc "type -t c"')" = "function"

mkdir -p "$sandbox/Projects/alpha-repo" "$sandbox/Projects/beta-repo"
check "c jumps into a project" test "$(interactiveShell 'c alpha-repo && pwd')" = "$sandbox/Projects/alpha-repo"
completions="$(interactiveShell 'COMP_WORDS=(c al); COMP_CWORD=1; _completeProjectNames; printf "%s\n" "${COMPREPLY[@]}"')"
check "c completes project names" test "$completions" = "alpha-repo"

mkdir -p "$sandbox/Projects.[literal]#/alpha repo"
literalPathCompletions="$(interactiveShell 'PROJECTS="$HOME/Projects.[literal]#"; COMP_WORDS=(c al); COMP_CWORD=1; _completeProjectNames; printf "%s\n" "${COMPREPLY[@]}"')"
check "c completes names under a project root containing pattern characters" \
  test "$literalPathCompletions" = "alpha repo"

printf 'loginProfileMarker=seen\n' > "$sandbox/.profile"
loginShellOutput="$(env -i HOME="$sandbox" PATH="/usr/bin:/bin" TERM=dumb \
  bash -ilc 'printf "%s %s" "$loginProfileMarker" "$DOTFILES"' 2>/dev/null)"
check "a login shell reads .profile and then the loader" \
  test "$loginShellOutput" = "seen $sandbox/.dotfiles"

printf 'export PROJECTS="$HOME/elsewhere"\n' > "$sandbox/.localrc"
check "localrc runs before the topics" test "$(interactiveShell 'printf %s "$PROJECTS"')" = "$sandbox/elsewhere"

checkRerunIsQuiet "second run reports no changes" "$(runInstall)"

printf 'export NVM_DIR="$HOME/.nvm"\n' >> "$sandbox/.bashrc"
checkRerunIsQuiet "an installer append leaves the stub recognised as ours" "$(runInstall)"
check "the append survives a rerun" grep -q 'NVM_DIR' "$sandbox/.bashrc"
check "the append never reached the repo" bash -c '! grep -q NVM_DIR "$1"' _ "$topicDir/bashrc"

orderHome="$sandbox/order-home"
orderRepo="$sandbox/order-repo"
mkdir -p "$orderHome" "$orderRepo/shell" "$orderRepo/aaa" "$orderRepo/zzz" "$orderRepo/noise"
touch "$orderHome/.hushlogin"
ln -s "$orderRepo" "$orderHome/.dotfiles"
cp "$topicDir/bashrc" "$orderRepo/shell/bashrc"
ln -s "$orderRepo/shell/bashrc" "$orderHome/.bashrc"
printf 'loadOrder+=(aaa-completion)\n' > "$orderRepo/aaa/completion.bash"
printf 'loadOrder+=(aaa-plain)\n' > "$orderRepo/aaa/plain.bash"
printf 'loadOrder+=(zzz-path)\nprependToPathOnce "$HOME/zzz-bin"\n' > "$orderRepo/zzz/path.bash"
printf 'loadOrder+=(zzz-plain)\n' > "$orderRepo/zzz/plain.bash"
printf 'loadOrder+=(noise-plain)\n' > "$orderRepo/noise/plain.bash"
printf 'loadOrder+=(localrc)\n' > "$orderHome/.localrc"
printf 'loadOrder+=(install-sh-must-not-load)\n' > "$orderRepo/aaa/install.sh"
printf 'loadOrder+=(install-sh-must-not-load)\n' > "$orderRepo/zzz/install.sh"
printf 'loadOrder+=(shell-plain)\n' > "$orderRepo/shell/plain.bash"

fallbackOrder="$(interactiveShellIn "$orderHome" 'printf "%s " "${loadOrder[@]}"')"
check "without a rendered list only the shell topic loads" \
  test "$fallbackOrder" = "localrc shell-plain "

mkdir -p "$orderHome/.config/dotfiles"
printf 'zzz\naaa\n' > "$orderHome/.config/dotfiles/topics"
observedOrder="$(interactiveShellIn "$orderHome" 'printf "%s " "${loadOrder[@]}"')"
check "localrc, then path, then plain, then completion" \
  test "$observedOrder" = "localrc zzz-path zzz-plain aaa-plain aaa-completion "
check "a topic absent from the rendered list is never sourced" \
  bash -c '[[ "$1" != *noise-plain* && "$1" != *shell-plain* ]]' _ "$observedOrder"
zzzBinIsOnPath() {
  [[ ":$(interactiveShellIn "$orderHome" 'printf %s "$PATH"'):" == *":$orderHome/zzz-bin:"* ]]
}
check "another topic's path.bash can use the path helper" zzzBinIsOnPath

printf 'aaa\n' > "$orderHome/.config/dotfiles/topics"
gatedOrder="$(interactiveShellIn "$orderHome" 'printf "%s " "${loadOrder[@]}"')"
check "a rendered topic list gates the loader on the profile" \
  test "$gatedOrder" = "localrc aaa-plain aaa-completion "

startSandboxHome "shell-profile-only"
printf 'export MACHINE_ONLY_EXPORT=1\n' > "$sandbox/.bash_profile"
profileOnlyStatus=0
profileOnlyOutput="$(runInstall)" || profileOnlyStatus=$?
check "a real bash_profile alone fails the topic" test "$profileOnlyStatus" -eq 1
check "a bash_profile only machine is told where its env went" \
  bash -c 'printf "%s\n" "$1" | grep -q ".pre-dotfiles.bak backups"' _ "$profileOnlyOutput"
check "the displaced bash_profile was backed up" \
  grep -q 'MACHINE_ONLY_EXPORT' "$sandbox/.bash_profile.pre-dotfiles.bak"

startSandboxHome "shell-localrc-present"
touch "$sandbox/.hushlogin"
printf 'export MACHINE_ONLY_EXPORT=1\n' > "$sandbox/.bash_profile"
printf 'export PROJECTS="$HOME/elsewhere"\n' > "$sandbox/.localrc"
localrcPresentStatus=0
localrcPresentOutput="$(runInstall)" || localrcPresentStatus=$?
check "a displaced login file fails the topic even when ~/.localrc exists" \
  test "$localrcPresentStatus" -eq 1
check "the warning names the backup holding the displaced env" \
  bash -c 'printf "%s\n" "$1" | grep -q ".bash_profile.pre-dotfiles.bak"' _ "$localrcPresentOutput"
check "the warning points at ~/.localrc" \
  bash -c 'printf "%s\n" "$1" | grep -q "into ~/.localrc"' _ "$localrcPresentOutput"

startSandboxHome "shell-bash-login"
touch "$sandbox/.hushlogin"
runInstall > /dev/null || true
printf 'export BASH_LOGIN_MARKER=seen\n' > "$sandbox/.bash_login"
printf 'export PROFILE_MARKER=seen\n' > "$sandbox/.profile"
bashLoginMarkers="$(env -i HOME="$sandbox" PATH="/usr/bin:/bin" TERM=dumb \
  bash -ilc 'printf "%s %s" "${BASH_LOGIN_MARKER:-none}" "${PROFILE_MARKER:-none}"' 2>/dev/null)"
check "a login shell reads the .bash_login the stub displaced, not .profile" \
  test "$bashLoginMarkers" = "seen none"

startSandboxHome "shell-unsafe-topic"
fixtureRepo="$sandbox/fixture-repo"
mkdir -p "$fixtureRepo/profiles/fixture" "$fixtureRepo/aaa"
cp -r "$repoRoot/script" "$fixtureRepo/script"
cp -r "$topicDir" "$fixtureRepo/shell"
touch "$fixtureRepo/aaa/install.sh"
printf '{ "topics": ["shell", "../evil", "ghost", "aaa"] }\n' > "$fixtureRepo/profiles/fixture/profile.json"
rm -f "$sandbox/.dotfiles"
ln -s "$fixtureRepo" "$sandbox/.dotfiles"
unsafeTopicOutput="$(env HOME="$sandbox" DOTFILES_PROFILE=fixture NO_COLOR=1 \
  bash "$fixtureRepo/shell/install.sh")" || true
check "an unusable topic name never reaches the rendered list" \
  test "$(cat "$sandbox/.config/dotfiles/topics")" = "$(printf 'shell\naaa')"
check "the dropped topic name is reported" \
  bash -c 'printf "%s\n" "$1" | grep -q "dropped \"../evil\""' _ "$unsafeTopicOutput"
check "a topic the repo does not have is dropped too" \
  bash -c 'printf "%s\n" "$1" | grep -q "dropped \"ghost\""' _ "$unsafeTopicOutput"

startSandboxHome "shell-topics-symlink"
mkdir -p "$sandbox/.config/dotfiles"
printf 'unrelated content\n' > "$sandbox/unrelated.txt"
ln -s "$sandbox/unrelated.txt" "$sandbox/.config/dotfiles/topics"
runInstall > /dev/null || true
check "a symlinked topics file is not written through" grep -qx 'unrelated content' "$sandbox/unrelated.txt"
check "the symlinked topics file was replaced by a plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$sandbox/.config/dotfiles/topics"

startSandboxHome "shell-darwin"
darwinHomebrewPrefix="$sandbox/homebrew"
darwinPythonToolsBinDirectory="$sandbox/.local/share/dotfiles/python-tools/bin"
darwinApplicationsDirectory="$sandbox/Applications"
darwinShellsFile="$sandbox/etc-shells"
darwinStubBin="$sandbox/darwin-stub-bin"
darwinCommandLog="$sandbox/darwin-commands.log"
mkdir -p "$darwinHomebrewPrefix/bin" "$darwinHomebrewPrefix/sbin" \
  "$darwinHomebrewPrefix/etc/profile.d" \
  "$darwinApplicationsDirectory/VSCodium.app/Contents/Resources/app/bin" \
  "$darwinPythonToolsBinDirectory" "$darwinStubBin"
touch "$darwinPythonToolsBinDirectory/python3" "$darwinPythonToolsBinDirectory/ruff"
chmod +x "$darwinPythonToolsBinDirectory/python3" "$darwinPythonToolsBinDirectory/ruff"
: > "$darwinShellsFile"
: > "$darwinCommandLog"
printf 'darwinCompletionLoaded=1\n' > "$darwinHomebrewPrefix/etc/profile.d/bash_completion.sh"
cat > "$darwinStubBin/sudo" <<'SUDO'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-n" ]]; then
  shift
fi
exec "$@"
SUDO
cat > "$darwinStubBin/chsh" <<'CHSH'
#!/usr/bin/env bash
printf 'chsh %s\n' "$*" >> "$DOTFILES_TEST_LOG"
CHSH
chmod +x "$darwinStubBin/sudo" "$darwinStubBin/chsh"
writeDarwinDirectoryServiceStub "$darwinStubBin"

runDarwinInstall() {
  env HOME="$sandbox" PATH="$darwinStubBin:/usr/bin:/bin" SHELL="${1:-/bin/zsh}" \
    DOTFILES_PROFILE=personal DOTFILES_PLATFORM=darwin \
    DOTFILES_TEST_STUB_BIN="$darwinStubBin" \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
    DOTFILES_TEST_SHELLS_FILE="$darwinShellsFile" DOTFILES_TEST_LOG="$darwinCommandLog" \
    NO_COLOR=1 bash "$topicDir/install.sh"
}

runDarwinInstallInPty() {
  env HOME="$sandbox" PATH="$darwinStubBin:/usr/bin:/bin" SHELL="${1:-/bin/bash}" \
    DOTFILES_PROFILE=personal DOTFILES_PLATFORM=darwin \
    DOTFILES_TEST_STUB_BIN="$darwinStubBin" \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
    DOTFILES_TEST_SHELLS_FILE="$darwinShellsFile" DOTFILES_TEST_LOG="$darwinCommandLog" \
    NO_COLOR=1 script -qec "bash $(printf '%q' "$topicDir/install.sh") < /dev/null" /dev/null < /dev/null
}

darwinInstallStatus=0
darwinInstallOutput="$(runDarwinInstall)" || darwinInstallStatus=$?
check "the darwin shell install exits clean when sudo and chsh succeed" test "$darwinInstallStatus" -eq 0
check "darwin registers Homebrew bash in the accepted shell list" \
  grep -qxF "$darwinHomebrewPrefix/bin/bash" "$darwinShellsFile"
check "darwin appends to the shell list through an unattended sudo" \
  grep -qx "sudo -n /usr/bin/tee -a $darwinShellsFile" "$darwinCommandLog"
check "darwin requests Homebrew bash as the login shell" \
  grep -qx "chsh -s $darwinHomebrewPrefix/bin/bash" "$darwinCommandLog"
check "the login shell change is reported" outputHas "$darwinInstallOutput" 'changed to'

setStubbedDarwinLoginShell "$darwinStubBin" /bin/zsh
grep -vxF "$darwinHomebrewPrefix/bin/bash" "$darwinShellsFile" > "$darwinShellsFile.next" || true
mv "$darwinShellsFile.next" "$darwinShellsFile"
cat > "$darwinStubBin/sudo" <<'SUDO'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-n" ]]; then
  exit 1
fi
exec "$@"
SUDO
chmod +x "$darwinStubBin/sudo"

utilLinuxScriptIsUsable=yes
script -qec true /dev/null < /dev/null >/dev/null 2>&1 || utilLinuxScriptIsUsable=no

if [[ "$utilLinuxScriptIsUsable" == no ]]; then
  printf '  skipped interactive sudo fallback: script does not take the util-linux -qec flags\n'
fi
if [[ "$utilLinuxScriptIsUsable" == yes ]]; then
  : > "$darwinCommandLog"
  darwinInteractiveRetryStatus=0
  darwinInteractiveRetryOutput="$(runDarwinInstallInPty)" || darwinInteractiveRetryStatus=$?
  check "interactive darwin retries the shell-list append after unattended sudo fails" \
    test "$darwinInteractiveRetryStatus" -eq 0
  check "interactive darwin appends through plain sudo after unattended sudo fails" \
    grep -qx "sudo /usr/bin/tee -a $darwinShellsFile" "$darwinCommandLog"
  check "interactive darwin reports the login shell change after the retry" \
    outputHas "$darwinInteractiveRetryOutput" 'changed to'
fi

setStubbedDarwinLoginShell "$darwinStubBin" /bin/zsh
grep -vxF "$darwinHomebrewPrefix/bin/bash" "$darwinShellsFile" > "$darwinShellsFile.next" || true
mv "$darwinShellsFile.next" "$darwinShellsFile"
: > "$darwinCommandLog"
darwinNoninteractiveRetryStatus=0
darwinNoninteractiveRetryOutput="$(runDarwinInstall < /dev/null 2>&1)" || darwinNoninteractiveRetryStatus=$?
check "non-interactive darwin warns when unattended sudo cannot append the shell list" \
  test "$darwinNoninteractiveRetryStatus" -eq 1
check "non-interactive darwin never retries the shell-list append with plain sudo" \
  bash -c '! grep -qx "sudo /usr/bin/tee -a $2" "$1"' _ "$darwinCommandLog" "$darwinShellsFile"
check "non-interactive darwin reports the accepted-shell warning" \
  outputHas "$darwinNoninteractiveRetryOutput" 'could not add'

cat > "$darwinStubBin/sudo" <<'SUDO'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-n" ]]; then
  shift
fi
exec "$@"
SUDO
chmod +x "$darwinStubBin/sudo"
printf '%s\n' "$darwinHomebrewPrefix/bin/bash" >> "$darwinShellsFile"

darwinInteractiveShell() {
  env -i HOME="$sandbox" PATH="/usr/bin:/bin" TERM=dumb DOTFILES_PLATFORM=darwin \
    DOTFILES_TEST_STUB_BIN="$darwinStubBin" \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
    bash -i -c "$1" 2>/dev/null
}

darwinPath="$(darwinInteractiveShell 'printf %s "$PATH"')"
check "darwin puts its Python tools environment first on PATH" \
  bash -c '[[ "$1" == "$2:"* ]]' _ "$darwinPath" "$darwinPythonToolsBinDirectory"
check "darwin resolves python3 from its Python tools environment" \
  test "$(darwinInteractiveShell 'command -v python3')" = "$darwinPythonToolsBinDirectory/python3"
check "darwin resolves ruff from its Python tools environment" \
  test "$(darwinInteractiveShell 'command -v ruff')" = "$darwinPythonToolsBinDirectory/ruff"
check "darwin keeps Homebrew bin on PATH" \
  bash -c '[[ ":$1:" == *":$2/bin:"* ]]' _ "$darwinPath" "$darwinHomebrewPrefix"
check "darwin puts Homebrew sbin on PATH" \
  bash -c '[[ ":$1:" == *":$2/sbin:"* ]]' _ "$darwinPath" "$darwinHomebrewPrefix"
check "darwin puts the VSCodium CLI directory on PATH" \
  bash -c '[[ ":$1:" == *":$2/VSCodium.app/Contents/Resources/app/bin:"* ]]' \
    _ "$darwinPath" "$darwinApplicationsDirectory"
check "darwin loads Homebrew bash completion" \
  test "$(darwinInteractiveShell 'printf %s "${darwinCompletionLoaded:-0}"')" = "1"

: > "$darwinCommandLog"
setStubbedDarwinLoginShell "$darwinStubBin" "$darwinHomebrewPrefix/bin/bash"
darwinSecondOutput="$(runDarwinInstall)"
check "a settled darwin shell rerun reports no changes" reportsNoChanges "$darwinSecondOutput"
check "a settled darwin shell rerun does not use sudo" \
  bash -c '! grep -q "^sudo " "$1"' _ "$darwinCommandLog"
check "the login shell directory services report ends the rerun, whatever launched it" \
  bash -c '! grep -q "^chsh " "$1"' _ "$darwinCommandLog"
check "a settled darwin shell rerun names the login shell it found" \
  outputHas "$darwinSecondOutput" "$darwinHomebrewPrefix/bin/bash"

setStubbedDarwinLoginShell "$darwinStubBin" /bin/zsh
grep -vxF "$darwinHomebrewPrefix/bin/bash" "$darwinShellsFile" > "$darwinShellsFile.next" || true
mv "$darwinShellsFile.next" "$darwinShellsFile"
cat > "$darwinStubBin/sudo" <<'SUDO'
#!/usr/bin/env bash
exit 1
SUDO
cat > "$darwinStubBin/chsh" <<'CHSH'
#!/usr/bin/env bash
exit 1
CHSH
chmod +x "$darwinStubBin/sudo" "$darwinStubBin/chsh"
darwinRefusalStatus=0
darwinRefusalOutput="$(runDarwinInstall)" || darwinRefusalStatus=$?
check "darwin shell policy failures fail the topic after installing stubs" test "$darwinRefusalStatus" -eq 1
check "a refused accepted-shell update is reported" outputHas "$darwinRefusalOutput" 'could not add'
check "a refused login-shell change is reported" outputHas "$darwinRefusalOutput" 'chsh refused'
check "darwin policy failures leave the bashrc stub installed" test -f "$sandbox/.bashrc"

cat > "$darwinStubBin/sudo" <<'SUDO'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-n" ]]; then
  shift
fi
exec "$@"
SUDO
cat > "$darwinStubBin/chsh" <<'CHSH'
#!/usr/bin/env bash
printf 'chsh %s\n' "$*" >> "$DOTFILES_TEST_LOG"
CHSH
chmod +x "$darwinStubBin/sudo" "$darwinStubBin/chsh"
printf '/bin/sh' > "$darwinShellsFile"
: > "$darwinCommandLog"
runDarwinInstall > /dev/null || true
check "an unterminated shells file keeps its last line whole" \
  grep -qxF '/bin/sh' "$darwinShellsFile"
check "the registered login shell stands on a line of its own" \
  grep -qxF "$darwinHomebrewPrefix/bin/bash" "$darwinShellsFile"
check "an unterminated shells file gains one line, not a fused one" \
  test "$(wc -l < "$darwinShellsFile")" -eq 2

reportTopicResults "shell"
