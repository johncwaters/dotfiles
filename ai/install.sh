#!/usr/bin/env bash
# Per-entry links preserve the runtime state beside them in ~/.claude (AGENTS.md).

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

if [[ -n "${DOTFILES_UPGRADE:-}" ]]; then
  source "$dotfilesRepo/script/lib/packages.sh"
fi

claudeHome="$HOME/.claude"
codexHome="$HOME/.codex"
kimiHome="$HOME/.kimi-code"
agyHome="$HOME/.gemini"
codexSkillsHome="$HOME/.agents"
agySkillsHome="$agyHome/config"
claudeSkillsDirectory="$claudeHome/skills"
repoSkillsDirectory="$dotfilesRepo/ai/skills"
profilePlanNames() {
  local action name
  while IFS=$'\t' read -r action name; do
    [[ "$action" == "$1" ]] || continue
    if [[ "$action" == source-* ]]; then
      printf '%s/%s\n' "$dotfilesRepo" "$name"
      continue
    fi
    printf '%s\n' "$name"
  done <<< "$profileConvergencePlan"
}

convergeAiProfileLink() {
  local label="$1" relativePath="$2" destination="$3"
  local sourcePath
  sourcePath="$(profilePlanNames "source-$relativePath")"
  convergeProfileLink "$label" "$relativePath" "$destination" "${sourcePath#"$dotfilesRepo/"}"
}

# A retired skill keeps its gitignored node_modules, so only SKILL.md marks it live.
entryIsLive() {
  local entryKind="$1" entryPath="$2"
  if [[ "$entryKind" == skills ]]; then
    [[ -f "$entryPath/SKILL.md" ]]
    return
  fi
  [[ -e "$entryPath" || -L "$entryPath" ]]
}

sharedEntryExists() {
  entryIsLive "$entryKind" "$repoEntriesDirectory/$1"
}

linkTargetsCurrentProfileEntry() {
  local entryName="$1" linkedEntryTarget="$2"
  local sourceProfile sourcePath
  for sourceProfile in "${aiProfileNames[@]}"; do
    sourcePath="profiles/$sourceProfile/$entryKind/$entryName"
    entryIsLive "$entryKind" "$dotfilesRepo/$sourcePath" || continue
    [[ "$linkedEntryTarget" == "$dotfilesAlias/$sourcePath" || "$linkedEntryTarget" == "$dotfilesRepo/$sourcePath" ]] && return 0
  done
  return 1
}

removeRetiredEntryLinks() {
  local retiredLinkScope="$1" entryKind="$2" entryLabel="$3" toolHome="${4:-$claudeHome}"
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$toolHome/$entryKind"
  local installedEntryPath
  local entryName
  local linkedEntryTarget
  [[ -d "$installedEntriesDirectory" && ! -L "$installedEntriesDirectory" ]] || return 0
  shopt -s dotglob nullglob
  for installedEntryPath in "$installedEntriesDirectory"/*; do
    [[ -L "$installedEntryPath" ]] || continue
    entryName="$(basename -- "$installedEntryPath")"
    linkedEntryTarget="$(symlinkTargetOf "$installedEntryPath")"
    case "$linkedEntryTarget" in
      "$dotfilesAlias/ai/$entryKind/"* | "$dotfilesRepo/ai/$entryKind/"*)
        [[ "$retiredLinkScope" == shared ]] || continue
        ! entryIsLive "$entryKind" "$repoEntriesDirectory/$entryName" || continue
        ;;
      "$dotfilesAlias/profiles/"*/$entryKind/* | "$dotfilesRepo/profiles/"*/$entryKind/*)
        [[ "$retiredLinkScope" == profile ]] || continue
        ! linkTargetsCurrentProfileEntry "$entryName" "$linkedEntryTarget" || continue
        ;;
      *) continue ;;
    esac
    rm -f -- "$installedEntryPath"
    noteApplied "$entryLabel $entryName" "retired link removed"
  done
  shopt -u dotglob nullglob
}

# Codex and agy load every SKILL.md under their skill homes, so a backup beside a foreign skill would still load.
isForeignEntryKept() {
  local installedEntryPath="$1" entryName="$2"
  [[ "$installedEntriesDirectory" != "$claudeHome/"* ]] || return 1
  [[ -e "$installedEntryPath" || -L "$installedEntryPath" ]] || return 1
  ! pathIsLinkIntoThisRepo "$installedEntryPath" || return 1
  noteWarned "$entryLabel $entryName" "a foreign entry holds this name, keeping it and skipping the repo $entryLabel"
}

linkSharedEntries() {
  local repoEntryPath
  local entryName
  shopt -s nullglob
  for repoEntryPath in "$repoEntriesDirectory"/*; do
    entryIsLive "$entryKind" "$repoEntryPath" || continue
    entryName="$(basename -- "$repoEntryPath")"
    ! isForeignEntryKept "$installedEntriesDirectory/$entryName" "$entryName" || continue
    linkEntry "$entryLabel $entryName" "${repoEntryPath#"$dotfilesRepo/"}" "$installedEntriesDirectory/$entryName"
  done
  shopt -u nullglob
}

linkProfileEntries() {
  local entryDirectory
  local repoEntryPath
  local entryName
  local sourceProfile
  local profileIndex
  declare -A linkedEntryNames=()
  shopt -s nullglob
  for ((profileIndex = ${#aiProfileNames[@]} - 1; profileIndex >= 0; profileIndex--)); do
    sourceProfile="${aiProfileNames[profileIndex]}"
    entryDirectory="$dotfilesRepo/profiles/$sourceProfile/$entryKind"
    for repoEntryPath in "$entryDirectory"/*; do
      entryIsLive "$entryKind" "$repoEntryPath" || continue
      entryName="$(basename -- "$repoEntryPath")"
      [[ -z "${linkedEntryNames[$entryName]:-}" ]] || continue
      linkedEntryNames["$entryName"]=1
      if sharedEntryExists "$entryName"; then
        noteWarned "$entryLabel $entryName" "profile $entryLabel conflicts with shared $entryLabel, keeping shared $entryLabel"
        continue
      fi
      ! isForeignEntryKept "$installedEntriesDirectory/$entryName" "$entryName" || continue
      linkEntry "$entryLabel $entryName" "${repoEntryPath#"$dotfilesRepo/"}" "$installedEntriesDirectory/$entryName"
    done
  done
  shopt -u nullglob
}

moveEntryDirectoryAsideUnlessPlain() {
  if [[ ! -L "$installedEntriesDirectory" ]] && [[ ! -e "$installedEntriesDirectory" || -d "$installedEntriesDirectory" ]]; then
    return 0
  fi
  moveExistingAside "$entryKind directory" "$installedEntriesDirectory"
}

convergeSharedEntryDirectory() {
  local entryKind="$1"
  local entryLabel="$2"
  local toolHome="${3:-$claudeHome}"
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$toolHome/$entryKind"
  moveEntryDirectoryAsideUnlessPlain
  mkdir -p -- "$installedEntriesDirectory"
  removeRetiredEntryLinks shared "$entryKind" "$entryLabel" "$toolHome"
  linkSharedEntries
}

convergeProfileEntryDirectory() {
  local entryKind="$1"
  local entryLabel="$2"
  local toolHome="${3:-$claudeHome}"
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$toolHome/$entryKind"
  [[ -d "$installedEntriesDirectory" && ! -L "$installedEntriesDirectory" ]] || return 0
  removeRetiredEntryLinks profile "$entryKind" "$entryLabel" "$toolHome"
  linkProfileEntries
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
  if ! "$playwrightCliPath" install --only-shell chromium; then
    noteWarned "skill $skillName browser" "Chromium headless shell install failed"
    return 0
  fi
  installHeadlessShellLibraries "$playwrightCliPath" "$skillName"
}

headlessShellLacksLibraries() {
  local headlessShellPath
  for headlessShellPath in "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell; do
    [[ -x "$headlessShellPath" ]] || continue
    env -u LD_LIBRARY_PATH ldd "$headlessShellPath" 2>/dev/null | grep -q 'not found' && return 0
  done
  return 1
}

installHeadlessShellLibraries() {
  local playwrightCliPath="$1"
  local skillName="$2"
  isDarwin && return 0
  headlessShellLacksLibraries || return 0
  local manualInstallHint="missing; run: $playwrightCliPath install-deps chromium --dry-run, then sudo /usr/bin/apt-get install the listed packages"
  local dependencyReport
  local missingPackages=()
  dependencyReport="$("$playwrightCliPath" install-deps chromium --dry-run 2>&1 || true)"
  mapfile -t missingPackages < <(sed -nE 's/^  ([^[:space:]]+)$/\1/p' <<< "$dependencyReport")
  if (( ${#missingPackages[@]} == 0 )); then
    noteWarned "skill $skillName browser libraries" "$manualInstallHint"
    return 0
  fi
  if sudo -n /usr/bin/apt-get install -y --no-install-recommends "${missingPackages[@]}"; then
    noteApplied "skill $skillName browser libraries" "installed through apt-get from playwright-core install-deps --dry-run"
    return 0
  fi
  noteWarned "skill $skillName browser libraries" "$manualInstallHint"
}

installLockedSkillDependencies() {
  local skillLockPath
  local skillDirectory
  local skillName
  command -v node > /dev/null 2>&1 || return 0
  command -v npm > /dev/null 2>&1 || return 0
  for skillLockPath in "$@"; do
    skillDirectory="$(dirname -- "$skillLockPath")"
    skillName="$(basename -- "$skillDirectory")"
    if skillDependenciesAreStale "$skillDirectory" && ! (cd -- "$skillDirectory" && npm ci --omit=dev); then
      noteWarned "skill $skillName dependencies" "npm ci failed"
      continue
    fi
    installSkillBrowser "$skillDirectory" "$skillName"
  done
}

installSharedSkillDependencies() {
  local skillLockPaths=()
  shopt -s nullglob
  skillLockPaths=("$repoSkillsDirectory"/*/package-lock.json)
  shopt -u nullglob
  installLockedSkillDependencies "${skillLockPaths[@]}"
}

installProfileSkillDependencies() {
  local skillLockPaths=()
  local skillDirectory
  local skillName
  local profileIndex
  declare -A seenSkillNames=()
  shopt -s nullglob
  for ((profileIndex = ${#aiProfileNames[@]} - 1; profileIndex >= 0; profileIndex--)); do
    for skillDirectory in "$dotfilesRepo/profiles/${aiProfileNames[profileIndex]}/skills"/*/; do
      skillDirectory="${skillDirectory%/}"
      skillName="$(basename -- "$skillDirectory")"
      [[ -z "${seenSkillNames[$skillName]:-}" ]] || continue
      seenSkillNames["$skillName"]=1
      ! entryIsLive skills "$repoSkillsDirectory/$skillName" || continue
      [[ -f "$skillDirectory/package-lock.json" ]] || continue
      skillLockPaths+=("$skillDirectory/package-lock.json")
    done
  done
  shopt -u nullglob
  installLockedSkillDependencies "${skillLockPaths[@]}"
}

convergeSharedEntryDirectory skills skill
convergeSharedEntryDirectory skills "Codex skill" "$codexSkillsHome"
convergeSharedEntryDirectory skills "agy skill" "$agySkillsHome"
convergeSharedEntryDirectory agents agent
convergeSharedEntryDirectory workflows workflow
installSharedSkillDependencies

renderAgyLaneAgents() {
  local agyAgentsDirectory="$agySkillsHome/agents"
  local claudeAgentPath agentName stagedPath previousNames retiredName
  local renderedNames=""
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "agy lane agents" "node not found, convergence skipped"
    return 0
  fi
  mkdir -p -- "$agyAgentsDirectory"
  for claudeAgentPath in "$dotfilesRepo/ai/agents"/*.md; do
    agentName="$(basename -- "$claudeAgentPath" .md)"
    renderedNames+="${renderedNames:+$'\n'}$agentName"
    clearDestinationIfNotPlainFile "agy agent $agentName" "$agyAgentsDirectory/$agentName.md" || continue
    stagedPath="$(mktemp "$agyAgentsDirectory/.dotfiles-render.XXXXXX")"
    if ! node "$dotfilesRepo/ai/render-agy-agent.mjs" "$claudeAgentPath" "$stagedPath"; then
      rm -f -- "$stagedPath"
      noteWarned "agy agent $agentName" "render failed"
      continue
    fi
    commitStagedFile "agy agent $agentName" "$stagedPath" "$agyAgentsDirectory/$agentName.md" "rendered"
  done
  previousNames="$(readDotfilesState ai-managed-agy-agents || true)"
  while IFS= read -r retiredName; do
    [[ -n "$retiredName" && ! -f "$dotfilesRepo/ai/agents/$retiredName.md" ]] || continue
    rm -f -- "$agyAgentsDirectory/$retiredName.md" "$(renderedCopyPath "$agyAgentsDirectory/$retiredName.md")"
    noteApplied "agy agent $retiredName" "retired render removed"
  done <<< "$previousNames"
  writeDotfilesState ai-managed-agy-agents "$renderedNames"
}

renderAgyLaneAgents

linkEntry "AGENTS.md" "ai/AGENTS.md" "$claudeHome/AGENTS.md"
linkEntry "MODELS.md" "ai/MODELS.md" "$claudeHome/MODELS.md"
linkEntry "tsconfig.json" "ai/tsconfig.json" "$claudeHome/tsconfig.json"
linkEntry "types" "ai/types" "$claudeHome/types"
linkEntry "hooks" "ai/hooks" "$claudeHome/hooks"
linkEntry "hud" "ai/hud" "$claudeHome/hud"

if [[ -z "${profileName:-}" ]]; then
  noteWarned "profile files" "no profile resolved, profile-dependent convergence skipped"
  finishTopic
fi

if ! profileConvergencePlan="$(node "$dotfilesRepo/ai/profile-config.mjs" "$profileName")"; then
  noteWarned "profile files" "could not read profile policy, profile-dependent convergence skipped"
  finishTopic
fi
mapfile -t aiProfileNames < <(profilePlanNames include-profile)
profileHooksSource="$(profilePlanNames source-hooks)"
profileCodexHooksSource="$(profilePlanNames source-codex-hooks.json)"
profileAgyHooksSource="$(profilePlanNames source-agy-hooks.json)"
profileMcpServersSource="$(profilePlanNames source-mcp-servers.json)"

convergeProfileEntryDirectory skills skill
convergeProfileEntryDirectory skills "Codex skill" "$codexSkillsHome"
convergeProfileEntryDirectory skills "agy skill" "$agySkillsHome"
installProfileSkillDependencies

# Codex, agy, and Kimi read one global AGENTS.md with no imports, so the profile rules are rendered into it.
renderProfileAgents() {
  local label="$1"
  local toolHome="$2"
  local agentOnlyRulesPath="${3:-}"
  local agentsPath="$toolHome/AGENTS.md"
  local profileAgentsPath="$(profilePlanNames source-AGENTS.md)"
  mkdir -p -- "$toolHome"
  if pathIsLinkIntoThisRepo "$agentsPath"; then
    rm -f -- "$agentsPath"
  fi
  clearDestinationIfNotPlainFile "$label" "$agentsPath" || return 0
  local stagedPath
  stagedPath="$(mktemp "$toolHome/.dotfiles-render.XXXXXX")"
  cat -- "$dotfilesRepo/ai/AGENTS.md" > "$stagedPath"
  if [[ -n "${profileName:-}" && -f "$profileAgentsPath" ]]; then
    printf '\n' >> "$stagedPath"
    cat -- "$profileAgentsPath" >> "$stagedPath"
  fi
  if [[ -n "$agentOnlyRulesPath" ]]; then
    printf '\n' >> "$stagedPath"
    cat -- "$agentOnlyRulesPath" >> "$stagedPath"
  fi
  commitStagedFile "$label" "$stagedPath" "$agentsPath" "rendered"
}

renderProfileAgents "Codex AGENTS.md" "$codexHome" "$dotfilesRepo/ai/codex-tools.md"
renderProfileAgents "agy AGENTS.md" "$agyHome" "$dotfilesRepo/ai/agy-tools.md"
if command -v kimi > /dev/null 2>&1; then
  renderProfileAgents "Kimi AGENTS.md" "$kimiHome"
fi

mcpPlanNeedsClaude() {
  local serverAction
  while IFS=$'\t' read -r _ serverAction _; do
    case "$serverAction" in
      add | replace | remove) return 0 ;;
    esac
  done <<< "$1"
  return 1
}

planMcpConvergence() {
  node - "$profileMcpServersSource" "$@" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [declarationPath, runtimePath, managedNames, runtimeShape] = process.argv.slice(2);
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
// Kimi infers HTTP from `url` and names SSE through `transport` (moonshotai.github.io/kimi-code customization/mcp).
function kimiServerConfig({ type, ...serverConfig }) {
  return type === 'sse' ? { ...serverConfig, transport: 'sse' } : serverConfig;
}
const plan = [];
for (const serverName of serverNames) {
  if (!serverName || /[\t\r\n]/.test(serverName)) process.exit(1);
  const isDeclared = Object.hasOwn(declaredServers, serverName);
  const isPresent = Object.hasOwn(currentServers, serverName);
  if (!isDeclared) {
    plan.push([serverName, isPresent ? 'remove' : 'forget', '']);
    continue;
  }
  const declaredConfig = declaredServers[serverName];
  if (!declaredConfig || typeof declaredConfig !== 'object' || Array.isArray(declaredConfig)) process.exit(1);
  const serverConfig = runtimeShape === 'kimi' ? kimiServerConfig(declaredConfig) : declaredConfig;
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
}

convergeMcpServers() {
  local convergencePlan
  local managedNames
  local recordedNames=""
  local remainingNames=""
  local serverName
  local serverAction
  local serverConfig
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "MCP servers" "node not found, convergence skipped"
    return 0
  fi
  managedNames="$(readDotfilesState ai-managed-mcp-servers || true)"
  if ! convergencePlan="$(planMcpConvergence "$HOME/.claude.json" "$managedNames" claude)"; then
    noteWarned "MCP servers" "could not read profile declarations, convergence skipped"
    return 0
  fi
  if ! command -v claude > /dev/null 2>&1; then
    mcpPlanNeedsClaude "$convergencePlan" || return 0
    noteWarned "MCP servers" "claude not found, convergence skipped"
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

convergeKimiMcpServers() {
  local mcpConfigPath="$kimiHome/mcp.json"
  local convergencePlan
  local managedNames
  local recordedNames=""
  local remainingNames=""
  local serverName
  local serverAction
  local serverConfig
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "Kimi MCP servers" "node not found, convergence skipped"
    return 0
  fi
  if ! pathIsPlainFileOrAbsent "$mcpConfigPath"; then
    noteWarned "Kimi MCP servers" "mcp.json is not a plain file, convergence skipped"
    return 0
  fi
  # The planner reads an unparseable file as empty and would claim hand-added names before the write fails.
  if [[ -f "$mcpConfigPath" ]] && ! node -e '
const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const mcpConfig = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.exit(isPlainObject(mcpConfig) && (mcpConfig.mcpServers === undefined || isPlainObject(mcpConfig.mcpServers)) ? 0 : 1)' "$mcpConfigPath" 2>/dev/null; then
    noteWarned "Kimi MCP servers" "could not read mcp.json, convergence skipped"
    return 0
  fi
  managedNames="$(readDotfilesState ai-managed-kimi-mcp-servers || true)"
  if ! convergencePlan="$(planMcpConvergence "$mcpConfigPath" "$managedNames" kimi)"; then
    noteWarned "Kimi MCP servers" "could not read profile declarations, convergence skipped"
    return 0
  fi
  while IFS=$'\t' read -r serverName serverAction serverConfig; do
    [[ -n "$serverName" ]] || continue
    if [[ "$serverAction" == blocked ]]; then
      noteWarned "Kimi MCP $serverName" "an unmanaged server with this name blocks convergence"
      continue
    fi
    recordedNames+="${recordedNames:+$'\n'}$serverName"
    case "$serverAction" in
      keep | add | replace) remainingNames+="${remainingNames:+$'\n'}$serverName" ;;
    esac
  done <<< "$convergencePlan"
  writeDotfilesState ai-managed-kimi-mcp-servers "$recordedNames"
  if [[ "$(readDotfilesState ai-managed-kimi-mcp-servers || true)" != "$recordedNames" ]]; then
    noteWarned "Kimi MCP servers" "could not record managed names, convergence skipped"
    return 0
  fi
  mkdir -p -- "$kimiHome"
  local stagedPath
  stagedPath="$(mktemp "$kimiHome/.dotfiles-mcp.XXXXXX")"
  if ! node - "$mcpConfigPath" "$stagedPath" "$convergencePlan" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const [mcpConfigPath, stagedPath, convergencePlan] = process.argv.slice(2);
const mcpConfig = fs.existsSync(mcpConfigPath) ? JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) : {};
if (!mcpConfig || typeof mcpConfig !== 'object' || Array.isArray(mcpConfig)) process.exit(1);
mcpConfig.mcpServers ??= {};
for (const planLine of convergencePlan.split('\n').filter(Boolean)) {
  const [serverName, serverAction, serverConfig] = planLine.split('\t');
  if (serverAction === 'remove') delete mcpConfig.mcpServers[serverName];
  if (serverAction === 'add' || serverAction === 'replace') mcpConfig.mcpServers[serverName] = JSON.parse(serverConfig);
}
fs.writeFileSync(stagedPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
NODE
  then
    rm -f -- "$stagedPath"
    noteWarned "Kimi MCP servers" "could not read mcp.json, convergence skipped"
    return 0
  fi
  chmod 600 "$stagedPath"
  if [[ ! -f "$mcpConfigPath" && -z "$remainingNames" ]] || filesAreIdentical "$stagedPath" "$mcpConfigPath"; then
    rm -f -- "$stagedPath"
    writeDotfilesState ai-managed-kimi-mcp-servers "$remainingNames"
    return 0
  fi
  mv -f -- "$stagedPath" "$mcpConfigPath"
  writeDotfilesState ai-managed-kimi-mcp-servers "$remainingNames"
  noteApplied "Kimi MCP servers" "converged"
}

renderAgentHooks() {
  local label="$1" basePath="$2" declarationPath="$3" hooksPath="$4" stateName="$5" groupName="${6:-}"
  local stagedPath
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "$label" "node not on PATH"
    return 0
  fi
  dotfilesStatePath "$stateName" || return 0
  mkdir -p -- "$(dirname -- "$hooksPath")"
  stagedPath="$(mktemp "$(dirname -- "$hooksPath")/.dotfiles-hooks.XXXXXX")"
  if ! node "$dotfilesRepo/ai/render-hooks.mjs" "$basePath" "$declarationPath" "$hooksPath" "$stagedPath" "$dotfilesStatePathValue" $groupName; then
    rm -f -- "$stagedPath"
    noteWarned "$label" "could not render hooks, convergence skipped"
    return 0
  fi
  if ! clearDestinationIfNotPlainFile "$label" "$hooksPath"; then
    rm -f -- "$stagedPath"
    return 0
  fi
  commitStagedFile "$label" "$stagedPath" "$hooksPath" "rendered"
}

renderCodexHooks() {
  local basePath="$dotfilesRepo/ai/codex-hooks.base.json"
  local declarationPath="$basePath"
  if [[ -f "$profileCodexHooksSource" ]]; then
    declarationPath="$profileCodexHooksSource"
  fi
  renderAgentHooks "Codex hooks" "$basePath" "$declarationPath" "$codexHome/hooks.json" ai-codex-owned-hook-commands
  clearDotfilesState ai-codex-hook-trust-epoch
  clearDotfilesState ai-codex-hook-trust-baseline
}

renderAgyHooks() {
  local basePath="$dotfilesRepo/ai/agy-hooks.base.json"
  local declarationPath="$basePath"
  if [[ -f "$profileAgyHooksSource" ]]; then
    declarationPath="$profileAgyHooksSource"
  fi
  renderAgentHooks "agy hooks" "$basePath" "$declarationPath" "$agyHome/config/hooks.json" ai-agy-owned-hook-commands dotfiles
}

syntaxEngineProbeStatus() {
  local probeStatus=0
  node "$dotfilesRepo/ai/hooks/validate-file.mjs" --probe-engine > /dev/null 2>&1 || probeStatus=$?
  printf '%s\n' "$probeStatus"
}

repairSyntaxEngine() {
  [[ "$(syntaxEngineProbeStatus)" == 1 ]] || return 0
  declare -F installGlobalNpmPackage > /dev/null || source "$dotfilesRepo/script/lib/packages.sh"
  local packageSource
  packageSource="$(listGlobalNpmPackages | awk -F '\t' '$1 == "@biomejs/biome" { print $1 ($2 == "" ? "" : "@" $2) }')" || true
  if [[ -z "$packageSource" ]]; then
    noteWarned "syntax engine" "biome cannot start and npm does not list it; the format guard checks JSON only"
    return 0
  fi
  noteStarting "syntax engine" "cannot start; npm install -g $packageSource"
  installGlobalNpmPackage "$packageSource" > /dev/null 2>&1 || true
  if [[ "$(syntaxEngineProbeStatus)" == 0 ]]; then
    noteInstalled "syntax engine" "reinstalled $packageSource"
    return 0
  fi
  noteWarned "syntax engine" "biome cannot start; the format guard checks JSON only"
}

# CLAUDE.md must be a plain file for Claude Code to follow its imports (AGENTS.md).
claudeImports=("@AGENTS.md")
if [[ -n "$(profilePlanNames source-AGENTS.md)" ]]; then
  claudeImports+=("@AGENTS.profile.md")
fi
writePlainFile "CLAUDE.md" "$claudeHome/CLAUDE.md" rendered printf '%s\n' "${claudeImports[@]}"

convergeAiProfileLink "AGENTS.profile.md" "AGENTS.md" "$claudeHome/AGENTS.profile.md"
convergeAiProfileLink "review-checklist.md" "review-checklist.md" "$claudeHome/review-checklist.md"
convergeAiProfileLink "owned-repos.txt" "owned-repos.txt" "$claudeHome/owned-repos.txt"

convergeAiProfileLink "profile hooks" "hooks" "$claudeHome/profile-hooks"
profileSettingsOverlayPath="$(profilePlanNames source-settings.overlay.json)"
if [[ ! -f "$profileSettingsOverlayPath" ]]; then
  profileSettingsOverlayPath=""
fi
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$profileSettingsOverlayPath" \
  "$claudeHome/settings.json"
renderCodexHooks
renderAgyHooks
repairSyntaxEngine
convergeMcpServers
if command -v kimi > /dev/null 2>&1; then
  convergeKimiMcpServers
fi

upgradeEnabledClaudePlugins() {
  [[ -n "${DOTFILES_UPGRADE:-}" ]] || return 0
  command -v claude >/dev/null 2>&1 || return 0
  local enabledPlugins
  local pluginId
  local marketplaceName
  local pluginListing
  local parsedPlugins
  local installedVersion
  local availableVersion
  declare -A enabledPluginIds=()
  declare -A refreshedMarketplaces=()
  declare -A failedMarketplaces=()
  if ! enabledPlugins="$(node -e '
    const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const [pluginId, isEnabled] of Object.entries(settings.enabledPlugins ?? {})) {
      if (isEnabled === true) console.log(pluginId);
    }
  ' "$claudeHome/settings.json")"; then
    recordFailedUpgrade plugin enabled unknown unknown
    return 0
  fi
  [[ -n "$enabledPlugins" ]] || return 0
  while IFS= read -r pluginId; do
    enabledPluginIds["$pluginId"]=1
    marketplaceName="${pluginId##*@}"
    [[ -z "${refreshedMarketplaces[$marketplaceName]:-}" ]] || continue
    refreshedMarketplaces["$marketplaceName"]=1
    if claude plugin marketplace update "$marketplaceName" >/dev/null 2>&1; then
      continue
    fi
    failedMarketplaces["$marketplaceName"]=1
  done <<< "$enabledPlugins"
  if ! pluginListing="$(claude plugin list --json --available 2>/dev/null)"; then
    while IFS= read -r pluginId; do
      recordFailedUpgrade plugin "$pluginId" unknown unknown
    done <<< "$enabledPlugins"
    return 0
  fi
  if ! parsedPlugins="$(node -e '
    const filesystem = require("node:fs");
    const path = require("node:path");
    const listing = JSON.parse(filesystem.readFileSync(0, "utf8"));
    const marketplacesDirectory = process.argv[1];
    const readJsonIfPresent = filePath => {
      try {
        return JSON.parse(filesystem.readFileSync(filePath, "utf8"));
      } catch {
        return undefined;
      }
    };
    const resolveAvailableVersion = pluginId => {
      const separatorIndex = pluginId.lastIndexOf("@");
      const pluginName = pluginId.slice(0, separatorIndex);
      const checkoutDirectory = path.join(marketplacesDirectory, pluginId.slice(separatorIndex + 1));
      const marketplace = readJsonIfPresent(path.join(checkoutDirectory, ".claude-plugin", "marketplace.json"));
      const marketplaceEntry = marketplace?.plugins?.find(plugin => plugin.name === pluginName);
      if (marketplaceEntry?.version) return marketplaceEntry.version;
      if (marketplaceEntry?.source && typeof marketplaceEntry.source === "object") return "unversioned";
      if (typeof marketplaceEntry?.source !== "string") return undefined;
      const pluginManifest = readJsonIfPresent(path.join(checkoutDirectory, marketplaceEntry.source, ".claude-plugin", "plugin.json"));
      if (pluginManifest && !pluginManifest.version) return "unversioned";
      return pluginManifest?.version;
    };
    for (const entry of listing.installed) {
      if (entry.readFromFolder) continue;
      console.log([entry.id, entry.version || "unknown", resolveAvailableVersion(entry.id) || "unknown"].join("\t"));
    }
  ' "$claudeHome/plugins/marketplaces" <<< "$pluginListing")"; then
    while IFS= read -r pluginId; do
      recordFailedUpgrade plugin "$pluginId" unknown unknown
    done <<< "$enabledPlugins"
    return 0
  fi
  while IFS=$'\t' read -r pluginId installedVersion availableVersion; do
    [[ -n "$pluginId" && -n "${enabledPluginIds[$pluginId]:-}" ]] || continue
    marketplaceName="${pluginId##*@}"
    if [[ -n "${failedMarketplaces[$marketplaceName]:-}" ]]; then
      continue
    fi
    if [[ "$availableVersion" == unversioned ]]; then
      areAllUpgradesApproved || continue
      if claude plugin update "$pluginId" >/dev/null 2>&1; then
        noteInstalled "$pluginId" "updated"
        continue
      fi
      recordFailedUpgrade plugin "$pluginId" "$installedVersion" unknown
      continue
    fi
    if [[ "$installedVersion" == unknown || "$availableVersion" == unknown ]]; then
      recordFailedUpgrade plugin "$pluginId" "$installedVersion" "$availableVersion"
      continue
    fi
    versionIsNewer "$installedVersion" "$availableVersion" || continue
    if shouldHoldUpgrade "$installedVersion" "$availableVersion"; then
      recordHeldUpgrade plugin "$pluginId" "$installedVersion" "$availableVersion"
      continue
    fi
    if claude plugin update "$pluginId" >/dev/null 2>&1; then
      noteInstalled "$pluginId" "upgraded from $installedVersion to $availableVersion"
      continue
    fi
    recordFailedUpgrade plugin "$pluginId" "$installedVersion" "$availableVersion"
  done <<< "$parsedPlugins"
  while IFS= read -r pluginId; do
    marketplaceName="${pluginId##*@}"
    [[ -n "${failedMarketplaces[$marketplaceName]:-}" ]] || continue
    recordFailedUpgrade plugin "$pluginId" unknown unknown
  done <<< "$enabledPlugins"
}

upgradeEnabledClaudePlugins

finishTopic
