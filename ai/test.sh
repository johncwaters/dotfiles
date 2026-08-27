#!/usr/bin/env bash
# Runs ai/install.sh against a sandbox HOME and asserts the link engine's contract:
# every destination is a link through the alias, runtime state survives, reruns are quiet.

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startSandboxHome "ai"

mkdir -p "$sandbox/.claude/projects/live-work" "$sandbox/.claude/sessions"
printf 'runtime\n' > "$sandbox/.claude/projects/live-work/state.json"
printf '{"token":"keep-me"}\n' > "$sandbox/.claude/.credentials.json"
printf 'pre-existing user notes\n' > "$sandbox/.claude/AGENTS.md"

runInstall() {
  env HOME="$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

changeMarkerPattern='\[ (ok|\+\+) \]'

printf '\nai topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"

linkedDestinations=(
  ".claude/AGENTS.md" ".claude/ROUTING.md" ".claude/tsconfig.json" ".claude/types"
  ".claude/agents" ".claude/commands" ".claude/hooks" ".claude/hud" ".claude/skills"
  ".claude/CLAUDE.md" ".codex/AGENTS.md"
)

for destination in "${linkedDestinations[@]}"; do
  fullPath="$sandbox/$destination"
  if [[ ! -L "$fullPath" ]]; then
    fail "$destination is a symlink"
    continue
  fi
  linkTarget="$(readlink -- "$fullPath")"
  case "$linkTarget" in
    "$sandbox/.dotfiles"/*) ;;
    *)
      fail "$destination points through ~/.dotfiles (got $linkTarget)"
      continue
      ;;
  esac
  if [[ ! -e "$fullPath" ]]; then
    fail "$destination resolves to something that exists"
    continue
  fi
  pass "$destination linked through the alias"
done

check "runtime project state survives" test -f "$sandbox/.claude/projects/live-work/state.json"
check "credentials survive" test -f "$sandbox/.claude/.credentials.json"
check "sessions dir survives" test -d "$sandbox/.claude/sessions"
check "displaced file was backed up" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"
check "backup keeps the old content" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

settingsPath="$sandbox/.claude/settings.json"
check "settings.json rendered" test -f "$settingsPath"
check "settings.json is valid JSON" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$settingsPath"
check "settings.json has no unrendered token" bash -c '! grep -q "{{HOME}}" "$1"' _ "$settingsPath"
check "settings.json points the commit policy at the alias" \
  grep -q "\"CLAUDE_COMMIT_POLICY_ROOT\": \"$sandbox/.dotfiles\"" "$settingsPath"
check "settings.json is not world readable" bash -c '[[ "$(stat -c %a "$1")" == "600" ]]' _ "$settingsPath"

countSettingsCommand() {
  grep -c -- "$1" "$settingsPath"
}
check "the base SessionStart hook reaches the profile" test "$(countSettingsCommand inject-routing.mjs)" -eq 1
check "the profile SessionStart hook is added, not replaced" test "$(countSettingsCommand caveman-ultra.mjs)" -eq 1
check "the retired sync hook is gone" test "$(countSettingsCommand sync-agents-md.mjs)" -eq 0

rm -f "$sandbox/.claude/AGENTS.md"
printf 'later hand written notes\n' > "$sandbox/.claude/AGENTS.md"
runInstall > /dev/null
check "a later displaced file gets its own backup" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the later backup holds the later content" grep -q 'later hand written notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the first backup is untouched" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

secondRunOutput="$(runInstall)"
if printf '%s\n' "$secondRunOutput" | grep -qE "$changeMarkerPattern"; then
  fail "second run reports no changes"
  printf '%s\n' "$secondRunOutput" | grep -E "$changeMarkerPattern"
fi
if ! printf '%s\n' "$secondRunOutput" | grep -qE "$changeMarkerPattern"; then
  pass "second run reports no changes"
fi

warnedRunStatus=0
env -u DOTFILES_PROFILE HOME="$sandbox" NO_COLOR=1 bash "$topicDir/install.sh" > /dev/null \
  || warnedRunStatus=$?
check "a topic that emits a warning exits non-zero" test "$warnedRunStatus" -eq 1

settingsBackupHolds() {
  grep -qs -- "$1" "$settingsPath".pre-dotfiles.bak*
}

printf '{"handEdit":"first-edit-to-settings"}\n' > "$settingsPath"
runInstall > /dev/null
printf '{"handEdit":"second-edit-to-settings"}\n' > "$settingsPath"
runInstall > /dev/null
check "the first hand edited settings.json is still recoverable" \
  settingsBackupHolds 'first-edit-to-settings'
check "the second hand edited settings.json is still recoverable" \
  settingsBackupHolds 'second-edit-to-settings'

# shellcheck source=../script/lib/context.sh
source "$repoRoot/script/lib/context.sh"

renderSandbox="$sandbox/render-engine"
mkdir -p "$renderSandbox"
renderBase="$renderSandbox/base.json"
renderOverlay="$renderSandbox/overlay.json"
renderDestination="$renderSandbox/settings.json"
printf '{"model":"first"}\n' > "$renderBase"
printf '{}\n' > "$renderOverlay"

renderIntoSandbox() {
  renderJsonTemplate "render probe" "$repoRoot/ai/render-settings.mjs" \
    "$renderBase" "$renderOverlay" "$renderDestination" > /dev/null
}

countRenderBackups() {
  find "$renderSandbox" -maxdepth 1 -name 'settings.json.pre-dotfiles.bak*' | wc -l
}

renderIntoSandbox
check "the first render leaves no backup" test "$(countRenderBackups)" -eq 0

printf '{"model":"second"}\n' > "$renderBase"
renderIntoSandbox
check "a repo side render change reaches the destination" grep -q 'second' "$renderDestination"
check "a repo side render change leaves no backup" test "$(countRenderBackups)" -eq 0

printf '{"model":"hand written"}\n' > "$renderDestination"
renderIntoSandbox
check "a hand edited destination is backed up" test "$(countRenderBackups)" -eq 1
check "the backup holds the hand edit" \
  grep -qs 'hand written' "$renderDestination".pre-dotfiles.bak

sidecarPath="$renderDestination.pre-dotfiles.rendered"
sidecarIsPlainFile() {
  [[ -f "$sidecarPath" && ! -L "$sidecarPath" ]]
}

decoyCredentialsPath="$renderSandbox/credentials.json"
printf '{"token":"keep-me"}\n' > "$decoyCredentialsPath"
rm -f "$sidecarPath"
ln -s "$decoyCredentialsPath" "$sidecarPath"
printf '{"model":"edited under a symlinked sidecar"}\n' > "$renderDestination"
backupsBeforeSymlinkedSidecar="$(countRenderBackups)"
symlinkedSidecarStatus=0
renderIntoSandbox || symlinkedSidecarStatus=$?
check "a symlinked sidecar does not fail the render" test "$symlinkedSidecarStatus" -eq 0
check "a symlinked sidecar is not written through" \
  grep -qx '{"token":"keep-me"}' "$decoyCredentialsPath"
check "a symlinked sidecar earns a backup instead of skipping one" \
  test "$(countRenderBackups)" -eq "$((backupsBeforeSymlinkedSidecar + 1))"
check "the backup holds the edit made under the symlinked sidecar" \
  grep -qs 'edited under a symlinked sidecar' "$renderDestination".pre-dotfiles.bak.*
check "the symlinked sidecar was replaced by a plain file" sidecarIsPlainFile

mirroredSidecarPath="$renderSandbox/mirrored-sidecar.json"
printf '{"model":"edited under a mirrored sidecar"}\n' > "$renderDestination"
cp "$renderDestination" "$mirroredSidecarPath"
rm -f "$sidecarPath"
ln -s "$mirroredSidecarPath" "$sidecarPath"
backupsBeforeMirroredSidecar="$(countRenderBackups)"
renderIntoSandbox
check "a sidecar symlinked at a copy of the destination still earns a backup" \
  test "$(countRenderBackups)" -eq "$((backupsBeforeMirroredSidecar + 1))"
check "the mirrored sidecar target keeps its own content" \
  grep -q 'edited under a mirrored sidecar' "$mirroredSidecarPath"

rm -f "$sidecarPath"
mkdir -p "$sidecarPath"
directorySidecarStatus=0
renderIntoSandbox || directorySidecarStatus=$?
check "a directory at the sidecar path does not fail the render" \
  test "$directorySidecarStatus" -eq 0
check "the directory sidecar was replaced by a plain file" sidecarIsPlainFile
rerunAfterDirectorySidecarStatus=0
renderIntoSandbox || rerunAfterDirectorySidecarStatus=$?
check "a directory at the sidecar path does not wedge later runs" \
  test "$rerunAfterDirectorySidecarStatus" -eq 0
check "the destination still holds what the renderer produced" grep -q 'second' "$renderDestination"

reportTopicResults "ai"
