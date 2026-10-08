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
profileSkillsDirectory=""
if [[ -n "${profileName:-}" && -d "$dotfilesRepo/profiles/$profileName/skills" ]]; then
  profileSkillsDirectory="$dotfilesRepo/profiles/$profileName/skills"
fi
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

sharedSkillExists() {
  [[ -e "$repoSkillsDirectory/$1" || -L "$repoSkillsDirectory/$1" ]]
}

linkTargetsCurrentProfileSkill() {
  local skillName="$1"
  local linkedSkillTarget="$2"
  [[ -n "$profileSkillsDirectory" && -e "$profileSkillsDirectory/$skillName" ]] || return 1
  [[ "$linkedSkillTarget" == "$dotfilesAlias/profiles/$profileName/skills/$skillName" \
    || "$linkedSkillTarget" == "$profileSkillsDirectory/$skillName" ]]
}

removeRetiredSkillLinks() {
  local installedSkillPath
  local skillName
  local linkedSkillTarget
  shopt -s dotglob nullglob
  for installedSkillPath in "$claudeSkillsDirectory"/*; do
    [[ -L "$installedSkillPath" ]] || continue
    skillName="$(basename -- "$installedSkillPath")"
    linkedSkillTarget="$(symlinkTargetOf "$installedSkillPath")"
    case "$linkedSkillTarget" in
      "$dotfilesAlias/ai/skills/"* | "$dotfilesRepo/ai/skills/"*)
        [[ ! -e "$repoSkillsDirectory/$skillName" ]] || continue
        ;;
      "$dotfilesAlias/profiles/"*/skills/* | "$dotfilesRepo/profiles/"*/skills/*)
        ! linkTargetsCurrentProfileSkill "$skillName" "$linkedSkillTarget" || continue
        ;;
      *) continue ;;
    esac
    rm -f -- "$installedSkillPath"
    noteApplied "skill $skillName" "retired link removed"
  done
  shopt -u dotglob nullglob
}

linkRepoSkills() {
  local skillDirectories=("$repoSkillsDirectory")
  local skillDirectory
  local repoSkillPath
  local skillName
  if [[ -n "$profileSkillsDirectory" ]]; then
    skillDirectories+=("$profileSkillsDirectory")
  fi
  shopt -s nullglob
  for skillDirectory in "${skillDirectories[@]}"; do
    for repoSkillPath in "$skillDirectory"/*; do
      skillName="$(basename -- "$repoSkillPath")"
      if [[ "$skillDirectory" != "$repoSkillsDirectory" ]] && sharedSkillExists "$skillName"; then
        noteWarned "skill $skillName" "profile skill conflicts with shared skill, keeping shared skill"
        continue
      fi
      linkEntry "skill $skillName" "${repoSkillPath#"$dotfilesRepo/"}" "$claudeSkillsDirectory/$skillName"
    done
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
  if [[ -n "$profileSkillsDirectory" ]]; then
    skillLockPaths+=("$profileSkillsDirectory"/*/package-lock.json)
  fi
  shopt -u nullglob
  for skillLockPath in "${skillLockPaths[@]}"; do
    skillDirectory="$(dirname -- "$skillLockPath")"
    skillName="$(basename -- "$skillDirectory")"
    if [[ "$skillDirectory" != "$repoSkillsDirectory/$skillName" ]] && sharedSkillExists "$skillName"; then
      continue
    fi
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

# Codex reads one global AGENTS.md with no imports, so the profile rules are rendered into it.
renderCodexAgents() {
  local codexAgentsPath="$codexHome/AGENTS.md"
  local profileAgentsPath="$dotfilesRepo/profiles/${profileName:-}/AGENTS.md"
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
  local withheldServerName=""
  if [[ "$profileName" == work ]] && ((isClaudeConfined == 0)); then
    withheldServerName="backchannels"
    noteWarned "MCP backchannels" "withheld until Claude confinement converges"
  fi
  managedNames="$(readDotfilesState ai-managed-mcp-servers || true)"
  if ! convergencePlan="$(node - "$dotfilesRepo/profiles/$profileName/mcp-servers.json" "$HOME/.claude.json" "$managedNames" "$withheldServerName" 2>/dev/null <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [declarationPath, runtimePath, managedNames, withheldServerName] = process.argv.slice(2);
const declaredServers = fs.existsSync(declarationPath)
  ? JSON.parse(fs.readFileSync(declarationPath, 'utf8')) : {};
if (!declaredServers || typeof declaredServers !== 'object' || Array.isArray(declaredServers)) process.exit(1);
if (withheldServerName) delete declaredServers[withheldServerName];
let currentServers = {};
try {
  currentServers = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))?.mcpServers ?? {};
} catch {}
if (!currentServers || typeof currentServers !== 'object' || Array.isArray(currentServers)) currentServers = {};
const managedNameSet = new Set(managedNames.split('\n').filter(Boolean));
const removedServerNames = Object.hasOwn(declaredServers, "backchannels") ? [] : ["backchannels"];
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

convergeProfileHooks() {
  local destination="$claudeHome/profile-hooks"
  if [[ "$profileName" == work || "$profileName" == work-server ]]; then
    linkEntry "profile hooks" "profiles/work/hooks" "$destination"
    return 0
  fi
  pathIsLinkIntoThisRepo "$destination" || return 0
  rm -f -- "$destination"
  noteApplied "profile hooks" "retired link removed"
}

removeNonWorkBackchannelsSkills() {
  [[ "$profileName" != work ]] || return 0
  local removedSkillPaths=("$claudeSkillsDirectory/backchannels" "$HOME/.agents/skills/backchannels")
  local removedSkillPath
  for removedSkillPath in "${removedSkillPaths[@]}"; do
    [[ -e "$removedSkillPath" || -L "$removedSkillPath" ]] || continue
    if rm -rf -- "$removedSkillPath"; then
      noteApplied "backchannels skill" "removed $removedSkillPath"
      continue
    fi
    noteWarned "backchannels skill" "could not remove $removedSkillPath"
  done
}

renderCodexHooksWithEpoch() {
  codexOwnedHooksManifest="$(node "$dotfilesRepo/ai/render-codex-hooks.mjs" "$1" "$codexHome/hooks.json" "$2" "$3")"
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
  if [[ "$profileName" == work ]]; then
    declarationPath="$dotfilesRepo/profiles/work/codex-hooks.json"
    trustEpoch="$(readDotfilesState ai-codex-hook-trust-epoch || true)"
  fi
  if [[ "$profileName" == work && -z "$trustEpoch" ]]; then
    isTrustBaselineOwed=1
    trustEpoch="$(newCodexHookTrustEpoch)"
  fi
  stagedPath="$(mktemp "$codexHome/.dotfiles-hooks.XXXXXX")"
  if ! renderCodexHooksWithEpoch "$declarationPath" "$stagedPath" "$trustEpoch"; then
    rm -f -- "$stagedPath"
    noteWarned "Codex hooks" "could not render hooks, convergence skipped"
    return 0
  fi
  if [[ "$profileName" == work ]] && ((isTrustBaselineOwed == 0)); then
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

convergeCodexBackchannels() {
  local serverConfiguration=""
  local isServerPresent=0
  local configPath="$codexHome/config.toml"
  local stagedDirectory
  local stagedPath
  local urlAssignment
  local isServerEnabled=0
  local enabledAssignment="enabled = false"
  if [[ "$profileName" == work ]] && ((isCodexConfined == 1)); then
    isServerEnabled=1
    enabledAssignment="enabled = true"
  fi
  if ! command -v codex > /dev/null 2>&1; then
    [[ "$profileName" == work ]] || return 0
    noteWarned "Codex MCP backchannels" "codex not found, convergence skipped"
    return 0
  fi
  if ! command -v node > /dev/null 2>&1; then
    noteWarned "Codex MCP backchannels" "node not on PATH"
    return 0
  fi
  if serverConfiguration="$(CODEX_HOME="$codexHome" codex mcp get backchannels --json 2>/dev/null)"; then
    isServerPresent=1
  fi
  if ((isServerPresent == 0)) && ! CODEX_HOME="$codexHome" codex mcp list --json > /dev/null 2>&1; then
    noteWarned "Codex MCP backchannels" "could not read configuration, convergence skipped"
    return 0
  fi
  if [[ "$profileName" != work ]]; then
    ((isServerPresent == 1)) || return 0
    if CODEX_HOME="$codexHome" codex mcp remove backchannels > /dev/null 2>&1; then
      noteApplied "Codex MCP backchannels" "removed"
      return 0
    fi
    noteWarned "Codex MCP backchannels" "remove failed"
    return 0
  fi
  if ! urlAssignment="$(node -e 'const servers = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log("url = " + JSON.stringify(servers.backchannels.url))' "$dotfilesRepo/profiles/work/mcp-servers.json")"; then
    noteWarned "Codex MCP backchannels" "could not read declaration"
    return 0
  fi
  if ((isServerEnabled == 0)); then
    noteWarned "Codex MCP backchannels" "disabled until Codex confinement converges"
  fi
  if ((isServerPresent == 1)) && node -e 'const server = JSON.parse(process.argv[1]); const declared = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8")).backchannels; process.exit(Boolean(server.enabled) === (process.argv[3] === "1") && server.transport?.type === "streamable_http" && server.transport.url === declared.url ? 0 : 1)' "$serverConfiguration" "$dotfilesRepo/profiles/work/mcp-servers.json" "$isServerEnabled"; then
    return 0
  fi
  if ! pathIsPlainFileOrAbsent "$configPath"; then
    noteWarned "Codex MCP backchannels" "config.toml is not a plain file, convergence skipped"
    return 0
  fi
  stagedDirectory="$(mktemp -d "$codexHome/.dotfiles-mcp.XXXXXX")"
  stagedPath="$stagedDirectory/config.toml"
  : > "$stagedPath"
  chmod 600 "$stagedPath"
  if [[ -f "$configPath" ]]; then
    cat -- "$configPath" > "$stagedPath"
  fi
  if ((isServerPresent == 1)) && ! CODEX_HOME="$stagedDirectory" codex mcp remove backchannels > /dev/null 2>&1; then
    rm -rf -- "$stagedDirectory"
    noteWarned "Codex MCP backchannels" "remove failed"
    return 0
  fi
  printf '\n[mcp_servers.backchannels]\n%s\n%s\n' "$urlAssignment" "$enabledAssignment" >> "$stagedPath"
  if ! CODEX_HOME="$stagedDirectory" codex mcp get backchannels --json > /dev/null 2>&1; then
    rm -rf -- "$stagedDirectory"
    noteWarned "Codex MCP backchannels" "rendered configuration is invalid, convergence skipped"
    return 0
  fi
  chmod 600 "$stagedPath"
  if mv -f -- "$stagedPath" "$configPath"; then
    rm -rf -- "$stagedDirectory"
    noteApplied "Codex MCP backchannels" "configured"
    return 0
  fi
  rm -rf -- "$stagedDirectory"
  noteWarned "Codex MCP backchannels" "could not write configuration"
}

if [[ -z "${profileName:-}" ]]; then
  noteWarned "profile files" "no profile resolved, CLAUDE.md and settings.json skipped"
  finishTopic
fi

# CLAUDE.md must be a copy for Claude Code to follow its @AGENTS.md import (AGENTS.md).
copyEntry "CLAUDE.md" "profiles/$profileName/CLAUDE.md" "$claudeHome/CLAUDE.md"

convergeOptionalProfileLink() {
  local label="$1"
  local profileSource="profiles/$profileName/$2"
  local destination="$claudeHome/$label"
  if [[ -f "$dotfilesRepo/$profileSource" ]]; then
    linkEntry "$label" "$profileSource" "$destination"
    return 0
  fi
  pathIsLinkIntoThisRepo "$destination" || return 0
  rm -f -- "$destination"
  noteApplied "$label" "retired link removed"
}

convergeOptionalProfileLink "AGENTS.profile.md" "AGENTS.md"
convergeOptionalProfileLink "review-checklist.md" "review-checklist.md"

isClaudeConfined=0
isCodexConfined=0
isProfileHooksLinkCurrent=0
warningsBeforeConfinement="$warningsEmittedHere"
convergeProfileHooks
if ((warningsEmittedHere == warningsBeforeConfinement)); then
  isProfileHooksLinkCurrent=1
fi
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$dotfilesRepo/profiles/$profileName/settings.overlay.json" \
  "$claudeHome/settings.json"
if ((warningsEmittedHere == warningsBeforeConfinement)); then
  isClaudeConfined=1
fi
removeNonWorkBackchannelsSkills
renderCodexHooks
if [[ "$profileName" == work ]] && ((isProfileHooksLinkCurrent == 1 && areCodexHooksRendered == 1)); then
  confirmCodexHookTrust
  isCodexConfined="$isCodexHookTrustConfirmed"
fi
convergeCodexBackchannels
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
    if ! areAllUpgradesApproved; then
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
