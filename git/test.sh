#!/usr/bin/env bash
# Runs git/install.sh against a sandbox HOME and asserts that a machine's existing
# identity moves into ~/.gitconfig.local and keeps working through the linked config.

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startGitSandbox() {
  startSandboxHome "$1"
  export XDG_CONFIG_HOME="$sandbox/.config"
}

startGitSandbox "git"
cat > "$sandbox/.gitconfig" <<'PREVIOUS'
[user]
	name = Sandbox Author
	email = sandbox@example.com
[include]
	path = ~/.gitconfig.local
PREVIOUS
chmod 644 "$sandbox/.gitconfig"

runInstall() {
  runTopicInstall "$topicDir"
}

gitConfigValue() {
  env HOME="$sandbox" git -C "$sandbox" config --get "$1"
}

modeOf() {
  fileModeOf "$1"
}

printf '\ngit topic\n'

installStatus=0
runInstall > /dev/null || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check ".gitconfig is a real file" bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$sandbox/.gitconfig"
check ".gitconfig includes the repo config through the alias" grep -qF 'path = ~/.dotfiles/git/gitconfig' "$sandbox/.gitconfig"
check ".gitconfig.local was seeded from the previous config" grep -q 'Sandbox Author' "$sandbox/.gitconfig.local"
check ".gitconfig.local is not world readable" test "$(modeOf "$sandbox/.gitconfig.local")" = "600"
check "the seed dropped the include of itself" \
  bash -c '! grep -q "gitconfig.local" "$1"' _ "$sandbox/.gitconfig.local"
check "the previous config was backed up" test -f "$sandbox/.gitconfig.pre-dotfiles.bak"
check "the backup is not world readable" test "$(modeOf "$sandbox/.gitconfig.pre-dotfiles.bak")" = "600"
check "git still sees the identity" test "$(gitConfigValue user.name)" = "Sandbox Author"
check "git sees the shared defaults" test "$(gitConfigValue pull.rebase)" = "true"

checkRerunIsQuiet "second run reports no changes" "$(runInstall)"

printf '[user]\n\tname = Hand Edited\n' > "$sandbox/.gitconfig.local"
runInstall > /dev/null
check "a hand written local config is never overwritten" test "$(gitConfigValue user.name)" = "Hand Edited"

env HOME="$sandbox" git config --global user.name "Written By Git"
check "git's own global write lands in the stub, not the repo" \
  bash -c '! grep -q "Written By Git" "$1"' _ "$repoRoot/git/gitconfig"
check "git's own global write is what git reads back" test "$(gitConfigValue user.name)" = "Written By Git"
checkRerunIsQuiet "an appended stub is still recognised as ours" "$(runInstall)"

rm -f "$sandbox/.gitconfig.local"
reseedStatus=0
runInstall > /dev/null || reseedStatus=$?
check "the stub this repo wrote is never seeded from" bash -c '! test -e "$1"' _ "$sandbox/.gitconfig.local"
check "the missing local config still warns" test "$reseedStatus" -eq 1

check "the example holds every key the seed would" bash -c 'grep -q "^\[user\]" "$1" && grep -q "gh auth git-credential" "$1"' _ "$topicDir/gitconfig.local.example"
check "the example resolves gh on PATH" bash -c '! grep -q "/usr/bin/gh" "$1"' _ "$topicDir/gitconfig.local.example"

startGitSandbox "git-symlinked"
mkdir -p "$sandbox/elsewhere"
printf '[user]\n\tname = Linked Author\n\temail = linked@example.com\n' > "$sandbox/elsewhere/gitconfig"
ln -s "$sandbox/elsewhere/gitconfig" "$sandbox/.gitconfig"
linkedStatus=0
runInstall > /dev/null || linkedStatus=$?
check "a symlinked previous config installs clean" test "$linkedStatus" -eq 0
check "a symlinked previous config is seeded from its target" grep -q 'Linked Author' "$sandbox/.gitconfig.local"
check "git reads the identity the link carried" test "$(gitConfigValue user.name)" = "Linked Author"
check "the previous link was backed up" test -L "$sandbox/.gitconfig.pre-dotfiles.bak"
check "the link target was left where it was" grep -q 'Linked Author' "$sandbox/elsewhere/gitconfig"

startGitSandbox "git-fresh"
freshStatus=0
freshOutput="$(runInstall)" || freshStatus=$?
check "a fresh machine without a local config warns" bash -c 'printf "%s\n" "$1" | grep -q "gitconfig.local.example"' _ "$freshOutput"
check "the warning fails the topic" test "$freshStatus" -eq 1
check "the fresh machine still got the stub" grep -qF 'gitconfig.local' "$sandbox/.gitconfig"

startGitSandbox "git-relative-include"
cat > "$sandbox/.gitconfig" <<'PREVIOUS'
[user]
	name = Relative Author
[pull]
	rebase = false
[include]
	path = .gitconfig.local
PREVIOUS
relativeStatus=0
runInstall > /dev/null || relativeStatus=$?
check "a relative self include installs clean" test "$relativeStatus" -eq 0
check "the seed dropped the relative include of itself" \
  bash -c '! grep -q "gitconfig.local" "$1"' _ "$sandbox/.gitconfig.local"
check "the machine's own setting outranks the shared default" \
  test "$(gitConfigValue pull.rebase)" = "false"

startGitSandbox "git-repo-include"
cat > "$sandbox/.gitconfig" <<PREVIOUS
[user]
	name = Cycle Author
[include]
	path = $repoRoot/git/gitconfig
[include]
	path = $sandbox/.dotfiles/git/gitconfig
[include]
  path = ~/.dotfiles/git/gitconfig
[include]
	path = ~/work/other/git/gitconfig
PREVIOUS
repoIncludeStatus=0
runInstall > /dev/null || repoIncludeStatus=$?
check "a previous config including the repo config installs clean" test "$repoIncludeStatus" -eq 0
check "the seed dropped the alias forms of the repo config include" \
  bash -c '! grep -q "\.dotfiles/git/gitconfig" "$1"' _ "$sandbox/.gitconfig.local"
check "the seed dropped the clone path form of the repo config include" \
  bash -c '! grep -qF "$2/git/gitconfig" "$1"' _ "$sandbox/.gitconfig.local" "$repoRoot"
check "an unrelated third party include survives the seed" \
  grep -qF 'path = ~/work/other/git/gitconfig' "$sandbox/.gitconfig.local"
check "git still reads the identity the cycle carried" test "$(gitConfigValue user.name)" = "Cycle Author"

startGitSandbox "git-xdg"
mkdir -p "$sandbox/.config/git"
printf '[user]\n\tname = Xdg Author\n[pull]\n\trebase = false\n[safe]\n\tdirectory = /srv/one\n' \
  > "$sandbox/.config/git/config"
xdgStatus=0
runInstall > /dev/null || xdgStatus=$?
check "an xdg config without a ~/.gitconfig installs clean" test "$xdgStatus" -eq 0
check "the xdg config seeded the local config" grep -q 'Xdg Author' "$sandbox/.gitconfig.local"
check "git reads the identity the xdg config carried" test "$(gitConfigValue user.name)" = "Xdg Author"
check "the xdg machine setting outranks the shared default" test "$(gitConfigValue pull.rebase)" = "false"
check "the seeded xdg config was moved aside" test -f "$sandbox/.config/git/config.pre-dotfiles.bak"
check "a multi valued key the xdg config carried is applied once" \
  test "$(env HOME="$sandbox" git -C "$sandbox" config --get-all safe.directory | wc -l)" = "1"

startGitSandbox "git-multi-valued-local"
printf '[user]\n\tname = Multi Author\n[safe]\n\tdirectory = /srv/one\n' > "$sandbox/.gitconfig.local"
runInstall > /dev/null || true
check "a multi valued local key is applied once" \
  test "$(env HOME="$sandbox" git -C "$sandbox" config --get-all safe.directory | wc -l)" = "1"

startGitSandbox "git-odd-include-syntax"
cat > "$sandbox/.gitconfig" <<PREVIOUS
[user]
	name = Odd Author
[include]
	Path = ~/.gitconfig.local ; trailing comment
	path = $sandbox/.dotfiles/git/gitconfig # another
PREVIOUS
oddStatus=0
runInstall > /dev/null || oddStatus=$?
check "uppercase and commented self includes install clean" test "$oddStatus" -eq 0
check "uppercase and commented self includes are stripped" \
  bash -c '! grep -qi "gitconfig" "$1"' _ "$sandbox/.gitconfig.local"
check "git still runs after odd include syntax" test "$(gitConfigValue user.name)" = "Odd Author"

startGitSandbox "git-local-already-present"
printf '[user]\n\tname = Local First\n' > "$sandbox/.gitconfig.local"
printf '[commit]\n\tgpgSign = true\n' > "$sandbox/.gitconfig"
presentStatus=0
presentOutput="$(runInstall)" || presentStatus=$?
check "a previous config that cannot be merged warns" \
  bash -c 'printf "%s\n" "$1" | grep -q "was not merged"' _ "$presentOutput"
check "the unmerged previous config fails the topic" test "$presentStatus" -eq 1
check "the unmerged previous config is preserved in a backup" \
  grep -q 'gpgSign' "$sandbox/.gitconfig.pre-dotfiles.bak"
check "the existing local config was left alone" test "$(gitConfigValue user.name)" = "Local First"

startGitSandbox "git-xdg-relative-include"
mkdir -p "$sandbox/.config/git"
printf '[user]\n\tname = Sibling Author\n' > "$sandbox/.config/git/identity"
printf '[include]\n\tpath = identity\n' > "$sandbox/.config/git/config"
relativeXdgStatus=0
runInstall > /dev/null || relativeXdgStatus=$?
check "an XDG config with a relative include installs clean" test "$relativeXdgStatus" -eq 0
check "the relative include was rebased onto the XDG dir" \
  grep -qF "path = $sandbox/.config/git/identity" "$sandbox/.gitconfig.local"
check "the sibling include still applies after retirement" test "$(gitConfigValue user.name)" = "Sibling Author"

reportTopicResults "git"
