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
stagedRepo="$(cd -- "$stagedRepo" && pwd)"
cp -R "$repoRoot/." "$stagedRepo"
rm -rf "$stagedRepo/.git" "$stagedRepo"/ai/skills/*/node_modules "$stagedRepo"/profiles/*/skills/*/node_modules
git init -q -b main "$stagedRepo"
stagedTopicDir="$stagedRepo/ai"
singleFileSkillPath="$stagedTopicDir/skills/single-file-skill-test.md"
printf 'tracked single file skill\n' > "$singleFileSkillPath"
workSkillNames=()
for workSkillPath in "$repoRoot"/profiles/work/skills/*/; do
  workSkillNames+=("$(basename -- "$workSkillPath")")
done
profileDependencySkillPath="$stagedRepo/profiles/work/skills/locked-profile-skill-test"
mkdir -p "$profileDependencySkillPath"
printf '{}\n' > "$profileDependencySkillPath/package-lock.json"
(cd -- "$stagedRepo" && git add -A -- ai/skills profiles/*/skills)

foreignSkillName=".synced-cutover-test"
foreignSkillPath="$stagedTopicDir/skills/$foreignSkillName"
mkdir -p "$foreignSkillPath"
printf 'synced runtime state\n' > "$foreignSkillPath/state.json"
rm -f "$sandbox/.dotfiles"
ln -s "$stagedRepo" "$sandbox/.dotfiles"
ln -s "$sandbox/.dotfiles/ai/skills" "$sandbox/.claude/skills"

skillDependencyLog="$sandbox/skill-dependency-commands.log"
: > "$skillDependencyLog"
skillDependencyStubBin="$sandbox/skill-dependency-stub-bin"
mkdir -p "$skillDependencyStubBin"
cat > "$skillDependencyStubBin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s in %s\n' "$*" "$PWD" >> "$SKILL_DEPENDENCY_LOG"
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
cat > "$skillDependencyStubBin/codex" <<'STUB'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argumentsPassed = process.argv.slice(2);
fs.appendFileSync(process.env.CODEX_MCP_COMMAND_LOG, `${JSON.stringify(argumentsPassed)}\n`);
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
if (configText.includes('invalid toml')) process.exit(1);
if (process.env.CODEX_HOME.includes('/.dotfiles-mcp.') && fs.existsSync(path.join(process.env.HOME, '.fail-codex-mcp-stage'))) process.exit(1);
const serverSection = /\n?\[mcp_servers\.backchannels\]\n([\s\S]*?)(?=\n\[|$)/.exec(configText);
const [group, action, serverName] = argumentsPassed;
if (group !== 'mcp') process.exit(1);
if (action === 'list') {
  console.log('[]');
  process.exit(0);
}
if (action === 'get') {
  if (serverName !== 'backchannels' || !serverSection) process.exit(1);
  const url = /^url = "(.*)"$/m.exec(serverSection[1])?.[1];
  console.log(JSON.stringify({name: serverName, enabled: !serverSection[1].includes('enabled = false'), transport: {type:'streamable_http', url}}));
  process.exit(0);
}
if (action !== 'remove' || serverName !== 'backchannels' || !serverSection) process.exit(1);
if (fs.existsSync(path.join(process.env.HOME, '.fail-codex-mcp-remove'))) process.exit(1);
fs.writeFileSync(configPath, configText.replace(serverSection[0], ''));
STUB
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
if (expectedPosthogUrl) expectedServers.backchannels = { type: 'http', url: 'https://api.backchannels.dev/mcp' };
if (expectedPosthogUrl) expectedServers.posthog = { type: 'http', url: expectedPosthogUrl };
process.exit(isDeepStrictEqual(runtimeSettings.mcpServers, expectedServers) && runtimeSettings.runtimeToken === 'keep-me' ? 0 : 1);
NODE
}

countMcpCommands() {
  grep -cF "[\"mcp\",\"$1\"" "$mcpCommandLog" || true
}

mkdir -p "$sandbox/.codex" "$sandbox/.agents/skills/backchannels" "$sandbox/.agents/skills/foreign" "$sandbox/.claude/skills/backchannels"
printf 'foreign skill\n' > "$sandbox/.agents/skills/foreign/SKILL.md"
printf 'backchannels skill\n' > "$sandbox/.agents/skills/backchannels/SKILL.md"
printf 'backchannels skill\n' > "$sandbox/.claude/skills/backchannels/SKILL.md"
cat > "$sandbox/.codex/config.toml" <<'TOML'
model = "keep-model"
[hooks.state]
foreign = { enabled = true, trusted_hash = "keep-trust" }
[mcp_servers.foreign]
url = "https://foreign.invalid/mcp"
[mcp_servers.backchannels]
url = "https://api.backchannels.dev/mcp"
TOML
node - "$sandbox/.codex/hooks.json" "$sandbox/.claude.json" <<'NODE'
const fs = require('node:fs');
const [hooksPath, runtimePath] = process.argv.slice(2);
const foreignHandler = {type:'command', command:'printf foreign-context', timeout:3};
const backchannelsHandler = {type:'command', command:"node '$HOME/.agents/skills/backchannels/session-start.mjs' 2>/dev/null || cat '$HOME/.agents/skills/backchannels/session-start.txt' 2>/dev/null || true", timeout:5};
fs.writeFileSync(hooksPath, JSON.stringify({description:'foreign metadata', hooks:{SessionStart:[{matcher:'startup|resume|clear', hooks:[foreignHandler, backchannelsHandler]}], Stop:[{hooks:[foreignHandler]}]}}));
const runtimeSettings = JSON.parse(fs.readFileSync(runtimePath,'utf8'));
runtimeSettings.mcpServers.backchannels = {type:'http', url:'https://api.backchannels.dev/mcp'};
fs.writeFileSync(runtimePath,JSON.stringify(runtimeSettings));
NODE

backchannelsArtifactsAreAbsent() {
  node - "$sandbox" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const homeDirectory = process.argv[2];
const hooks = JSON.parse(fs.readFileSync(path.join(homeDirectory, '.codex/hooks.json'), 'utf8'));
const runtime = JSON.parse(fs.readFileSync(path.join(homeDirectory, '.claude.json'), 'utf8'));
const config = fs.readFileSync(path.join(homeDirectory, '.codex/config.toml'), 'utf8');
const skillPaths = ['.claude/skills/backchannels', '.agents/skills/backchannels', '.claude/profile-hooks'];
process.exit(!runtime.mcpServers.backchannels && !config.includes('mcp_servers.backchannels') && !JSON.stringify(hooks).includes('backchannels') && skillPaths.every(skillPath => !fs.existsSync(path.join(homeDirectory, skillPath))) ? 0 : 1);
NODE
}

foreignBackchannelsNeighboursArePreserved() {
  node - "$sandbox" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const homeDirectory = process.argv[2];
const hooks = JSON.parse(fs.readFileSync(path.join(homeDirectory, '.codex/hooks.json'), 'utf8'));
const config = fs.readFileSync(path.join(homeDirectory, '.codex/config.toml'), 'utf8');
const foreignStartup = hooks.hooks.SessionStart.find(entry => entry.matcher === 'startup|resume|clear');
process.exit(hooks.description === 'foreign metadata' && foreignStartup?.hooks.length === 1 && foreignStartup.hooks[0].command === 'printf foreign-context' && hooks.hooks.Stop[0].hooks[0].timeout === 3 && config.includes('model = "keep-model"') && config.includes('[hooks.state]\nforeign = { enabled = true, trusted_hash = "keep-trust" }') && config.includes('[mcp_servers.foreign]\nurl = "https://foreign.invalid/mcp"') && fs.existsSync(path.join(homeDirectory, '.agents/skills/foreign/SKILL.md')) ? 0 : 1);
NODE
}

trustCodexHooks() {
  node - "$sandbox/.codex/hooks.json" "$sandbox/.codex/config.toml" "$1" <<'NODE'
const fs = require('node:fs');
const [hooksPath, configPath, trustedHash] = process.argv.slice(2);
const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
let configText = fs.readFileSync(configPath, 'utf8');
for (const [eventName, entries] of Object.entries(hooks)) {
  entries.forEach((entry, entryIndex) => entry.hooks.forEach((handler, handlerIndex) => {
    if (!handler.command.includes('confine-backchannels.mjs')) return;
    const stateKey = `${hooksPath}:${eventName.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase()}:${entryIndex}:${handlerIndex}`;
    const tableHeader = `[hooks.state.${JSON.stringify(stateKey)}]`;
    configText = configText.split('\n').filter((line, lineIndex, lines) => line !== tableHeader && lines[lineIndex - 1] !== tableHeader).join('\n');
    configText += `\n${tableHeader}\ntrusted_hash = "${trustedHash}"\n`;
  }));
}
fs.writeFileSync(configPath, configText);
NODE
}

codexBackchannelsIsEnabled() {
  grep -A2 -xF '[mcp_servers.backchannels]' "$sandbox/.codex/config.toml" | grep -qx 'enabled = true'
}

codexBackchannelsIsDisabled() {
  grep -A2 -xF '[mcp_servers.backchannels]' "$sandbox/.codex/config.toml" | grep -qx 'enabled = false'
}

printf '\nai topic\n'

renderFixtureDirectory="$sandbox/render-codex-hooks-fixture"
mkdir -p "$renderFixtureDirectory"
node - "$renderFixtureDirectory/hooks.json" <<'NODE'
const fs = require('node:fs');
const handler = command => ({type:'command', command});
fs.writeFileSync(process.argv[2], JSON.stringify({hooks:{SessionStart:[{hooks:[handler('node /srv/backchannels/audit.mjs'), handler("node '$HOME/.agents/skills/backchannels/session-start.mjs' || true"), handler('node "/home/x/.claude/profile-hooks/confine-backchannels.mjs" --codex-startup')]}]}}));
NODE
node "$stagedRepo/ai/render-codex-hooks.mjs" "$stagedRepo/ai/codex-hooks.base.json" "$renderFixtureDirectory/hooks.json" "$renderFixtureDirectory/rendered.json" > /dev/null
check "Codex hook render keeps a foreign hook under another backchannels path and drops only owned and old-installer hooks" \
  node -e 'const commands = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hooks.SessionStart.flatMap(entry => entry.hooks.map(handler => handler.command)); process.exit(JSON.stringify(commands) === JSON.stringify(["node /srv/backchannels/audit.mjs"]) ? 0 : 1)' "$renderFixtureDirectory/rendered.json"

installStatus=0
firstRunOutput="$(runTopicInstall "$stagedTopicDir")" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "personal converge removes installer-owned backchannels artifacts" backchannelsArtifactsAreAbsent
check "personal cleanup preserves foreign hooks, MCP config, skills, and hook trust" foreignBackchannelsNeighboursArePreserved
check "install says what it did" test -n "$firstRunOutput"
for skillName in "${workSkillNames[@]}"; do
  check "personal profile leaves work skill $skillName absent" \
    bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$sandbox/.claude/skills/$skillName"
done
check "personal profile installs no work skill dependencies" \
  bash -c '! grep -qF /profiles/work/skills/ "$1"' _ "$skillDependencyLog"
check "converge installs a skill's locked dependencies from inside its directory because npm 11 ci --prefix from elsewhere reports the skill missing from its own lock" \
  grep -qx "npm ci --omit=dev in .*/ai/skills/social-images" "$skillDependencyLog"
check "converge installs the headless browser for a skill shipping playwright-core" \
  grep -qx 'playwright-core install --only-shell chromium' "$skillDependencyLog"
reviewChecklistPath="$sandbox/.claude/review-checklist.md"
check "personal profile leaves the review checklist absent" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"

check "plain converge runs no plugin command" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin",'
cp "$stagedRepo/ai/settings.base.json" "$sandbox/settings-before-plugin-tests.json"
node -e '
  const filesystem = require("node:fs");
  const settingsPath = process.argv[1];
  const settings = JSON.parse(filesystem.readFileSync(settingsPath, "utf8"));
  settings.enabledPlugins["companion@caveman"] = true;
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
  printf '{"installed":[{"id":"caveman@caveman","version":"%s"},{"id":"disabled@other","version":"1.0.0"},{"id":"companion@caveman","version":"%s"}],"available":[{"pluginId":"disabled@other","name":"disabled","marketplaceName":"other"}]}\n' \
    "$1" "$2" > "$sandbox/.plugin-list.json"
}
writeInstalledPlugins 2.1.0 2.1.0
writePluginMarketplace 2.2.0 2.2.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "unapproved plugin update is never applied" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update",'
check "plugin version resolves from the marketplace source plugin.json" grep -qx 'plugin caveman@caveman 2.1.0 2.2.0' "$pluginHeldPath"
check "plugin version resolves from the marketplace entry" grep -qx 'plugin companion@caveman 2.1.0 2.2.0' "$pluginHeldPath"
check "disabled plugin is never held" bash -c '! grep -qF disabled "$1"' _ "$pluginHeldPath"
check "disabled plugin records no failure" test ! -e "$pluginFailedPath"
check "plugin marketplace refreshes once" test "$(grep -cxF '["plugin","marketplace","update","caveman"]' "$mcpCommandLog")" -eq 1
check "plugins are listed once with available versions" test "$(grep -cxF '["plugin","list","--json","--available"]' "$mcpCommandLog")" -eq 1
writePluginMarketplace 3.0.0 2.2.0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null
check "major plugin is held" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update",'
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
check "an unversioned url-sourced plugin does not fail a nightly upgrade" test "$unversionedNightlyStatus" -eq 0
check "an unversioned url-sourced plugin issues no nightly update" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update","companion@caveman"]'
check "an unversioned url-sourced plugin records no nightly hold" bash -c '! grep -qsF companion "$1"' _ "$pluginHeldPath"
check "an unversioned url-sourced plugin records no nightly failure" bash -c '! grep -qsF companion "$1"' _ "$pluginFailedPath"
unversionedApprovedStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || unversionedApprovedStatus=$?
check "approval updates an unversioned url-sourced plugin" grep -qxF '["plugin","update","companion@caveman"]' "$mcpCommandLog"
check "an approved unversioned url-sourced plugin update succeeds cleanly" test "$unversionedApprovedStatus" -eq 0
check "an approved unversioned url-sourced plugin records no failure" bash -c '! grep -qsF companion "$1"' _ "$pluginFailedPath"
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
check "current plugin issues no update" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update",'
check "current plugin records no hold" test ! -e "$pluginHeldPath"
check "clean plugin run clears pending failures" test ! -e "$pluginFailedPath"
writeInstalledPlugins 2.1.0 2.2.0
printf '{"name":"caveman"}\n' > "$pluginMarketplacePath/.claude-plugin/plugin.json"
pathSourcedNightlyStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=1 runTopicInstall "$stagedTopicDir" > /dev/null || pathSourcedNightlyStatus=$?
check "an unversioned path-sourced plugin does not fail a nightly upgrade" test "$pathSourcedNightlyStatus" -eq 0
check "an unversioned path-sourced plugin issues no nightly update" bash -c '! grep -qF "$2" "$1"' _ "$mcpCommandLog" '["plugin","update","caveman@caveman"]'
check "an unversioned path-sourced plugin records no nightly failure" test ! -e "$pluginFailedPath"
pathSourcedApprovedStatus=0
: > "$mcpCommandLog"
DOTFILES_UPGRADE=all runTopicInstall "$stagedTopicDir" > /dev/null || pathSourcedApprovedStatus=$?
check "approval updates an unversioned path-sourced plugin" grep -qxF '["plugin","update","caveman@caveman"]' "$mcpCommandLog"
check "an approved unversioned path-sourced plugin update succeeds cleanly" test "$pathSourcedApprovedStatus" -eq 0
cp "$sandbox/settings-before-plugin-tests.json" "$stagedRepo/ai/settings.base.json"
: > "$mcpCommandLog"

mkdir -p "$sandbox/.claude/skills/backchannels" "$sandbox/.agents/skills/backchannels"
printf 'external Claude skill\n' > "$sandbox/.claude/skills/backchannels/SKILL.md"
printf 'external Codex skill\n' > "$sandbox/.agents/skills/backchannels/SKILL.md"
printf 'process.stdout.write("backchannels startup context");\n' > "$sandbox/.agents/skills/backchannels/session-start.mjs"
firstWorkStatus=0
workMcpOutput="$(runTopicInstall "$stagedTopicDir" work)" || firstWorkStatus=$?
check "a first work converge warns until Codex hooks are reviewed" test "$firstWorkStatus" -eq 1
check "work preserves external Claude skill ownership" grep -qx 'external Claude skill' "$sandbox/.claude/skills/backchannels/SKILL.md"
check "work preserves external Codex skill ownership" grep -qx 'external Codex skill' "$sandbox/.agents/skills/backchannels/SKILL.md"
check "work links profile hooks through the alias" \
  bash -c '[[ -L "$1" && "$(readlink "$1")" == "$2" ]]' _ "$sandbox/.claude/profile-hooks" "$sandbox/.dotfiles/profiles/work/hooks"
check "the shared installed hooks contain none of the three work hooks" \
  bash -c 'for hookName in confine-backchannels confine-cloudflare gate-posthog-exec-write; do [[ ! -e "$1/$hookName.mjs" ]] || exit 1; done' _ "$sandbox/.claude/hooks"
check "work configures the Codex backchannels server" grep -qx 'url = "https://api.backchannels.dev/mcp"' "$sandbox/.codex/config.toml"
check "work preserves foreign hooks and Codex trust" foreignBackchannelsNeighboursArePreserved
check "a first Codex hook render leaves backchannels disabled" codexBackchannelsIsDisabled
check "a first Codex hook render asks for hook review" outputHas "$workMcpOutput" "review hooks with /hooks, then rerun dot"
check "Codex owned hooks render ahead of foreign hooks" \
  node -e 'const hooks = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hooks; process.exit(hooks.SessionStart[0].hooks[0].command.includes("confine-backchannels.mjs") && hooks.PreToolUse[0].hooks[0].command.includes("confine-backchannels.mjs") ? 0 : 1)' "$sandbox/.codex/hooks.json"
trustCodexHooks "sha256:first-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "trusted Codex hooks enable backchannels" codexBackchannelsIsEnabled
cp "$stagedRepo/profiles/work/codex-hooks.json" "$sandbox/codex-hooks-declaration-backup.json"
node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], fs.readFileSync(process.argv[1], "utf8").replaceAll("\"timeout\": 10", "\"timeout\": 9"))' "$stagedRepo/profiles/work/codex-hooks.json"
changedHooksStatus=0
changedHooksOutput="$(runTopicInstall "$stagedTopicDir" work)" || changedHooksStatus=$?
check "changed Codex hooks disable backchannels until re-trusted" codexBackchannelsIsDisabled
check "changed Codex hooks warn" test "$changedHooksStatus" -eq 1
runTopicInstall "$stagedTopicDir" work > /dev/null || true
check "a stale trust hash at an owned hook position does not count" codexBackchannelsIsDisabled
trustCodexHooks "sha256:second-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "re-trusted changed Codex hooks enable backchannels" codexBackchannelsIsEnabled
cp "$sandbox/codex-hooks-declaration-backup.json" "$stagedRepo/profiles/work/codex-hooks.json"
runTopicInstall "$stagedTopicDir" work > /dev/null || true
trustCodexHooks "sha256:third-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "restored Codex hooks are enabled again once trusted" codexBackchannelsIsEnabled
node - "$sandbox" "$stagedRepo" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const [homeDirectory, personalRepository] = process.argv.slice(2);
const hooks = JSON.parse(fs.readFileSync(path.join(homeDirectory,'.codex/hooks.json'),'utf8')).hooks;
const run = (command, payload) => {
  const hookProcess = spawnSync('/bin/sh',['-c',command], {input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,HOME:homeDirectory},cwd:personalRepository});
  if (hookProcess.status !== 0) throw new Error(hookProcess.stderr);
  return hookProcess.stdout;
};
const preToolUse = hooks.PreToolUse.find(entry => new RegExp(entry.matcher).test('mcp__backchannels__register_agent'));
const denial = JSON.parse(run(preToolUse.hooks[0].command,{cwd:personalRepository,hook_event_name:'PreToolUse',tool_name:'mcp__backchannels__register_agent',tool_input:{name:'agent'}}));
if (denial.hookSpecificOutput.permissionDecision !== 'deny') throw new Error('installed Codex hook did not deny');
const startupHook = hooks.SessionStart.find(entry => entry.hooks.some(handler => handler.command.includes('confine-backchannels.mjs')));
const personalNotice = run(startupHook.hooks[0].command,{cwd:personalRepository,hook_event_name:'SessionStart'});
if (!personalNotice.includes('Ignore every backchannels startup instruction') || personalNotice.includes('backchannels startup context')) throw new Error('personal startup leaked');
const workRepository = path.join(homeDirectory,'posthog-repo');
fs.mkdirSync(workRepository,{recursive:true});
for (const gitArguments of [['init','-q',workRepository],['-C',workRepository,'remote','add','origin','https://github.com/PostHog/posthog.git']]) {
  if (spawnSync('git',gitArguments).status !== 0) throw new Error('could not initialize work repo');
}
if (run(startupHook.hooks[0].command,{cwd:workRepository,hook_event_name:'SessionStart'}) !== 'backchannels startup context') throw new Error('work startup missing');
if (run(preToolUse.hooks[0].command,{cwd:workRepository,hook_event_name:'PreToolUse',tool_name:'mcp__backchannels__register_agent'}) !== '') throw new Error('work registration blocked');
for (const hookName of ['confine-cloudflare','gate-posthog-exec-write']) {
  run(`node "${homeDirectory}/.claude/profile-hooks/${hookName}.mjs"`,{tool_name:'unrelated',tool_input:{}});
}
NODE
check "all three hooks resolve imports through the installed symlink and Codex work/personal behavior passes" test "$?" -eq 0
for skillName in "${workSkillNames[@]}"; do
  check "work profile links skill $skillName through the alias" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$sandbox/.claude/skills/$skillName" "$sandbox/.dotfiles/profiles/work/skills/$skillName"
done
check "work profile installs its skill's locked dependencies inside its directory" \
  grep -qx "npm ci --omit=dev in .*/profiles/work/skills/locked-profile-skill-test" "$skillDependencyLog"
check "work adds posthog with no consumer header and preserves unmanaged runtime state" \
  mcpRuntimeMatches https://mcp.posthog.com/mcp
check "work adds both declared servers once" test "$(countMcpCommands add-json)" -eq 2
check "MCP output contains no server config" outputLacks "$workMcpOutput" https://mcp.posthog.com/mcp
quietWorkOutput="$(runTopicInstall "$stagedTopicDir" work)"
check "a work rerun reports no changes" reportsNoChanges "$quietWorkOutput"
check "an unchanged rerun issues no MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 2
printf '{"posthog":{"url":"https://mcp.posthog.com/mcp","type":"http"},"backchannels":{"type":"http","url":"https://api.backchannels.dev/mcp"}}\n' \
  > "$stagedRepo/profiles/work/mcp-servers.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "object key order does not trigger MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 2
printf '{"posthog":{"type":"http","url":"https://changed.invalid/mcp"},"backchannels":{"type":"http","url":"https://api.backchannels.dev/mcp"}}\n' \
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
check "work to personal removes all backchannels artifacts" backchannelsArtifactsAreAbsent
check "work to personal preserves foreign hooks, skills, MCP config, and trust" foreignBackchannelsNeighboursArePreserved
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
check "an unmanaged differing server triggers no mutation beyond adding backchannels" \
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
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile removes the stale work review checklist link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$reviewChecklistPath"
printf 'local review notes\n' > "$reviewChecklistPath"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile preserves a non-repo review checklist" \
  grep -qx 'local review notes' "$reviewChecklistPath"
rm -f -- "$reviewChecklistPath"
profileAgentsPath="$sandbox/.claude/AGENTS.profile.md"
codexAgentsPath="$sandbox/.codex/AGENTS.md"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "work profile links its own AGENTS.md through the alias" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$profileAgentsPath" "$sandbox/.dotfiles/profiles/work/AGENTS.md"
check "work Codex AGENTS.md is a rendered plain file" \
  bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$codexAgentsPath"
check "work Codex AGENTS.md carries the shared rules then the work rules" \
  bash -c 'diff -q "$1" <(cat "$2"; printf "\n"; cat "$3") > /dev/null' _ \
  "$codexAgentsPath" "$stagedRepo/ai/AGENTS.md" "$stagedRepo/profiles/work/AGENTS.md"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile removes the work AGENTS.profile.md link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$profileAgentsPath"
check "personal Codex AGENTS.md holds only the shared rules" \
  cmp -s "$codexAgentsPath" "$stagedRepo/ai/AGENTS.md"
check "converge skips npm ci while a skill's installed lock is current" \
  test "$(grep -c '^npm ci ' "$skillDependencyLog")" -eq 2

linkedDestinations=(
  ".claude/AGENTS.md" ".claude/ROUTING.md" ".claude/tsconfig.json" ".claude/types"
  ".claude/agents" ".claude/workflows" ".claude/commands" ".claude/hooks" ".claude/hud"
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
mkdir -p "$skillsPath/open-pr"
printf 'foreign skill state\n' > "$skillsPath/open-pr/state.json"
foreignWorkSkillPath="$sandbox/foreign-sprint-update"
mkdir -p "$foreignWorkSkillPath"
printf 'foreign linked skill state\n' > "$foreignWorkSkillPath/state.json"
ln -s "$foreignWorkSkillPath" "$skillsPath/sprint-update"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "personal profile preserves a foreign directory named after a work skill" \
  bash -c '[[ ! -L "$1" ]] && grep -qx "foreign skill state" "$1/state.json"' _ "$skillsPath/open-pr"
check "personal profile preserves a foreign symlink named after a work skill" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]] && grep -qx "foreign linked skill state" "$1/state.json"' _ \
  "$skillsPath/sprint-update" "$foreignWorkSkillPath"
rm -rf "$skillsPath/open-pr"
rm -f "$skillsPath/sprint-update"
for skillName in "${workSkillNames[@]}"; do
  ln -s "$sandbox/.dotfiles/ai/skills/$skillName" "$skillsPath/$skillName"
done
runTopicInstall "$stagedTopicDir" work > /dev/null
for skillName in "${workSkillNames[@]}"; do
  check "work profile migrates the former shared skill $skillName" \
    bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
    "$skillsPath/$skillName" "$sandbox/.dotfiles/profiles/work/skills/$skillName"
done
rm -f "$skillsPath/sprint-update"
ln -s "$stagedRepo/profiles/work/skills/sprint-update" "$skillsPath/sprint-update"
ln -s "$sandbox/.dotfiles/profiles/retired/skills/commit" "$skillsPath/commit-from-retired-profile"
ln -s "$stagedRepo/profiles/retired/skills/deleted" "$skillsPath/deleted-profile-skill"
ln -s "$sandbox/.dotfiles/profiles/work/skills/deleted" "$skillsPath/.hidden-profile-skill"
runTopicInstall "$stagedTopicDir" personal > /dev/null
for skillName in "${workSkillNames[@]}" commit-from-retired-profile deleted-profile-skill locked-profile-skill-test .hidden-profile-skill; do
  check "personal profile removes profile skill link $skillName through the alias or clone path" \
    bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$skillsPath/$skillName"
done
profileConflictSkillPath="$stagedRepo/profiles/work/skills/commit"
mkdir -p "$profileConflictSkillPath"
printf '{}\n' > "$profileConflictSkillPath/package-lock.json"
profileConflictStatus=0
profileConflictOutput="$(runTopicInstall "$stagedTopicDir" work)" || profileConflictStatus=$?
check "a profile skill conflicting with a shared skill warns" \
  outputHas "$profileConflictOutput" "profile skill conflicts with shared skill"
check "a profile skill conflict fails the topic" test "$profileConflictStatus" -eq 1
check "a profile skill conflict keeps the shared link" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$skillsPath/commit" "$sandbox/.dotfiles/ai/skills/commit"
check "a conflicting profile skill installs no dependencies" \
  bash -c '! grep -qF /profiles/work/skills/commit "$1"' _ "$skillDependencyLog"
rm -rf "$profileConflictSkillPath"
noProfileSkillsStatus=0
runTopicInstallWithoutProfile "$stagedTopicDir" > /dev/null || noProfileSkillsStatus=$?
check "a missing profile still warns" test "$noProfileSkillsStatus" -eq 1
for skillName in "${workSkillNames[@]}"; do
  check "a missing profile removes work skill $skillName" \
    bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$skillsPath/$skillName"
done
check "a missing profile keeps shared skills linked" \
  bash -c '[[ -L "$1" && "$(readlink -- "$1")" == "$2" ]]' _ \
  "$skillsPath/commit" "$sandbox/.dotfiles/ai/skills/commit"
runTopicInstall "$stagedTopicDir" personal > /dev/null
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
missingClaudeStatus=0
missingClaudeOutput="$(env HOME="$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 PATH="$gitlessBin" \
  bash "$stagedTopicDir/install.sh")" || missingClaudeStatus=$?
check "an absent claude CLI warns" outputHas "$missingClaudeOutput" "claude not found"
check "an absent Codex CLI warns" outputHas "$missingClaudeOutput" "codex not found"
check "an absent claude CLI marks the topic warned" test "$missingClaudeStatus" -eq 1
check "an absent claude CLI still renders work settings" \
  cmp -s "$sandbox/.claude/CLAUDE.md" "$stagedRepo/profiles/work/CLAUDE.md"
check "an absent claude CLI preserves managed and unmanaged servers" mcpRuntimeMatches https://mcp.posthog.com/mcp
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "retirement after an absent CLI preserves the unmanaged server" mcpRuntimeMatches ""
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

runTopicInstall "$stagedTopicDir" work > /dev/null
node - "$sandbox/.codex/config.toml" <<'NODE'
const fs = require('node:fs');
const configPath = process.argv[2];
fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('https://api.backchannels.dev/mcp', 'https://outdated.invalid/mcp'));
NODE
cp "$sandbox/.codex/config.toml" "$sandbox/codex-config-before-failed-render.toml"
: > "$sandbox/.fail-codex-mcp-stage"
failedCodexRenderStatus=0
failedCodexRenderOutput="$(runTopicInstall "$stagedTopicDir" work)" || failedCodexRenderStatus=$?
check "Codex rejects an invalid staged config with a warning" test "$failedCodexRenderStatus" -eq 1
check "a rejected Codex render preserves the current config" cmp -s "$sandbox/.codex/config.toml" "$sandbox/codex-config-before-failed-render.toml"
rm -f "$sandbox/.fail-codex-mcp-stage"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a changed Codex URL converges" grep -qx 'url = "https://api.backchannels.dev/mcp"' "$sandbox/.codex/config.toml"
check "a changed Codex URL preserves foreign config and trust" foreignBackchannelsNeighboursArePreserved
: > "$sandbox/.fail-codex-mcp-remove"
failedCodexRemovalStatus=0
failedCodexRemovalOutput="$(runTopicInstall "$stagedTopicDir" personal)" || failedCodexRemovalStatus=$?
check "a failed Codex removal follows the topic warning convention" test "$failedCodexRemovalStatus" -eq 1
check "a failed Codex removal preserves the server for the next converge" grep -qxF '[mcp_servers.backchannels]' "$sandbox/.codex/config.toml"
check "a failed Codex removal still removes startup hooks" bash -c '! grep -q backchannels "$1"' _ "$sandbox/.codex/hooks.json"
rm -f "$sandbox/.fail-codex-mcp-remove"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "a failed Codex removal converges once the CLI can remove it" backchannelsArtifactsAreAbsent
cp "$sandbox/.codex/config.toml" "$sandbox/codex-valid-config.toml"
printf 'invalid toml\n' > "$sandbox/.codex/config.toml"
invalidCodexConfigStatus=0
invalidCodexConfigOutput="$(runTopicInstall "$stagedTopicDir" work)" || invalidCodexConfigStatus=$?
check "an unreadable Codex config warns" test "$invalidCodexConfigStatus" -eq 1
check "an unreadable Codex config is never overwritten" grep -qx 'invalid toml' "$sandbox/.codex/config.toml"
cp "$sandbox/codex-valid-config.toml" "$sandbox/.codex/config.toml"
runTopicInstall "$stagedTopicDir" personal > /dev/null
cp "$sandbox/.codex/hooks.json" "$sandbox/codex-valid-hooks.json"
printf 'not json\n' > "$sandbox/.codex/hooks.json"
invalidCodexHooksStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null 2>&1 || invalidCodexHooksStatus=$?
check "unparseable Codex hooks warn" test "$invalidCodexHooksStatus" -eq 1
check "unparseable Codex hooks preserve the source for correction" grep -qx 'not json' "$sandbox/.codex/hooks.json"
check "unparseable Codex hooks leave the Codex backchannels server disabled" codexBackchannelsIsDisabled
cp "$sandbox/codex-valid-hooks.json" "$sandbox/.codex/hooks.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "Codex backchannels is enabled again once its trusted hooks render" codexBackchannelsIsEnabled
codexTrustEpochPath="$XDG_STATE_HOME/dotfiles/ai-codex-hook-trust-epoch"
codexTrustBaselinePath="$XDG_STATE_HOME/dotfiles/ai-codex-hook-trust-baseline"
cp "$sandbox/.codex/hooks.json" "$sandbox/codex-hooks-before-quiet-rerun.json"
cp "$codexTrustEpochPath" "$sandbox/codex-trust-epoch-before-quiet-rerun"
quietRerunStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null || quietRerunStatus=$?
check "an unchanged trusted converge reruns quietly" test "$quietRerunStatus" -eq 0
check "an unchanged converge keeps the Codex trust epoch" cmp -s "$codexTrustEpochPath" "$sandbox/codex-trust-epoch-before-quiet-rerun"
check "an unchanged converge keeps the Codex hook definitions" cmp -s "$sandbox/.codex/hooks.json" "$sandbox/codex-hooks-before-quiet-rerun.json"
check "owned Codex hook commands carry the trust epoch" grep -qF -- "--trust-epoch=$(cat "$codexTrustEpochPath")" "$sandbox/.codex/hooks.json"
rm -f "$codexTrustEpochPath" "$codexTrustBaselinePath"
lostTrustStateStatus=0
runTopicInstall "$stagedTopicDir" work > /dev/null || lostTrustStateStatus=$?
check "lost Codex trust state warns" test "$lostTrustStateStatus" -eq 1
check "lost Codex trust state disables backchannels" codexBackchannelsIsDisabled
check "lost Codex trust state rotates the trust epoch" bash -c '! cmp -s "$1" "$2"' _ "$codexTrustEpochPath" "$sandbox/codex-trust-epoch-before-quiet-rerun"
check "lost Codex trust state changes the owned hook definitions" bash -c '! cmp -s "$1" "$2"' _ "$sandbox/.codex/hooks.json" "$sandbox/codex-hooks-before-quiet-rerun.json"
trustCodexHooks "sha256:third-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null || true
check "the pre-loss trust hash does not count after lost Codex trust state" codexBackchannelsIsDisabled
trustCodexHooks "sha256:after-state-loss-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "re-trusted hooks after lost Codex trust state enable backchannels" codexBackchannelsIsEnabled
rm -f "$codexTrustEpochPath" "$codexTrustBaselinePath"
mv "$stagedRepo/profiles/work/hooks" "$sandbox/work-hooks-aside"
runTopicInstall "$stagedTopicDir" work > /dev/null 2>&1 || true
check "a warned profile hooks link still records the Codex trust baseline" test -s "$codexTrustBaselinePath"
check "a warned profile hooks link leaves backchannels disabled" codexBackchannelsIsDisabled
trustCodexHooks "sha256:while-link-warned-trust"
mv "$sandbox/work-hooks-aside" "$stagedRepo/profiles/work/hooks"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "hooks trusted while the profile hooks link warned enable backchannels once it converges" codexBackchannelsIsEnabled
cp "$stagedRepo/profiles/work/settings.overlay.json" "$sandbox/settings-overlay-backup.json"
printf 'not json\n' > "$stagedRepo/profiles/work/settings.overlay.json"
failedClaudeConfinementStatus=0
failedClaudeConfinementOutput="$(runTopicInstall "$stagedTopicDir" work)" || failedClaudeConfinementStatus=$?
check "a failed Claude settings render warns" test "$failedClaudeConfinementStatus" -eq 1
check "a failed Claude settings render withholds the Claude backchannels server" \
  node -e 'process.exit(require(process.argv[1]).mcpServers.backchannels ? 1 : 0)' "$sandbox/.claude.json"
check "a failed Claude settings render names the withheld server" \
  outputHas "$failedClaudeConfinementOutput" "withheld until Claude confinement converges"
cp "$sandbox/settings-overlay-backup.json" "$stagedRepo/profiles/work/settings.overlay.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a recovered Claude settings render restores the Claude backchannels server" \
  node -e 'process.exit(require(process.argv[1]).mcpServers.backchannels ? 0 : 1)' "$sandbox/.claude.json"
runTopicInstall "$stagedTopicDir" personal > /dev/null

settingsHookCommandsResolve() {
  node - "$sandbox/.claude/settings.json" <<'NODE'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const commands = Object.values(settings.hooks ?? {}).flatMap(entries => entries.flatMap(entry => entry.hooks.map(handler => handler.command)));
const scriptPaths = commands.flatMap(command => command.match(/\/[^\s"']+\.mjs/g) ?? []);
process.exit(scriptPaths.length > 0 && scriptPaths.every(scriptPath => fs.existsSync(scriptPath)) ? 0 : 1);
NODE
}

runTopicInstall "$stagedTopicDir" work > /dev/null
trustCodexHooks "sha256:no-profile-trust"
runTopicInstall "$stagedTopicDir" work > /dev/null
mkdir -p "$sandbox/.claude/skills/backchannels" "$sandbox/.agents/skills/backchannels"
noProfileSnapshot="$sandbox/no-profile-snapshot"
rm -rf "$noProfileSnapshot"
mkdir -p "$noProfileSnapshot"
cp "$sandbox/.claude.json" "$sandbox/.codex/hooks.json" "$sandbox/.codex/config.toml" "$sandbox/.claude/settings.json" "$noProfileSnapshot/"
noProfileStatus=0
runTopicInstall "$stagedTopicDir" "" > /dev/null || noProfileStatus=$?
check "a no-profile converge warns" test "$noProfileStatus" -eq 1
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
mkdir -p "$sandbox/.claude/skills/backchannels" "$sandbox/.agents/skills/backchannels"
serverStatus=0
runTopicInstall "$stagedTopicDir" server > /dev/null || serverStatus=$?
check "server converge follows topic warning convention" test "$serverStatus" -eq 0
check "server converge removes all backchannels artifacts" backchannelsArtifactsAreAbsent
check "server cleanup preserves foreign entries" foreignBackchannelsNeighboursArePreserved
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

profileClaudeMdImportsOnlyAgentsFiles() {
  local profileDirectory="$1"
  local expectedImports="@AGENTS.md"
  if [[ -f "$profileDirectory/AGENTS.md" ]]; then
    expectedImports+=$'\n@AGENTS.profile.md'
  fi
  [[ "$(cat -- "$profileDirectory/CLAUDE.md")" == "$expectedImports" ]]
}

for profileDirectory in "$repoRoot"/profiles/*/; do
  profileName="$(basename -- "$profileDirectory")"
  check "$profileName CLAUDE.md only imports its AGENTS files, so profile rules live in AGENTS.md" \
    profileClaudeMdImportsOnlyAgentsFiles "$profileDirectory"
done

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
check "settings.json pins the haiku alias to the model ROUTING.md names" \
  node -e 'const fs=require("fs");const routedHaikuModel=(fs.readFileSync(process.argv[1],"utf8").match(/^\| `haiku` \(([^)]+)\)/m)||[])[1];const pinnedHaikuModel=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).env.ANTHROPIC_DEFAULT_HAIKU_MODEL;process.exit(routedHaikuModel&&routedHaikuModel===pinnedHaikuModel?0:1)' "$topicDir/ROUTING.md" "$settingsPath"

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

check "work-server renders caveman defaults without backchannels confinement or retired plugins" \
  node - "$sandbox/deny-probe-work-server.json" "$topicDir/settings.base.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const renderedText = fs.readFileSync(process.argv[2], "utf8");
const renderedSettings = JSON.parse(renderedText);
const baseSettings = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
assert.equal(renderedSettings.enabledPlugins["caveman@caveman"], true);
assert.deepEqual(renderedSettings.extraKnownMarketplaces.caveman, baseSettings.extraKnownMarketplaces.caveman);
assert.equal(renderedSettings.env.CAVEMAN_DEFAULT_MODE, baseSettings.env.CAVEMAN_DEFAULT_MODE);
assert.equal(renderedSettings.env.CAVEMAN_TELEMETRY, baseSettings.env.CAVEMAN_TELEMETRY);
assert.doesNotMatch(renderedText, /confine-backchannels|example-org|[/]org-|telegram@claude-plugins-official/);
JS

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
check "settings.json keeps agent teams off so named agents reach the subagent row script" \
  grep -q "\"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\": \"0\"" "$settingsPath"
check "settings.json rewrites the subagent rows with the repo script" \
  grep -q "\"command\": \"node $sandbox/.claude/hud/subagent-hud.mjs\"" "$settingsPath"
check "settings.json has no unrendered token" bash -c '! grep -q "{{HOME}}" "$1"' _ "$settingsPath"
check "settings.json points the commit policy at the alias" \
  grep -q "\"CLAUDE_COMMIT_POLICY_ROOT\": \"$sandbox/.dotfiles\"" "$settingsPath"
check "settings.json is not world readable" test "$(fileModeOf "$settingsPath")" = "600"

countSettingsCommand() {
  grep -c -- "$1" "$settingsPath"
}
check "the routing SessionStart hook reaches the profile" test "$(countSettingsCommand inject-routing.mjs)" -eq 1
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
hookTestFiles=("$topicDir"/hooks/test/*.test.mjs "$repoRoot"/profiles/work/hooks/test/*.test.mjs)
workflowTestFiles=("$topicDir"/workflows/test/*.test.mjs)
commitTestFiles=("$topicDir"/skills/commit/test/*.test.ts)
openPrTestFiles=("$repoRoot"/profiles/work/skills/open-pr/test/*.test.mjs)
socialImagesTestFiles=("$topicDir"/skills/social-images/test/*.test.mjs)
hudTestFiles=("$topicDir"/hud/test/*.test.mjs)
shopt -u nullglob
check "hook behavior tests are present" test "${#hookTestFiles[@]}" -gt 0
check "workflow behavior tests are present" test "${#workflowTestFiles[@]}" -gt 0
check "commit behavior tests are present" test "${#commitTestFiles[@]}" -gt 0
check "open-pr evidence tests are present" test "${#openPrTestFiles[@]}" -gt 0
check "social-images render tests are present" test "${#socialImagesTestFiles[@]}" -gt 0
check "hud tests are present" test "${#hudTestFiles[@]}" -gt 0
if ((${#hookTestFiles[@]} > 0 && ${#workflowTestFiles[@]} > 0 && ${#commitTestFiles[@]} > 0 && ${#openPrTestFiles[@]} > 0 && ${#socialImagesTestFiles[@]} > 0 && ${#hudTestFiles[@]} > 0)); then
  check "hook, workflow, commit, open-pr, social-images, and hud behavior tests pass" node --test "${hookTestFiles[@]}" "${workflowTestFiles[@]}" "${commitTestFiles[@]}" "${openPrTestFiles[@]}" "${socialImagesTestFiles[@]}" "${hudTestFiles[@]}"
fi

reportTopicResults "ai"
