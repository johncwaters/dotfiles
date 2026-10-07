#!/usr/bin/env bash
# Per-entry links preserve the runtime state beside them in ~/.claude (AGENTS.md).

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

claudeHome="$HOME/.claude"
codexHome="$HOME/.codex"
claudeSkillsDirectory="$claudeHome/skills"
repoSkillsDirectory="$dotfilesRepo/ai/skills"
skillsStagingDirectory="$claudeHome/.skills-cutover"

resolvedDirectoryPath() {
  cd -- "$1" 2> /dev/null && pwd -P
}

repoSkillsIndexIsReadable() {
  local trackedSkillPaths
  command -v git > /dev/null 2>&1 || return 1
  trackedSkillPaths="$(git -C "$dotfilesRepo" ls-files -- ai/skills 2> /dev/null)" || return 1
  [[ -n "$trackedSkillPaths" ]]
}

repoSkillEntryIsTracked() {
  local trackedSkillPaths
  trackedSkillPaths="$(git -C "$dotfilesRepo" ls-files -- "ai/skills/$1" 2> /dev/null)" || return 1
  [[ -n "$trackedSkillPaths" ]]
}

claudeSkillsLinkPointsOutsideRepoSkills() {
  local linkedDirectory
  local repoSkillsPath
  pathIsLinkIntoThisRepo "$claudeSkillsDirectory" || return 1
  linkedDirectory="$(resolvedDirectoryPath "$claudeSkillsDirectory" || true)"
  repoSkillsPath="$(resolvedDirectoryPath "$repoSkillsDirectory" || true)"
  [[ -z "$repoSkillsPath" || "$linkedDirectory" != "$repoSkillsPath" ]]
}

stageForeignSkillEntriesOutOfTheRepo() {
  local repoSkillEntries=()
  local repoSkillEntry
  local skillName
  shopt -s dotglob nullglob
  repoSkillEntries=("$repoSkillsDirectory"/*)
  shopt -u dotglob nullglob
  for repoSkillEntry in "${repoSkillEntries[@]}"; do
    skillName="$(basename -- "$repoSkillEntry")"
    if repoSkillEntryIsTracked "$skillName"; then
      continue
    fi
    mkdir -p -- "$skillsStagingDirectory"
    mv -- "$repoSkillEntry" "$skillsStagingDirectory/$skillName"
  done
}

cutOverLegacySkillsDirectoryLink() {
  pathIsLinkIntoThisRepo "$claudeSkillsDirectory" || return 0
  if ! repoSkillsIndexIsReadable; then
    noteWarned "skills directory" "git cannot name the tracked skills, cutover skipped"
    return 1
  fi
  stageForeignSkillEntriesOutOfTheRepo
  rm -f -- "$claudeSkillsDirectory"
}

adoptStagedSkillEntries() {
  local stagedEntries=()
  local stagedEntry
  local skillName
  [[ -d "$skillsStagingDirectory" ]] || return 0
  shopt -s dotglob nullglob
  stagedEntries=("$skillsStagingDirectory"/*)
  shopt -u dotglob nullglob
  for stagedEntry in "${stagedEntries[@]}"; do
    skillName="$(basename -- "$stagedEntry")"
    if [[ -e "$claudeSkillsDirectory/$skillName" || -L "$claudeSkillsDirectory/$skillName" ]]; then
      noteWarned "skill $skillName" "already in ~/.claude/skills, left in $skillsStagingDirectory"
      continue
    fi
    mv -- "$stagedEntry" "$claudeSkillsDirectory/$skillName"
    noteApplied "skill $skillName" "moved out of repo"
  done
  rmdir -- "$skillsStagingDirectory" 2> /dev/null || true
}

removeRetiredSkillLinks() {
  local installedSkillPath
  local skillName
  shopt -s nullglob
  for installedSkillPath in "$claudeSkillsDirectory"/*; do
    skillName="$(basename -- "$installedSkillPath")"
    if [[ -e "$repoSkillsDirectory/$skillName" ]]; then
      continue
    fi
    case "$(symlinkTargetOf "$installedSkillPath")" in
      "$dotfilesAlias/ai/skills/"* | "$dotfilesRepo/ai/skills/"*)
        rm -f -- "$installedSkillPath"
        noteApplied "skill $skillName" "retired link removed"
        ;;
    esac
  done
  shopt -u nullglob
}

linkRepoSkills() {
  local repoSkillPath
  local skillName
  shopt -s nullglob
  for repoSkillPath in "$repoSkillsDirectory"/*; do
    skillName="$(basename -- "$repoSkillPath")"
    linkEntry "skill $skillName" "ai/skills/$skillName" "$claudeSkillsDirectory/$skillName"
  done
  shopt -u nullglob
}

moveSkillsPathAsideUnlessItIsAPlainDirectory() {
  if [[ ! -L "$claudeSkillsDirectory" ]] && [[ ! -e "$claudeSkillsDirectory" || -d "$claudeSkillsDirectory" ]]; then
    return 0
  fi
  moveExistingAside "skills directory" "$claudeSkillsDirectory"
}

installRepoSkills() {
  if claudeSkillsLinkPointsOutsideRepoSkills; then
    noteWarned "skills directory" "links into the repo outside ai/skills, move it aside by hand"
    return 0
  fi
  cutOverLegacySkillsDirectoryLink || return 0
  moveSkillsPathAsideUnlessItIsAPlainDirectory
  mkdir -p -- "$claudeSkillsDirectory"
  adoptStagedSkillEntries
  removeRetiredSkillLinks
  linkRepoSkills
}

skillDependenciesAreStale() {
  local installedLockPath="$1/node_modules/.package-lock.json"
  [[ ! -f "$installedLockPath" || "$1/package-lock.json" -nt "$installedLockPath" ]]
}

installSkillBrowser() {
  local skillDirectory="$1"
  local skillName="$2"
  local playwrightCliPath="$skillDirectory/node_modules/.bin/playwright-core"
  [[ -x "$playwrightCliPath" ]] || return 0
  "$playwrightCliPath" install --only-shell chromium && return 0
  noteWarned "skill $skillName browser" "Chromium headless shell install failed"
}

installSkillDependencies() {
  local skillLockPaths=()
  local skillLockPath
  local skillDirectory
  local skillName
  command -v node > /dev/null 2>&1 || return 0
  command -v npm > /dev/null 2>&1 || return 0
  shopt -s nullglob
  skillLockPaths=("$repoSkillsDirectory"/*/package-lock.json)
  shopt -u nullglob
  for skillLockPath in "${skillLockPaths[@]}"; do
    skillDirectory="$(dirname -- "$skillLockPath")"
    skillName="$(basename -- "$skillDirectory")"
    if skillDependenciesAreStale "$skillDirectory" && ! (cd -- "$skillDirectory" && npm ci --omit=dev); then
      noteWarned "skill $skillName dependencies" "npm ci failed"
      continue
    fi
    installSkillBrowser "$skillDirectory" "$skillName"
  done
}

installRepoSkills
installSkillDependencies

linkEntry "AGENTS.md" "ai/AGENTS.md" "$claudeHome/AGENTS.md"
linkEntry "ROUTING.md" "ai/ROUTING.md" "$claudeHome/ROUTING.md"
linkEntry "tsconfig.json" "ai/tsconfig.json" "$claudeHome/tsconfig.json"
linkEntry "types" "ai/types" "$claudeHome/types"
linkEntry "agents" "ai/agents" "$claudeHome/agents"
linkEntry "workflows" "ai/workflows" "$claudeHome/workflows"
linkEntry "commands" "ai/commands" "$claudeHome/commands"
linkEntry "hooks" "ai/hooks" "$claudeHome/hooks"
linkEntry "hud" "ai/hud" "$claudeHome/hud"
linkEntry "Codex AGENTS.md" "ai/AGENTS.md" "$codexHome/AGENTS.md"

if [[ -z "${profileName:-}" ]]; then
  noteWarned "profile files" "no profile resolved, CLAUDE.md and settings.json skipped"
  finishTopic
fi

# CLAUDE.md must be a copy for Claude Code to follow its @AGENTS.md import (AGENTS.md).
copyEntry "CLAUDE.md" "profiles/$profileName/CLAUDE.md" "$claudeHome/CLAUDE.md"
convergeReviewChecklist() {
  local reviewChecklistSource="profiles/$profileName/review-checklist.md"
  local reviewChecklistDestination="$claudeHome/review-checklist.md"
  if [[ -f "$dotfilesRepo/$reviewChecklistSource" ]]; then
    linkEntry "review-checklist.md" "$reviewChecklistSource" "$reviewChecklistDestination"
    return 0
  fi
  pathIsLinkIntoThisRepo "$reviewChecklistDestination" || return 0
  rm -f -- "$reviewChecklistDestination"
  noteApplied "review-checklist.md" "retired link removed"
}

convergeReviewChecklist
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$dotfilesRepo/profiles/$profileName/settings.overlay.json" \
  "$claudeHome/settings.json"

convergeMcpServers() {
  local convergencePlan
  local managedNames
  local recordedNames=""
  local remainingNames=""
  local serverName
  local serverAction
  local serverConfig
  if ! command -v claude > /dev/null 2>&1; then
    noteWarned "MCP servers" "claude not found, convergence skipped"
    return 0
  fi
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "MCP servers" "node not found, convergence skipped"
    return 0
  fi
  managedNames="$(readDotfilesState ai-managed-mcp-servers || true)"
  if ! convergencePlan="$(node - "$dotfilesRepo/profiles/$profileName/mcp-servers.json" "$HOME/.claude.json" "$managedNames" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [declarationPath, runtimePath, managedNames] = process.argv.slice(2);
const declaredServers = fs.existsSync(declarationPath)
  ? JSON.parse(fs.readFileSync(declarationPath, 'utf8')) : {};
if (!declaredServers || typeof declaredServers !== 'object' || Array.isArray(declaredServers)) process.exit(1);
let currentServers = {};
try {
  currentServers = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))?.mcpServers ?? {};
} catch {}
if (!currentServers || typeof currentServers !== 'object' || Array.isArray(currentServers)) currentServers = {};
const managedNameSet = new Set(managedNames.split('\n').filter(Boolean));
const serverNames = new Set([...managedNameSet, ...Object.keys(declaredServers)]);
const plan = [];
for (const serverName of serverNames) {
  if (!serverName || /[\t\r\n]/.test(serverName)) process.exit(1);
  const isDeclared = Object.hasOwn(declaredServers, serverName);
  const isPresent = Object.hasOwn(currentServers, serverName);
  if (!isDeclared) {
    plan.push([serverName, isPresent ? 'remove' : 'forget', '']);
    continue;
  }
  const serverConfig = declaredServers[serverName];
  if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) process.exit(1);
  const matchesDeclaration = isPresent && isDeepStrictEqual(currentServers[serverName], serverConfig);
  if (isPresent && !matchesDeclaration && !managedNameSet.has(serverName)) {
    plan.push([serverName, 'blocked', '']);
    continue;
  }
  const serverAction = isPresent ? (matchesDeclaration ? 'keep' : 'replace') : 'add';
  plan.push([serverName, serverAction, JSON.stringify(serverConfig)]);
}
process.stdout.write(plan.map(entry => entry.join('\t')).join('\n'));
NODE
)"; then
    noteWarned "MCP servers" "could not read profile declarations, convergence skipped"
    return 0
  fi
  while IFS=$'\t' read -r serverName serverAction serverConfig; do
    [[ -n "$serverName" ]] || continue
    [[ "$serverAction" != blocked ]] || continue
    recordedNames+="${recordedNames:+$'\n'}$serverName"
  done <<< "$convergencePlan"
  writeDotfilesState ai-managed-mcp-servers "$recordedNames"
  if [[ "$(readDotfilesState ai-managed-mcp-servers || true)" != "$recordedNames" ]]; then
    noteWarned "MCP servers" "could not record managed names, convergence skipped"
    return 0
  fi
  while IFS=$'\t' read -r serverName serverAction serverConfig; do
    [[ -n "$serverName" ]] || continue
    [[ "$serverAction" != forget ]] || continue
    if [[ "$serverAction" == blocked ]]; then
      noteWarned "MCP $serverName" "an unmanaged server with this name blocks convergence"
      continue
    fi
    if [[ "$serverAction" == remove || "$serverAction" == replace ]]; then
      if ! claude mcp remove --scope user "$serverName" > /dev/null 2>&1; then
        noteWarned "MCP $serverName" "remove failed"
        remainingNames+="${remainingNames:+$'\n'}$serverName"
        continue
      fi
      noteApplied "MCP $serverName" "removed"
      [[ "$serverAction" != remove ]] || continue
    fi
    remainingNames+="${remainingNames:+$'\n'}$serverName"
    [[ "$serverAction" != keep ]] || continue
    if claude mcp add-json --scope user "$serverName" "$serverConfig" > /dev/null 2>&1; then
      noteApplied "MCP $serverName" "added"
      continue
    fi
    noteWarned "MCP $serverName" "add failed"
  done <<< "$convergencePlan"
  writeDotfilesState ai-managed-mcp-servers "$remainingNames"
}

convergeMcpServers

finishTopic
