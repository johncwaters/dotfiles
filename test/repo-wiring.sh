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
}

for profileJsonPath in "$repoRoot"/profiles/*/profile.json; do
  profileDirectoryPath="$(dirname -- "$profileJsonPath")"
  profileTopics="$(readProfileTopics "$profileJsonPath")"
  if grep -qx packages <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has package groups for its packages topic" \
      test -f "$profileDirectoryPath/packages.txt"
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

check "work-server runs only packages, ai and git on Linux, leaving glimmervoid and repos to the devbox provisioner" \
  node - "$repoRoot/profiles/work-server" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const profileDirectory = process.argv[2];
const readProfileJson = name => JSON.parse(fs.readFileSync(`${profileDirectory}/${name}`, "utf8"));
assert.deepEqual(readProfileJson("profile.json"), { platform: "linux", topics: ["packages", "ai", "git"] });
for (const excludedFile of ["glimmervoid.overlay.json", "mcp-servers.json"]) {
  assert.equal(fs.existsSync(`${profileDirectory}/${excludedFile}`), false);
}
JS

for sharedWorkFile in AGENTS.md settings.overlay.json hooks skills; do
  check "work-server inherits work $sharedWorkFile without copying agent additions" \
    test "$(node "$repoRoot/ai/profile-config.mjs" work-server "$sharedWorkFile")" = \
    "$repoRoot/profiles/work/$sharedWorkFile"
done

check "work-server settings equal work settings" \
  cmp -s "$sandbox/rendered-ai-settings.work.json" "$sandbox/rendered-ai-settings.work-server.json"

# These topics confine their commands to the sandbox home without command stubs.
topicSuitesNeedingStubs() {
  topicDirectoriesWithAnInstaller | grep -Evx 'ai|git|shell'
}

for stubbedTopicSuite in $(topicSuitesNeedingStubs); do
  check "$stubbedTopicSuite uses the shared stubbed sandbox" \
    grep -q 'startStubbedSandbox' "$repoRoot/$stubbedTopicSuite/test.sh"
done

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
# shellcheck source=../repos/paths.sh
source "$repoRoot/repos/paths.sh"

repoListEntryPaths() {
  local listLine
  while IFS= read -r listLine || [[ -n "$listLine" ]]; do
    listLine="$(normalizeListLine "$listLine")"
    listLineIsAnEntry "$listLine" || continue
    normalizeListPath "${listLine%%=*}"
  done < "$1"
}

everyListedRepoIsAGlimmervoidProject() {
  repoListEntryPaths "$1" | node -e '
const fs = require("node:fs");
const [settingsPath] = process.argv.slice(1);
const projects = JSON.parse(fs.readFileSync(settingsPath, "utf8")).projects;
const projectPaths = new Set(projects.map(project => project.path));
const projectPathCounts = projects.reduce((counts, project) => counts.set(project.path, (counts.get(project.path) ?? 0) + 1), new Map());
const missingRepoPaths = fs.readFileSync(0, "utf8").split("\n").filter(relativePath => relativePath !== "")
  .filter(relativePath => relativePath !== "Projects/posthog")
  .filter(relativePath => !projectPaths.has(`{{HOME}}/${relativePath}`));
const duplicatedPaths = [...projectPathCounts].filter(([, count]) => count > 1).map(([projectPath]) => projectPath);
if (missingRepoPaths.length > 0 || duplicatedPaths.length > 0) { console.error({ missingRepoPaths, duplicatedPaths }); process.exit(1); }
' "$2"
}

check "every work-server repo except the template posthog checkout is a glimmervoid project in the shared settings" \
  everyListedRepoIsAGlimmervoidProject "$repoRoot/profiles/work-server/repos.txt" "$repoRoot/glimmervoid/settings.json"
check "every profile shares one glimmervoid settings file through the sync engine" \
  bash -c 'test -f "$1/glimmervoid/settings.json" && ! compgen -G "$1/profiles/*/glimmervoid.settings.json" > /dev/null && grep -q "glimmervoid/settings.json" "$1/glimmervoid/install.sh" "$1/profiles/work/devbox/provision.sh" "$1/devbox/lib.sh"' _ "$repoRoot"
for examplePath in repos/repos.example.txt glimmervoid/config.example.json \
  git/gitconfig.local.example shell/localrc.example; do
  check "the README names $examplePath" grep -qF "\`$examplePath\`" "$repoRoot/README.md"
done
check "glimmervoid reads tracked inputs through the checkout root" \
  bash -c '! grep -q '\''\$dotfilesAlias'\'' "$1/glimmervoid/install.sh"' _ "$repoRoot"
check "glimmervoid uses the shared JSON merger" \
  grep -qF 'script/lib/merge-json.mjs' "$repoRoot/glimmervoid/install.sh"
check "the glimmervoid seed has one shared home token" \
  bash -c '! grep -q "__HOME__" "$1/glimmervoid/config.example.json" "$1/glimmervoid/settings.json" && grep -q "{{HOME}}" "$1/glimmervoid/settings.json"' \
  _ "$repoRoot"
check "glimmervoid has no seed kind selector" \
  bash -c '! grep -q "glimmervoidSeedInputsFor" "$1/glimmervoid/install.sh"' _ "$repoRoot"
check "the server profile owns its glimmervoid overlay" \
  test -f "$repoRoot/profiles/server/glimmervoid.overlay.json"
check "the glimmervoid topic owns no server overlay" \
  test ! -e "$repoRoot/glimmervoid/config.server.overlay.json"
check "the generic glimmervoid seed renderer has no server-only name" \
  bash -c 'grep -q "^renderGlimmervoidSeed()" "$1/glimmervoid/install.sh" && ! grep -q "renderGlimmervoidServerSeed" "$1/glimmervoid/install.sh"' \
  _ "$repoRoot"

mergedWithoutOverlayPath="$sandbox/merged-without-overlay.json"
HOME="$sandbox" node "$repoRoot/script/lib/merge-json.mjs" \
  "$repoRoot/glimmervoid/settings.json" "" "$mergedWithoutOverlayPath" /fixture/home
check "the shared merger accepts a missing overlay" \
  grep -qF '"/fixture/home/Projects"' "$mergedWithoutOverlayPath"

# Every topic reaches the merger through the ~/.dotfiles alias, so the main-module guard must survive a symlink.
mergerAliasPath="$sandbox/merge-json-alias.mjs"
ln -sf "$repoRoot/script/lib/merge-json.mjs" "$mergerAliasPath"
mergedThroughAliasPath="$sandbox/merged-through-alias.json"
HOME="$sandbox" node "$mergerAliasPath" \
  "$repoRoot/glimmervoid/settings.json" "" "$mergedThroughAliasPath" /fixture/home
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
    basePath: `${repoRoot}/glimmervoid/settings.json`,
    destinationPath,
    home: homePath,
  });
  const settings = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
  assert.equal(settings.repoRoots[0], `${homePath}/Projects`);
  assert.equal(settings.projects[0].path, `${homePath}/Projects`);
}
JS
check "glimmervoid creates no temporary empty overlay" \
  bash -c '! grep -q "glimmervoid-empty-overlay" "$1/glimmervoid/install.sh"' _ "$repoRoot"

check "no profile or ai file mandates an /org-* plugin command" \
  bash -c '! grep -rq "/org-" "$1"/profiles/*/AGENTS.md "$1"/ai' _ "$repoRoot"
check "no profile overlay enables the retired example-org plugin" \
  bash -c '! grep -qil example-org "$1"/profiles/*/settings.overlay.json' _ "$repoRoot"
check "the work overlay gates exec writes on every declared MCP server because the plugin that carried the gate is off" \
  node -e 'const fs=require("fs");const overlay=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const serverNames=Object.keys(JSON.parse(fs.readFileSync(process.argv[2],"utf8")));const gateEntries=(overlay.hooks?.PreToolUse||[]).filter((entry)=>entry.hooks.some((hook)=>hook.command.includes("gate-posthog-exec-write.mjs")));process.exit(serverNames.length>0&&serverNames.every((serverName)=>gateEntries.some((entry)=>new RegExp(entry.matcher).test(`mcp__${serverName}__exec`)))?0:1)' "$repoRoot/profiles/work/settings.overlay.json" "$repoRoot/profiles/work/mcp-servers.json"
check "the work overlay disables the Cloudflare plugin because its skills went unused, keeping its marketplace known" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(overlay.enabledPlugins?.["cloudflare@cloudflare"]===false&&overlay.extraKnownMarketplaces?.cloudflare?.source?.repo==="cloudflare/skills"?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
check "block-comments is wired only for Glimmervoid sessions and the shared growth guards for every Claude and Codex" \
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
    const sharedWiringPaths = ["ai/settings.base.json", "ai/codex-hooks.base.json"];
    const profileWiringPaths = fs.readdirSync(path.join(root, "profiles"))
      .flatMap((profileName) => [`profiles/${profileName}/settings.overlay.json`, `profiles/${profileName}/codex-hooks.json`])
      .filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
    const isGlimmervoidOnly = read("glimmervoid/settings.json").includes("hooks/block-comments.mjs")
      && [...sharedWiringPaths, ...profileWiringPaths].every((relativePath) => !read(relativePath).includes("block-comments"));
    const sharedGuards = ["block-else.mjs", "block-use-effect.mjs", "block-fixed-sleep.mjs", "block-button-labels.mjs"];
    const areGuardsShared = sharedWiringPaths.every((relativePath) => sharedGuards.every((guardName) => read(relativePath).includes(`hooks/${guardName}`)));
    process.exit(isGlimmervoidOnly && areGuardsShared ? 0 : 1);
  ' "$repoRoot"
check "the work hooks and their tests live only under the work profile" \
  bash -c 'for hookName in gate-posthog-exec-write; do [[ -f "$1/profiles/work/hooks/$hookName.mjs" && -f "$1/profiles/work/hooks/test/$hookName.test.mjs" && ! -e "$1/ai/hooks/$hookName.mjs" && ! -e "$1/ai/hooks/test/$hookName.test.mjs" ]] || exit 1; done' _ "$repoRoot"
check "work Claude hook commands use the profile hook link" \
  node -e 'const overlay=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const commands=Object.values(overlay.hooks).flatMap(entries=>entries.flatMap(entry=>entry.hooks.map(hook=>hook.command)));process.exit(commands.every(command=>command.includes("/.claude/profile-hooks/"))?0:1)' "$repoRoot/profiles/work/settings.overlay.json"
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
const profilesDirectory = path.join(root, 'profiles');
const profileNames = fs.readdirSync(profilesDirectory).filter((name) => fs.statSync(path.join(profilesDirectory, name)).isDirectory());
const sharedSkillNames = new Set(fs.readdirSync(path.join(root, 'ai/skills')));
const profileOnlySkillNames = profileNames.flatMap((profileName) => {
  const skillsDirectory = path.join(profilesDirectory, profileName, 'skills');
  return fs.existsSync(skillsDirectory) ? fs.readdirSync(skillsDirectory) : [];
}).filter((skillName) => !sharedSkillNames.has(skillName));
const mcpServerNamesByProfile = profileNames
  .map((profileName) => path.join(profilesDirectory, profileName, 'mcp-servers.json'))
  .filter((serversPath) => fs.existsSync(serversPath))
  .map((serversPath) => Object.keys(JSON.parse(fs.readFileSync(serversPath, 'utf8'))));
const profileOnlyMcpToolPrefixes = [...new Set(mcpServerNamesByProfile.flat())]
  .filter((serverName) => !mcpServerNamesByProfile.every((serverNames) => serverNames.includes(serverName)))
  .map((serverName) => `mcp__${serverName}`);
const escapeForRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const profileOnlyNames = [...new Set([...profileOnlySkillNames, ...profileOnlyMcpToolPrefixes])].map(escapeForRegex);
const profileSpecificContent = new RegExp(
  `profiles/(?:${profileNames.map(escapeForRegex).join('|')})\\b|profileName[^\\n]*(?:==|!=)\\s*["']?(?:${profileNames.map(escapeForRegex).join('|')})\\b`
    + (profileOnlyNames.length ? `|(?<![\\w-])(?:${profileOnlyNames.join('|')})(?![A-Za-z0-9-])` : ''),
  'i',
);
const scan = (relativePath) => {
  const absolutePath = path.join(root, relativePath);
  if (fs.statSync(absolutePath).isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      if (['test', 'node_modules', '.git'].includes(entry) || entry === 'test.sh') continue;
      scan(path.join(relativePath, entry));
    }
    return;
  }
  if (profileSpecificContent.test(fs.readFileSync(absolutePath, 'utf8'))) {
    throw new Error(`profile-specific shared content: ${relativePath}`);
  }
};
for (const relativePath of ['ai', 'coder/install.sh', 'devbox/lib.sh', 'devbox/install.sh', 'vscodium/install.sh', 'script/lib']) scan(relativePath);
NODE
check "house style is shared without a profile copy" \
  bash -c '[[ -f "$1/ai/skills/applying-house-style/SKILL.md" && ! -e "$1/profiles/personal/skills/applying-house-style" && ! -e "$1/profiles/work/skills/applying-house-style" ]]' _ "$repoRoot"
check "only the work profile carries the editor MCP and remote provision inputs" \
  bash -c '[[ -f "$1/profiles/work/vscodium-mcp.json" && -f "$1/profiles/work/devbox/provision.sh" && ! -e "$1/vscodium/mcp.json" && ! -e "$1/devbox/provision.sh" ]]' _ "$repoRoot"

termsLabelPattern=$'^[ \t>#*+_0-9.)-]*Terms[*_]*:[*_]*'

docsCarryingATermsLabel() {
  grep -rlE --include='*.md' --exclude-dir=node_modules --exclude-dir=.git \
    -- "$termsLabelPattern" "$repoRoot" | grep -vxF -- "$repoRoot/GLOSSARY.md"
}

wrappedLineDecorationPattern=$'^[ \t>]*'

glossaryTermsCitedByDoc() {
  awk -v termsLabelPattern="$termsLabelPattern" \
    -v wrappedLineDecorationPattern="$wrappedLineDecorationPattern" '
    function endTermsSentence() { print ""; isInsideTermsSentence = 0 }
    function joinTermsText(termsText) {
      printf "%s ", termsText
      if (termsText ~ /\.([ \t]|$)/) endTermsSentence()
    }
    $0 ~ termsLabelPattern {
      sub(termsLabelPattern, "")
      isInsideTermsSentence = 1
      joinTermsText($0)
      next
    }
    !isInsideTermsSentence { next }
    { sub(wrappedLineDecorationPattern, "") }
    /^$/ { endTermsSentence(); next }
    { joinTermsText($0) }
    END { if (isInsideTermsSentence) print "" }
  ' "$1" \
    | sed -E 's/\.([[:space:]].*)?$//' \
    | tr ',' '\n' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | grep . | sort -u
}

everyCitedGlossaryTermIsDefined() {
  local citingDocPath citedTerm citedTermCount
  local citingDocCount=0
  while IFS= read -r citingDocPath; do
    citingDocCount=$((citingDocCount + 1))
    citedTermCount=0
    while IFS= read -r citedTerm; do
      citedTermCount=$((citedTermCount + 1))
      grep -qF -- "- **$citedTerm**:" "$repoRoot/GLOSSARY.md" || return 1
    done < <(glossaryTermsCitedByDoc "$citingDocPath")
    ((citedTermCount > 0)) || return 1
  done < <(docsCarryingATermsLabel)
  ((citingDocCount > 0))
}
check "every glossary term a doc cites is defined in GLOSSARY.md" everyCitedGlossaryTermIsDefined

sourceRuleScanner="$(cat <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [root, ruleName] = process.argv.slice(1);
const repoPaths = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((repoPath) => repoPath && fs.existsSync(path.join(root, repoPath)) && fs.statSync(path.join(root, repoPath)).isFile());
const isTestPath = (repoPath) => /(^|\/)test(\/|\.sh$)/.test(repoPath);
const readRepoFile = (repoPath) => fs.readFileSync(path.join(root, repoPath), 'utf8');
const isShellScript = (repoPath) => /\.(?:sh|bash)$/.test(repoPath) || repoPath.startsWith('bin/') || /^#!.*\b(?:ba)?sh\b/.test(readRepoFile(repoPath).split('\n', 1)[0]);
const shellScripts = repoPaths.filter((repoPath) => !isTestPath(repoPath) && isShellScript(repoPath));
const topicInstallers = repoPaths.filter((repoPath) => /^[^/]+\/install\.sh$/.test(repoPath));
const COMMAND_SEPARATORS = new Set([';', '&&', '||', '|', '&']);
const COMMAND_PREFIXES = new Set(['if', '!', 'then', 'do', 'elif', 'else', 'while', 'until', '{', '(']);
function shellWordsOf(line) {
  const words = [];
  let currentWord = '';
  let quote = null;
  let substitutionDepth = 0;
  const finishWord = () => {
    if (currentWord) words.push(currentWord);
    currentWord = '';
  };
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '#' && quote === null && substitutionDepth === 0 && currentWord === '') break;
    if (character === '$' && line[index + 1] === '(') substitutionDepth += 1;
    if (character === ')' && substitutionDepth > 0) substitutionDepth -= 1;
    if (substitutionDepth === 0 && (character === '"' || character === "'")) quote = quote === character ? null : quote ?? character;
    const isOutsideQuotes = quote === null && substitutionDepth === 0;
    if (isOutsideQuotes && /\s/.test(character)) {
      finishWord();
      continue;
    }
    if (isOutsideQuotes && /[;&|]/.test(character)) {
      finishWord();
      const operator = line.slice(index, index + 2) === character.repeat(2) ? character.repeat(2) : character;
      words.push(operator);
      index += operator.length - 1;
      continue;
    }
    currentWord += character;
  }
  finishWord();
  return words;
}
function commandsOf(line) {
  const commands = [[]];
  for (const word of shellWordsOf(line)) {
    if (COMMAND_SEPARATORS.has(word)) {
      commands.push([]);
      continue;
    }
    const currentCommand = commands[commands.length - 1];
    if (currentCommand.length === 0 && COMMAND_PREFIXES.has(word)) continue;
    currentCommand.push(word);
  }
  return commands.filter((command) => command.length > 0);
}
function violationsBy(repoPathsToScan, isViolatingCommand) {
  return repoPathsToScan.flatMap((repoPath) => readRepoFile(repoPath).split('\n')
    .flatMap((line, index) => commandsOf(line).some(isViolatingCommand) ? [`${repoPath}:${index + 1}: ${line.trim()}`] : []));
}
function localImportClosure(entryPaths) {
  const visitedModulePaths = new Set();
  const modulePathsToVisit = [...entryPaths];
  while (modulePathsToVisit.length > 0) {
    const modulePath = modulePathsToVisit.pop();
    if (visitedModulePaths.has(modulePath) || !fs.existsSync(path.join(root, modulePath))) continue;
    visitedModulePaths.add(modulePath);
    for (const [, specifier] of readRepoFile(modulePath).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\/[^'"]+)['"]/g)) {
      modulePathsToVisit.push(path.posix.join(path.posix.dirname(modulePath), specifier));
    }
  }
  return [...visitedModulePaths];
}
const PLATFORM_PROBE = /\buname\b|\$\{?OSTYPE\b|\bsw_vers\b/;
const isSymlinkFlag = (word) => word === '--symbolic' || /^-[A-Za-z]*s[A-Za-z]*$/.test(word);
function decidingPostToolUseHooks() {
  const settingsPaths = ['ai/settings.base.json', 'ai/codex-hooks.base.json', ...fs.readdirSync(path.join(root, 'profiles'))
    .flatMap((profileName) => [`profiles/${profileName}/settings.overlay.json`, `profiles/${profileName}/codex-hooks.json`])]
    .filter((settingsPath) => fs.existsSync(path.join(root, settingsPath)));
  return settingsPaths.flatMap((settingsPath) => {
    const postToolUseEntries = JSON.parse(readRepoFile(settingsPath)).hooks?.PostToolUse ?? [];
    const profileHooksDirectory = path.posix.join(path.posix.dirname(settingsPath), 'hooks');
    return postToolUseEntries.flatMap((entry) => entry.hooks ?? []).flatMap(({ command = '' }) => {
      const installedHook = command.match(/\.claude\/(hooks|profile-hooks)\/([\w.-]+\.mjs)/);
      if (!installedHook) return [];
      const hookPath = path.posix.join(installedHook[1] === 'hooks' ? 'ai/hooks' : profileHooksDirectory, installedHook[2]);
      const decidingModules = localImportClosure([hookPath])
        .filter((modulePath) => !modulePath.endsWith('/hook-io.mjs') && /\b(?:denyPreToolUse|askPreToolUse)\s*\(|permissionDecision\s*:/.test(readRepoFile(modulePath)));
      return decidingModules.map((modulePath) => `${settingsPath}: ${hookPath} decides in PostToolUse through ${modulePath}; move the decision to PreToolUse`);
    });
  });
}
const violationsByRule = {
  platform: () => violationsBy(shellScripts.filter((repoPath) => repoPath !== 'script/lib/platform.sh'),
    (command) => PLATFORM_PROBE.test(command.join(' ').replace(/\buname\s+-m\b/g, ''))),
  'raw-symlink': () => violationsBy(topicInstallers, (command) => command[0] === 'ln' && command.slice(1).some(isSymlinkFlag)),
  'link-target': () => violationsBy(topicInstallers.filter((repoPath) => repoPath !== 'git/install.sh'),
    (command) => command[0] === 'linkEntry' && command.length > 5),
  'post-tool-use-decision': decidingPostToolUseHooks,
};
const violations = violationsByRule[ruleName]();
for (const violation of violations) console.error(violation);
process.exit(violations.length > 0 ? 1 : 0);
NODE
)"
check "platform branches go through script/lib/platform.sh; uname -m reads only the architecture" \
  node -e "$sourceRuleScanner" "$repoRoot" platform
check "topic installers link through linkEntry, never a raw ln -s" \
  node -e "$sourceRuleScanner" "$repoRoot" raw-symlink
check "only git/install.sh overrides linkEntry's ~/.dotfiles alias target" \
  node -e "$sourceRuleScanner" "$repoRoot" link-target
check "no PostToolUse hook makes a permission decision, since the bytes are already written" \
  node -e "$sourceRuleScanner" "$repoRoot" post-tool-use-decision

check "validate-file.mjs and its helpers stay synchronous and import only node built-ins or hook helpers" \
  node - "$repoRoot" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const problems = [];
const visitedModulePaths = new Set();
const modulePathsToVisit = ['ai/hooks/validate-file.mjs'];
while (modulePathsToVisit.length > 0) {
  const modulePath = modulePathsToVisit.pop();
  if (visitedModulePaths.has(modulePath)) continue;
  visitedModulePaths.add(modulePath);
  const moduleSource = fs.readFileSync(path.join(root, modulePath), 'utf8');
  if (/\bawait\b|\.then\s*\(|\bcreateRequire\b/.test(moduleSource)) problems.push(`${modulePath}: awaits or defers; validation runs on every write and must stay synchronous`);
  for (const [, specifier] of moduleSource.matchAll(/(?:^\s*(?:import|export)\b[^'"]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm)) {
    if (specifier.startsWith('node:')) continue;
    if (!specifier.startsWith('./')) {
      problems.push(`${modulePath}: imports ${specifier}; use node built-ins or ./ hook helpers`);
      continue;
    }
    modulePathsToVisit.push(path.posix.join(path.posix.dirname(modulePath), specifier));
  }
}
for (const problem of problems) console.error(problem);
process.exit(problems.length > 0 ? 1 : 0);
NODE

check "every AGENTS.md rule names its enforcer in rule-enforcement.json" \
  node - "$repoRoot" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.argv[2];
const registry = JSON.parse(fs.readFileSync(path.join(root, 'rule-enforcement.json'), 'utf8'));
const listedPaths = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const existingListedPaths = new Set(listedPaths.filter((listedPath) => fs.existsSync(path.join(root, listedPath))));
const slugOf = (text) => (text.replace(/`/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 6).join('-');
const listItemMarker = /^([-*+]|\d+[.)])\s+/;
const tagLine = /^<\/?([a-z0-9_-]+)>$/;
function taggedRuleKeysIn(lines) {
  const ruleKeys = [];
  let openTagName = null;
  let isInsideBlock = false;
  for (const line of lines) {
    const tagMatch = line.match(tagLine);
    if (tagMatch && !line.startsWith('</') && openTagName === null) {
      ruleKeys.push(tagMatch[1]);
      openTagName = tagMatch[1];
      continue;
    }
    if (tagMatch && line === `</${openTagName}>`) {
      openTagName = null;
      isInsideBlock = false;
      continue;
    }
    if (openTagName !== null) continue;
    if (line.trim() === '') {
      isInsideBlock = false;
      continue;
    }
    if (isInsideBlock && !listItemMarker.test(line)) continue;
    ruleKeys.push(slugOf(line.replace(listItemMarker, '')));
    isInsideBlock = true;
  }
  return ruleKeys;
}
function markdownRuleKeysIn(lines) {
  const ruleKeys = [];
  let isUnderMap = false;
  let isInsideBlock = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      isUnderMap = /^##\s+Map\s*$/.test(line);
      isInsideBlock = false;
      continue;
    }
    if (line.trim() === '') {
      isInsideBlock = false;
      continue;
    }
    if (line.startsWith('|')) continue;
    const isMapEntry = isUnderMap && listItemMarker.test(line);
    if (isInsideBlock && (isUnderMap || !listItemMarker.test(line))) continue;
    isInsideBlock = true;
    if (isMapEntry) continue;
    ruleKeys.push(slugOf(line.replace(listItemMarker, '')));
  }
  return ruleKeys;
}
function ruleKeysIn(text) {
  const lines = text.split('\n');
  return lines.some((line) => tagLine.test(line)) ? taggedRuleKeysIn(lines) : markdownRuleKeysIn(lines);
}
const isEnforcerFile = (enforcerPath) => existingListedPaths.has(enforcerPath)
  && path.basename(enforcerPath) !== 'AGENTS.md'
  && fs.statSync(path.join(root, enforcerPath)).isFile();
const problems = [];
const agentsPaths = [...existingListedPaths].filter((listedPath) => path.basename(listedPath) === 'AGENTS.md');
for (const agentsPath of agentsPaths) {
  if (!registry.files[agentsPath]) problems.push(`${agentsPath}: no entry in rule-enforcement.json`);
}
let proseRuleCount = 0;
for (const [agentsPath, entriesByRuleKey] of Object.entries(registry.files)) {
  if (!agentsPaths.includes(agentsPath)) {
    problems.push(`${agentsPath}: listed but missing; drop its entry`);
    continue;
  }
  const ruleKeys = ruleKeysIn(fs.readFileSync(path.join(root, agentsPath), 'utf8'));
  const duplicateRuleKeys = new Set(ruleKeys.filter((ruleKey, index) => ruleKeys.indexOf(ruleKey) !== index));
  for (const ruleKey of duplicateRuleKeys) problems.push(`${agentsPath} ${ruleKey}: two rules share this key; reword one's first six words`);
  for (const ruleKey of ruleKeys) {
    if (!entriesByRuleKey[ruleKey]) problems.push(`${agentsPath} ${ruleKey}: classify it as check, review, or prose`);
  }
  for (const [ruleKey, entry] of Object.entries(entriesByRuleKey)) {
    if (!ruleKeys.includes(ruleKey)) problems.push(`${agentsPath} ${ruleKey}: no such rule; rename or drop the entry`);
    if (entry.kind === 'prose') {
      proseRuleCount += 1;
      if (!entry.reason) problems.push(`${agentsPath} ${ruleKey}: a prose rule needs a reason`);
      continue;
    }
    if (!['check', 'review'].includes(entry.kind) || !(entry.by?.length > 0)) {
      problems.push(`${agentsPath} ${ruleKey}: kind must be check, review, or prose, and check or review needs by`);
      continue;
    }
    for (const enforcerPath of entry.by) {
      if (!isEnforcerFile(enforcerPath)) problems.push(`${agentsPath} ${ruleKey}: enforcer ${enforcerPath} is not a repo file other than an AGENTS.md`);
    }
  }
}
if (proseRuleCount !== registry.proseCeiling) problems.push(`${proseRuleCount} prose rules but proseCeiling is ${registry.proseCeiling}; set it in the same commit`);
for (const problem of problems) console.error(problem);
process.exit(problems.length > 0 ? 1 : 0);
NODE

reportTopicResults "repo wiring"
