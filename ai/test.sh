#!/usr/bin/env bash

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

stagedRepo="$sandbox/staged-dotfiles"
mkdir -p "$stagedRepo"
cp -R "$repoRoot/." "$stagedRepo"
rm -rf "$stagedRepo/.git"
git init -q -b main "$stagedRepo"
stagedTopicDir="$stagedRepo/ai"
singleFileSkillPath="$stagedTopicDir/skills/single-file-skill-test.md"
printf 'tracked single file skill\n' > "$singleFileSkillPath"
git -C "$stagedRepo" add -A -- ai/skills

foreignSkillName=".synced-cutover-test"
foreignSkillPath="$stagedTopicDir/skills/$foreignSkillName"
mkdir -p "$foreignSkillPath"
printf 'synced runtime state\n' > "$foreignSkillPath/state.json"
rm -f "$sandbox/.dotfiles"
ln -s "$stagedRepo" "$sandbox/.dotfiles"
ln -s "$sandbox/.dotfiles/ai/skills" "$sandbox/.claude/skills"

printf '\nai topic\n'

installStatus=0
firstRunOutput="$(runTopicInstall "$stagedTopicDir")" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
reviewChecklistPath="$sandbox/.claude/review-checklist.md"
check "personal profile leaves the review checklist absent" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "work profile links the review checklist through the alias" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$reviewChecklistPath" "$sandbox/.dotfiles/profiles/work/review-checklist.md"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile removes the stale work review checklist link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"
printf 'local review notes\n' > "$reviewChecklistPath"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile preserves a non-repo review checklist" \
  grep -qx 'local review notes' "$reviewChecklistPath"
rm -f -- "$reviewChecklistPath"

linkedDestinations=(
  ".claude/AGENTS.md" ".claude/ROUTING.md" ".claude/tsconfig.json" ".claude/types"
  ".claude/agents" ".claude/workflows" ".claude/commands" ".claude/hooks" ".claude/hud"
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

skillsPath="$sandbox/.claude/skills"
check "skills is a plain directory, never a whole-directory link" \
  bash -c '[[ -d "$1" && ! -L "$1" ]]' _ "$skillsPath"
for repoSkillPath in "$stagedTopicDir"/skills/*; do
  skillName="$(basename -- "$repoSkillPath")"
  installedSkillPath="$skillsPath/$skillName"
  check "skill $skillName is linked through the alias" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$installedSkillPath" "$sandbox/.dotfiles/ai/skills/$skillName"
done
check "cutover preserves a foreign skill entry" \
  grep -qx 'synced runtime state' "$skillsPath/$foreignSkillName/state.json"
check "cutover removes the foreign skill entry from the repo" \
  test ! -e "$foreignSkillPath"
check "cutover leaves a tracked single file skill in the repo" \
  grep -qx 'tracked single file skill' "$singleFileSkillPath"
retiredSkillPath="$skillsPath/retired-skill-test"
ln -s "$sandbox/.dotfiles/ai/skills/retired-skill-test" "$retiredSkillPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a retired repo skill link is removed" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$retiredSkillPath"

stagingPath="$sandbox/.claude/.skills-cutover"
interruptedSkillPath="$stagingPath/interrupted-skill-test"
mkdir -p "$interruptedSkillPath"
printf 'interrupted runtime state\n' > "$interruptedSkillPath/state.json"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a cutover interrupted after its link was replaced finishes on the next run" \
  grep -qx 'interrupted runtime state' "$skillsPath/interrupted-skill-test/state.json"
check "a finished cutover leaves nothing staged" bash -c '! test -e "$1"' _ "$stagingPath"

rm -rf "$skillsPath"
ln -s "$sandbox/.dotfiles/ai" "$skillsPath"
misPointedStatus=0
misPointedOutput="$(runTopicInstall "$stagedTopicDir")" || misPointedStatus=$?
check "a skills link into the repo outside ai/skills warns" \
  outputHas "$misPointedOutput" "outside ai/skills"
check "a skills link into the repo outside ai/skills fails the topic" \
  test "$misPointedStatus" -eq 1
check "a mis-pointed skills link empties nothing out of the repo" \
  test -f "$stagedTopicDir/AGENTS.md"
check "a mis-pointed skills link writes no skill link into the repo" \
  bash -c '! test -e "$1" && ! test -L "$1"' _ "$stagedTopicDir/commit"
rm -f "$skillsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "removing the mis-pointed link converges the skills directory again" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/commit" ]]' _ "$skillsPath"

gitlessBin="$sandbox/gitless-bin"
mkdir -p "$gitlessBin"
linkCoreUtilities --into "$gitlessBin" bash basename dirname cat cmp cp chmod find grep head \
  ln ls mkdir mktemp mv node readlink rm rmdir sed stat tr uname wc
rm -rf "$skillsPath"
ln -s "$sandbox/.dotfiles/ai/skills" "$skillsPath"
gitlessStatus=0
gitlessOutput="$(env HOME="$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 PATH="$gitlessBin" \
  bash "$stagedTopicDir/install.sh")" || gitlessStatus=$?
check "a converge that cannot read the index warns" \
  outputHas "$gitlessOutput" "git cannot name the tracked skills"
check "a converge that cannot read the index moves no repo skill out" \
  test -d "$stagedTopicDir/skills/commit"
check "a converge that cannot read the index displaces no repo skill" \
  bash -c '! ls "$1"/*.pre-dotfiles.bak* > /dev/null 2>&1' _ "$stagedTopicDir/skills"
check "a converge that cannot read the index leaves the old link in place" test -L "$skillsPath"
rm -f "$skillsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "the skills directory converges again once git is back" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/commit" ]]' _ "$skillsPath"

rm -rf "$skillsPath"
ln -s "$sandbox/deleted-skills-directory" "$skillsPath"
danglingLinkStatus=0
runTopicInstall "$stagedTopicDir" > /dev/null || danglingLinkStatus=$?
check "a dangling foreign skills link does not fail the topic" test "$danglingLinkStatus" -eq 0
check "a dangling foreign skills link is backed up" \
  bash -c 'ls "$1".pre-dotfiles.bak* > /dev/null 2>&1' _ "$skillsPath"
check "a dangling foreign skills link converges to a plain directory" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/commit" ]]' _ "$skillsPath"

foreignSkillsHome="$sandbox/foreign-skills-home"
mkdir -p "$foreignSkillsHome"
printf 'foreign skills state\n' > "$foreignSkillsHome/state.json"
rm -rf "$skillsPath"
ln -s "$foreignSkillsHome" "$skillsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a foreign skills link converges to a plain directory" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/commit" ]]' _ "$skillsPath"
check "a foreign skills directory takes no repo skill link" \
  bash -c '! test -e "$1/commit" && ! test -L "$1/commit"' _ "$foreignSkillsHome"
check "a foreign skills directory keeps what it held" \
  grep -qx 'foreign skills state' "$foreignSkillsHome/state.json"

workflowPinsEveryAgentCall() {
  local workflowPath="$1"
  local agentCallCount
  local modelPinnedCallCount
  agentCallCount="$(grep -oF 'agent(' "$workflowPath" | wc -l)"
  modelPinnedCallCount="$(grep -Ec "agent\\([^,]+, \\{ model: '[^']+'" "$workflowPath" || true)"
  [[ "$agentCallCount" -eq "$modelPinnedCallCount" ]]
}

workflowCarriesDelegationMarkers() {
  local workflowPath="$1"
  grep -qF 'Scope:' "$workflowPath" \
    && grep -qF 'Out of scope:' "$workflowPath" \
    && grep -qF 'Definition of done:' "$workflowPath"
}

workflowModelIdsComeFromRouting() {
  local workflowPath="$1"
  local modelId
  while read -r modelId; do
    [[ -n "$modelId" ]] || continue
    grep -qF -- "$modelId" "$topicDir/ROUTING.md" || return 1
  done < <(
    {
      grep -oE 'gpt-[a-z0-9]+([.-][a-z0-9]+)*' "$workflowPath" || true
      grep -oE "model: '[^']+'" "$workflowPath" | sed -E "s/^model: '(.*)'$/\1/" || true
    } | sort -u
  )
}

workflowCliCommandsComeFromRouting() {
  local workflowPath="$1"
  local cliCommand
  while read -r cliCommand; do
    [[ -n "$cliCommand" ]] || continue
    grep -qF -- "$cliCommand" "$topicDir/ROUTING.md" || return 1
  done < <(
    {
      grep -oE -- "codex exec [^']*" "$workflowPath" || true
      grep -oE -- "grok --prompt-file [^']*" "$workflowPath" || true
    } | sort -u
  )
}

workflowAvoidsResumeBreakingCalls() {
  ! grep -qE 'Math\.random\(|Date\.now\(|new Date\(\)' "$1"
}

qaSwarmDeclaresThreeLaneCap() {
  grep -qE '^const maxLanesPerRun = 3$' "$topicDir/workflows/qa-swarm.js"
}

reviewerAgentsDoNotReportForAbsentOwners() {
  ! grep -qF 'on behalf of an owner' "$topicDir"/agents/*-reviewer.md
}

shopt -s nullglob
workflowScripts=("$topicDir"/workflows/*.js)
shopt -u nullglob
check "workflow scripts are present" test "${#workflowScripts[@]}" -gt 0
for workflowPath in "${workflowScripts[@]}"; do
  workflowName="$(basename -- "$workflowPath")"
  check "$workflowName pins every agent model" workflowPinsEveryAgentCall "$workflowPath"
  check "$workflowName carries delegation markers" workflowCarriesDelegationMarkers "$workflowPath"
  check "$workflowName names only models ROUTING.md lists" workflowModelIdsComeFromRouting "$workflowPath"
  check "$workflowName names only CLI invocations ROUTING.md lists" workflowCliCommandsComeFromRouting "$workflowPath"
  check "$workflowName avoids calls the workflow runtime rejects" workflowAvoidsResumeBreakingCalls "$workflowPath"
done
check "qa-swarm caps each run at three lanes" qaSwarmDeclaresThreeLaneCap
check "reviewer agents stay inside their own lanes" reviewerAgentsDoNotReportForAbsentOwners

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
  node --input-type=module -e 'import {readFileSync} from "node:fs";import {pathToFileURL} from "node:url";const {buildClaudeProtectedReadRules}=await import(pathToFileURL(process.argv[3]));const readJson=(path)=>JSON.parse(readFileSync(path,"utf8"));const baseDenyList=readJson(process.argv[1]).permissions.deny;const renderedDenyList=readJson(process.argv[2]).permissions.deny;process.exit(baseDenyList.length>0&&JSON.stringify(renderedDenyList)===JSON.stringify([...baseDenyList,...buildClaudeProtectedReadRules()])?0:1)' "$topicDir/settings.base.json" "$settingsPath" "$topicDir/protected-paths.mjs"
check "settings.json pins the sonnet alias to the model ROUTING.md names" \
  node -e 'const fs=require("fs");const routedSonnetModel=(fs.readFileSync(process.argv[1],"utf8").match(/^\| `sonnet` \(([^)]+)\)/m)||[])[1];const pinnedSonnetModel=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).env.ANTHROPIC_DEFAULT_SONNET_MODEL;process.exit(routedSonnetModel&&routedSonnetModel===pinnedSonnetModel?0:1)' "$topicDir/ROUTING.md" "$settingsPath"

renderProfileSettings() {
  HOME="$sandbox" node "$repoRoot/ai/render-settings.mjs" \
    "$topicDir/settings.base.json" "$1" "$2" /fixture/home > /dev/null
}

renderKeepsEveryBasePermission() {
  node -e 'const readJson=(path)=>JSON.parse(require("fs").readFileSync(path,"utf8"));const permissionName=process.argv[3];const basePermissions=readJson(process.argv[1]).permissions[permissionName];const renderedPermissions=readJson(process.argv[2]).permissions[permissionName]||[];process.exit(basePermissions.length>0&&basePermissions.every((permission)=>renderedPermissions.includes(permission))?0:1)' \
    "$topicDir/settings.base.json" "$2" "$1"
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
    renderKeepsEveryBasePermission deny "$renderedProfilePath"
  check "the $profileName render keeps every base allow entry" \
    renderKeepsEveryBasePermission allow "$renderedProfilePath"
  check "the $profileName overlay defines no deny list of its own" \
    overlayDefinesNoDenyList "$profileOverlayPath"
done

check "settings.json keeps the personal permissions allow list" \
  node -e 'const renderedSettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(renderedSettings.permissions.allow.includes("Bash(node:*)")?0:1)' "$settingsPath"
check "settings.json keeps the base allow list through the overlay merge" \
  renderKeepsEveryBasePermission allow "$settingsPath"
for workflowScriptPath in "$topicDir"/workflows/*.js; do
  workflowName="$(basename -- "$workflowScriptPath" .js)"
  check "the base allow list runs the $workflowName workflow without a prompt" \
    node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).permissions.allow.includes(`Workflow(${process.argv[2]})`)?0:1)' "$topicDir/settings.base.json" "$workflowName"
done
check "settings.json keeps the personal permissions default mode" \
  node -e 'const renderedSettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(renderedSettings.permissions.defaultMode==="auto"?0:1)' "$settingsPath"
check "settings.json has no unrendered token" bash -c '! grep -q "{{HOME}}" "$1"' _ "$settingsPath"
check "settings.json points the commit policy at the alias" \
  grep -q "\"CLAUDE_COMMIT_POLICY_ROOT\": \"$sandbox/.dotfiles\"" "$settingsPath"
check "settings.json is not world readable" test "$(fileModeOf "$settingsPath")" = "600"

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
runTopicInstall "$stagedTopicDir" > /dev/null
check "a later displaced file gets its own backup" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the later backup holds the later content" grep -q 'later hand written notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the first backup is untouched" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

rm -f "$claudeMdPath"
ln -s "$sandbox/.dotfiles/profiles/personal/CLAUDE.md" "$claudeMdPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "an old CLAUDE.md symlink converges to a plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$claudeMdPath"
check "converging the old symlink leaves no backup" \
  bash -c '! ls "$1".pre-dotfiles.bak* >/dev/null 2>&1' _ "$claudeMdPath"

printf 'hand edited claude memory\n' > "$claudeMdPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a hand edited CLAUDE.md is backed up before the copy returns" \
  grep -qs 'hand edited claude memory' "$claudeMdPath".pre-dotfiles.bak*
check "the copy wins over the hand edit" \
  cmp -s "$claudeMdPath" "$repoRoot/profiles/personal/CLAUDE.md"

checkRerunIsQuiet "second run reports no changes" "$(runTopicInstall "$stagedTopicDir")"

warnedRunStatus=0
runTopicInstallWithoutProfile "$stagedTopicDir" > /dev/null \
  || warnedRunStatus=$?
check "a topic that emits a warning exits non-zero" test "$warnedRunStatus" -eq 1

settingsBackupHolds() {
  grep -qs -- "$1" "$settingsPath".pre-dotfiles.bak*
}

printf '{"handEdit":"first-edit-to-settings"}\n' > "$settingsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
printf '{"handEdit":"second-edit-to-settings"}\n' > "$settingsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
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

shopt -s nullglob
hookTestFiles=("$topicDir"/hooks/test/*.test.mjs)
workflowTestFiles=("$topicDir"/workflows/test/*.test.mjs)
commitTestFiles=("$topicDir"/skills/commit/test/*.test.ts)
openPrTestFiles=("$topicDir"/skills/open-pr/test/*.test.mjs)
shopt -u nullglob
check "hook behavior tests are present" test "${#hookTestFiles[@]}" -gt 0
check "workflow behavior tests are present" test "${#workflowTestFiles[@]}" -gt 0
check "commit behavior tests are present" test "${#commitTestFiles[@]}" -gt 0
check "open-pr evidence tests are present" test "${#openPrTestFiles[@]}" -gt 0
if ((${#hookTestFiles[@]} > 0 && ${#workflowTestFiles[@]} > 0 && ${#commitTestFiles[@]} > 0 && ${#openPrTestFiles[@]} > 0)); then
  check "hook, workflow, commit, and open-pr behavior tests pass" node --test "${hookTestFiles[@]}" "${workflowTestFiles[@]}" "${commitTestFiles[@]}" "${openPrTestFiles[@]}"
fi

reportTopicResults "ai"
