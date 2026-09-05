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
  runTopicInstall "$topicDir"
}

printf '\nai topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"

linkedDestinations=(
  ".claude/AGENTS.md" ".claude/ROUTING.md" ".claude/tsconfig.json" ".claude/types"
  ".claude/agents" ".claude/commands" ".claude/hooks" ".claude/hud" ".claude/skills"
  ".codex/AGENTS.md"
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

# Claude Code drops every @import in a symlinked CLAUDE.md, so this one entry is a copy.
claudeMdPath="$sandbox/.claude/CLAUDE.md"
check "CLAUDE.md is a plain file, never a symlink" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$claudeMdPath"
check "CLAUDE.md matches the profile copy" \
  cmp -s "$claudeMdPath" "$repoRoot/profiles/personal/CLAUDE.md"

check "runtime project state survives" test -f "$sandbox/.claude/projects/live-work/state.json"
check "credentials survive" test -f "$sandbox/.claude/.credentials.json"
check "sessions dir survives" test -d "$sandbox/.claude/sessions"
check "displaced file was backed up" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"
check "backup keeps the old content" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

settingsPath="$sandbox/.claude/settings.json"
check "settings.json rendered" test -f "$settingsPath"
check "settings.json is valid JSON" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$settingsPath"
check "settings.json keeps the base deny list through the overlay merge" \
  node -e 'const readJson=(path)=>JSON.parse(require("fs").readFileSync(path,"utf8"));const baseDenyList=readJson(process.argv[1]).permissions.deny;const renderedDenyList=readJson(process.argv[2]).permissions.deny;process.exit(baseDenyList.length>0&&JSON.stringify(renderedDenyList)===JSON.stringify(baseDenyList)?0:1)' "$topicDir/settings.base.json" "$settingsPath"

renderProfileSettings() {
  HOME="$sandbox" node "$repoRoot/ai/render-settings.mjs" \
    "$topicDir/settings.base.json" "$1" "$2" /fixture/home > /dev/null
}

renderKeepsEveryBaseDenyEntry() {
  node -e 'const readJson=(path)=>JSON.parse(require("fs").readFileSync(path,"utf8"));const baseDenyList=readJson(process.argv[1]).permissions.deny;const renderedDenyList=readJson(process.argv[2]).permissions.deny||[];process.exit(baseDenyList.length>0&&baseDenyList.every((denyEntry)=>renderedDenyList.includes(denyEntry))?0:1)' \
    "$topicDir/settings.base.json" "$1"
}

overlayDefinesNoDenyList() {
  node -e 'const overlaySettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlaySettings.permissions&&overlaySettings.permissions.deny?1:0)' "$1"
}

for profileOverlayPath in "$repoRoot"/profiles/*/settings.overlay.json; do
  profileName="$(basename -- "$(dirname -- "$profileOverlayPath")")"
  renderedProfilePath="$sandbox/deny-probe-$profileName.json"
  check "the $profileName overlay renders" \
    renderProfileSettings "$profileOverlayPath" "$renderedProfilePath"
  check "the $profileName render keeps every base deny entry" \
    renderKeepsEveryBaseDenyEntry "$renderedProfilePath"
  check "the $profileName overlay defines no deny list of its own" \
    overlayDefinesNoDenyList "$profileOverlayPath"
done

check "settings.json keeps the personal permissions allow list" \
  node -e 'const renderedSettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(renderedSettings.permissions.allow.includes("Bash(node:*)")?0:1)' "$settingsPath"
check "settings.json keeps the personal permissions default mode" \
  node -e 'const renderedSettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(renderedSettings.permissions.defaultMode==="auto"?0:1)' "$settingsPath"
check "settings.json has no unrendered token" bash -c '! grep -q "{{HOME}}" "$1"' _ "$settingsPath"
check "settings.json points the commit policy at the alias" \
  grep -q "\"CLAUDE_COMMIT_POLICY_ROOT\": \"$sandbox/.dotfiles\"" "$settingsPath"
check "settings.json is not world readable" bash -c '[[ "$(stat -c %a "$1")" == "600" ]]' _ "$settingsPath"

countSettingsCommand() {
  grep -c -- "$1" "$settingsPath"
}
check "the routing SessionStart hook reaches the profile" test "$(countSettingsCommand inject-routing.mjs)" -eq 1
check "the caveman ultra hook renders from the base" test "$(countSettingsCommand caveman-ultra.mjs)" -eq 1
check "the finding scope hook reaches the profile" test "$(countSettingsCommand check-finding-scope.mjs)" -eq 1
check "the plan challenge hook reaches the profile" test "$(countSettingsCommand challenge-plan.mjs)" -eq 1
check "the retired sync hook is gone" test "$(countSettingsCommand sync-agents-md.mjs)" -eq 0
check "commit and pr attribution render empty from the base" \
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.attribution.commit===""&&s.attribution.pr===""?0:1)' "$settingsPath"

rm -f "$sandbox/.claude/AGENTS.md"
printf 'later hand written notes\n' > "$sandbox/.claude/AGENTS.md"
runInstall > /dev/null
check "a later displaced file gets its own backup" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the later backup holds the later content" grep -q 'later hand written notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the first backup is untouched" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

# A machine converged before the copy switch still holds the old CLAUDE.md symlink;
# it is ours, so the rerun replaces it with the copy and leaves no backup behind.
rm -f "$claudeMdPath"
ln -s "$sandbox/.dotfiles/profiles/personal/CLAUDE.md" "$claudeMdPath"
runInstall > /dev/null
check "an old CLAUDE.md symlink converges to a plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$claudeMdPath"
check "converging the old symlink leaves no backup" \
  bash -c '! ls "$1".pre-dotfiles.bak* >/dev/null 2>&1' _ "$claudeMdPath"

printf 'hand edited claude memory\n' > "$claudeMdPath"
runInstall > /dev/null
check "a hand edited CLAUDE.md is backed up before the copy returns" \
  grep -qs 'hand edited claude memory' "$claudeMdPath".pre-dotfiles.bak*
check "the copy wins over the hand edit" \
  cmp -s "$claudeMdPath" "$repoRoot/profiles/personal/CLAUDE.md"

checkRerunIsQuiet "second run reports no changes" "$(runInstall)"

warnedRunStatus=0
runTopicInstallWithoutProfile "$topicDir" > /dev/null \
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

# A profile overlay's hooks join the base's for the same event; replacing them would
# silently drop every hook the base ships, which is how the base earns its hooks.
hookBase="$renderSandbox/hooks-base.json"
hookOverlay="$renderSandbox/hooks-overlay.json"
hookDestination="$renderSandbox/hooks-settings.json"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node base-only-hook.mjs"}]}]}}\n' \
  > "$hookBase"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node overlay-only-hook.mjs"}]}]}}\n' \
  > "$hookOverlay"
renderJsonTemplate "hook merge probe" "$repoRoot/ai/render-settings.mjs" \
  "$hookBase" "$hookOverlay" "$hookDestination" > /dev/null
check "an overlay hook renders alongside the base hook it shares an event with" \
  bash -c 'grep -q "base-only-hook.mjs" "$1" && grep -q "overlay-only-hook.mjs" "$1"' _ "$hookDestination"

check "hook behavior tests pass" node --test "$topicDir/hooks/hooks.test.mjs"

reportTopicResults "ai"
