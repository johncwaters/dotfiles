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

for profileJsonPath in "$repoRoot"/profiles/*/profile.json; do
  profileDirectoryPath="$(dirname -- "$profileJsonPath")"
  profileTopics="$(readProfileTopics "$profileJsonPath")"
  if grep -qx packages <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has package groups for its packages topic" \
      test -f "$profileDirectoryPath/packages.txt"
  fi
  if grep -qx glissa <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has glissa settings for its glissa topic" \
      test -f "$profileDirectoryPath/glissa.json"
  fi
  if grep -qx vscodium <<< "$profileTopics"; then
    check "$(basename -- "$profileDirectoryPath") has vscodium settings for its vscodium topic" \
      test -f "$profileDirectoryPath/vscodium.json"
  fi
done

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
check "the repository map names the bubblewrap sandbox" \
  grep -q 'shared bubblewrap sandbox' "$repoRoot/AGENTS.md"
check "the repository map no longer names a Docker matrix" \
  bash -c '! grep -q "Docker matrix" "$1/AGENTS.md"' _ "$repoRoot"
check "the README profile file list names glissa settings" \
  grep -qF '`glissa.json`' "$repoRoot/README.md"
check "the README profile file list names glissa overlays" \
  grep -qF '`glissa.overlay.json`' "$repoRoot/README.md"
check "the README profile file list names vscodium settings" \
  grep -qF '`vscodium.json`' "$repoRoot/README.md"
for examplePath in repos/repos.example.txt glissa/config.example.json \
  git/gitconfig.local.example shell/localrc.example; do
  check "the README names $examplePath" grep -qF "\`$examplePath\`" "$repoRoot/README.md"
done
check "the README names the rendered Claude settings inputs" \
  bash -c 'grep -qF '\''`~/.claude/settings.json` is rendered from `ai/settings.base.json`'\'' "$1/README.md" && grep -qF '\''`settings.overlay.json`'\'' "$1/README.md"' \
  _ "$repoRoot"
check "the README says bootstrap writes the machine profile" \
  grep -qF '`.machine-profile` is written by' "$repoRoot/README.md"
check "glissa reads tracked inputs through the checkout root" \
  bash -c '! grep -q '\''\$dotfilesAlias'\'' "$1/glissa/install.sh"' _ "$repoRoot"
check "glissa uses the shared JSON merger" \
  grep -qF 'script/lib/merge-json.mjs' "$repoRoot/glissa/install.sh"
check "the glissa seed has one shared home token" \
  bash -c '! grep -q "__HOME__" "$1/glissa/config.example.json" && grep -q "{{HOME}}" "$1/glissa/config.example.json"' \
  _ "$repoRoot"
check "glissa has no seed kind selector" \
  bash -c '! grep -q "glissaSeedInputsFor" "$1/glissa/install.sh"' _ "$repoRoot"
check "profile glissa settings have no seed key" \
  bash -c '! grep -q '"'"'"seed"'"'"' "$1"/profiles/*/glissa.json' _ "$repoRoot"
check "the server profile owns its glissa overlay" \
  test -f "$repoRoot/profiles/server/glissa.overlay.json"
check "the glissa topic owns no server overlay" \
  test ! -e "$repoRoot/glissa/config.server.overlay.json"
check "the generic glissa seed renderer has no server-only name" \
  bash -c 'grep -q "^renderGlissaSeed()" "$1/glissa/install.sh" && ! grep -q "renderGlissaServerSeed" "$1/glissa/install.sh"' \
  _ "$repoRoot"

mergedWithoutOverlayPath="$sandbox/merged-without-overlay.json"
HOME="$sandbox" node "$repoRoot/script/lib/merge-json.mjs" \
  "$repoRoot/glissa/config.example.json" "" "$mergedWithoutOverlayPath" /fixture/home
check "the shared merger accepts a missing overlay" \
  grep -qF '"/fixture/home/Projects"' "$mergedWithoutOverlayPath"
check "glissa creates no temporary empty overlay" \
  bash -c '! grep -q "glissa-empty-overlay" "$1/glissa/install.sh"' _ "$repoRoot"
check "the repository map names the shared JSON merger" \
  grep -qF '`script/lib/merge-json.mjs`' "$repoRoot/AGENTS.md"
check "the repository map names cross-cutting suites" \
  grep -qF 'cross-cutting suites listed in `test/run-all.sh`' "$repoRoot/AGENTS.md"

renderedAiSettingsPath="$sandbox/rendered-ai-settings.json"
HOME="$sandbox" node "$repoRoot/ai/render-settings.mjs" \
  "$repoRoot/ai/settings.base.json" \
  "$repoRoot/profiles/personal/settings.overlay.json" \
  "$renderedAiSettingsPath" \
  /fixture/home
check "the shared merger keeps the prior ai settings bytes" \
  cmp -s "$repoRoot/test/fixtures/ai-settings.personal.json" "$renderedAiSettingsPath"

reportTopicResults "repo wiring"
