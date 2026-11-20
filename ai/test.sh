#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

for skillWithDependenciesDirectory in "$topicDir/skills/auditing-brand" "$topicDir/skills/designing-ui"; do
  if [[ ! -d "$skillWithDependenciesDirectory/node_modules" ]]; then
    (cd -- "$skillWithDependenciesDirectory" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund > /dev/null)
  fi
done

startSandboxHome "ai"

mkdir -p "$sandbox/.claude/projects/live-work" "$sandbox/.claude/sessions"
printf 'runtime\n' > "$sandbox/.claude/projects/live-work/state.json"
printf '{"token":"keep-me"}\n' > "$sandbox/.claude/.credentials.json"
printf 'pre-existing user notes\n' > "$sandbox/.claude/AGENTS.md"

stagedRepo="$sandbox/staged-dotfiles"
mkdir -p "$stagedRepo"
stagedRepo="$(cd -- "$stagedRepo" && pwd)"
cp -R "$repoRoot/." "$stagedRepo"
rm -rf "$stagedRepo/.git" "$stagedRepo"/ai/skills/*/node_modules "$stagedRepo"/profiles/*/skills/*/node_modules "$stagedRepo/profiles/personal/mcp-servers.json"
stagedTopicDir="$stagedRepo/ai"
workSkillNames=()
for workSkillManifestPath in "$repoRoot"/profiles/work/skills/*/SKILL.md; do
  workSkillNames+=("$(basename -- "$(dirname -- "$workSkillManifestPath")")")
done
profileDependencySkillPath="$stagedRepo/profiles/work/skills/locked-profile-skill-test"
mkdir -p "$profileDependencySkillPath"
printf '{}\n' > "$profileDependencySkillPath/package-lock.json"

rm -f "$sandbox/.dotfiles"
ln -s "$stagedRepo" "$sandbox/.dotfiles"

skillDependencyLog="$sandbox/skill-dependency-commands.log"
: > "$skillDependencyLog"
skillDependencyStubBin="$sandbox/skill-dependency-stub-bin"
mkdir -p "$skillDependencyStubBin"
cat > "$skillDependencyStubBin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s in %s\n' "$*" "$PWD" >> "$SKILL_DEPENDENCY_LOG"
if [[ "$1 $2" == "ls -g" ]]; then
  printf '%s\n' "$HOME/npm-global/lib" "$HOME/npm-global/lib/node_modules/@biomejs/biome"
  exit 0
fi
if [[ "$1 $2" == "install -g" ]]; then
  rm -f "$HOME/.syntax-engine-cannot-start"
  exit 0
fi
skillDirectory="$PWD"
mkdir -p "$skillDirectory/node_modules/.bin"
printf '{}\n' > "$skillDirectory/node_modules/.package-lock.json"
cat > "$skillDirectory/node_modules/.bin/playwright-core" <<'PLAYWRIGHT'
#!/usr/bin/env bash
printf 'playwright-core %s\n' "$*" >> "$SKILL_DEPENDENCY_LOG"
PLAYWRIGHT
chmod +x "$skillDirectory/node_modules/.bin/playwright-core"
STUB
chmod +x "$skillDependencyStubBin/npm"
printf '#!/usr/bin/env bash\n[[ ! -e "$HOME/.syntax-engine-cannot-start" ]]\n' > "$skillDependencyStubBin/biome"
chmod +x "$skillDependencyStubBin/biome"
export BIOME_BIN="$skillDependencyStubBin/biome"
export PATH="$skillDependencyStubBin:$PATH"
export SKILL_DEPENDENCY_LOG="$skillDependencyLog"
export XDG_STATE_HOME="$sandbox/.local/state"
mcpCommandLog="$sandbox/mcp-commands.log"
: > "$mcpCommandLog"
export MCP_COMMAND_LOG="$mcpCommandLog"
cat > "$skillDependencyStubBin/claude" <<'STUB'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argumentsPassed = process.argv.slice(2);
fs.appendFileSync(process.env.MCP_COMMAND_LOG, `${JSON.stringify(argumentsPassed)}\n`);
const runtimePath = path.join(process.env.HOME, '.claude.json');
let runtimeSettings = {};
try {
  runtimeSettings = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
} catch {}
runtimeSettings.mcpServers ??= {};
const [group, action, scopeFlag, scope, serverName, serverConfig] = argumentsPassed;
if (group === 'plugin') {
  if (action === 'marketplace') process.exit(fs.existsSync(path.join(process.env.HOME, '.fail-plugin-marketplace')) ? 1 : 0);
  if (action === 'list') {
    console.log(fs.readFileSync(path.join(process.env.HOME, '.plugin-list.json'), 'utf8'));
    process.exit(0);
  }
  if (action === 'update') process.exit(fs.existsSync(path.join(process.env.HOME, '.fail-plugin-update')) ? 1 : 0);
  process.exit(1);
}
if (group !== 'mcp') process.exit(1);
if (action === 'get') process.exit(Object.hasOwn(runtimeSettings.mcpServers, scopeFlag) ? 0 : 1);
if (scopeFlag !== '--scope' || scope !== 'user') process.exit(1);
if (fs.existsSync(path.join(process.env.HOME, `.fail-mcp-${action}`))) process.exit(1);
if (action === 'add-json') {
  if (Object.hasOwn(runtimeSettings.mcpServers, serverName)) process.exit(1);
  runtimeSettings.mcpServers[serverName] = JSON.parse(serverConfig);
}
if (action === 'remove') {
  if (!Object.hasOwn(runtimeSettings.mcpServers, serverName)) process.exit(1);
  delete runtimeSettings.mcpServers[serverName];
}
if (!['add-json', 'remove'].includes(action)) process.exit(1);
fs.writeFileSync(runtimePath, JSON.stringify(runtimeSettings));
STUB
chmod +x "$skillDependencyStubBin/claude"
codexMcpCommandLog="$sandbox/codex-mcp-commands.log"
: > "$codexMcpCommandLog"
export CODEX_MCP_COMMAND_LOG="$codexMcpCommandLog"
cp "$repoRoot/test/fixtures/codex-mcp.cjs" "$skillDependencyStubBin/codex"
chmod +x "$skillDependencyStubBin/codex"
printf '{"mcpServers":{"foreign":{"type":"http","url":"https://unmanaged.invalid/mcp"}},"runtimeToken":"keep-me"}\n' \
  > "$sandbox/.claude.json"

mcpRuntimeMatches() {
  node - "$sandbox/.claude.json" "$1" <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [runtimePath, expectedPosthogUrl] = process.argv.slice(2);
const runtimeSettings = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
const expectedServers = { foreign: { type: 'http', url: 'https://unmanaged.invalid/mcp' } };
if (expectedPosthogUrl) expectedServers.posthog = { type: 'http', url: expectedPosthogUrl };
if (expectedPosthogUrl) expectedServers.gauge = { type: 'http', url: 'https://app.withgauge.com/mcp' };
process.exit(isDeepStrictEqual(runtimeSettings.mcpServers, expectedServers) && runtimeSettings.runtimeToken === 'keep-me' ? 0 : 1);
NODE
}

countMcpCommands() {
  grep -cF "[\"mcp\",\"$1\"" "$mcpCommandLog" || true
}

mkdir -p "$sandbox/.codex" "$sandbox/.agents/skills/foreign"
printf 'foreign skill\n' > "$sandbox/.agents/skills/foreign/SKILL.md"
cat > "$sandbox/.codex/config.toml" <<'TOML'
model = "keep-model"
[hooks.state]
foreign = { enabled = true, trusted_hash = "keep-trust" }
[mcp_servers.foreign]
url = "https://foreign.invalid/mcp"
TOML
node - "$sandbox/.codex/hooks.json" "$sandbox/.claude.json" <<'NODE'
const fs = require('node:fs');
const [hooksPath, runtimePath] = process.argv.slice(2);
const foreignHandler = {type:'command', command:'printf foreign-context', timeout:3};
fs.writeFileSync(hooksPath, JSON.stringify({description:'foreign metadata', hooks:{SessionStart:[{matcher:'startup|resume|clear', hooks:[foreignHandler]}], Stop:[{hooks:[foreignHandler]}]}}));
const runtimeSettings = JSON.parse(fs.readFileSync(runtimePath,'utf8'));
runtimeSettings.mcpServers.backchannels = {type:'http', url:'https://api.backchannels.dev/mcp'};
fs.writeFileSync(runtimePath,JSON.stringify(runtimeSettings));
NODE
mkdir -p "$XDG_STATE_HOME/dotfiles"
printf 'backchannels\n' > "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"

retiredManagedServerIsAbsent() {
  node - "$sandbox" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const homeDirectory = process.argv[2];
const runtime = JSON.parse(fs.readFileSync(path.join(homeDirectory, '.claude.json'), 'utf8'));
process.exit(!runtime.mcpServers.backchannels && !fs.existsSync(path.join(homeDirectory, '.claude/profile-hooks')) ? 0 : 1);
NODE
}

foreignCodexConfigIsPreserved() {
  node - "$sandbox" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const homeDirectory = process.argv[2];
const hooks = JSON.parse(fs.readFileSync(path.join(homeDirectory, '.codex/hooks.json'), 'utf8'));
const config = fs.readFileSync(path.join(homeDirectory, '.codex/config.toml'), 'utf8');
const foreignStartup = hooks.hooks.SessionStart.find(entry => entry.matcher === 'startup|resume|clear');
process.exit(hooks.description === 'foreign metadata' && foreignStartup?.hooks.length === 1 && foreignStartup.hooks[0].command === 'printf foreign-context' && hooks.hooks.Stop.some(entry => entry.hooks.some(handler => handler.command === 'printf foreign-context' && handler.timeout === 3)) && config.includes('model = "keep-model"') && config.includes('[hooks.state]\nforeign = { enabled = true, trusted_hash = "keep-trust" }') && config.includes('[mcp_servers.foreign]\nurl = "https://foreign.invalid/mcp"') && fs.existsSync(path.join(homeDirectory, '.agents/skills/foreign/SKILL.md')) ? 0 : 1);
NODE
}

printf '\nai topic\n'

installStatus=0
firstRunOutput="$(runTopicInstall "$stagedTopicDir")" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "personal converge removes a retired managed MCP server" retiredManagedServerIsAbsent
check "personal cleanup preserves foreign hooks, MCP config, skills, and hook trust" foreignCodexConfigIsPreserved
check "install says what it did" test -n "$firstRunOutput"
mkdir -p "$sandbox/npm-global/lib/node_modules/@biomejs/biome"
printf '{"version":"2.6.5"}\n' > "$sandbox/npm-global/lib/node_modules/@biomejs/biome/package.json"
: > "$sandbox/.syntax-engine-cannot-start"
engineRepairOutput="$(runTopicInstall "$stagedTopicDir")" || true
check "the converge reinstalls a syntax engine that cannot start, at its installed version, until it starts" \
  outputHas "$engineRepairOutput" "reinstalled @biomejs/biome@2.6.5"
for skillName in "${workSkillNames[@]}"; do
  check "personal profile leaves work skill $skillName absent" \
    bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$sandbox/.claude/skills/$skillName"
done
check "personal profile installs no work skill dependencies" \
  bash -c '! grep -qF /profiles/work/skills/ "$1"' _ "$skillDependencyLog"
check "converge installs a skill's locked dependencies from inside its directory because npm 11 ci --prefix from elsewhere reports the skill missing from its own lock" \
  grep -qx "npm ci --omit=dev in .*/ai/skills/composing-social-images" "$skillDependencyLog"
check "converge installs the headless browser for a skill shipping playwright-core" \
  grep -qx 'playwright-core install --only-shell chromium' "$skillDependencyLog"
check "converge runs no sudo browser library install when no headless shell lacks a library" \
  bash -c '! grep -qF "install-deps" "$1"' _ "$skillDependencyLog"
reviewChecklistPath="$sandbox/.claude/review-checklist.md"
ownedReposPath="$sandbox/.claude/owned-repos.txt"
check "personal profile leaves the review checklist absent" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"

check "plain converge runs no plugin command" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin",'
cp "$stagedRepo/ai/settings.base.json" "$sandbox/settings-before-plugin-tests.json"
node -e '
  const filesystem = require("node:fs");
  const settingsPath = process.argv[1];
  const settings = JSON.parse(filesystem.readFileSync(settingsPath, "utf8"));
  settings.enabledPlugins["companion@caveman"] = true;
  settings.enabledPlugins["folder-mod@dotfiles"] = true;
  settings.enabledPlugins["disabled@other"] = false;
  filesystem.writeFileSync(settingsPath, JSON.stringify(settings));
' "$stagedRepo/ai/settings.base.json"
pluginHeldPath="$sandbox/.local/state/dotfiles/upgrades-held-ai"
pluginFailedPath="$sandbox/.local/state/dotfiles/upgrades-failed-ai-pending"
pluginMarketplacePath="$sandbox/.claude/plugins/marketplaces/caveman"
mkdir -p "$pluginMarketplacePath/.claude-plugin"
writePluginMarketplace() {
  printf '{"name":"caveman","plugins":[{"name":"caveman","source":"./"},{"name":"companion","source":{"source":"url","url":"https://companion.invalid/companion.git"}%s}]}\n' \
    "${2:+,\"version\":\"$2\"}" > "$pluginMarketplacePath/.claude-plugin/marketplace.json"
  printf '{"name":"caveman","version":"%s"}\n' "$1" > "$pluginMarketplacePath/.claude-plugin/plugin.json"
}
writeInstalledPlugins() {
  printf '{"installed":[{"id":"caveman@caveman","version":"%s"},{"id":"disabled@other","version":"1.0.0"},{"id":"companion@caveman","version":"%s"},{"id":"folder-mod@dotfiles","version":"0.1.0","readFromFolder":"/folder/mods/folder-mod","folderVersion":"0.1.0"}],"available":[{"pluginId":"disabled@other","name":"disabled","marketplaceName":"other"}]}\n' \
    "$1" "$2" > "$sandbox/.plugin-list.json"
}
writeInstalledPlugins 2.1.0 2.1.0
writePluginMarketplace 2.2.0 2.2.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "same-major plugin resolved from the marketplace source plugin.json applies" grep -qxF '["plugin","update","caveman@caveman"]' "$mcpCommandLog"
check "same-major plugin resolved from the marketplace entry applies" grep -qxF '["plugin","update","companion@caveman"]' "$mcpCommandLog"
check "same-major plugins are never held" test ! -e "$pluginHeldPath"
check "disabled plugin never updates nightly" bash -c '! grep -qF disabled "$1"' _ "$mcpCommandLog"
check "disabled plugin records no failure" test ! -e "$pluginFailedPath"
check "a plugin read from its folder refreshes its marketplace and is neither updated nor failed" bash -c 'grep -qxF "$3" "$1" && ! grep -qF "$4" "$1" && ! grep -qsF folder-mod "$2"' _ "$mcpCommandLog" "$pluginFailedPath" '["plugin","marketplace","update","dotfiles"]' '["plugin","update","folder-mod@dotfiles"]'
check "plugin marketplace refreshes once" test "$(grep -cxF '["plugin","marketplace","update","caveman"]' "$mcpCommandLog")" -eq 1
check "plugins are listed once with available versions" test "$(grep -cxF '["plugin","list","--json","--available"]' "$mcpCommandLog")" -eq 1
writeInstalledPlugins 11ddc0c9813c 2.1.0
writePluginMarketplace 4.0.1 2.2.0
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "a commit-sha installed plugin version is updatable" grep -qx 'plugin caveman@caveman 11ddc0c9813c 4.0.1' "$pluginHeldPath"
writeInstalledPlugins abddc0c9813c 2.1.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "a letter-leading commit-sha plugin version is held" grep -qx 'plugin caveman@caveman abddc0c9813c 4.0.1' "$pluginHeldPath"
check "a letter-leading commit-sha plugin never updates nightly" bash -c '! grep -qxF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update","caveman@caveman"]'
writeInstalledPlugins 2.1.0 2.1.0
writePluginMarketplace 3.0.0 2.2.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "major plugin is held" bash -c '! grep -qxF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update","caveman@caveman"]'
check "major plugin is recorded" grep -qx 'plugin caveman@caveman 2.1.0 3.0.0' "$pluginHeldPath"
: > "$mcpCommandLog"
runTopicInstall "$stagedTopicDir" > /dev/null
check "plain converge preserves plugin holds" test -s "$pluginHeldPath"
check "plain converge still runs no plugin command" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin",'
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null
check "approval applies major plugin" grep -qxF '["plugin","update","caveman@caveman"]' "$mcpCommandLog"
check "approval applies same-major plugin" grep -qxF '["plugin","update","companion@caveman"]' "$mcpCommandLog"
check "disabled plugin never updates" bash -c '! grep -qF disabled "$1"' _ "$mcpCommandLog"
check "approval clears plugin holds" test ! -e "$pluginHeldPath"
touch "$sandbox/.fail-plugin-update"
pluginFailureStatus=0
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || pluginFailureStatus=$?
check "failed plugin update fails the topic" test "$pluginFailureStatus" -eq 1
check "failed plugin update is pending" grep -qx 'plugin caveman@caveman 2.1.0 3.0.0' "$pluginFailedPath"
rm -f "$sandbox/.fail-plugin-update"
touch "$sandbox/.fail-plugin-marketplace"
pluginMarketplaceFailureStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || pluginMarketplaceFailureStatus=$?
check "marketplace refresh failure fails the topic" test "$pluginMarketplaceFailureStatus" -eq 1
check "failed marketplace blocks its plugin update" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update",'
check "marketplace failure leaves the plugin pending" grep -qx 'plugin caveman@caveman unknown unknown' "$pluginFailedPath"
rm -f "$sandbox/.fail-plugin-marketplace"
writeInstalledPlugins 3.0.0 2.2.0
writePluginMarketplace 3.0.0
unversionedNightlyStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null || unversionedNightlyStatus=$?
check "an unversioned url-sourced plugin skips nightly updates without holds or failures" \
  bash -c '[[ "$1" -eq 0 ]] && ! grep -qF "$5" "$2" && ! grep -qsF companion "$3" && ! grep -qsF companion "$4"' _ \
  "$unversionedNightlyStatus" "$mcpCommandLog" "$pluginHeldPath" "$pluginFailedPath" '["plugin","update","companion@caveman"]'
unversionedApprovedStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || unversionedApprovedStatus=$?
check "approval updates an unversioned url-sourced plugin without failures" \
  bash -c '[[ "$1" -eq 0 ]] && grep -qxF "$4" "$2" && ! grep -qsF companion "$3"' _ \
  "$unversionedApprovedStatus" "$mcpCommandLog" "$pluginFailedPath" '["plugin","update","companion@caveman"]'
touch "$sandbox/.fail-plugin-update"
unversionedFailureStatus=0
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || unversionedFailureStatus=$?
check "a failed unversioned plugin update fails the topic" test "$unversionedFailureStatus" -eq 1
check "a failed unversioned plugin update is pending" grep -qx 'plugin companion@caveman 2.2.0 unknown' "$pluginFailedPath"
rm -f "$sandbox/.fail-plugin-update"
printf '{"name":"caveman","plugins":[{"name":"caveman","source":"./"}]}\n' > "$pluginMarketplacePath/.claude-plugin/marketplace.json"
pluginUnresolvedStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || pluginUnresolvedStatus=$?
check "a plugin missing from its marketplace fails the topic" test "$pluginUnresolvedStatus" -eq 1
check "a plugin missing from its marketplace is pending" grep -qx 'plugin companion@caveman 2.2.0 unknown' "$pluginFailedPath"
check "a plugin missing from its marketplace issues no update" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update","companion@caveman"]'
writePluginMarketplace 3.0.0 2.2.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "current plugins skip updates and clear holds and pending failures" \
  bash -c '! grep -qF "$4" "$1" && [[ ! -e "$2" && ! -e "$3" ]]' _ \
  "$mcpCommandLog" "$pluginHeldPath" "$pluginFailedPath" '["plugin","update",'
writeInstalledPlugins 2.1.0 2.2.0
printf '{"name":"caveman"}\n' > "$pluginMarketplacePath/.claude-plugin/plugin.json"
pathSourcedNightlyStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null || pathSourcedNightlyStatus=$?
check "an unversioned path-sourced plugin skips nightly updates without failures" \
  bash -c '[[ "$1" -eq 0 && ! -e "$3" ]] && ! grep -qF "$4" "$2"' _ \
  "$pathSourcedNightlyStatus" "$mcpCommandLog" "$pluginFailedPath" '["plugin","update","caveman@caveman"]'
pathSourcedApprovedStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || pathSourcedApprovedStatus=$?
check "approval updates an unversioned path-sourced plugin successfully" \
  bash -c '[[ "$1" -eq 0 ]] && grep -qxF "$3" "$2"' _ \
  "$pathSourcedApprovedStatus" "$mcpCommandLog" '["plugin","update","caveman@caveman"]'
cp "$sandbox/settings-before-plugin-tests.json" "$stagedRepo/ai/settings.base.json"
: > "$mcpCommandLog"

firstWorkStatus=0
workMcpOutput="$(runTopicInstall "$stagedTopicDir" work)" || firstWorkStatus=$?
check "a first work converge exits clean" test "$firstWorkStatus" -eq 0
check "work links profile hooks through the alias" \
  bash -c '[[ -L "$1" && "$(readlink "$1")" == "$2" ]]' _ "$sandbox/.claude/profile-hooks" "$sandbox/.dotfiles/profiles/work/hooks"
check "the shared installed hooks contain none of the work hooks" \
  bash -c '[[ ! -e "$1/gate-posthog-exec-write.mjs" ]]' _ "$sandbox/.claude/hooks"
check "work preserves foreign hooks and Codex trust" foreignCodexConfigIsPreserved
check "all work hooks resolve imports through the installed symlink" \
  bash -c 'for hookName in gate-posthog-exec-write require-worktree; do env HOME="$1" node "$1/.claude/profile-hooks/$hookName.mjs" <<< "{\"tool_name\":\"unrelated\",\"tool_input\":{}}" || exit 1; done' _ "$sandbox"
check "work renders its worktree guard into agy's hooks beside the shared ones" \
  bash -c 'grep -qF "profile-hooks/require-worktree.mjs\\\" --agent=agy" "$1" && grep -qF "hooks/block-else.mjs" "$1"' _ "$sandbox/.gemini/config/hooks.json"
for skillName in "${workSkillNames[@]}"; do
  check "work profile links skill $skillName through the alias" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$sandbox/.claude/skills/$skillName" "$sandbox/.dotfiles/profiles/work/skills/$skillName"
done
check "work profile installs its skill's locked dependencies inside its directory" \
  grep -qx "npm ci --omit=dev in .*/profiles/work/skills/locked-profile-skill-test" "$skillDependencyLog"
check "work adds posthog with no consumer header and preserves unmanaged runtime state" \
  mcpRuntimeMatches https://mcp.posthog.com/mcp
check "work adds every declared server once" test "$(countMcpCommands add-json)" -eq 2
check "MCP output contains no server config" outputLacks "$workMcpOutput" https://mcp.posthog.com/mcp
quietWorkOutput="$(runTopicInstall "$stagedTopicDir" work)"
check "a work rerun reports no changes" reportsNoChanges "$quietWorkOutput"
check "an unchanged rerun issues no MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 2
printf '{"posthog":{"url":"https://mcp.posthog.com/mcp","type":"http"},"gauge":{"url":"https://app.withgauge.com/mcp","type":"http"}}\n' \
  > "$stagedRepo/profiles/work/mcp-servers.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "object key order does not trigger MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 2
printf '{"posthog":{"type":"http","url":"https://changed.invalid/mcp"},"gauge":{"type":"http","url":"https://app.withgauge.com/mcp"}}\n' \
  > "$stagedRepo/profiles/work/mcp-servers.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a changed config removes then adds the managed server" \
  node -e 'const commands = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse); process.exit(commands.length === 4 && commands[2][1] === "remove" && commands[3][1] === "add-json" ? 0 : 1)' "$mcpCommandLog"
check "a changed URL converges while preserving unmanaged state" mcpRuntimeMatches https://changed.invalid/mcp
: > "$sandbox/.fail-mcp-remove"
failedRemovalStatus=0
runTopicInstall "$stagedTopicDir" personal > /dev/null || failedRemovalStatus=$?
check "a failed removal warns" test "$failedRemovalStatus" -eq 1
check "a failed removal retains ownership for retry" \
  grep -qx posthog "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"
rm -f "$sandbox/.fail-mcp-remove"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "switching to personal removes only the managed servers" mcpRuntimeMatches ""
check "work to personal removes the work-only artifacts" retiredManagedServerIsAbsent
check "work to personal preserves foreign hooks, skills, MCP config, and trust" foreignCodexConfigIsPreserved
quietPersonalOutput="$(runTopicInstall "$stagedTopicDir" personal)"
check "a personal rerun reports no changes" reportsNoChanges "$quietPersonalOutput"
check "successful retirement clears the ownership record" \
  grep -qx '' "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"
cp "$repoRoot/profiles/work/mcp-servers.json" "$stagedRepo/profiles/work/mcp-servers.json"
node -e 'const fs = require("node:fs"); const runtimeSettings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); runtimeSettings.mcpServers.posthog = { type: "http", url: "https://eu.unmanaged.invalid/mcp" }; fs.writeFileSync(process.argv[1], JSON.stringify(runtimeSettings))' "$sandbox/.claude.json"
mcpCommandCountBeforeUnmanaged="$(wc -l < "$mcpCommandLog")"
unmanagedConflictStatus=0
unmanagedConflictOutput="$(runTopicInstall "$stagedTopicDir" work)" || unmanagedConflictStatus=$?
check "an unmanaged differing server with a declared name warns" test "$unmanagedConflictStatus" -eq 1
check "an unmanaged differing server names the blocked convergence" \
  outputHas "$unmanagedConflictOutput" "unmanaged server with this name blocks convergence"
check "an unmanaged differing server survives a work converge unchanged" \
  mcpRuntimeMatches https://eu.unmanaged.invalid/mcp
check "an unmanaged differing server triggers no mutation beyond adding the other declared servers" \
  test "$(wc -l < "$mcpCommandLog")" -eq "$((mcpCommandCountBeforeUnmanaged + 1))"
check "an unmanaged differing server is not recorded as managed" \
  bash -c '! grep -qx posthog "$1"' _ "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"
node -e 'const fs = require("node:fs"); const runtimeSettings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); delete runtimeSettings.mcpServers.posthog; fs.writeFileSync(process.argv[1], JSON.stringify(runtimeSettings))' "$sandbox/.claude.json"
: > "$sandbox/.fail-mcp-add-json"
failedAdditionStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null || failedAdditionStatus=$?
check "a failed addition warns" test "$failedAdditionStatus" -eq 1
rm -f "$sandbox/.fail-mcp-add-json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a failed addition is retried on the next converge" mcpRuntimeMatches https://mcp.posthog.com/mcp
check "work profile links the review checklist through the alias" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$reviewChecklistPath" "$sandbox/.dotfiles/profiles/work/review-checklist.md"
check "work profile links its owned repo list" \
  test "$(readlink "$ownedReposPath")" = "$sandbox/.dotfiles/profiles/work/owned-repos.txt"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile removes the stale work review checklist link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"
check "personal profile drops the work owned repo list" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$ownedReposPath"
printf 'local review notes\n' > "$reviewChecklistPath"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile preserves a non-repo review checklist" \
  grep -qx 'local review notes' "$reviewChecklistPath"
rm -f -- "$reviewChecklistPath"
profileAgentsPath="$sandbox/.claude/AGENTS.profile.md"
printf '#!/bin/sh\nexit 0\n' > "$skillDependencyStubBin/kimi"
chmod +x "$skillDependencyStubBin/kimi"
mkdir -p "$sandbox/.kimi-code"
printf '{"mcpServers":{"foreign":{"url":"https://unmanaged.invalid/mcp"}},"keepMe":true}\n' > "$sandbox/.kimi-code/mcp.json"
kimiMcpServersMatch() {
  node - "$sandbox/.kimi-code/mcp.json" "$1" <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [mcpConfigPath, expectsWorkServers] = process.argv.slice(2);
const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
const expectedServers = { foreign: { url: 'https://unmanaged.invalid/mcp' } };
if (expectsWorkServers === 'work') expectedServers.posthog = { url: 'https://mcp.posthog.com/mcp' };
if (expectsWorkServers === 'work') expectedServers.gauge = { url: 'https://app.withgauge.com/mcp' };
process.exit(isDeepStrictEqual(mcpConfig.mcpServers, expectedServers) && mcpConfig.keepMe === true ? 0 : 1);
NODE
}
runTopicInstall "$stagedTopicDir" work > /dev/null
check "work Kimi mcp.json gains the declared servers and keeps hand-added ones" \
  kimiMcpServersMatch work
check "work profile links its own AGENTS.md through the alias" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$profileAgentsPath" "$sandbox/.dotfiles/profiles/work/AGENTS.md"
for toolName in codex kimi-code; do
  toolAgentsPath="$sandbox/.$toolName/AGENTS.md"
  check "work $toolName AGENTS.md is a rendered plain file" \
    bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$toolAgentsPath"
  check "work $toolName AGENTS.md carries the shared rules then the work rules" \
    bash -c 'diff -q "$1" <(cat "$2"; printf "\n"; cat "$3") > /dev/null' _ \
    "$toolAgentsPath" "$stagedRepo/ai/AGENTS.md" "$stagedRepo/profiles/work/AGENTS.md"
done
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile removes the work AGENTS.profile.md link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$profileAgentsPath"
for toolName in codex kimi-code; do
  check "personal $toolName AGENTS.md holds only the shared rules" \
    cmp -s "$sandbox/.$toolName/AGENTS.md" "$stagedRepo/ai/AGENTS.md"
done
check "personal Kimi mcp.json drops the work servers and keeps hand-added ones" kimiMcpServersMatch personal
printf '{"mcpServers":{"posthog":{"url":"https://mine.invalid/mcp"}},}\n' > "$sandbox/.kimi-code/mcp.json"
runTopicInstall "$stagedTopicDir" work > /dev/null || true
printf '{"mcpServers":{"posthog":{"url":"https://mine.invalid/mcp"}}}\n' > "$sandbox/.kimi-code/mcp.json"
runTopicInstall "$stagedTopicDir" work > /dev/null || true
check "a Kimi mcp.json that failed to parse never hands its hand-added server to dotfiles" \
  grep -qF 'https://mine.invalid/mcp' "$sandbox/.kimi-code/mcp.json"
printf '{"mcpServers":[]}\n' > "$sandbox/.kimi-code/mcp.json"
arrayServersOutput="$(runTopicInstall "$stagedTopicDir" work)" || true
check "a Kimi mcp.json whose mcpServers is not an object warns instead of converging" \
  outputHas "$arrayServersOutput" "could not read mcp.json"
rm -f "$skillDependencyStubBin/kimi"
rm -rf "$sandbox/.kimi-code"
kimilessBin="$sandbox/kimiless-bin"
mkdir -p "$kimilessBin"
linkCoreUtilities --into "$kimilessBin" bash basename dirname cat cmp cp chmod find git grep head \
  ln ls mkdir mktemp mv readlink rm rmdir sed stat tail tr uname wc node
env HOME="$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 PATH="$skillDependencyStubBin:$kimilessBin" \
  bash "$stagedTopicDir/install.sh" > /dev/null || true
check "a converge without kimi on PATH leaves ~/.kimi-code absent" test ! -e "$sandbox/.kimi-code"
lockedSkillCount="$(find "$stagedTopicDir/skills" "$stagedRepo/profiles/work/skills" -mindepth 2 -maxdepth 2 -name package-lock.json | wc -l)"
check "converge skips npm ci while a skill's installed lock is current" \
  test "$(grep -c '^npm ci ' "$skillDependencyLog")" -eq "$lockedSkillCount"

linkedDestinations=(
  ".claude/AGENTS.md" ".claude/MODELS.md" ".claude/tsconfig.json" ".claude/types"
  ".claude/hooks" ".claude/hud"
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

for entryKind in agents workflows; do
  check "$entryKind converges through per-entry links" \
    bash -c '[[ -d "$1" && ! -L "$1" ]]; for entry in "$1"/*; do [[ -L "$entry" && -e "$entry" ]] || exit 1; done' _ "$sandbox/.claude/$entryKind"
done

skillsPath="$sandbox/.claude/skills"
mkdir -p "$skillsPath/triaging-posthog-errors"
printf 'foreign skill state\n' > "$skillsPath/triaging-posthog-errors/state.json"
foreignWorkSkillPath="$sandbox/foreign-sprint-update"
mkdir -p "$foreignWorkSkillPath"
printf 'foreign linked skill state\n' > "$foreignWorkSkillPath/state.json"
ln -s "$foreignWorkSkillPath" "$skillsPath/posting-sprint-updates"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile preserves a foreign directory named after a work skill" \
  bash -c '[[ ! -L "$1" ]] && grep -qx "foreign skill state" "$1/state.json"' _ "$skillsPath/triaging-posthog-errors"
check "personal profile preserves a foreign symlink named after a work skill" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]] && grep -qx "foreign linked skill state" "$1/state.json"' _ \
  "$skillsPath/posting-sprint-updates" "$foreignWorkSkillPath"
rm -rf "$skillsPath/triaging-posthog-errors"
rm -f "$skillsPath/posting-sprint-updates"
for skillName in "${workSkillNames[@]}"; do
  ln -s "$sandbox/.dotfiles/ai/skills/$skillName" "$skillsPath/$skillName"
done
runTopicInstall "$stagedTopicDir" work > /dev/null
for skillName in "${workSkillNames[@]}"; do
  check "work profile migrates the former shared skill $skillName" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$skillsPath/$skillName" "$sandbox/.dotfiles/profiles/work/skills/$skillName"
done
mkdir -p "$stagedRepo/profiles/work/skills/leftover-profile-skill/node_modules"
ln -s "$sandbox/.dotfiles/profiles/work/skills/leftover-profile-skill" "$skillsPath/leftover-profile-skill"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a profile skill directory left without SKILL.md is retired, not relinked" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$skillsPath/leftover-profile-skill"
rm -r "$stagedRepo/profiles/work/skills/leftover-profile-skill"
rm -f "$skillsPath/posting-sprint-updates"
ln -s "$stagedRepo/profiles/work/skills/posting-sprint-updates" "$skillsPath/posting-sprint-updates"
ln -s "$sandbox/.dotfiles/profiles/retired/skills/landing" "$skillsPath/commit-from-retired-profile"
ln -s "$stagedRepo/profiles/retired/skills/deleted" "$skillsPath/deleted-profile-skill"
ln -s "$sandbox/.dotfiles/profiles/work/skills/deleted" "$skillsPath/.hidden-profile-skill"
runTopicInstall "$stagedTopicDir" personal > /dev/null
for skillName in "${workSkillNames[@]}" commit-from-retired-profile deleted-profile-skill locked-profile-skill-test .hidden-profile-skill; do
  check "personal profile removes profile skill link $skillName through the alias or clone path" \
    bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$skillsPath/$skillName"
done
profileConflictSkillPath="$stagedRepo/profiles/work/skills/landing"
mkdir -p "$profileConflictSkillPath"
printf '{}\n' > "$profileConflictSkillPath/package-lock.json"
printf 'profile commit\n' > "$profileConflictSkillPath/SKILL.md"
profileConflictStatus=0
profileConflictOutput="$(runTopicInstall "$stagedTopicDir" work)" || profileConflictStatus=$?
check "a profile skill conflicting with a shared skill warns" \
  outputHas "$profileConflictOutput" "profile skill conflicts with shared skill"
check "a profile skill conflict fails the topic" test "$profileConflictStatus" -eq 1
check "a profile skill conflict keeps the shared link" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$skillsPath/landing" "$sandbox/.dotfiles/ai/skills/landing"
check "a conflicting profile skill installs no dependencies" \
  bash -c '! grep -qF /profiles/work/skills/landing "$1"' _ "$skillDependencyLog"
rm -rf "$profileConflictSkillPath"
rm -f "$stagedTopicDir/skills/composing-social-images/node_modules/.package-lock.json"
: > "$skillDependencyLog"
noProfileSkillsStatus=0
runTopicInstallWithoutProfile "$stagedTopicDir" > /dev/null || noProfileSkillsStatus=$?
check "a missing profile still installs a shared skill's locked dependencies" \
  grep -qx "npm ci --omit=dev in .*/ai/skills/composing-social-images" "$skillDependencyLog"
check "a missing profile still warns" test "$noProfileSkillsStatus" -eq 1
for skillName in "${workSkillNames[@]}"; do
  check "a missing profile preserves work skill $skillName" \
    test -L "$skillsPath/$skillName"
done
check "a missing profile keeps shared skills linked" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$skillsPath/landing" "$sandbox/.dotfiles/ai/skills/landing"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "skills is a plain directory, never a whole-directory link" \
  bash -c '[[ -d "$1" && ! -L "$1" ]]' _ "$skillsPath"
for repoSkillManifestPath in "$stagedTopicDir"/skills/*/SKILL.md; do
  skillName="$(basename -- "$(dirname -- "$repoSkillManifestPath")")"
  installedSkillPath="$skillsPath/$skillName"
  check "skill $skillName is linked through the alias" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$installedSkillPath" "$sandbox/.dotfiles/ai/skills/$skillName"
done
retiredSkillPath="$skillsPath/retired-skill-test"
ln -s "$sandbox/.dotfiles/ai/skills/retired-skill-test" "$retiredSkillPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a retired repo skill link is removed" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$retiredSkillPath"

gitlessBin="$sandbox/gitless-bin"
mkdir -p "$gitlessBin"
linkCoreUtilities --into "$gitlessBin" bash basename dirname cat cmp cp chmod find grep head \
  ln ls mkdir mktemp mv node readlink rm rmdir sed stat tr uname wc
runTopicInstall "$stagedTopicDir" work > /dev/null
cp "$sandbox/.claude.json" "$sandbox/runtime-settings-backup.json"
rm -f "$sandbox/.claude.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a missing runtime file is treated as an absent server" \
  node -e 'const runtimeSettings = require(process.argv[1]); process.exit(runtimeSettings.mcpServers.posthog.url === "https://mcp.posthog.com/mcp" ? 0 : 1)' "$sandbox/.claude.json"
printf 'not json\n' > "$sandbox/.claude.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "an unparseable runtime file is treated as an absent server" \
  node -e 'const runtimeSettings = require(process.argv[1]); process.exit(runtimeSettings.mcpServers.posthog.url === "https://mcp.posthog.com/mcp" ? 0 : 1)' "$sandbox/.claude.json"
cp "$sandbox/runtime-settings-backup.json" "$sandbox/.claude.json"
mv "$sandbox/.codex/config.toml" "$sandbox/codex-config-aside.toml"
node -e 'const fs = require("node:fs"); const runtimeSettings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); runtimeSettings.mcpServers.posthog.url = "https://drifted.invalid/mcp"; fs.writeFileSync(process.argv[1], JSON.stringify(runtimeSettings));' "$sandbox/.claude.json"
missingClaudeStatus=0
missingClaudeOutput="$(env HOME="$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 PATH="$gitlessBin" \
  bash "$stagedTopicDir/install.sh")" || missingClaudeStatus=$?
mv "$sandbox/codex-config-aside.toml" "$sandbox/.codex/config.toml"
check "an absent claude CLI warns when a server needs replacing" outputHas "$missingClaudeOutput" "claude not found"
check "an absent Codex CLI with no Codex config is skipped quietly" \
  bash -c '! grep -qE "\[warn\] +Codex (hooks|MCP)" <<< "$1"' _ "$missingClaudeOutput"
check "an absent claude CLI marks the topic warned" test "$missingClaudeStatus" -eq 1
check "an absent claude CLI still renders work CLAUDE.md with the profile import" \
  test "$(cat "$sandbox/.claude/CLAUDE.md")" = $'@AGENTS.md\n@AGENTS.profile.md'
check "an absent claude CLI preserves managed and unmanaged servers" mcpRuntimeMatches https://drifted.invalid/mcp
mv "$sandbox/.claude.json" "$sandbox/runtime-settings-aside.json"
env HOME="$sandbox" DOTFILES_PROFILE=personal NO_COLOR=1 PATH="$gitlessBin" \
  bash "$stagedTopicDir/install.sh" > /dev/null || true
mv "$sandbox/runtime-settings-aside.json" "$sandbox/.claude.json"
check "an absent claude CLI keeps managed ownership when the runtime file is missing" \
  grep -qx posthog "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"
cp "$sandbox/.codex/hooks.json" "$sandbox/codex-valid-hooks.json"
printf 'not json\n' > "$sandbox/.codex/hooks.json"
invalidCodexHooksStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null 2>&1 || invalidCodexHooksStatus=$?
check "unparseable Codex hooks warn" test "$invalidCodexHooksStatus" -eq 1
check "unparseable Codex hooks preserve the source for correction" grep -qx 'not json' "$sandbox/.codex/hooks.json"
cp "$sandbox/codex-valid-hooks.json" "$sandbox/.codex/hooks.json"
printf 'stale\n' > "$XDG_STATE_HOME/dotfiles/ai-codex-hook-trust-epoch"
printf 'stale\n' > "$XDG_STATE_HOME/dotfiles/ai-codex-hook-trust-baseline"
quietRerunStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null || quietRerunStatus=$?
check "a work converge with Codex and no hook trust exits clean" test "$quietRerunStatus" -eq 0
check "a converge clears the retired Codex hook trust state" \
  bash -c '[[ ! -e "$1/ai-codex-hook-trust-epoch" && ! -e "$1/ai-codex-hook-trust-baseline" ]]' _ "$XDG_STATE_HOME/dotfiles"
mv "$stagedRepo/profiles/work/hooks" "$sandbox/work-hooks-aside"
rm -f "$sandbox/.claude/profile-hooks"
mkdir -p "$sandbox/.claude/profile-hooks"
printf 'foreign hook directory\n' > "$sandbox/.claude/profile-hooks/foreign.txt"
runTopicInstall "$stagedTopicDir" work > /dev/null 2>&1 || true
check "an absent profile hook declaration preserves the foreign directory" \
  grep -qx 'foreign hook directory' "$sandbox/.claude/profile-hooks/foreign.txt"
mv "$sandbox/work-hooks-aside" "$stagedRepo/profiles/work/hooks"
runTopicInstall "$stagedTopicDir" work > /dev/null || true
cp "$stagedRepo/profiles/work/settings.overlay.json" "$sandbox/settings-overlay-backup.json"
printf 'not json\n' > "$stagedRepo/profiles/work/settings.overlay.json"
failedClaudeSettingsStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null || failedClaudeSettingsStatus=$?
check "a failed Claude settings render warns" test "$failedClaudeSettingsStatus" -eq 1
cp "$sandbox/settings-overlay-backup.json" "$stagedRepo/profiles/work/settings.overlay.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
settingsHookCommandsResolve() {
  node - "$sandbox/.claude/settings.json" <<'NODE'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const commands = Object.values(settings.hooks ?? {}).flatMap(entries => entries.flatMap(entry => entry.hooks.map(handler => handler.command)));
const scriptPaths = commands.flatMap(command => command.match(/\/[^\s"']+\.mjs/g) ?? []);
process.exit(scriptPaths.length > 0 && scriptPaths.every(scriptPath => fs.existsSync(scriptPath)) ? 0 : 1);
NODE
}


mkdir -p "$stagedRepo/profiles/work-server/skills/child-fixture" "$stagedRepo/profiles/personal/skills/personal-fixture"
printf 'child addition\n' > "$stagedRepo/profiles/work-server/skills/child-fixture/SKILL.md"
printf 'personal addition\n' > "$stagedRepo/profiles/personal/skills/personal-fixture/SKILL.md"
runTopicInstall "$stagedTopicDir" work-server > /dev/null
check "work-server installs its own addition beside inherited skills" \
  test "$(readlink "$sandbox/.claude/skills/child-fixture")" = "$sandbox/.dotfiles/profiles/work-server/skills/child-fixture"
check "work-server excludes personal additions" test ! -e "$sandbox/.claude/skills/personal-fixture"
check "work-server installs every settings hook at a present script" settingsHookCommandsResolve
check "work-server inherits work rules for Claude" \
  test "$(readlink "$sandbox/.claude/AGENTS.profile.md")" = "$sandbox/.dotfiles/profiles/work/AGENTS.md"
check "work-server inherits work rules for Codex" \
  grep -q 'Prefer working in a dedicated git worktree' "$sandbox/.codex/AGENTS.md"
check "work-server renders shared and work rules for agy as a plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]] && grep -q "Prefer working in a dedicated git worktree" "$1" && grep -qF "$(head -1 "$2")" "$1"' _ "$sandbox/.gemini/AGENTS.md" "$stagedRepo/ai/AGENTS.md"
for skillsHome in "$sandbox/.agents/skills" "$sandbox/.gemini/config/skills"; do
  check "work-server links its own addition into $skillsHome" \
    test "$(readlink "$skillsHome/child-fixture")" = "$sandbox/.dotfiles/profiles/work-server/skills/child-fixture"
  check "work-server links the shared house style into $skillsHome" \
    test "$(readlink "$skillsHome/applying-house-style")" = "$sandbox/.dotfiles/ai/skills/applying-house-style"
done
for skillName in "${workSkillNames[@]}"; do
  check "work-server inherits $skillName without a copy" \
    test "$(readlink "$sandbox/.claude/skills/$skillName")" = "$sandbox/.dotfiles/profiles/work/skills/$skillName"
done
check "work-server inherits the review checklist" \
  test "$(readlink "$reviewChecklistPath")" = "$sandbox/.dotfiles/profiles/work/review-checklist.md"
check "work-server inherits the work owned repo list" \
  test "$(readlink "$ownedReposPath")" = "$sandbox/.dotfiles/profiles/work/owned-repos.txt"
checkRerunIsQuiet "work-server rerun is quiet" "$(runTopicInstall "$stagedTopicDir" work-server)"
childFixtureLinkedForCodexAndAgy=no
[[ -L "$sandbox/.agents/skills/child-fixture" && -L "$sandbox/.gemini/config/skills/child-fixture" ]] && childFixtureLinkedForCodexAndAgy=yes
runTopicInstall "$stagedTopicDir" server > /dev/null
check "server removes inherited work-only artifacts" retiredManagedServerIsAbsent
check "server retires the child profile addition" test ! -L "$sandbox/.claude/skills/child-fixture"
check "server retires the child profile addition for Codex and agy" \
  bash -c '[[ "$3" == yes && ! -L "$1/child-fixture" && ! -L "$2/child-fixture" && -f "$1/foreign/SKILL.md" ]]' _ "$sandbox/.agents/skills" "$sandbox/.gemini/config/skills" "$childFixtureLinkedForCodexAndAgy"
check "server keeps shared house style" test -L "$sandbox/.claude/skills/applying-house-style"
rm -r "$stagedRepo/profiles/work-server/skills/child-fixture" "$stagedRepo/profiles/personal/skills/personal-fixture"
overridingChildDirectory="$stagedRepo/profiles/overriding-child-fixture"
mkdir -p "$overridingChildDirectory/skills/posting-sprint-updates"
printf '{"extends":"work"}\n' > "$overridingChildDirectory/ai.json"
printf 'child override\n' > "$overridingChildDirectory/skills/posting-sprint-updates/SKILL.md"
overridingChildStatus=0
overridingChildOutput="$(runTopicInstall "$stagedTopicDir" overriding-child-fixture)" || overridingChildStatus=$?
check "a child skill overriding its parent's skill gets the child link" \
  test "$(readlink "$sandbox/.claude/skills/posting-sprint-updates")" = "$sandbox/.dotfiles/profiles/overriding-child-fixture/skills/posting-sprint-updates"
check "a child skill overriding its parent's skill converges without a warning" test "$overridingChildStatus" -eq 0
check "a child skill overriding its parent's skill names no duplicate" outputLacks "$overridingChildOutput" "duplicate"
checkRerunIsQuiet "a child overriding a parent skill reruns quietly" "$(runTopicInstall "$stagedTopicDir" overriding-child-fixture)"
rm -rf "$overridingChildDirectory"

rm -f "$sandbox/.gemini/config/skills/applying-house-style"
mkdir -p "$sandbox/.gemini/config/skills/applying-house-style"
printf 'my own house style\n' > "$sandbox/.gemini/config/skills/applying-house-style/SKILL.md"
runTopicInstall "$stagedTopicDir" personal > /dev/null || true
check "an agy skill of the same name as a repo skill is kept in place with no backup beside it" \
  bash -c '[[ ! -L "$1/applying-house-style" ]] && grep -qx "my own house style" "$1/applying-house-style/SKILL.md" && ! compgen -G "$1/applying-house-style.pre-dotfiles*" > /dev/null' _ "$sandbox/.gemini/config/skills"
rm -rf "$sandbox/.gemini/config/skills/applying-house-style"
runTopicInstall "$stagedTopicDir" personal > /dev/null

check "personal installs the shared house style" \
  test "$(readlink "$sandbox/.claude/skills/applying-house-style")" = "$sandbox/.dotfiles/ai/skills/applying-house-style"
mv "$stagedRepo/profiles/work" "$stagedRepo/profiles/renamed"
runTopicInstall "$stagedTopicDir" renamed > /dev/null
check "another profile keeps the shared house style" test -L "$sandbox/.claude/skills/applying-house-style"
check "a renamed profile links its hooks generically" \
  test "$(readlink "$sandbox/.claude/profile-hooks")" = "$sandbox/.dotfiles/profiles/renamed/hooks"
mv "$stagedRepo/profiles/renamed" "$stagedRepo/profiles/work"

check "AI inheritance rejects cycles, missing parents, and escaping names before convergence" \
  node --input-type=module - "$stagedRepo" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const repository = process.argv[2];
const { profileLineage } = await import(pathToFileURL(`${repository}/ai/profile-config.mjs`));
const inheritedDirectory = `${repository}/profiles/inherited-fixture`;
fs.mkdirSync(inheritedDirectory);
for (const parent of ['inherited-fixture', 'absent-fixture', '../work']) {
  fs.writeFileSync(`${inheritedDirectory}/ai.json`, JSON.stringify({extends: parent}));
  assert.throws(() => profileLineage('inherited-fixture'));
}
fs.writeFileSync(`${inheritedDirectory}/ai.json`, JSON.stringify({extends: 'work-server'}));
assert.deepEqual(profileLineage('inherited-fixture'), ['work', 'work-server', 'inherited-fixture']);
fs.rmSync(inheritedDirectory, {recursive: true});
NODE

renderFixtureDirectory="$sandbox/render-hooks-fixture"
mkdir -p "$renderFixtureDirectory"
check "Codex combines shared and profile hooks, reruns quietly, and retires deleted declarations" \
  env HOME="$sandbox" node --input-type=module - "$stagedRepo" "$renderFixtureDirectory" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [repository, fixture] = process.argv.slice(2);
const basePath = `${repository}/ai/codex-hooks.base.json`;
const originalBase = fs.readFileSync(basePath);
const overlayPath = `${fixture}/overlay.json`;
const runtimePath = `${fixture}/generic-hooks.json`;
const destinationPath = `${fixture}/generic-rendered.json`;
const ownedPath = `${fixture}/owned.json`;
const declaration = command => ({hooks:{Stop:[{hooks:[{type:'command',command}]}]}});
fs.writeFileSync(basePath, JSON.stringify(declaration('printf shared-hook')));
fs.writeFileSync(overlayPath, JSON.stringify(declaration('printf profile-hook')));
fs.writeFileSync(runtimePath, JSON.stringify(declaration('printf foreign-hook')));
const render = () => {
  const processOutput = spawnSync(process.execPath, [`${repository}/ai/render-hooks.mjs`, basePath, overlayPath, runtimePath, destinationPath, ownedPath], {encoding:'utf8'});
  assert.equal(processOutput.status, 0, processOutput.stderr);
  fs.copyFileSync(destinationPath, runtimePath);
  return fs.readFileSync(runtimePath, 'utf8');
};
try {
  const firstRender = render();
  assert.deepEqual(JSON.parse(firstRender).hooks.Stop.flatMap(entry => entry.hooks.map(handler => handler.command)), ['printf shared-hook', 'printf profile-hook', 'printf foreign-hook']);
  assert.equal(render(), firstRender);
  fs.writeFileSync(basePath, '{"hooks":{}}');
  fs.writeFileSync(overlayPath, '{"hooks":{}}');
  assert.deepEqual(JSON.parse(render()).hooks.Stop.flatMap(entry => entry.hooks.map(handler => handler.command)), ['printf foreign-hook']);
} finally {
  fs.writeFileSync(basePath, originalBase);
}
NODE

check "agy hooks render under the dotfiles group beside a foreign group and plain Stop handlers" \
  env HOME="$sandbox" node --input-type=module - "$stagedRepo" "$renderFixtureDirectory" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [repository, fixture] = process.argv.slice(2);
const basePath = `${fixture}/agy-base.json`;
const runtimePath = `${fixture}/agy-hooks.json`;
const destinationPath = `${fixture}/agy-rendered.json`;
const ownedPath = `${fixture}/agy-owned.json`;
fs.writeFileSync(basePath, JSON.stringify({hooks:{Stop:[{type:'command',command:'node {{HOME}}/stop.mjs'}],PreToolUse:[{matcher:'^run_command$',hooks:[{type:'command',command:'node {{HOME}}/guard.mjs'}]}]}}));
fs.writeFileSync(runtimePath, JSON.stringify({mine:{Stop:[{type:'command',command:'printf foreign'}]}}));
const render = () => {
  const processOutput = spawnSync(process.execPath, [`${repository}/ai/render-hooks.mjs`, basePath, basePath, runtimePath, destinationPath, ownedPath, 'dotfiles'], {encoding:'utf8'});
  assert.equal(processOutput.status, 0, processOutput.stderr);
  fs.copyFileSync(destinationPath, runtimePath);
  return JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
};
const rendered = render();
assert.deepEqual(rendered.mine, {Stop:[{type:'command',command:'printf foreign'}]});
assert.deepEqual(rendered.dotfiles.Stop, [{type:'command',command:`node ${process.env.HOME}/stop.mjs`}]);
assert.equal(rendered.dotfiles.PreToolUse[0].hooks[0].command, `node ${process.env.HOME}/guard.mjs`);
assert.equal(rendered.hooks, undefined);
assert.deepEqual(render(), rendered);
NODE

mkdir -p "$stagedRepo/profiles/minimal"
runTopicInstall "$stagedTopicDir" minimal > /dev/null
check "a profile without an overlay still gets shared hooks" \
  grep -q load-agents-md.mjs "$sandbox/.claude/settings.json"
check "a profile without an overlay gets no work hooks" \
  bash -c '! grep -q profile-hooks "$1"' _ "$sandbox/.claude/settings.json"
runTopicInstall "$stagedTopicDir" personal > /dev/null


runTopicInstall "$stagedTopicDir" work > /dev/null
mkdir -p "$sandbox/.claude/skills/backchannels" "$sandbox/.agents/skills/backchannels"
noProfileSnapshot="$sandbox/no-profile-snapshot"
rm -rf "$noProfileSnapshot"
mkdir -p "$noProfileSnapshot"
cp "$sandbox/.codex/AGENTS.md" "$sandbox/.claude.json" "$sandbox/.codex/hooks.json" "$sandbox/.codex/config.toml" "$sandbox/.claude/settings.json" "$noProfileSnapshot/"
noProfileStatus=0
runTopicInstall "$stagedTopicDir" "" > /dev/null || noProfileStatus=$?
check "a no-profile converge warns" test "$noProfileStatus" -eq 1
check "a no-profile converge leaves Codex instructions alone" cmp -s "$sandbox/.codex/AGENTS.md" "$noProfileSnapshot/AGENTS.md"
check "a no-profile converge leaves Claude MCP servers alone" cmp -s "$sandbox/.claude.json" "$noProfileSnapshot/.claude.json"
check "a no-profile converge leaves Codex hooks alone" cmp -s "$sandbox/.codex/hooks.json" "$noProfileSnapshot/hooks.json"
check "a no-profile converge leaves Codex MCP config alone" cmp -s "$sandbox/.codex/config.toml" "$noProfileSnapshot/config.toml"
check "a no-profile converge leaves Claude settings alone" cmp -s "$sandbox/.claude/settings.json" "$noProfileSnapshot/settings.json"
check "a no-profile converge keeps the profile hooks link" \
  bash -c '[[ -L "$1" && "$(readlink "$1")" == "$2" ]]' _ "$sandbox/.claude/profile-hooks" "$sandbox/.dotfiles/profiles/work/hooks"
check "a no-profile converge keeps the backchannels skill directories" \
  test -d "$sandbox/.claude/skills/backchannels" -a -d "$sandbox/.agents/skills/backchannels"
check "a no-profile converge leaves every settings hook command pointing at a present script" settingsHookCommandsResolve

runTopicInstall "$stagedTopicDir" work > /dev/null
nodelessBin="$sandbox/nodeless-bin"
mkdir -p "$nodelessBin"
linkCoreUtilities --into "$nodelessBin" bash basename dirname cat cmp cp chmod find git grep head \
  ln ls mkdir mktemp mv readlink rm rmdir sed stat tr uname wc
nodelessSnapshot="$sandbox/nodeless-snapshot"
rm -rf "$nodelessSnapshot"
mkdir -p "$nodelessSnapshot"
cp "$sandbox/.codex/AGENTS.md" "$sandbox/.claude.json" "$sandbox/.codex/hooks.json" "$sandbox/.codex/config.toml" \
  "$sandbox/.claude/settings.json" "$sandbox/.claude/CLAUDE.md" "$nodelessSnapshot/"
rm -f "$sandbox/.claude/AGENTS.md" "$skillsPath/landing"
nodelessStatus=0
nodelessOutput="$(env HOME="$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 PATH="$nodelessBin" \
  bash "$stagedTopicDir/install.sh")" || nodelessStatus=$?
check "a converge without node warns" test "$nodelessStatus" -eq 1
check "a converge without node names the skipped profile policy" \
  outputHas "$nodelessOutput" "could not read profile policy"
check "a converge without node still links the shared AGENTS.md" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ "$sandbox/.claude/AGENTS.md" "$sandbox/.dotfiles/ai/AGENTS.md"
check "a converge without node still links shared skills" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ "$skillsPath/landing" "$sandbox/.dotfiles/ai/skills/landing"
for skillName in "${workSkillNames[@]}"; do
  check "a converge without node preserves work skill $skillName" test -L "$skillsPath/$skillName"
done
check "a converge without node keeps the profile hooks link" \
  bash -c '[[ -L "$1" && "$(readlink "$1")" == "$2" ]]' _ "$sandbox/.claude/profile-hooks" "$sandbox/.dotfiles/profiles/work/hooks"
check "a converge without node leaves Claude instructions alone" cmp -s "$sandbox/.claude/CLAUDE.md" "$nodelessSnapshot/CLAUDE.md"
check "a converge without node leaves Codex instructions alone" cmp -s "$sandbox/.codex/AGENTS.md" "$nodelessSnapshot/AGENTS.md"
check "a converge without node leaves Claude MCP servers alone" cmp -s "$sandbox/.claude.json" "$nodelessSnapshot/.claude.json"
check "a converge without node leaves Codex hooks alone" cmp -s "$sandbox/.codex/hooks.json" "$nodelessSnapshot/hooks.json"
check "a converge without node leaves Codex MCP config alone" cmp -s "$sandbox/.codex/config.toml" "$nodelessSnapshot/config.toml"
check "a converge without node leaves Claude settings alone" cmp -s "$sandbox/.claude/settings.json" "$nodelessSnapshot/settings.json"

runTopicInstall "$stagedTopicDir" work > /dev/null
mkdir -p "$sandbox/.claude/skills/backchannels" "$sandbox/.agents/skills/backchannels"
serverStatus=0
runTopicInstall "$stagedTopicDir" server > /dev/null || serverStatus=$?
check "server converge follows topic warning convention" test "$serverStatus" -eq 0
check "server converge removes the work-only artifacts" retiredManagedServerIsAbsent
check "server cleanup preserves foreign entries" foreignCodexConfigIsPreserved
serverRerunStatus=0
serverRerunOutput="$(runTopicInstall "$stagedTopicDir" server)" || serverRerunStatus=$?
check "server rerun keeps the expected exit status" test "$serverRerunStatus" -eq 0
check "server rerun reports no changes" reportsNoChanges "$serverRerunOutput"
runTopicInstall "$stagedTopicDir" personal > /dev/null

rm -rf "$skillsPath"
ln -s "$sandbox/deleted-skills-directory" "$skillsPath"
danglingLinkStatus=0
runTopicInstall "$stagedTopicDir" > /dev/null || danglingLinkStatus=$?
check "a dangling foreign skills link does not fail the topic" test "$danglingLinkStatus" -eq 0
check "a dangling foreign skills link is backed up" \
  bash -c 'ls "$1".pre-dotfiles.bak* > /dev/null 2>&1' _ "$skillsPath"
check "a dangling foreign skills link converges to a plain directory" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/landing" ]]' _ "$skillsPath"

foreignSkillsHome="$sandbox/foreign-skills-home"
mkdir -p "$foreignSkillsHome"
printf 'foreign skills state\n' > "$foreignSkillsHome/state.json"
rm -rf "$skillsPath"
ln -s "$foreignSkillsHome" "$skillsPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a foreign skills link converges to a plain directory" \
  bash -c '[[ -d "$1" && ! -L "$1" && -L "$1/landing" ]]' _ "$skillsPath"
check "a foreign skills directory takes no repo skill link" \
  bash -c '! test -e "$1/landing" && ! test -L "$1/landing"' _ "$foreignSkillsHome"
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

workflowModelIdsComeFromModels() {
  local workflowPath="$1"
  local modelId
  while read -r modelId; do
    [[ -n "$modelId" ]] || continue
    grep -qF -- "$modelId" "$topicDir/MODELS.md" || return 1
  done < <(
    {
      grep -oE 'gpt-[a-z0-9]+([.-][a-z0-9]+)*' "$workflowPath" || true
      grep -oE "model: '[^']+'" "$workflowPath" | sed -E "s/^model: '(.*)'$/\1/" || true
    } | sort -u
  )
}

workflowAvoidsResumeBreakingCalls() {
  ! grep -qE 'Math\.random\(|Date\.now\(|new Date\(\)' "$1"
}

shopt -s nullglob
workflowScripts=("$topicDir"/workflows/*.js)
shopt -u nullglob
check "workflow scripts are present" test "${#workflowScripts[@]}" -gt 0
for workflowPath in "${workflowScripts[@]}"; do
  workflowName="$(basename -- "$workflowPath")"
  check "$workflowName pins every agent model" workflowPinsEveryAgentCall "$workflowPath"
  check "$workflowName carries delegation markers" workflowCarriesDelegationMarkers "$workflowPath"
  check "$workflowName names only models MODELS.md lists" workflowModelIdsComeFromModels "$workflowPath"
  check "$workflowName avoids calls the workflow runtime rejects" workflowAvoidsResumeBreakingCalls "$workflowPath"
done

mainGuardsResolveSymlinks() {
  local unresolvedScripts
  unresolvedScripts="$(
    grep -rlE --include='*.mjs' --include='*.js' --include='*.ts' --exclude-dir=node_modules 'import\.meta\.url.*argv\[1\]|argv\[1\].*import\.meta\.url' "$topicDir" \
      | xargs -r grep -LE 'realpathSync\(process\.argv\[1\]\)'
  )"
  [[ -z "$unresolvedScripts" ]] || { printf 'unresolved main guard: %s\n' $unresolvedScripts >&2; return 1; }
}
check "every script main guard resolves argv[1] through symlinks" mainGuardsResolveSymlinks

# Claude Code drops every @import in a symlinked CLAUDE.md, so this one entry is a copy.
claudeMdPath="$sandbox/.claude/CLAUDE.md"
check "CLAUDE.md is a plain file, never a symlink" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$claudeMdPath"
check "a profile without its own AGENTS.md gets a CLAUDE.md importing only the shared rules" \
  test "$(cat "$claudeMdPath")" = "@AGENTS.md"
check "no profile carries a CLAUDE.md, so profile rules live in AGENTS.md" \
  bash -c '! compgen -G "$1/profiles/*/CLAUDE.md" > /dev/null' _ "$repoRoot"

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
check "settings.json pins the sonnet alias to the model MODELS.md names" \
  node -e 'const fs=require("fs");const routedSonnetModel=(fs.readFileSync(process.argv[1],"utf8").match(/^\| `sonnet` \(([^)]+)\)/m)||[])[1];const pinnedSonnetModel=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).env.ANTHROPIC_DEFAULT_SONNET_MODEL;process.exit(routedSonnetModel&&routedSonnetModel===pinnedSonnetModel?0:1)' "$topicDir/MODELS.md" "$settingsPath"
check "settings.json pins the haiku alias to the model MODELS.md names" \
  node -e 'const fs=require("fs");const routedHaikuModel=(fs.readFileSync(process.argv[1],"utf8").match(/^\| `haiku` \(([^)]+)\)/m)||[])[1];const pinnedHaikuModel=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).env.ANTHROPIC_DEFAULT_HAIKU_MODEL;process.exit(routedHaikuModel&&routedHaikuModel===pinnedHaikuModel?0:1)' "$topicDir/MODELS.md" "$settingsPath"

renderProfileSettings() {
  HOME="$sandbox" node "$repoRoot/ai/render-settings.mjs" \
    "$topicDir/settings.base.json" "$1" "$2" /fixture/home > /dev/null
}

renderKeepsEveryBasePermission() {
  node -e 'const readJson=(path)=>JSON.parse(require("fs").readFileSync(path,"utf8"));const permissionName=process.argv[3];const basePermissions=readJson(process.argv[1]).permissions[permissionName];const renderedPermissions=readJson(process.argv[2]).permissions[permissionName]||[];process.exit(basePermissions.length>0&&basePermissions.every((permission)=>renderedPermissions.includes(permission))?0:1)' \
    "$topicDir/settings.base.json" "$2" "$1"
}

overlayDefinesNoDenyList() {
  if [[ -z "$1" ]]; then
    return 0
  fi
  node -e 'const overlaySettings=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlaySettings.permissions&&overlaySettings.permissions.deny?1:0)' "$1"
}

for profileDirectory in "$repoRoot"/profiles/*/; do
  profileName="$(basename -- "$profileDirectory")"
  profileOverlayPath="$(node "$repoRoot/ai/profile-config.mjs" "$profileName" settings.overlay.json)"
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
check "settings.json is not world readable" test "$(fileModeOf "$settingsPath")" = "600"

rm -f "$sandbox/.claude/AGENTS.md"
printf 'later hand written notes\n' > "$sandbox/.claude/AGENTS.md"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a later displaced file gets its own backup" test -f "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the later backup holds the later content" grep -q 'later hand written notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak.2"
check "the first backup is untouched" grep -q 'pre-existing user notes' "$sandbox/.claude/AGENTS.md.pre-dotfiles.bak"

rm -f "$claudeMdPath"
ln -s "$sandbox/.dotfiles/ai/AGENTS.md" "$claudeMdPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "an old CLAUDE.md symlink converges to a plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$claudeMdPath"
check "converging the old symlink leaves no backup" \
  bash -c '! ls "$1".pre-dotfiles.bak* >/dev/null 2>&1' _ "$claudeMdPath"

printf 'hand edited claude memory\n' > "$claudeMdPath"
runTopicInstall "$stagedTopicDir" > /dev/null
check "a hand edited CLAUDE.md is backed up before the rendered file returns" \
  grep -qs 'hand edited claude memory' "$claudeMdPath".pre-dotfiles.bak*
check "the rendered file wins over the hand edit" \
  test "$(cat "$claudeMdPath")" = "@AGENTS.md"

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
hookTestFiles=("$topicDir"/hooks/test/*.test.mjs "$repoRoot"/profiles/work/hooks/test/*.test.mjs)
workflowTestFiles=("$topicDir"/workflows/test/*.test.mjs)
commitTestFiles=("$topicDir"/skills/landing/test/*.test.ts)
retroTestFiles=("$topicDir"/skills/running-retros/test/*.test.ts)
releaseTestFiles=("$topicDir"/skills/releasing/test/*.test.ts)
specTestFiles=("$topicDir"/skills/specifying/test/*.test.ts)
capturingUiTestFiles=("$topicDir"/skills/capturing-ui/test/*.test.mjs)
socialImagesTestFiles=("$topicDir"/skills/composing-social-images/test/*.test.mjs)
animatingTestFiles=("$topicDir"/skills/animating/test/*.test.mjs)
whiteboardTestFiles=("$topicDir"/skills/drawing-whiteboards/test/*.test.ts)
hudTestFiles=("$topicDir"/hud/test/*.test.mjs)
workSkillTestFiles=("$repoRoot"/profiles/work/skills/*/test/*.test.ts)
shopt -u nullglob
check "all behavior test groups are present" \
  test "$((${#hookTestFiles[@]} > 0 && ${#workflowTestFiles[@]} > 0 && ${#commitTestFiles[@]} > 0 && ${#retroTestFiles[@]} > 0 && ${#releaseTestFiles[@]} > 0 && ${#specTestFiles[@]} > 0 && ${#capturingUiTestFiles[@]} > 0 && ${#socialImagesTestFiles[@]} > 0 && ${#animatingTestFiles[@]} > 0 && ${#whiteboardTestFiles[@]} > 0 && ${#hudTestFiles[@]} > 0 && ${#workSkillTestFiles[@]} > 0))" -eq 1
if ((${#hookTestFiles[@]} > 0 && ${#workflowTestFiles[@]} > 0 && ${#commitTestFiles[@]} > 0 && ${#retroTestFiles[@]} > 0 && ${#releaseTestFiles[@]} > 0 && ${#capturingUiTestFiles[@]} > 0 && ${#socialImagesTestFiles[@]} > 0 && ${#animatingTestFiles[@]} > 0 && ${#whiteboardTestFiles[@]} > 0 && ${#hudTestFiles[@]} > 0)); then
  check "hook, workflow, landing, running-retros, releasing, capturing-ui, composing-social-images, animating, drawing-whiteboards, and hud behavior tests pass" node --test "${hookTestFiles[@]}" "${workflowTestFiles[@]}" "${commitTestFiles[@]}" "${retroTestFiles[@]}" "${releaseTestFiles[@]}" "${capturingUiTestFiles[@]}" "${socialImagesTestFiles[@]}" "${animatingTestFiles[@]}" "${whiteboardTestFiles[@]}" "${hudTestFiles[@]}"
fi
check "auditing-brand census tests pass" node --test "$topicDir/skills/auditing-brand/test/census.test.ts"
check "securing-browser-code check tests pass" node --test "$topicDir/skills/securing-browser-code/test/check.test.ts"
check "writing-in-voice draft lint tests pass" node --test "$topicDir/skills/writing-in-voice/test/lint-draft.test.mjs"
check "designing-ui slop lint tests pass" node --test "$topicDir/skills/designing-ui/test/lint-slop.test.mjs"
check "designing-ui layout shift tests pass" node --test "$topicDir/skills/designing-ui/test/layout-shift.test.mjs"
if ((${#workSkillTestFiles[@]} > 0)); then
  check "work profile skill behavior tests pass" node --test "${workSkillTestFiles[@]}"
fi

if ((${#specTestFiles[@]} > 0)); then
  check "design spec render and documentation contracts pass" node --test --test-concurrency=1 "${specTestFiles[@]}"
fi

check "explaining-visually example pictures use only the whiteboard palette and role colors" node "$topicDir/skills/explaining-visually/scripts/check-palette.ts" "$topicDir"/skills/explaining-visually/examples/*.svg

check "every shared and profile skill passes skill-lint" node "$topicDir/hooks/skill-lint.mjs"

reportTopicResults "ai"
