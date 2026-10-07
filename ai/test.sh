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
rm -rf "$stagedRepo/.git" "$stagedRepo"/ai/skills/*/node_modules
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
printf '{"mcpServers":{"backchannels":{"type":"http","url":"https://unmanaged.invalid/mcp"}},"runtimeToken":"keep-me"}\n' \
  > "$sandbox/.claude.json"

mcpRuntimeMatches() {
  node - "$sandbox/.claude.json" "$1" <<'NODE'
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const [runtimePath, expectedPosthogUrl] = process.argv.slice(2);
const runtimeSettings = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
const expectedServers = { backchannels: { type: 'http', url: 'https://unmanaged.invalid/mcp' } };
if (expectedPosthogUrl) expectedServers.posthog = { type: 'http', url: expectedPosthogUrl };
process.exit(isDeepStrictEqual(runtimeSettings.mcpServers, expectedServers) && runtimeSettings.runtimeToken === 'keep-me' ? 0 : 1);
NODE
}

countMcpCommands() {
  grep -cF "[\"mcp\",\"$1\"" "$mcpCommandLog" || true
}

printf '\nai topic\n'

installStatus=0
firstRunOutput="$(runTopicInstall "$stagedTopicDir")" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
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

workMcpOutput="$(runTopicInstall "$stagedTopicDir" work)"
check "work adds posthog with no consumer header and preserves unmanaged runtime state" \
  mcpRuntimeMatches https://mcp.posthog.com/mcp
check "work adds posthog once" test "$(countMcpCommands add-json)" -eq 1
check "MCP output contains no server config" outputLacks "$workMcpOutput" https://mcp.posthog.com/mcp
runTopicInstall "$stagedTopicDir" work > /dev/null
check "an unchanged rerun issues no MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 1
printf '{"posthog":{"url":"https://mcp.posthog.com/mcp","type":"http"}}\n' \
  > "$stagedRepo/profiles/work/mcp-servers.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "object key order does not trigger MCP mutation" test "$(wc -l < "$mcpCommandLog")" -eq 1
printf '{"posthog":{"type":"http","url":"https://changed.invalid/mcp"}}\n' \
  > "$stagedRepo/profiles/work/mcp-servers.json"
runTopicInstall "$stagedTopicDir" work > /dev/null
check "a changed config removes then adds the managed server" \
  node -e 'const commands = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse); process.exit(commands.length === 3 && commands[1][1] === "remove" && commands[2][1] === "add-json" ? 0 : 1)' "$mcpCommandLog"
check "a changed URL converges while preserving unmanaged state" mcpRuntimeMatches https://changed.invalid/mcp
: > "$sandbox/.fail-mcp-remove"
failedRemovalStatus=0
runTopicInstall "$stagedTopicDir" personal > /dev/null || failedRemovalStatus=$?
check "a failed removal warns" test "$failedRemovalStatus" -eq 1
check "a failed removal retains ownership for retry" \
  grep -qx posthog "$XDG_STATE_HOME/dotfiles/ai-managed-mcp-servers"
rm -f "$sandbox/.fail-mcp-remove"
runTopicInstall "$stagedTopicDir" personal > /dev/null
check "switching to personal removes only the managed server" mcpRuntimeMatches ""
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
check "an unmanaged differing server triggers no MCP mutation" \
  test "$(wc -l < "$mcpCommandLog")" -eq "$mcpCommandCountBeforeUnmanaged"
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
check "converge skips npm ci while a skill's installed lock is current" \
  test "$(grep -c '^npm ci ' "$skillDependencyLog")" -eq 1

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
hookTestFiles=("$topicDir"/hooks/test/*.test.mjs)
workflowTestFiles=("$topicDir"/workflows/test/*.test.mjs)
commitTestFiles=("$topicDir"/skills/commit/test/*.test.ts)
openPrTestFiles=("$topicDir"/skills/open-pr/test/*.test.mjs)
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
