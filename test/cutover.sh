#!/usr/bin/env bash
# Destructive by design: it replaces $HOME/.claude, so it only runs inside the throwaway home test/run-sandbox.sh provides.

set -euo pipefail

if [[ "${DOTFILES_SANDBOX:-}" != "1" ]]; then
  printf 'cutover.sh: refusing to run outside test/run-sandbox.sh; it replaces $HOME/.claude.\n' >&2
  exit 1
fi

repoUnderTest="${DOTFILES_REPO_UNDER_TEST:?run through test/run-sandbox.sh}"
claudeSetupRepo="${CLAUDE_SETUP_REPO:?needs a claude-setup clone to rehearse against}"
# shellcheck source=./harness.sh
source "$repoUnderTest/test/harness.sh"

stagedRepo="$HOME/Projects/dotfiles"
claudeHome="$HOME/.claude"
backupDirectory="$HOME/claude-backup"

printf '\ncutover rehearsal\n'

mkdir -p "$HOME/Projects"
cp -a "$repoUnderTest" "$stagedRepo"
rm -rf "$stagedRepo/.git" "$stagedRepo/.machine-profile"
printf 'personal\n' > "$stagedRepo/.machine-profile"
# Every topic that converges a fresh home without reaching the network, so packages and repos stay out.
printf '{ "topics": ["shell", "ai", "git", "fonts"] }\n' > "$stagedRepo/profiles/personal/profile.json"

git clone --quiet "$claudeSetupRepo" "$claudeHome"
mkdir -p "$claudeHome/projects/live-work" "$claudeHome/sessions" "$claudeHome/plugins/repos" \
  "$claudeHome/tasks" "$claudeHome/teams" "$claudeHome/file-history"
printf '{"token":"SANDBOX-CREDENTIAL"}\n' > "$claudeHome/.credentials.json"
chmod 600 "$claudeHome/.credentials.json"
printf '{"permissions":{"allow":["Bash(true:*)"]}}\n' > "$claudeHome/settings.local.json"
printf 'session transcript\n' > "$claudeHome/projects/live-work/transcript.jsonl"
printf 'installed plugin\n' > "$claudeHome/plugins/repos/marker"
printf 'history\n' > "$claudeHome/history.jsonl"
# The predecessor rendered these two and gitignored them, so a real ~/.claude carries them in as untracked files this repo takes over.
printf '{"model":"rendered-by-the-old-setup"}\n' > "$claudeHome/settings.json"
printf 'the old profile CLAUDE.md\n' > "$claudeHome/CLAUDE.md"
printf '[user]\n\tname = Sandbox Author\n\temail = sandbox@example.com\n' > "$HOME/.gitconfig"
printf 'export SANDBOX_MACHINE_ENV=1\n' > "$HOME/.localrc"

check "the rehearsal starts from a real clone" test -d "$claudeHome/.git"
check "the rehearsal starts with the tracked file present" test -e "$claudeHome/settings.base.json"
check "the rehearsal starts with the tracked directory present" test -d "$claudeHome/setup"

"$stagedRepo/script/adopt-claude-home" --yes --backup-dir "$backupDirectory" > /dev/null

adoptedSettings="$(cat "$claudeHome/settings.json" 2>/dev/null || true)"

check "the clone was detached" bash -c '! test -e "$1/.git"' _ "$claudeHome"
check "an untracked rendered file survived adoption" grep -q 'rendered-by-the-old-setup' "$claudeHome/settings.json"
check "a tracked directory was removed" bash -c '! test -e "$1/setup"' _ "$claudeHome"
check "a tracked file was removed" bash -c '! test -e "$1/settings.base.json"' _ "$claudeHome"
check "the vendored skills were removed" bash -c '! test -e "$1/skills"' _ "$claudeHome"

for survivor in projects sessions plugins tasks teams file-history .credentials.json settings.local.json history.jsonl; do
  check "runtime survived: $survivor" test -e "$claudeHome/$survivor"
done
check "a live transcript survived intact" grep -q 'session transcript' "$claudeHome/projects/live-work/transcript.jsonl"
check "the credential survived intact" grep -q 'SANDBOX-CREDENTIAL' "$claudeHome/.credentials.json"

check "the backup exists" test -d "$backupDirectory"
check "the backup holds the credential" grep -q 'SANDBOX-CREDENTIAL' "$backupDirectory/.credentials.json"
check "the backup kept the credential readable only by its owner" \
  bash -c '[[ "$(stat -c %a "$1")" == "600" ]]' _ "$backupDirectory/.credentials.json"
check "the backup holds the removed directory" test -e "$backupDirectory/setup"
check "the backup holds the removed file" test -e "$backupDirectory/settings.base.json"
check "the backup holds the clone" test -e "$backupDirectory/.git"
check "the backup root is reachable only by its owner" \
  bash -c '[[ "$(stat -c %a "$1")" == "700" ]]' _ "$backupDirectory"
check "a finished run left no lock behind" bash -c '! test -e "$1"' _ "$HOME/.adopt-claude-home.lock"

check "adopting twice is safe" "$stagedRepo/script/adopt-claude-home" --yes --backup-dir "$HOME/second-backup"
check "the second run wrote no backup" bash -c '! test -e "$1"' _ "$HOME/second-backup"

firstConvergeStatus=0
firstConverge="$("$stagedRepo/script/bootstrap" 2>&1)" || firstConvergeStatus=$?
check "the first converge succeeded" test "$firstConvergeStatus" -eq 0
if ((firstConvergeStatus != 0)); then
  printf '%s\n' "$firstConverge"
fi
check "the alias was created" test -L "$HOME/.dotfiles"
check "the alias points at the staged clone" bash -c '[[ "$(readlink "$1")" == "$2" ]]' _ "$HOME/.dotfiles" "$stagedRepo"
check "the git topic converged to a real stub" bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$HOME/.gitconfig"
check "the git identity moved from the previous config" grep -q 'Sandbox Author' "$HOME/.gitconfig.local"
check "the fonts topic converged" test -L "$HOME/.local/share/fonts/CommitMono-400-Regular.otf"

brokenLinks=0
cloneTargetedLinks=0
while IFS= read -r linkPath; do
  linkTarget="$(readlink -- "$linkPath")"
  if [[ ! -e "$linkPath" ]]; then
    brokenLinks=$((brokenLinks + 1))
    printf '    broken: %s -> %s\n' "$linkPath" "$linkTarget"
  fi
  case "$linkTarget" in
    "$HOME/.dotfiles"/*) ;;
    *)
      cloneTargetedLinks=$((cloneTargetedLinks + 1))
      printf '    not through the alias: %s -> %s\n' "$linkPath" "$linkTarget"
      ;;
  esac
done < <(find "$claudeHome" "$HOME/.codex" -maxdepth 1 -type l 2>/dev/null)

check "every link resolves" test "$brokenLinks" -eq 0
check "every link goes through the alias" test "$cloneTargetedLinks" -eq 0

settingsPath="$claudeHome/settings.json"
check "settings.json is valid JSON" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$settingsPath"
check "settings.json names no clone path" bash -c '! grep -q "Projects/dotfiles" "$1"' _ "$settingsPath"
check "settings.json names no claude-setup path" bash -c '! grep -q "claude-setup" "$1"' _ "$settingsPath"
check "the old settings.json survived adoption" test -n "${adoptedSettings:-}"
check "the displaced settings.json was preserved" \
  bash -c 'grep -rqs "rendered-by-the-old-setup" "$1".pre-dotfiles.bak*' _ "$settingsPath"
check "the displaced CLAUDE.md was preserved" \
  bash -c 'grep -rqs "the old profile CLAUDE.md" "$1".pre-dotfiles.bak*' _ "$claudeHome/CLAUDE.md"

check "the shell rc stub sources the repo rc through the alias" \
  grep -qF 'source "$HOME/.dotfiles/shell/bashrc"' "$HOME/.bashrc"
check "the git identity moved into .gitconfig.local" grep -q 'Sandbox Author' "$HOME/.gitconfig.local"
check "git reads the identity through the linked config" \
  bash -c '[[ "$(git -C "$HOME" config --get user.name)" == "Sandbox Author" ]]'
check "skills resolve through the link" test -f "$claudeHome/skills/commit/SKILL.md"
check "agents resolve through the link" test -f "$claudeHome/agents/code-reviewer.md"
check "the codex mirror resolves" test -f "$HOME/.codex/AGENTS.md"
check "AGENTS.md and its codex mirror are one file" bash -c '[[ "$(readlink -f "$1")" == "$(readlink -f "$2")" ]]' \
  _ "$claudeHome/AGENTS.md" "$HOME/.codex/AGENTS.md"

routingOutput="$(node "$claudeHome/hooks/inject-routing.mjs" </dev/null 2>/dev/null || true)"
check "the routing loader injects ROUTING.md" bash -c '[[ "$1" == *"Routing rules for this session"* ]]' _ "$routingOutput"

# The dash is built from its code point so this file does not itself carry one.
emDash="$(printf '\u2014')"
emDashVerdict="$(printf '{"tool_input":{"file_path":"%s/probe.md","content":"a sentence with an em dash %s in it"}}' "$HOME" "$emDash" \
  | node "$claudeHome/hooks/validate-file.mjs" 2>/dev/null || true)"
check "the fixture really holds an em dash" \
  bash -c '[[ "$(printf "%s" "$1" | od -An -tx1 | tr -d " \n")" == "e28094" ]]' _ "$emDash"
check "validate-file still rejects an em dash" bash -c '[[ "$1" == *deny* ]]' _ "$emDashVerdict"

cleanVerdict="$(printf '{"tool_input":{"file_path":"%s/probe.md","content":"a sentence with no dash in it"}}' "$HOME" \
  | node "$claudeHome/hooks/validate-file.mjs" 2>/dev/null || true)"
check "validate-file still allows clean text" bash -c '[[ "$1" != *deny* ]]' _ "$cleanVerdict"

secondConvergeStatus=0
secondConverge="$("$stagedRepo/script/bootstrap" 2>&1)" || secondConvergeStatus=$?
if ((secondConvergeStatus != 0)); then
  printf '%s\n' "$secondConverge"
fi
check "the second converge reports no changes" bash -c '[[ "$1" == *": 0 changed,"* ]]' _ "$secondConverge"
check "the second converge reports no warnings" bash -c '[[ "$1" == *", 0 warnings."* ]]' _ "$secondConverge"

# Everything below rebuilds ~/.claude as a synthetic claude-setup clone, because the refusals stand between a live home and an unrecoverable removal.
printf '\nrefusals\n'

fixtureIdentity=(-c user.name=cutover -c user.email=cutover@example.invalid)

resetFixtureHome() {
  rm -rf "$claudeHome"
  git -c init.defaultBranch=main init --quiet "$claudeHome"
  git -C "$claudeHome" remote add origin https://example.invalid/claude-setup.git
  mkdir -p "$claudeHome/projects/live-work"
  printf 'session transcript\n' > "$claudeHome/projects/live-work/transcript.jsonl"
  printf '{"token":"SANDBOX-CREDENTIAL"}\n' > "$claudeHome/.credentials.json"
  chmod 600 "$claudeHome/.credentials.json"
}

commitFixture() {
  git -C "$claudeHome" add -f -- "$@"
  git -C "$claudeHome" "${fixtureIdentity[@]}" commit --quiet -m 'fixture'
}

runAdoptFrom() {
  local workingDirectory="$1"
  shift
  adoptStatus=0
  adoptOutput="$(cd -- "$workingDirectory" && "$stagedRepo/script/adopt-claude-home" "$@" 2>&1)" \
    || adoptStatus=$?
}

runAdopt() {
  runAdoptFrom "$HOME" "$@"
}

resetFixtureHome
mkdir -p "$claudeHome/setup"
printf 'tracked\n' > "$claudeHome/setup/marker"
commitFixture setup

for forbiddenBackup in relative-leak "$stagedRepo/leaked-backup" "$HOME/.dotfiles/claude-backup" "$claudeHome/inside-backup"; do
  runAdoptFrom "$stagedRepo" --yes --backup-dir "$forbiddenBackup"
  check "a backup at $forbiddenBackup is refused" test "$adoptStatus" -ne 0
  check "the refusal for $forbiddenBackup says where the backup would land" outputHas "$adoptOutput" 'would land in'
done
check "a refused placement copied nothing into the repo" \
  bash -c '! test -e "$1/relative-leak" && ! test -e "$1/leaked-backup" && ! test -e "$1/claude-backup"' _ "$stagedRepo"
check "a refused placement left the credential where it was" \
  grep -q 'SANDBOX-CREDENTIAL' "$claudeHome/.credentials.json"
check "a refused placement left the clone in place" test -d "$claudeHome/.git"

symlinkTargetHome="$HOME/claude-elsewhere"
rm -rf "$symlinkTargetHome"
mv "$claudeHome" "$symlinkTargetHome"
ln -s "$symlinkTargetHome" "$claudeHome"
runAdopt --yes --backup-dir "$HOME/symlink-backup"
check "a symlinked ~/.claude is refused" test "$adoptStatus" -ne 0
check "the refusal names the symlink" outputHas "$adoptOutput" 'is a symlink'
check "the symlink target kept its clone" test -d "$symlinkTargetHome/.git"
check "the symlink target kept its tracked content" test -e "$symlinkTargetHome/setup/marker"
check "a symlinked ~/.claude wrote no backup" bash -c '! test -e "$1"' _ "$HOME/symlink-backup"
rm -f "$claudeHome"

resetFixtureHome
mkdir -p "$claudeHome/setup"
printf 'tracked\n' > "$claudeHome/setup/marker"
commitFixture setup
rm -rf "$claudeHome/setup" "$claudeHome/projects" "$claudeHome/.credentials.json"
runAdopt --yes --backup-dir "$HOME/empty-backup"
check "a backup holding nothing outside .git is refused" test "$adoptStatus" -ne 0
check "the empty backup refusal says so" outputHas "$adoptOutput" 'holds nothing outside .git'
check "the emptied clone survived the refusal" test -d "$claudeHome/.git"
check "the empty backup refusal names the backup it made" outputHas "$adoptOutput" "$HOME/empty-backup"
check "the empty backup refusal took its backup back" bash -c '! test -e "$1"' _ "$HOME/empty-backup"

resetFixtureHome
mkdir -p "$claudeHome/plugins/repos"
printf 'vendored\n' > "$claudeHome/plugins/vendored.txt"
printf 'installed plugin\n' > "$claudeHome/plugins/repos/installed"
commitFixture plugins/vendored.txt
runAdopt --yes --backup-dir "$HOME/protected-backup"
check "a clone tracking a protected runtime name is refused" test "$adoptStatus" -ne 0
check "the refusal names the protected path" outputHas "$adoptOutput" 'plugins'
check "the installed plugin survived the refusal" grep -q 'installed plugin' "$claudeHome/plugins/repos/installed"
check "a protected name wrote no backup" bash -c '! test -e "$1"' _ "$HOME/protected-backup"

resetFixtureHome
mkdir -p "$claudeHome/setup"
printf 'tracked\n' > "$claudeHome/setup/config.example"
printf 'repos.txt\n' > "$claudeHome/.gitignore"
printf 'https://example.invalid/private.git\n' > "$claudeHome/setup/repos.txt"
commitFixture setup/config.example .gitignore
runAdopt --yes --backup-dir "$HOME/untracked-backup"
check "an untracked file inside a tracked directory is refused" test "$adoptStatus" -ne 0
check "the refusal names the untracked file" outputHas "$adoptOutput" 'setup/repos.txt'
check "the untracked private file survived the refusal" grep -q 'private.git' "$claudeHome/setup/repos.txt"

shimDirectory="$HOME/shims"
mkdir -p "$shimDirectory"
cat > "$shimDirectory/cp" <<'SHIM'
#!/usr/bin/env bash
/usr/bin/cp "$@"
copyStatus=$?
rm -f -- "${!#}/setup/marker"
exit "$copyStatus"
SHIM
chmod +x "$shimDirectory/cp"

resetFixtureHome
mkdir -p "$claudeHome/setup"
printf 'tracked\n' > "$claudeHome/setup/marker"
printf 'also tracked\n' > "$claudeHome/setup/other"
commitFixture setup
adoptStatus=0
adoptOutput="$(PATH="$shimDirectory:$PATH" "$stagedRepo/script/adopt-claude-home" \
  --yes --backup-dir "$HOME/corrupt-backup" 2>&1)" || adoptStatus=$?
check "a backup missing a file that would be destroyed aborts the run" test "$adoptStatus" -ne 0
check "the abort names the entry the backup lost" outputHas "$adoptOutput" 'setup:'
check "the file the backup lost is still in ~/.claude" grep -q 'tracked' "$claudeHome/setup/marker"
check "the clone survived the aborted run" test -d "$claudeHome/.git"
check "the aborted run names the backup it made" outputHas "$adoptOutput" "$HOME/corrupt-backup"
check "the aborted run took its backup back" bash -c '! test -e "$1"' _ "$HOME/corrupt-backup"

resetFixtureHome
mkdir -p "$claudeHome/bulk"
for paddingIndex in $(seq 1 900); do
  printf 'padding %s\n' "$paddingIndex" > "$claudeHome/bulk/file-$paddingIndex"
done
head -c 16000000 /dev/zero > "$claudeHome/bulk/ballast.bin"
printf 'first line\n' > "$claudeHome/bulk/churn.log"
commitFixture bulk

liveWriterStopFile="$HOME/stop-the-live-writer"
rm -f "$liveWriterStopFile"
(
  while [[ ! -e "$liveWriterStopFile" ]]; do
    printf 'a live session wrote this\n' >> "$claudeHome/bulk/churn.log"
    sleep 0.005
  done
) &
liveWriterPid=$!
runAdopt --yes --backup-dir "$HOME/race-backup"
touch "$liveWriterStopFile"
wait "$liveWriterPid" 2>/dev/null || true
check "a write landing during the copy aborts the run" test "$adoptStatus" -ne 0
check "the abort names the directory that changed under it" outputHas "$adoptOutput" 'bulk:'
check "the raced tree is still in ~/.claude" test -e "$claudeHome/bulk/ballast.bin"
check "the clone survived the raced run" test -d "$claudeHome/.git"
check "the raced run took its backup back" bash -c '! test -e "$1"' _ "$HOME/race-backup"

resetFixtureHome
mkdir -p "$claudeHome/docs"
accentedName=$'café.md'
newlineName=$'two\nlines.md'
quotedName=$'weird "name" with a space.md'
printf 'accented\n' > "$claudeHome/docs/$accentedName"
printf 'newline\n' > "$claudeHome/docs/$newlineName"
printf 'quoted\n' > "$claudeHome/$quotedName"
commitFixture docs "$quotedName"
runAdopt --yes --backup-dir "$HOME/quoted-backup"
check "a clone with non ascii tracked paths adopts cleanly" test "$adoptStatus" -eq 0
check "the non ascii tracked path was removed" bash -c '! test -e "$1"' _ "$claudeHome/docs/$accentedName"
check "the newline named tracked path was removed" bash -c '! test -e "$1"' _ "$claudeHome/docs/$newlineName"
check "the quoted tracked path was removed" bash -c '! test -e "$1"' _ "$claudeHome/$quotedName"
check "the backup holds the non ascii path" test -e "$HOME/quoted-backup/docs/$accentedName"
check "runtime survived the awkwardly named removal" test -e "$claudeHome/projects/live-work/transcript.jsonl"

printf '\nbackup placement guards\n'

seedTrackedFixture() {
  resetFixtureHome
  mkdir -p "$claudeHome/setup"
  printf 'tracked\n' > "$claudeHome/setup/marker"
  commitFixture setup
}

seedTrackedFixture
worktreeOrigin="$HOME/worktree-origin"
prunedWorkTree="$HOME/pruned-worktree"
rm -rf "$worktreeOrigin" "$prunedWorkTree"
git -c init.defaultBranch=main init --quiet "$worktreeOrigin"
printf 'seed\n' > "$worktreeOrigin/seed.txt"
git -C "$worktreeOrigin" add seed.txt
git -C "$worktreeOrigin" "${fixtureIdentity[@]}" commit --quiet -m seed
git -C "$worktreeOrigin" "${fixtureIdentity[@]}" worktree add --quiet "$prunedWorkTree" -b side

runAdopt --yes --backup-dir "$prunedWorkTree/leaked-backup"
check "a backup inside a healthy worktree is refused" test "$adoptStatus" -ne 0
check "the healthy worktree refusal says where the backup would land" outputHas "$adoptOutput" 'would land in'

rm -rf "$worktreeOrigin/.git/worktrees"
oldSwallowedGuardAnswer="$(git -C "$prunedWorkTree" rev-parse --show-toplevel 2>/dev/null || true)"
check "the swallowed git call reads a pruned worktree as no repository at all" \
  test -z "$oldSwallowedGuardAnswer"
runAdopt --yes --backup-dir "$prunedWorkTree/leaked-backup"
check "a backup inside a worktree whose gitdir is gone is refused" test "$adoptStatus" -ne 0
check "the pruned worktree refusal says where the backup would land" outputHas "$adoptOutput" 'would land in'
check "the pruned worktree refusal wrote no backup" bash -c '! test -e "$1"' _ "$prunedWorkTree/leaked-backup"
check "the pruned worktree refusal left the clone in place" test -d "$claudeHome/.git"
check "the pruned worktree refusal left the credential where it was" \
  grep -q 'SANDBOX-CREDENTIAL' "$claudeHome/.credentials.json"

seedTrackedFixture
for syncedBackup in "$HOME/Dropbox/claude-backup" "$HOME/Nextcloud/claude-backup" \
  "$HOME/Library/Mobile Documents/claude-backup" "$HOME/Sync/claude-backup"; do
  runAdopt --yes --backup-dir "$syncedBackup"
  check "a backup at $syncedBackup is refused" test "$adoptStatus" -ne 0
  check "the refusal for $syncedBackup names the sync client" outputHas "$adoptOutput" 'sync client uploads'
  check "the refusal for $syncedBackup wrote nothing" bash -c '! test -e "$1"' _ "$syncedBackup"
done
check "a synced placement left the clone in place" test -d "$claudeHome/.git"

printf '\nbackup permissions\n'

widenCredentialShimDirectory="$HOME/shims-widen-credential"
mkdir -p "$widenCredentialShimDirectory"
cat > "$widenCredentialShimDirectory/cp" <<'SHIM'
#!/usr/bin/env bash
/usr/bin/cp "$@"
copyStatus=$?
chmod 644 -- "${!#}/.credentials.json" 2>/dev/null || true
exit "$copyStatus"
SHIM
chmod +x "$widenCredentialShimDirectory/cp"

seedTrackedFixture
adoptStatus=0
adoptOutput="$(PATH="$widenCredentialShimDirectory:$PATH" "$stagedRepo/script/adopt-claude-home" \
  --yes --backup-dir "$HOME/widened-backup" 2>&1)" || adoptStatus=$?
check "a backup whose credential lost its 600 bit is refused" test "$adoptStatus" -ne 0
check "the widened credential refusal names the mode the source had" outputHas "$adoptOutput" 'mode 600'
check "the widened credential refusal names the mode the backup got" outputHas "$adoptOutput" '644 in the backup'
check "the widened credential refusal removed nothing" test -e "$claudeHome/setup/marker"
check "the widened backup was not left behind" bash -c '! test -e "$1"' _ "$HOME/widened-backup"

droppedModeShimDirectory="$HOME/shims-dropped-modes"
mkdir -p "$droppedModeShimDirectory"
printf '#!/usr/bin/env bash\nexit 0\n' > "$droppedModeShimDirectory/chmod"
chmod +x "$droppedModeShimDirectory/chmod"

seedTrackedFixture
chmod 755 "$claudeHome"
adoptStatus=0
adoptOutput="$(PATH="$droppedModeShimDirectory:$PATH" "$stagedRepo/script/adopt-claude-home" \
  --yes --backup-dir "$HOME/wide-root-backup" 2>&1)" || adoptStatus=$?
check "a backup root that did not keep mode 700 is refused" test "$adoptStatus" -ne 0
check "the wide backup root refusal names the mode it got" outputHas "$adoptOutput" 'rather than 700'
check "the wide backup root refusal removed nothing" test -e "$claudeHome/setup/marker"
check "the wide backup root was not left behind" bash -c '! test -e "$1"' _ "$HOME/wide-root-backup"

printf '\nretained backups\n'

seedTrackedFixture
printf 'unreadable\n' > "$claudeHome/setup/sealed"
commitFixture setup/sealed
chmod 000 "$claudeHome/setup/sealed"
runAdopt --yes --backup-dir "$HOME/unreadable-backup"
chmod 644 "$claudeHome/setup/sealed"
check "a file the copy cannot read aborts the run" test "$adoptStatus" -ne 0
check "the unreadable copy names the backup it made" outputHas "$adoptOutput" "$HOME/unreadable-backup"
check "the unreadable copy took its backup back" bash -c '! test -e "$1"' _ "$HOME/unreadable-backup"
check "the unreadable copy removed nothing" test -e "$claudeHome/setup/marker"

blockedRemovalShimDirectory="$HOME/shims-blocked-removal"
mkdir -p "$blockedRemovalShimDirectory"
cat > "$blockedRemovalShimDirectory/rm" <<'SHIM'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    "$HOME"/.claude/*) exit 1 ;;
  esac
done
/usr/bin/rm "$@"
SHIM
chmod +x "$blockedRemovalShimDirectory/rm"

seedTrackedFixture
adoptStatus=0
adoptOutput="$(PATH="$blockedRemovalShimDirectory:$PATH" "$stagedRepo/script/adopt-claude-home" \
  --yes --backup-dir "$HOME/kept-backup" 2>&1)" || adoptStatus=$?
check "a removal that fails part way aborts the run" test "$adoptStatus" -ne 0
check "a refusal once removal began keeps the backup" test -d "$HOME/kept-backup"
check "the kept backup is named in the refusal" outputHas "$adoptOutput" "$HOME/kept-backup"
check "the refusal says the backup was kept" outputHas "$adoptOutput" 'was kept and holds a copy of your credentials'
check "the kept backup still holds the credential" grep -q 'SANDBOX-CREDENTIAL' "$HOME/kept-backup/.credentials.json"
rm -rf "$HOME/kept-backup"

printf '\nthe lock\n'

adoptLockDirectory="$HOME/.adopt-claude-home.lock"

seedTrackedFixture
bash -c 'exit 0' &
deadHolderPid=$!
wait "$deadHolderPid" 2>/dev/null || true
rm -rf "$adoptLockDirectory"
mkdir -p "$adoptLockDirectory"
printf '%s\n' "$deadHolderPid" > "$adoptLockDirectory/holder-pid"
runAdopt --yes --backup-dir "$HOME/reclaimed-backup"
check "a lock whose recorded pid is gone is reclaimed" test "$adoptStatus" -eq 0
check "the reclaimed lock is reported" outputHas "$adoptOutput" 'lock reclaimed'
check "the reclaiming run finished the adoption" bash -c '! test -e "$1/.git"' _ "$claudeHome"
check "the reclaiming run released the lock" bash -c '! test -e "$1"' _ "$adoptLockDirectory"

seedTrackedFixture
sleep 120 &
liveHolderPid=$!
rm -rf "$adoptLockDirectory"
mkdir -p "$adoptLockDirectory"
printf '%s\n' "$liveHolderPid" > "$adoptLockDirectory/holder-pid"
runAdopt --yes --backup-dir "$HOME/blocked-backup"
check "a lock whose recorded pid is alive is refused" test "$adoptStatus" -ne 0
check "the live lock refusal names the pid holding it" outputHas "$adoptOutput" "pid $liveHolderPid"
check "the live lock refusal does not tell the operator to delete it" \
  bash -c '[[ "$1" != *"remove that directory"* ]]' _ "$adoptOutput"
check "the live lock survived the refusal" test -e "$adoptLockDirectory/holder-pid"
check "the blocked run wrote no backup" bash -c '! test -e "$1"' _ "$HOME/blocked-backup"
check "the blocked run left the clone in place" test -d "$claudeHome/.git"
kill "$liveHolderPid" 2>/dev/null || true
wait "$liveHolderPid" 2>/dev/null || true
rm -rf "$adoptLockDirectory"

reportTopicResults "cutover"
