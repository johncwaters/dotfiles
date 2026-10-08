#!/usr/bin/env bash
set -euo pipefail

testDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$testDirectory/.." && pwd)"
# shellcheck source=./harness.sh
source "$repoRoot/test/harness.sh"

startSandboxHome "repo-wiring"

printf '\nrepo wiring\n'

dotfilesRepo="$repoRoot"
# shellcheck source=../script/lib/profile.sh
source "$repoRoot/script/lib/profile.sh"

topicsNamedByAnyProfile() {
  local profileJsonPath
  for profileJsonPath in "$repoRoot"/profiles/*/profile.json; do
    readProfileTopics "$profileJsonPath"
  done | sort -u
}

topicDirectoriesWithAnInstaller() {
  local installerPath
  for installerPath in "$repoRoot"/*/install.sh; do
    basename -- "$(dirname -- "$installerPath")"
  done | sort -u
}

namedTopics="$(topicsNamedByAnyProfile)"

someProfileNamesTopic() {
  grep -qx -- "$1" <<< "$namedTopics"
}

for wiredTopic in $namedTopics; do
  check "the $wiredTopic topic a profile names has an installer" \
    test -f "$repoRoot/$wiredTopic/install.sh"
  check "the $wiredTopic topic a profile names has a suite" \
    test -f "$repoRoot/$wiredTopic/test.sh"
done

for installableTopic in $(topicDirectoriesWithAnInstaller); do
  check "the $installableTopic topic is named by some profile" \
    someProfileNamesTopic "$installableTopic"
  check "the README topics table names $installableTopic" \
    grep -qF "| \`$installableTopic\` |" "$repoRoot/README.md"
done

checkProfileClaudeSettings() {
  local profileName="$1"
  local profileOverlayPath
  profileOverlayPath="$(node "$repoRoot/ai/profile-config.mjs" "$profileName" settings.overlay.json)"
  if [[ ! -f "$profileOverlayPath" ]]; then
    fail "$profileName has Claude settings for its ai topic"
    return
  fi
  pass "$profileName has Claude settings for its ai topic"
  local renderedProfileSettingsPath="$sandbox/rendered-ai-settings.$profileName.json"
  HOME="$sandbox" node "$repoRoot/ai/render-settings.mjs" \
    "$repoRoot/ai/settings.base.json" "$profileOverlayPath" \
    "$renderedProfileSettingsPath" /fixture/home
  check "the $profileName profile defaults caveman to ultracave" \
    grep -qF '"CAVEMAN_DEFAULT_MODE": "ultracave"' "$renderedProfileSettingsPath"
  check "the $profileName profile turns caveman telemetry off because it reports the install ID and IP by default" \
    grep -qF '"CAVEMAN_TELEMETRY": "0"' "$renderedProfileSettingsPath"
  check "the $profileName profile enables the caveman plugin" \
    grep -qF '"caveman@caveman": true' "$renderedProfileSettingsPath"
  check "the $profileName profile leaves caveman mode to the plugin, which honors CAVEMAN_DEFAULT_MODE since 3.1.0" \
    bash -c '! grep -qF caveman-ultra.mjs "$1"' _ "$renderedProfileSettingsPath"
  local profileSettingsFixturePath="$repoRoot/test/fixtures/ai-settings.$profileName.json"
  if [[ -f "$profileSettingsFixturePath" ]]; then
    check "the shared merger keeps the prior $profileName ai settings bytes" \
      cmp -s "$profileSettingsFixturePath" "$renderedProfileSettingsPath"
  fi
}

for profileJsonPath in "$repoRoot"/profiles/*/profile.json; do
  profileDirectoryPath="$(dirname -- "$profileJsonPath")"
  profileTopics="$(readProfileTopics "$profileJsonPath")"
  if grep -qx packages <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has package groups for its packages topic" \
      test -f "$profileDirectoryPath/packages.txt"
  fi
  if grep -qx glimmervoid <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has glimmervoid settings for its glimmervoid topic" \
      test -f "$profileDirectoryPath/glimmervoid.json"
  fi
  if grep -qx vscodium <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has vscodium settings for its vscodium topic" \
      test -f "$profileDirectoryPath/vscodium.json"
  fi
  if grep -qx ai <<< "$profileTopics"; then
    checkProfileClaudeSettings "$(basename -- "$profileDirectoryPath")" \
      "$profileDirectoryPath/settings.overlay.json"
  fi
done

check "work-server runs only ai and git on Linux, leaving glimmervoid and repos to the devbox provisioner" \
  node - "$repoRoot/profiles/work-server" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const profileDirectory = process.argv[2];
const readProfileJson = name => JSON.parse(fs.readFileSync(`${profileDirectory}/${name}`, "utf8"));
assert.deepEqual(readProfileJson("profile.json"), { platform: "linux", topics: ["ai", "git"] });
for (const excludedFile of ["glimmervoid.json", "glimmervoid.overlay.json", "mcp-servers.json", "packages.txt"]) {
  assert.equal(fs.existsSync(`${profileDirectory}/${excludedFile}`), false);
}
JS

for sharedWorkFile in CLAUDE.md AGENTS.md commit-policy.json settings.overlay.json hooks codex-hooks.json skills; do
  check "work-server inherits work $sharedWorkFile without copying agent additions" \
    test "$(node "$repoRoot/ai/profile-config.mjs" work-server "$sharedWorkFile")" = \
    "$repoRoot/profiles/$(case "$sharedWorkFile" in commit-policy.json) printf work-server ;; *) printf work ;; esac)/$sharedWorkFile"
done

check "work-server settings equal work settings including confinement" \
  cmp -s "$sandbox/rendered-ai-settings.work.json" "$sandbox/rendered-ai-settings.work-server.json"

# These topics confine their commands to the sandbox home without command stubs.
topicSuitesNeedingStubs() {
  topicDirectoriesWithAnInstaller | grep -Evx 'ai|git|shell'
}

for stubbedTopicSuite in $(topicSuitesNeedingStubs); do
  check "$stubbedTopicSuite uses the shared stubbed sandbox" \
    grep -q 'startStubbedSandbox' "$repoRoot/$stubbedTopicSuite/test.sh"
done

check "README points rendered destinations at the render engine" \
  bash -c 'grep -q "rendered" "$1/README.md" && grep -q "script/lib/render.sh" "$1/README.md"' \
  _ "$repoRoot"
check "the README fresh mac section names the command line tools, the sudo refresh, and the work converge command" \
  bash -c 'freshMacSection="$(sed -n "/^### Fresh mac/,/^Entry points:/p" "$1/README.md")"; grep -qF "xcode-select --install" <<< "$freshMacSection" && grep -qF "sudo -v" <<< "$freshMacSection" && grep -qF "bin/dot --profile work" <<< "$freshMacSection"' \
  _ "$repoRoot"
check "render decisions reuse the shared plain file predicate" \
  grep -q 'pathIsPlainFileOrAbsent "$copyPath"' "$repoRoot/script/lib/render.sh"
check "the repository map names the bubblewrap sandbox" \
  grep -q 'shared bubblewrap sandbox' "$repoRoot/AGENTS.md"
check "the repository map no longer names a Docker matrix" \
  bash -c '! grep -q "Docker matrix" "$1/AGENTS.md"' _ "$repoRoot"
profileSectionOfReadme="$(sed -n '/^## Profiles/,/^## Topics/p' "$repoRoot/README.md")"
profileInputMaps="$profileSectionOfReadme
$(cat "$repoRoot/ai/hooks/AGENTS.md")"
declare -A checkedProfileInputNames=()
for profileInputPath in "$repoRoot"/profiles/*/*; do
  profileInputName="$(basename -- "$profileInputPath")"
  [[ -d "$profileInputPath" ]] && profileInputName+="/"
  [[ -z "${checkedProfileInputNames[$profileInputName]:-}" ]] || continue
  checkedProfileInputNames[$profileInputName]=1
  check "the README or hook map names profile input $profileInputName" \
    grep -qF "$profileInputName\`" <<< "$profileInputMaps"
done
check "work and work-server share one glimmervoid settings file through the sync engine" \
  bash -c 'test -f "$1/profiles/work/glimmervoid.settings.json" && test ! -e "$1/profiles/work-server/glimmervoid.settings.json" && grep -q "profiles/work/glimmervoid.settings.json" "$1/glimmervoid/install.sh" "$1/profiles/work/devbox/provision.sh"' _ "$repoRoot"
check "the README profile file list names vscodium settings" \
  grep -qF '`vscodium.json`' "$repoRoot/README.md"
for examplePath in repos/repos.example.txt glimmervoid/config.example.json \
  git/gitconfig.local.example shell/localrc.example; do
  check "the README names $examplePath" grep -qF "\`$examplePath\`" "$repoRoot/README.md"
done
check "the README names the rendered Claude settings inputs" \
  bash -c 'grep -qF '\''`~/.claude/settings.json` is rendered from `ai/settings.base.json`'\'' "$1/README.md" && grep -qF '\''`settings.overlay.json`'\'' "$1/README.md"' \
  _ "$repoRoot"
check "the README says bootstrap writes the machine profile" \
  grep -qF '`.machine-profile` is written by' "$repoRoot/README.md"
check "glimmervoid reads tracked inputs through the checkout root" \
  bash -c '! grep -q '\''\$dotfilesAlias'\'' "$1/glimmervoid/install.sh"' _ "$repoRoot"
check "glimmervoid uses the shared JSON merger" \
  grep -qF 'script/lib/merge-json.mjs' "$repoRoot/glimmervoid/install.sh"
check "the glimmervoid seed has one shared home token" \
  bash -c '! grep -q "__HOME__" "$1/glimmervoid/config.example.json" && grep -q "{{HOME}}" "$1/glimmervoid/config.example.json"' \
  _ "$repoRoot"
check "glimmervoid has no seed kind selector" \
  bash -c '! grep -q "glimmervoidSeedInputsFor" "$1/glimmervoid/install.sh"' _ "$repoRoot"
check "profile glimmervoid settings have no seed key" \
  bash -c '! grep -q '"'"'"seed"'"'"' "$1"/profiles/*/glimmervoid.json' _ "$repoRoot"
check "the server profile owns its glimmervoid overlay" \
  test -f "$repoRoot/profiles/server/glimmervoid.overlay.json"
check "the glimmervoid topic owns no server overlay" \
  test ! -e "$repoRoot/glimmervoid/config.server.overlay.json"
check "the generic glimmervoid seed renderer has no server-only name" \
  bash -c 'grep -q "^renderGlimmervoidSeed()" "$1/glimmervoid/install.sh" && ! grep -q "renderGlimmervoidServerSeed" "$1/glimmervoid/install.sh"' \
  _ "$repoRoot"

mergedWithoutOverlayPath="$sandbox/merged-without-overlay.json"
HOME="$sandbox" node "$repoRoot/script/lib/merge-json.mjs" \
  "$repoRoot/glimmervoid/config.example.json" "" "$mergedWithoutOverlayPath" /fixture/home
check "the shared merger accepts a missing overlay" \
  grep -qF '"/fixture/home/Projects"' "$mergedWithoutOverlayPath"

# Every topic reaches the merger through the ~/.dotfiles alias, so the main-module guard must survive a symlink.
mergerAliasPath="$sandbox/merge-json-alias.mjs"
ln -sf "$repoRoot/script/lib/merge-json.mjs" "$mergerAliasPath"
mergedThroughAliasPath="$sandbox/merged-through-alias.json"
HOME="$sandbox" node "$mergerAliasPath" \
  "$repoRoot/glimmervoid/config.example.json" "" "$mergedThroughAliasPath" /fixture/home
check "the shared merger renders when reached through a symlink" \
  grep -qF '"/fixture/home/Projects"' "$mergedThroughAliasPath"
check "the shared merger escapes home paths inside JSON strings" \
  node --input-type=module - "$repoRoot" "$sandbox" <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
const [repoRoot, sandbox] = process.argv.slice(2);
const { mergeJsonFiles } = await import(`${repoRoot}/script/lib/merge-json.mjs`);
const destinationPath = `${sandbox}/escaped-home.json`;
for (const homePath of ['/fixture/carbon "unit"', '/fixture/line\nbreak', '/fixture/tab\tstop']) {
  mergeJsonFiles({
    basePath: `${repoRoot}/glimmervoid/config.example.json`,
    destinationPath,
    home: homePath,
  });
  const settings = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
  assert.equal(settings.repoRoots[0], `${homePath}/Projects`);
  assert.equal(settings.projects[0].path, `${homePath}/Projects/glimmervoid`);
}
JS
check "glimmervoid creates no temporary empty overlay" \
  bash -c '! grep -q "glimmervoid-empty-overlay" "$1/glimmervoid/install.sh"' _ "$repoRoot"
check "the repository map names the shared JSON merger" \
  grep -qF '`script/lib/merge-json.mjs`' "$repoRoot/AGENTS.md"
check "the repository map names cross-cutting suites" \
  grep -qF 'cross-cutting suites listed in `test/run-all.sh`' "$repoRoot/AGENTS.md"

check "the personal ai settings golden fixture exists" \
  test -f "$repoRoot/test/fixtures/ai-settings.personal.json"

check "no profile or ai file mandates an /org-* plugin command" \
  bash -c '! grep -rq "/org-" "$1"/profiles/*/CLAUDE.md "$1"/ai' _ "$repoRoot"
check "no profile overlay enables the retired example-org plugin" \
  bash -c '! grep -qil example-org "$1"/profiles/*/settings.overlay.json' _ "$repoRoot"
check "the work overlay disables the PostHog plugin because its unused skills cost every turn and the MCP server is declared directly" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlay.enabledPlugins&&overlay.enabledPlugins["posthog@claude-plugins-official"]===false?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "the work overlay gates exec writes on every declared MCP server because the plugin that carried the gate is off" \
  node -e 'const fs=require("fs");const overlay=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const serverNames=Object.keys(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));const gateEntries=(overlay.hooks?.PreToolUse||[]).filter((entry)=>entry.hooks.some((hook)=>hook.command.includes("gate-posthog-exec-write.mjs")));process.exit(serverNames.length>0&&serverNames.every((serverName)=>gateEntries.some((entry)=>new RegExp(entry.matcher).test(`mcp__${serverName}__exec`)))?0:1)' "$repoRoot/profiles/work/settings.overlay.json" "$repoRoot/profiles/work/mcp-servers.json"
check "the work overlay disables the Slack plugin because the claude.ai Slack connector replaces it" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlay.enabledPlugins&&overlay.enabledPlugins["slack@claude-plugins-official"]===false?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "the work overlay disables the Cloudflare plugin because its skills went unused, keeping its marketplace known" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlay.enabledPlugins?.["cloudflare@cloudflare"]===false&&overlay.extraKnownMarketplaces?.cloudflare?.source?.repo==="cloudflare/skills"?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "the work overlay confines Cloudflare to the backchannel repo because the plugin grant spans the whole account" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit((overlay.hooks?.PreToolUse||[]).some((entry)=>["mcp__plugin_cloudflare_cloudflare__execute","Bash","Skill"].every((toolName)=>new RegExp(entry.matcher).test(toolName))&&entry.hooks.some((hook)=>hook.command.includes("confine-cloudflare.mjs")))?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "the work overlay confines backchannels to work repos because it is an internal PostHog tool" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const wires=(entries,names)=>(entries||[]).some((entry)=>names.every((name)=>entry.matcher===undefined||new RegExp(entry.matcher).test(name))&&entry.hooks.some((hook)=>hook.command.includes("confine-backchannels.mjs")));process.exit(wires(overlay.hooks?.PreToolUse,["mcp__backchannels__register_agent","Skill","ListMcpResourcesTool","ReadMcpResourceTool"])&&wires(overlay.hooks?.SessionStart,["startup","resume","clear","compact"])?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "the three work hooks and their tests live only under the work profile" \
  bash -c 'for hookName in confine-backchannels confine-cloudflare gate-posthog-exec-write; do [[ -f "$1/profiles/work/hooks/$hookName.mjs" && -f "$1/profiles/work/hooks/test/$hookName.test.mjs" && ! -e "$1/ai/hooks/$hookName.mjs" && ! -e "$1/ai/hooks/test/$hookName.test.mjs" ]] || exit 1; done' _ "$repoRoot"
check "work Claude hook commands use the profile hook link" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const commands=Object.values(overlay.hooks).flatMap(entries=>entries.flatMap(entry=>entry.hooks.map(hook=>hook.command)));process.exit(commands.every(command=>command.includes("/.claude/profile-hooks/"))?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "work Codex denies backchannels tools and gates startup through confinement" \
  node - "$repoRoot/profiles/work/codex-hooks.json" <<'NODE'
const fs = require('node:fs');
const hooks = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).hooks;
const isConfined = hooks.PreToolUse.some(entry => ['mcp__backchannels__register_agent', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].every(toolName => new RegExp(entry.matcher).test(toolName)) && entry.hooks.some(handler => handler.command.includes('/.claude/profile-hooks/confine-backchannels.mjs')));
const startupHooks = hooks.SessionStart.flatMap(entry => entry.hooks);
const hasGatedStartup = ['startup', 'resume', 'clear', 'compact'].every(source => hooks.SessionStart.some(entry => new RegExp(entry.matcher).test(source))) && startupHooks.length === 1 && startupHooks[0].command.includes('/.claude/profile-hooks/confine-backchannels.mjs') && startupHooks[0].command.includes('--codex-startup --trust-epoch={{TRUST_EPOCH}}');
process.exit(isConfined && hasGatedStartup ? 0 : 1);
NODE
check "only work declares a backchannels MCP server or Codex hooks" \
  node - "$repoRoot/profiles" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const profilesDirectory = process.argv[2];
for (const profileName of fs.readdirSync(profilesDirectory)) {
  const declarationPath = path.join(profilesDirectory, profileName, 'mcp-servers.json');
  const backchannels = fs.existsSync(declarationPath) ? JSON.parse(fs.readFileSync(declarationPath, 'utf8')).backchannels : undefined;
  if (profileName === 'work') {
    if (backchannels?.type !== 'http' || backchannels.url !== 'https://api.backchannels.dev/mcp') process.exit(1);
    continue;
  }
  if (backchannels || fs.existsSync(path.join(profilesDirectory, profileName, 'codex-hooks.json'))) process.exit(1);
}
NODE
check "every profile with a confined server wires its confining hook for Claude and Codex" \
  node --input-type=module - "$repoRoot" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repoRoot = process.argv[2];
const { confiningHookScriptName, profilePolicy, profileSource, wiresConfiningHook } = await import(pathToFileURL(`${repoRoot}/ai/profile-config.mjs`));
const readHooks = (sourcePath) => (sourcePath ? JSON.parse(fs.readFileSync(sourcePath, 'utf8')).hooks ?? {} : {});
const unwiredServers = [];
for (const profileName of fs.readdirSync(`${repoRoot}/profiles`)) {
  if (!fs.statSync(`${repoRoot}/profiles/${profileName}`).isDirectory()) continue;
  const declarationPath = profileSource(profileName, 'mcp-servers.json');
  const declaredServers = declarationPath ? JSON.parse(fs.readFileSync(declarationPath, 'utf8')) : {};
  const confinedServerNames = Object.entries(profilePolicy(profileName).mcpServers)
    .filter(([serverName, serverPolicy]) => serverPolicy.confined && Object.hasOwn(declaredServers, serverName))
    .map(([serverName]) => serverName);
  const hooksSource = profileSource(profileName, 'hooks');
  const clientHooks = {
    claude: readHooks(profileSource(profileName, 'settings.overlay.json')),
    codex: readHooks(profileSource(profileName, 'codex-hooks.json')),
  };
  for (const serverName of confinedServerNames) {
    const scriptName = confiningHookScriptName(serverName);
    const hasScript = Boolean(hooksSource) && fs.existsSync(path.join(hooksSource, scriptName));
    for (const [clientName, hooksByEvent] of Object.entries(clientHooks)) {
      if (hasScript && wiresConfiningHook(hooksByEvent, `{{HOME}}/.claude/profile-hooks/${scriptName}`, serverName)) continue;
      unwiredServers.push(`${profileName}/${clientName}/${serverName}`);
    }
  }
}
if (unwiredServers.length > 0) {
  console.error(unwiredServers.join('\n'));
  process.exit(1);
}
NODE
check "no profile overlay owns caveman" \
  bash -c '! grep -qil caveman "$1"/profiles/*/settings.overlay.json' _ "$repoRoot"
check "the assistant scopes Telegram itself because a global enable lets any session kill its poller" \
  bash -c '! grep -qil telegram@claude-plugins-official "$1"/profiles/*/settings.overlay.json' _ "$repoRoot"

check "no chmod passes the end-of-options separator BSD chmod rejects" \
  bash -c '! grep -rqE "chmod( +(-[^ |&;#]*|[0-7]{3,4}|[ugoa]*[-+=][rwxXstugo]+))* +--( |$)" --exclude-dir=.git --exclude-dir=.claude "$1"' _ "$repoRoot"
check "the global npm listing escapes the slash BWK awk ends the regex at" \
  grep -qF 'node_modules[\\\/]' "$repoRoot/script/lib/packages.sh"

check "shared AI runtime and installers contain no profile-specific tool names or profile branches" \
  node - "$repoRoot" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const scan = (relativePath) => {
  const absolutePath = path.join(root, relativePath);
  if (fs.statSync(absolutePath).isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      if (['test', 'node_modules', '.git'].includes(entry) || entry === 'test.sh') continue;
      scan(path.join(relativePath, entry));
    }
    return;
  }
  const text = fs.readFileSync(absolutePath, 'utf8');
  const boundaryText = relativePath === 'ai/skills/house-style/SKILL.md'
    ? text.replace("Not for PostHog product UI, which follows PostHog's own design system.", '') : text;
  if (/posthog|backchannels|profiles\/(work|personal|server)\b|profileName[^\n]*(?:==|!=)\s*["']?(?:work|personal|server)\b/i.test(boundaryText)) {
    throw new Error(`profile-specific shared content: ${relativePath}`);
  }
};
for (const relativePath of ['ai', 'coder/install.sh', 'devbox/lib.sh', 'devbox/install.sh', 'vscodium/install.sh', 'script/lib']) scan(relativePath);
NODE
check "house style is shared without a profile copy" \
  bash -c '[[ -f "$1/ai/skills/house-style/SKILL.md" && ! -e "$1/profiles/personal/skills/house-style" && ! -e "$1/profiles/work/skills/house-style" ]]' _ "$repoRoot"
check "only the work profile carries the editor MCP and remote provision inputs" \
  bash -c '[[ -f "$1/profiles/work/vscodium-mcp.json" && -f "$1/profiles/work/devbox/provision.sh" && ! -e "$1/vscodium/mcp.json" && ! -e "$1/devbox/provision.sh" ]]' _ "$repoRoot"

reportTopicResults "repo wiring"
