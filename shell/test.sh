#!/usr/bin/env bash
# Runs shell/install.sh against a sandbox HOME and asserts the loader's contract:
# ~/.localrc first, then the listed topics' path.bash, then the rest, then completion.bash.

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
  env -i HOME="$1" PATH="/usr/bin:/bin" TERM=dumb bash -i -c "$2" 2>/dev/null
}

interactiveShell() {
  interactiveShellIn "$sandbox" "$1"
}

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
check "the backup is not world readable" test "$(stat -c %a "$sandbox/.bashrc.pre-dotfiles.bak")" = "600"
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
  test "$(interactiveShell 'source "$HOME/.bashrc"; printf %s "$PATH"' | grep -o -F "$sandbox/.dotfiles/bin" | wc -l)" = "1"
check "PROJECTS defaults under HOME" test "$(interactiveShell 'printf %s "$PROJECTS"')" = "$sandbox/Projects"
check "c is a function" test "$(interactiveShell 'type -t c')" = "function"
check "a nested login shell still loads the topics" \
  test "$(interactiveShell 'bash -ilc "type -t c"')" = "function"

mkdir -p "$sandbox/Projects/alpha-repo" "$sandbox/Projects/beta-repo"
check "c jumps into a project" test "$(interactiveShell 'c alpha-repo && pwd')" = "$sandbox/Projects/alpha-repo"
completions="$(interactiveShell 'COMP_WORDS=(c al); COMP_CWORD=1; _completeProjectNames; printf "%s\n" "${COMPREPLY[@]}"')"
check "c completes project names" test "$completions" = "alpha-repo"

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

reportTopicResults "shell"
