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
  local retiredLinkScope="$1" entryKind="$2" entryLabel="$3"
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$claudeHome/$entryKind"
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

linkSharedEntries() {
  local repoEntryPath
  local entryName
  shopt -s nullglob
  for repoEntryPath in "$repoEntriesDirectory"/*; do
    entryIsLive "$entryKind" "$repoEntryPath" || continue
    entryName="$(basename -- "$repoEntryPath")"
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
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$claudeHome/$entryKind"
  moveEntryDirectoryAsideUnlessPlain
  mkdir -p -- "$installedEntriesDirectory"
  removeRetiredEntryLinks shared "$entryKind" "$entryLabel"
  linkSharedEntries
}

convergeProfileEntryDirectory() {
  local entryKind="$1"
  local entryLabel="$2"
  local repoEntriesDirectory="$dotfilesRepo/ai/$entryKind"
  local installedEntriesDirectory="$claudeHome/$entryKind"
  [[ -d "$installedEntriesDirectory" && ! -L "$installedEntriesDirectory" ]] || return 0
  removeRetiredEntryLinks profile "$entryKind" "$entryLabel"
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
convergeSharedEntryDirectory agents agent
removeRetiredEntryLinks shared commands command
convergeSharedEntryDirectory workflows workflow
installSharedSkillDependencies

linkEntry "AGENTS.md" "ai/AGENTS.md" "$claudeHome/AGENTS.md"
linkEntry "MODELS.md" "ai/MODELS.md" "$claudeHome/MODELS.md"
if pathIsLinkIntoThisRepo "$claudeHome/ROUTING.md"; then
  rm -f -- "$claudeHome/ROUTING.md"
  noteApplied "ROUTING.md" "retired link removed"
fi
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
profileMcpServersSource="$(profilePlanNames source-mcp-servers.json)"

convergeProfileEntryDirectory skills skill
installProfileSkillDependencies

# Codex reads one global AGENTS.md with no imports, so the profile rules are rendered into it.
renderCodexAgents() {
  local codexAgentsPath="$codexHome/AGENTS.md"
  local profileAgentsPath="$(profilePlanNames source-AGENTS.md)"
  mkdir -p -- "$codexHome"
  if pathIsLinkIntoThisRepo "$codexAgentsPath"; then
    rm -f -- "$codexAgentsPath"
  fi
  clearDestinationIfNotPlainFile "Codex AGENTS.md" "$codexAgentsPath" || return 0
  local stagedPath
  stagedPath="$(mktemp "$codexHome/.dotfiles-render.XXXXXX")"
  cat -- "$dotfilesRepo/ai/AGENTS.md" > "$stagedPath"
  if [[ -n "${profileName:-}" && -f "$profileAgentsPath" ]]; then
    printf '\n' >> "$stagedPath"
    cat -- "$profileAgentsPath" >> "$stagedPath"
  fi
  commitStagedFile "Codex AGENTS.md" "$stagedPath" "$codexAgentsPath" "rendered"
}

renderCodexAgents

serversLackingWiredConfinement() {
  local renderedHooksPath="$1"
  shift
  node --input-type=module - "$dotfilesRepo/ai/profile-config.mjs" "$renderedHooksPath" "$claudeHome/profile-hooks" "$@" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [profileConfigPath, renderedHooksPath, profileHooksDirectory, ...serverNames] = process.argv.slice(2);
const { confiningHookScriptName, wiresConfiningHook } = await import(pathToFileURL(profileConfigPath));
let hooksByEvent = {};
try {
  hooksByEvent = JSON.parse(fs.readFileSync(renderedHooksPath, 'utf8')).hooks ?? {};
} catch {}
for (const serverName of serverNames) {
  const confiningScriptPath = `${profileHooksDirectory}/${confiningHookScriptName(serverName)}`;
  if (fs.existsSync(confiningScriptPath) && wiresConfiningHook(hooksByEvent, confiningScriptPath, serverName)) continue;
  console.log(serverName);
}
NODE
}

serversWithoutConfinementIn() {
  local renderedHooksPath="$1"
  local isClientConfined="$2"
  local confinedServerNames=()
  local unconfinedServerNames
  mapfile -t confinedServerNames < <(profilePlanNames confine-server)
  ((${#confinedServerNames[@]} > 0)) || return 0
  if ((isClientConfined == 1)) && unconfinedServerNames="$(serversLackingWiredConfinement "$renderedHooksPath" "${confinedServerNames[@]}")"; then
    printf '%s' "$unconfinedServerNames"
    return 0
  fi
  printf '%s\n' "${confinedServerNames[@]}"
}

mcpPlanNeedsClaude() {
  local serverAction
  while IFS=$'\t' read -r _ serverAction _; do
    case "$serverAction" in
      add | replace | remove) return 0 ;;
    esac
  done <<< "$1"
  return 1
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
  local withheldServerNames
  withheldServerNames="$(serversWithoutConfinementIn "$claudeHome/settings.json" "$isClaudeConfined")"
  if [[ -n "$withheldServerNames" ]]; then
    noteWarned "MCP $withheldServerNames" "withheld until Claude confinement converges"
  fi
  managedNames="$(readDotfilesState ai-managed-mcp-servers || true)"
  if ! convergencePlan="$(node - "$profileMcpServersSource" "$HOME/.claude.json" "$managedNames" "$withheldServerNames" "$(profilePlanNames remove-server)" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [declarationPath, runtimePath, managedNames, withheldServerNames, removedNames] = process.argv.slice(2);
const declaredServers = fs.existsSync(declarationPath)
  ? JSON.parse(fs.readFileSync(declarationPath, 'utf8')) : {};
if (!declaredServers || typeof declaredServers !== 'object' || Array.isArray(declaredServers)) process.exit(1);
for (const serverName of withheldServerNames.split("\n").filter(Boolean)) delete declaredServers[serverName];
let currentServers = {};
try {
  currentServers = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))?.mcpServers ?? {};
} catch {}
if (!currentServers || typeof currentServers !== 'object' || Array.isArray(currentServers)) currentServers = {};
const managedNameSet = new Set(managedNames.split('\n').filter(Boolean));
const removedServerNames = [...removedNames.split("\n"), ...withheldServerNames.split("\n")].filter(Boolean);
const serverNames = new Set([...managedNameSet, ...Object.keys(declaredServers), ...removedServerNames]);
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

removeExcludedSkills() {
  local skillName skillPath
  while IFS= read -r skillName; do
    [[ -n "$skillName" ]] || continue
    for skillPath in "$claudeSkillsDirectory/$skillName" "$HOME/.agents/skills/$skillName"; do
      [[ -e "$skillPath" || -L "$skillPath" ]] || continue
      if rm -rf -- "$skillPath"; then
        noteApplied "skill $skillName" "removed $skillPath"
        continue
      fi
      noteWarned "skill $skillName" "could not remove $skillPath"
    done
  done < <(profilePlanNames remove-skill)
}

renderCodexHooksWithEpoch() {
  dotfilesStatePath ai-codex-owned-hook-commands || return 1
  codexOwnedHooksManifest="$(node "$dotfilesRepo/ai/render-codex-hooks.mjs" "$1" "$codexHome/hooks.json" "$2" "$3" "$dotfilesStatePathValue")"
}

newCodexHookTrustEpoch() {
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
}

# Codex hashes are deterministic per definition, so a baseline is only recorded alongside a fresh epoch that forces re-trust.
recordCodexHookTrustBaseline() {
  local manifestLines=()
  local currentTrust
  mapfile -t manifestLines <<< "$codexOwnedHooksManifest"
  if ! currentTrust="$(readCodexTrustedHashes "${manifestLines[@]:1}" 2>/dev/null)"; then
    noteWarned "Codex hooks" "could not read hook trust from config.toml"
    return 0
  fi
  writeDotfilesState ai-codex-hook-trust-epoch "$1"
  writeDotfilesState ai-codex-hook-trust-baseline "${manifestLines[0]}"$'\n'"$currentTrust"
}

renderCodexHooks() {
  local declarationPath="$dotfilesRepo/ai/codex-hooks.base.json"
  local hooksPath="$codexHome/hooks.json"
  local stagedPath
  local trustEpoch=""
  local recordedTrustBaseline
  local isTrustBaselineOwed=0
  areCodexHooksRendered=0
  codexOwnedHooksManifest=""
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "Codex hooks" "node not on PATH"
    return 0
  fi
  if [[ -f "$profileCodexHooksSource" ]]; then
    declarationPath="$profileCodexHooksSource"
    trustEpoch="$(readDotfilesState ai-codex-hook-trust-epoch || true)"
  fi
  if [[ -f "$profileCodexHooksSource" && -z "$trustEpoch" ]]; then
    isTrustBaselineOwed=1
    trustEpoch="$(newCodexHookTrustEpoch)"
  fi
  stagedPath="$(mktemp "$codexHome/.dotfiles-hooks.XXXXXX")"
  if ! renderCodexHooksWithEpoch "$declarationPath" "$stagedPath" "$trustEpoch"; then
    rm -f -- "$stagedPath"
    noteWarned "Codex hooks" "could not render hooks, convergence skipped"
    return 0
  fi
  if [[ -f "$profileCodexHooksSource" ]] && ((isTrustBaselineOwed == 0)); then
    recordedTrustBaseline="$(readDotfilesState ai-codex-hook-trust-baseline || true)"
    if [[ "${recordedTrustBaseline%%$'\n'*}" != "${codexOwnedHooksManifest%%$'\n'*}" ]]; then
      isTrustBaselineOwed=1
      trustEpoch="$(newCodexHookTrustEpoch)"
    fi
  fi
  if ((isTrustBaselineOwed == 1)) && ! renderCodexHooksWithEpoch "$declarationPath" "$stagedPath" "$trustEpoch"; then
    rm -f -- "$stagedPath"
    noteWarned "Codex hooks" "could not render hooks, convergence skipped"
    return 0
  fi
  if ! clearDestinationIfNotPlainFile "Codex hooks" "$hooksPath"; then
    rm -f -- "$stagedPath"
    return 0
  fi
  commitStagedFile "Codex hooks" "$stagedPath" "$hooksPath" "rendered"
  areCodexHooksRendered=1
  ((isTrustBaselineOwed == 1)) || return 0
  recordCodexHookTrustBaseline "$trustEpoch"
}

readCodexTrustedHashes() {
  node - "$codexHome/config.toml" "$@" <<'NODE'
const fs = require('node:fs');
const [configPath, ...stateKeys] = process.argv.slice(2);
const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
const quotedString = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
const unquote = (token) => (token.startsWith("'") ? token.slice(1, -1) : JSON.parse(token));
const keyedStateTable = new RegExp(String.raw`^\[\s*hooks\s*\.\s*state\s*\.\s*(${quotedString})\s*\]$`);
const sharedStateTable = /^\[\s*hooks\s*\.\s*state\s*\]$/;
const trustedHashAssignment = new RegExp(String.raw`^trusted_hash\s*=\s*(${quotedString})`);
const inlineStateEntry = new RegExp(String.raw`^(${quotedString})\s*=\s*\{.*\btrusted_hash\s*=\s*(${quotedString})`);
const trustedHashByKey = new Map();
let keyedTableName;
let isInSharedStateTable = false;
for (const line of configText.split(/\r?\n/).map((rawLine) => rawLine.trim())) {
  if (line.startsWith('[')) {
    const keyedTable = keyedStateTable.exec(line);
    keyedTableName = keyedTable ? unquote(keyedTable[1]) : undefined;
    isInSharedStateTable = sharedStateTable.test(line);
    continue;
  }
  const keyedAssignment = keyedTableName === undefined ? null : trustedHashAssignment.exec(line);
  if (keyedAssignment) trustedHashByKey.set(keyedTableName, unquote(keyedAssignment[1]));
  const inlineEntry = isInSharedStateTable ? inlineStateEntry.exec(line) : null;
  if (inlineEntry) trustedHashByKey.set(unquote(inlineEntry[1]), unquote(inlineEntry[2]));
}
for (const stateKey of stateKeys) process.stdout.write(`${stateKey}\t${trustedHashByKey.get(stateKey) ?? ''}\n`);
NODE
}

# Codex skips changed hooks until trusted and keeps its hash private, so trust counts once each owned hash moves off the value recorded at the last change.
confirmCodexHookTrust() {
  local manifestLines=()
  local currentTrust
  local recordedTrustLines=()
  local recordedTrustLine
  local stateKey
  local trustedHash
  declare -A recordedHashByKey=()
  isCodexHookTrustConfirmed=0
  mapfile -t manifestLines <<< "$codexOwnedHooksManifest"
  if ((${#manifestLines[@]} < 2)); then
    noteWarned "Codex hooks" "no confinement hooks declared"
    return 0
  fi
  if ! currentTrust="$(readCodexTrustedHashes "${manifestLines[@]:1}" 2>/dev/null)"; then
    noteWarned "Codex hooks" "could not read hook trust from config.toml"
    return 0
  fi
  mapfile -t recordedTrustLines <<< "$(readDotfilesState ai-codex-hook-trust-baseline || true)"
  if [[ "${recordedTrustLines[0]:-}" != "${manifestLines[0]}" ]]; then
    noteWarned "Codex hooks" "open codex, review hooks with /hooks, then rerun dot"
    return 0
  fi
  for recordedTrustLine in "${recordedTrustLines[@]:1}"; do
    IFS=$'\t' read -r stateKey trustedHash <<< "$recordedTrustLine"
    [[ -n "$stateKey" ]] || continue
    recordedHashByKey["$stateKey"]="$trustedHash"
  done
  while IFS=$'\t' read -r stateKey trustedHash; do
    [[ -n "$stateKey" ]] || continue
    if [[ -z "$trustedHash" || "$trustedHash" == "${recordedHashByKey[$stateKey]:-}" ]]; then
      noteWarned "Codex hooks" "open codex, review hooks with /hooks, then rerun dot"
      return 0
    fi
  done <<< "$currentTrust"
  isCodexHookTrustConfirmed=1
}

codexConfigDeclaresServer() {
  [[ -f "$codexHome/config.toml" ]] || return 1
  grep -qE "^[[:space:]]*\[[[:space:]]*mcp_servers[[:space:]]*\.[[:space:]]*[\"']?$1[\"']?[[:space:]]*[].]" "$codexHome/config.toml"
}

convergeCodexServer() {
  local serverName="$1"
  local shouldRemove="$2"
  local isConfinementMissing="$3"
  local serverConfiguration=""
  local isServerPresent=0
  local configPath="$codexHome/config.toml"
  local stagedDirectory
  local stagedPath
  local urlAssignment
  local isServerEnabled=0
  local enabledAssignment="enabled = false"
  if [[ "$shouldRemove" == 0 ]] && ((isConfinementMissing == 0)); then
    isServerEnabled=1
    enabledAssignment="enabled = true"
  fi
  if ! command -v codex > /dev/null 2>&1; then
    if [[ "$shouldRemove" == 1 || "$isConfinementMissing" == 1 ]] && codexConfigDeclaresServer "$serverName"; then
      noteWarned "Codex MCP $serverName" "codex not on PATH, config.toml still declares this server"
    fi
    return 0
  fi
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "Codex MCP $serverName" "node not on PATH"
    return 0
  fi
  if serverConfiguration="$(CODEX_HOME="$codexHome" codex mcp get "$serverName" --json 2>/dev/null)"; then
    isServerPresent=1
  fi
  if ((isServerPresent == 0)) && ! CODEX_HOME="$codexHome" codex mcp list --json > /dev/null 2>&1; then
    noteWarned "Codex MCP $serverName" "could not read configuration, convergence skipped"
    return 0
  fi
  if [[ "$shouldRemove" == 1 ]]; then
    if ((isServerPresent == 0)); then
      codexManagedNames="$(grep -vxF "$serverName" <<< "$codexManagedNames" || true)"
      writeDotfilesState ai-managed-codex-mcp-servers "$codexManagedNames"
      return 0
    fi
    if CODEX_HOME="$codexHome" codex mcp remove "$serverName" > /dev/null 2>&1; then
      noteApplied "Codex MCP $serverName" "removed"
      codexManagedNames="$(grep -vxF "$serverName" <<< "$codexManagedNames" || true)"
      writeDotfilesState ai-managed-codex-mcp-servers "$codexManagedNames"
      return 0
    fi
    noteWarned "Codex MCP $serverName" "remove failed"
    return 0
  fi
  if ! urlAssignment="$(node -e 'const servers = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log("url = " + JSON.stringify(servers[process.argv[2]].url))' "$profileMcpServersSource" "$serverName")"; then
    noteWarned "Codex MCP $serverName" "could not read declaration"
    return 0
  fi
  if ((isServerEnabled == 0)); then
    noteWarned "Codex MCP $serverName" "disabled until Codex confinement converges"
  fi
  if ((isServerPresent == 1)) && ! grep -qxF "$serverName" <<< "$codexManagedNames" \
    && ! profilePlanNames exclusive-server | grep -qxF "$serverName"; then
    noteWarned "Codex MCP $serverName" "an unmanaged server with this name blocks convergence"
    return 0
  fi
  if ! grep -qxF "$serverName" <<< "$codexManagedNames"; then
    codexManagedNames+="${codexManagedNames:+$'\n'}$serverName"
    writeDotfilesState ai-managed-codex-mcp-servers "$codexManagedNames"
    if [[ "$(readDotfilesState ai-managed-codex-mcp-servers || true)" != "$codexManagedNames" ]]; then
      noteWarned "Codex MCP $serverName" "could not record ownership, convergence skipped"
      return 0
    fi
  fi
  if ((isServerPresent == 1)) && node -e 'const server = JSON.parse(process.argv[1]); const declared = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"))[process.argv[4]]; process.exit(Boolean(server.enabled) === (process.argv[3] === "1") && server.transport?.type === "streamable_http" && server.transport.url === declared.url ? 0 : 1)' "$serverConfiguration" "$profileMcpServersSource" "$isServerEnabled" "$serverName"; then
    return 0
  fi
  if ! pathIsPlainFileOrAbsent "$configPath"; then
    noteWarned "Codex MCP $serverName" "config.toml is not a plain file, convergence skipped"
    return 0
  fi
  stagedDirectory="$(mktemp -d "$codexHome/.dotfiles-mcp.XXXXXX")"
  stagedPath="$stagedDirectory/config.toml"
  : > "$stagedPath"
  chmod 600 "$stagedPath"
  if [[ -f "$configPath" ]]; then
    cat -- "$configPath" > "$stagedPath"
  fi
  if ((isServerPresent == 1)) && ! CODEX_HOME="$stagedDirectory" codex mcp remove "$serverName" > /dev/null 2>&1; then
    rm -rf -- "$stagedDirectory"
    noteWarned "Codex MCP $serverName" "remove failed"
    return 0
  fi
  printf '\n[mcp_servers.%s]\n%s\n%s\n' "$serverName" "$urlAssignment" "$enabledAssignment" >> "$stagedPath"
  if ! CODEX_HOME="$stagedDirectory" codex mcp get "$serverName" --json > /dev/null 2>&1; then
    rm -rf -- "$stagedDirectory"
    noteWarned "Codex MCP $serverName" "rendered configuration is invalid, convergence skipped"
    return 0
  fi
  chmod 600 "$stagedPath"
  if mv -f -- "$stagedPath" "$configPath"; then
    rm -rf -- "$stagedDirectory"
    noteApplied "Codex MCP $serverName" "configured"
    return 0
  fi
  rm -rf -- "$stagedDirectory"
  noteWarned "Codex MCP $serverName" "could not write configuration"
}

convergeCodexServers() {
  local serverName isConfinementMissing
  local codexManagedNames
  local activeServerNames
  local removedServerNames
  local unconfinedServerNames
  declare -A hasRetiredServer=()
  codexManagedNames="$(readDotfilesState ai-managed-codex-mcp-servers || true)"
  activeServerNames="$(profilePlanNames codex-server)"
  unconfinedServerNames="$(serversWithoutConfinementIn "$codexHome/hooks.json" "$isCodexConfined")"
  removedServerNames="$(profilePlanNames remove-server)"
  while IFS= read -r serverName; do
    [[ -n "$serverName" ]] || continue
    grep -qxF "$serverName" <<< "$activeServerNames" && continue
    removedServerNames+="${removedServerNames:+$'\n'}$serverName"
  done <<< "$codexManagedNames"
  while IFS= read -r serverName; do
    [[ -n "$serverName" ]] || continue
    [[ -z "${hasRetiredServer[$serverName]:-}" ]] || continue
    hasRetiredServer["$serverName"]=1
    convergeCodexServer "$serverName" 1 0
  done <<< "$removedServerNames"
  while IFS= read -r serverName; do
    [[ -n "$serverName" ]] || continue
    isConfinementMissing=0
    if grep -qxF "$serverName" <<< "$unconfinedServerNames"; then
      isConfinementMissing=1
    fi
    convergeCodexServer "$serverName" 0 "$isConfinementMissing"
  done <<< "$activeServerNames"
}

# CLAUDE.md must be a copy for Claude Code to follow its @AGENTS.md import (AGENTS.md).
profileClaudeSource="$(profilePlanNames source-CLAUDE.md)"
copyEntry "CLAUDE.md" "${profileClaudeSource#"$dotfilesRepo/"}" "$claudeHome/CLAUDE.md"

convergeAiProfileLink "AGENTS.profile.md" "AGENTS.md" "$claudeHome/AGENTS.profile.md"
convergeAiProfileLink "review-checklist.md" "review-checklist.md" "$claudeHome/review-checklist.md"

isClaudeConfined=0
isCodexConfined=0
isProfileHooksLinkCurrent=0
warningsBeforeConfinement="$warningsEmittedHere"
convergeAiProfileLink "profile hooks" "hooks" "$claudeHome/profile-hooks"
if ((warningsEmittedHere == warningsBeforeConfinement)) \
  && linkIsCurrent "${profileHooksSource#"$dotfilesRepo/"}" "$claudeHome/profile-hooks" \
  && [[ -d "$claudeHome/profile-hooks" ]]; then
  isProfileHooksLinkCurrent=1
fi
profileSettingsOverlayPath="$(profilePlanNames source-settings.overlay.json)"
if [[ ! -f "$profileSettingsOverlayPath" ]]; then
  profileSettingsOverlayPath=""
fi
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$profileSettingsOverlayPath" \
  "$claudeHome/settings.json"
if ((warningsEmittedHere == warningsBeforeConfinement && isProfileHooksLinkCurrent == 1)) && [[ -n "$profileSettingsOverlayPath" ]]; then
  isClaudeConfined=1
fi
removeExcludedSkills
renderCodexHooks
if command -v codex > /dev/null 2>&1 && [[ -f "$profileCodexHooksSource" ]] && ((isProfileHooksLinkCurrent == 1 && areCodexHooksRendered == 1)); then
  confirmCodexHookTrust
  isCodexConfined="$isCodexHookTrustConfirmed"
fi
convergeCodexServers
convergeMcpServers

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
