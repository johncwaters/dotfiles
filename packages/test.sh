#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "packages"

realHome="$HOME"
realHomePathsNoStubMayName=(
  "$realHome/.bashrc"
  "$realHome/.npm-global"
)
sandboxTemp="$sandbox/tmp"

mkdir -p "$stubState/package-commands" \
  "$stubState/npm-installed" "$stubState/flatpak-installed" "$stubState/cask-installed" \
  "$stubState/python-modules" \
  "$sandboxTemp"

coreUtilities=(
  bash sh env cat sed awk grep tail head cut tr find sort uniq wc mktemp rm mkdir
  rmdir cp mv ln readlink basename dirname chmod cmp id date stat touch true false xargs
  od tee expr sleep printf test
)
linkCoreUtilities "${coreUtilities[@]}"
ln -s "$(type -P node)" "$coreBin/node-runtime"

writeAptStubThatInstallsMappedCommands

writeContainedSudoStub

writeStub curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
requestedUrl=""
outputPath=""
while (($# > 0)); do
  if [[ "$1" == "-o" ]]; then
    outputPath="$2"
    shift 2
    continue
  fi
  if [[ "$1" == http* ]]; then
    requestedUrl="$1"
  fi
  shift
done
emitBody() {
  case "$requestedUrl" in
    *nodesource.com*)
      printf ':\n'
      ;;
    *claude.ai/install.sh)
      printf 'mkdir -p "$HOME/.local/bin"\n'
      printf 'cp "$DOTFILES_TEST_STATE/available/claude" "$HOME/.local/bin/claude"\n'
      ;;
    *)
      return 1
      ;;
  esac
}
if [[ -n "$outputPath" ]]; then
  emitBody > "$outputPath"
  exit $?
fi
emitBody
STUB

writeStub brew <<'STUB'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == outdated ]]; then
  cat "$DOTFILES_TEST_STATE/brew-outdated.json" 2>/dev/null || printf '{"formulae":[],"casks":[]}\n'
  exit 0
fi
if [[ "${1:-}" == info ]]; then
  printf '{"formulae":[{"name":"python@3.14"}]}\n'
  exit 0
fi
if [[ "${1:-}" == update ]]; then
  [[ ! -f "$DOTFILES_TEST_STATE/brew-update-fails" ]]
  exit $?
fi
if [[ "${1:-}" == upgrade ]]; then
  printf 'brew-upgrade-environment HOMEBREW_NO_AUTO_UPDATE=%s HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=%s\n' \
    "${HOMEBREW_NO_AUTO_UPDATE:-}" "${HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK:-}" >> "$DOTFILES_TEST_LOG"
  [[ ! -f "$DOTFILES_TEST_STATE/brew-upgrade-fails" ]]
  exit $?
fi
if [[ "${1:-} ${2:-}" == "list --cask" ]]; then
  [[ -f "$DOTFILES_TEST_STATE/cask-installed/${3:-}" ]]
  exit $?
fi
if [[ "${1:-} ${2:-}" == "install --cask" ]]; then
  touch "$DOTFILES_TEST_STATE/cask-installed/${3:-}"
fi
for packageName in "$@"; do
  case "$packageName" in
    git | gh)
      cp "$DOTFILES_TEST_STATE/available/$packageName" "$DOTFILES_TEST_STUB_BIN/$packageName"
      ;;
    ripgrep)
      cp "$DOTFILES_TEST_STATE/available/rg" "$DOTFILES_TEST_STUB_BIN/rg"
      ;;
    bash-completion@2)
      mkdir -p "$DOTFILES_TEST_HOMEBREW_PREFIX/etc/profile.d"
      cp "$DOTFILES_TEST_STATE/available/bash_completion" \
        "$DOTFILES_TEST_HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh"
      ;;
    python3)
      mkdir -p "$DOTFILES_TEST_HOMEBREW_PREFIX/bin"
      cp "$DOTFILES_TEST_STATE/available/python3" "$DOTFILES_TEST_HOMEBREW_PREFIX/bin/python3"
      ;;
    node)
      cp "$DOTFILES_TEST_STATE/available/node" "$DOTFILES_TEST_STUB_BIN/node"
      cp "$DOTFILES_TEST_STATE/available/npm" "$DOTFILES_TEST_STUB_BIN/npm"
      ;;
  esac
done
STUB

writeStub npm <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$DOTFILES_TEST_LOG"
prefixFile="$DOTFILES_TEST_STATE/npm-prefix"
installedDir="$DOTFILES_TEST_STATE/npm-installed"
currentPrefix() {
  if [[ -f "$prefixFile" ]]; then
    cat "$prefixFile"
    return 0
  fi
  printf '%s\n' "$DOTFILES_TEST_STATE/system-npm-prefix"
}
encodeName() {
  printf '%s\n' "$1" | tr '/' '%'
}
case "$1 ${2:-}" in
  "config get")
    if [[ "${3:-}" == "prefix" ]]; then
      currentPrefix
      exit 0
    fi
    exit 1
    ;;
  "config set")
    if [[ "${3:-}" == "prefix" ]]; then
      printf '%s\n' "${4:-}" > "$prefixFile"
      exit 0
    fi
    exit 1
    ;;
  "root -g")
    printf '%s/lib/node_modules\n' "$(currentPrefix)"
    exit 0
    ;;
  "prefix -g")
    currentPrefix
    exit 0
    ;;
esac
if [[ "$1" == "outdated" ]]; then
  cat "$DOTFILES_TEST_STATE/npm-outdated.json" 2>/dev/null || printf '{}\n'
  exit 1
fi
if [[ "$1" == "ls" ]]; then
  printf '%s/lib/node_modules\n' "$(currentPrefix)"
  for recordFile in "$installedDir"/*; do
    if [[ ! -f "$recordFile" ]]; then
      continue
    fi
    read -r packageName < "$recordFile"
    packageVersion="$(sed -n '2p' "$recordFile")"
    packageDirectory="$(currentPrefix)/lib/node_modules/$packageName"
    mkdir -p "$packageDirectory"
    printf '{"version":"%s"}\n' "${packageVersion:-1.0.0}" > "$packageDirectory/package.json"
    printf '%s\n' "$packageDirectory"
  done
  exit 0
fi
if [[ "$1" == "pack" ]]; then
  packageSpec="$2"
  packageName="${packageSpec##*/}"
  printf '%s' "" > "$packageName-0.0.0.tgz"
  printf '%s\n' "$packageName" > "$packageName-0.0.0.tgz.name"
  printf '%s-0.0.0.tgz\n' "$packageName"
  exit 0
fi
if [[ "$1" == "install" ]]; then
  packageSpec="$3"
  packageName="${packageSpec%@latest}"
  if [[ -f "$DOTFILES_TEST_STATE/npm-upgrade-fails" ]]; then
    printf 'upgrade unavailable\n' >&2
    exit 1
  fi
  if [[ "$packageSpec" == *.tgz ]]; then
    packageName="$(cat "$packageSpec.name")"
  fi
  packageVersion=1.0.0
  if [[ "$packageName" == "@openai/codex" ]]; then
    packageVersion=0.159.0
  fi
  if [[ "$packageSpec" == *@latest && -f "$DOTFILES_TEST_STATE/npm-latest-version" ]]; then
    read -r packageVersion < "$DOTFILES_TEST_STATE/npm-latest-version"
  fi
  printf '%s\n%s\n' "$packageName" "$packageVersion" > "$installedDir/$(encodeName "$packageName")"
  exit 0
fi
if [[ "$1" == "uninstall" ]]; then
  rm -f "$installedDir/$(encodeName "$3")"
  exit 0
fi
exit 0
STUB

writeStub node <<'STUB'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-v" ]]; then
  printf 'v22.18.0\n'
  exit 0
fi
if [[ "${1:-}" == "-e" ]]; then
  exec "$DOTFILES_TEST_CORE_BIN/node-runtime" "$@"
fi
exit 0
STUB

writeStub python3 <<'STUB'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "$DOTFILES_TEST_LOG"
moduleDir="$DOTFILES_TEST_STATE/python-modules"
if [[ "${1:-}" == "-c" && "${2:-}" == 'import sys; print(sys.base_prefix)' ]]; then
  case "$0" in
    "$DOTFILES_TEST_HOMEBREW_PREFIX"/*)
      printf '%s/Cellar/python/3.14\n' "$DOTFILES_TEST_HOMEBREW_PREFIX"
      ;;
    "$HOME/.local/share/dotfiles/python-tools"/*)
      cat "${0%/*}/base-prefix" 2>/dev/null || printf '/usr\n'
      ;;
    *)
      printf '/usr\n'
      ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
  environmentDirectory="${*: -1}"
  rm -rf "$environmentDirectory"
  mkdir -p "$environmentDirectory/bin"
  cp "$0" "$environmentDirectory/bin/python3"
  "$0" -c 'import sys; print(sys.base_prefix)' > "$environmentDirectory/bin/base-prefix"
  exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "pip" && "${3:-}" == "--version" ]]; then
  printf 'pip 24.0\n'
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-}" == "-m pip list" ]]; then
  cat "$DOTFILES_TEST_STATE/pip-outdated.json" 2>/dev/null || printf '[]\n'
  exit 0
fi
if [[ "${1:-}" == "-c" ]]; then
  moduleName="${2#import }"
  [[ -f "$moduleDir/$moduleName" ]]
  exit $?
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "pip" && "${3:-}" == "install" ]]; then
  if [[ "$*" == *" --upgrade "* && -f "$DOTFILES_TEST_STATE/pip-upgrade-fails" ]]; then
    exit 1
  fi
  if [[ "$*" == *" pyyaml" && "$*" != *" --user "* \
    && "$0" != "$HOME/.local/share/dotfiles/python-tools/"* ]]; then
    exit 1
  fi
  for argument in "$@"; do
    case "$argument" in
      -* | pip | install) continue ;;
    esac
    mappingFile="$DOTFILES_TEST_STATE/pip-modules/$argument"
    if [[ -f "$mappingFile" ]]; then
      touch "$moduleDir/$(cat "$mappingFile")"
    fi
    if [[ "$argument" == "ruff" ]]; then
      printf '#!/usr/bin/env bash\nexit 0\n' > "${0%/*}/ruff"
      chmod +x "${0%/*}/ruff"
    fi
  done
  exit 0
fi
exit 0
STUB

writeStub gh <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  [[ ! -f "$DOTFILES_TEST_STATE/gh-unauthed" ]]
  exit $?
fi
exit 0
STUB

writeStub git <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "clone" ]]; then
  targetDirectory="${*: -1}"
  mkdir -p "$targetDirectory"
  exit 0
fi
exit 0
STUB

writeStub rg <<'STUB'
#!/usr/bin/env bash
:
STUB

writeStub flatpak <<'STUB'
#!/usr/bin/env bash
printf 'flatpak %s\n' "$*" >> "$DOTFILES_TEST_LOG"
installedDir="$DOTFILES_TEST_STATE/flatpak-installed"
if [[ "${1:-}" == "info" ]]; then
  [[ -f "$installedDir/$2" ]]
  exit $?
fi
if [[ "${1:-}" == "install" ]]; then
  appId="${*: -1}"
  touch "$installedDir/$appId"
  exportShare="$HOME/.local/share/flatpak/exports/share"
  mkdir -p "$exportShare/applications" "$exportShare/icons/hicolor/128x128/apps"
  printf '[Desktop Entry]\nName=%s\n' "$appId" > "$exportShare/applications/$appId.desktop"
  printf 'icon bytes\n' > "$exportShare/icons/hicolor/128x128/apps/$appId.png"
  exit 0
fi
exit 0
STUB

writeStub claude <<'STUB'
#!/usr/bin/env bash
printf 'claude %s\n' "$*" >> "$DOTFILES_TEST_LOG"
versionFile="$DOTFILES_TEST_STATE/claude-version"
if [[ "${1:-}" == "--version" ]]; then
  installedClaudeVersion=2.1.285
  if [[ -f "$versionFile" ]]; then
    read -r installedClaudeVersion < "$versionFile"
  fi
  printf '%s (Claude Code)\n' "$installedClaudeVersion"
  exit 0
fi
if [[ "${1:-}" == "update" ]]; then
  if [[ -f "$DOTFILES_TEST_STATE/claude-update-fails" ]]; then
    printf 'update unavailable\n' >&2
    exit 1
  fi
  if [[ -f "$DOTFILES_TEST_STATE/claude-update-stays-old" ]]; then
    exit 0
  fi
  printf '2.1.285\n' > "$versionFile"
fi
exit 0
STUB

writeStub bash_completion <<'STUB'
#!/usr/bin/env bash
:
STUB

for recordingOnlyCommand in dpkg systemctl update-desktop-database gtk-update-icon-cache; do
  writeStub "$recordingOnlyCommand" <<STUB
#!/usr/bin/env bash
printf '$recordingOnlyCommand %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
done

for presentFromTheStart in apt-get sudo curl flatpak dpkg systemctl \
  update-desktop-database gtk-update-icon-cache; do
  provideCommand "$presentFromTheStart"
done

mapPackageToCommands git "git"
mapPackageToCommands ripgrep "rg"
mapPackageToCommands bash-completion "bash_completion"
mapPackageToCommands gh "gh"
mapPackageToCommands nodejs "node npm"
mapPackageToCommands npm "npm"
mapPackageToCommands python3 "python3"

mkdir -p "$stubState/pip-modules"
printf 'ruff\n' > "$stubState/pip-modules/ruff"
printf 'yaml\n' > "$stubState/pip-modules/pyyaml"

printf 'oh-my-claude-sisyphus\n' > "$stubState/npm-installed/oh-my-claude-sisyphus"
printf '@xai-official/grok\n' > "$stubState/npm-installed/@xai-official%grok"
mkdir -p "$sandbox/.grok"
printf 'token\n' > "$sandbox/.grok/auth.json"

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE="${1:-personal}" \
    DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}


printf '\npackages topic\n'

realBashrcFingerprint() {
  if [[ ! -f "$realHome/.bashrc" ]]; then
    printf 'absent\n'
    return 0
  fi
  cksum < "$realHome/.bashrc"
}

realBashrcBefore="$(realBashrcFingerprint)"

installStatus=0

upgradeHome="$sandbox/upgrade-home"
mkdir -p "$upgradeHome"
ln -s "$repoRoot" "$upgradeHome/.dotfiles"
: > "$upgradeHome/.dotfiles-test-sandbox"
cp -R "$stubBin" "$sandbox/stubs-before-upgrades"
cp -R "$stubState" "$sandbox/state-before-upgrades"
provideCommand brew
provideCommand node
provideCommand npm
provideCommand python3
writeDarwinDirectoryServiceStub "$stubBin" "$realHome"
upgradeHomebrewPrefix="$upgradeHome/homebrew"
mkdir -p "$upgradeHomebrewPrefix/bin" "$upgradeHome/Applications"
cp "$stubBin/python3" "$upgradeHomebrewPrefix/bin/python3"
runUpgradeInstall() {
  runInStubbedSandbox "$upgradeHome" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
    DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$upgradeHomebrewPrefix" \
    DOTFILES_TEST_APPLICATIONS_DIRECTORY="$upgradeHome/Applications" \
    DOTFILES_TEST_BASH_COMPLETION_PATH="$upgradeHomebrewPrefix/etc/profile.d/bash_completion.sh" \
    NO_COLOR=1 bash "$topicDir/install.sh"
}
runUpgradeInstall > /dev/null
mkdir -p "$upgradeHome/.local/state/dotfiles"
printf 'plugin example 1.0.0 2.0.0\n' > "$upgradeHome/.local/state/dotfiles/upgrades-held-ai"
printf 'plugin example 1.0.0 1.1.0\n' > "$upgradeHome/.local/state/dotfiles/upgrades-failed-ai-pending"
: > "$commandLog"
runUpgradeInstall > /dev/null
check "a plain converge queries no outdated packages" logLacks 'outdated'
check "a plain converge runs no brew upgrade" logLacks 'brew upgrade'
check "a plain converge runs no pip upgrade" logLacks '--upgrade'
printf '{"formulae":[{"name":"git","installed_versions":["2.1.0"],"current_version":"2.2.0"},{"name":"node","installed_versions":["22.18.0"],"current_version":"22.19.0"},{"name":"python@3.14","installed_versions":["3.14.0"],"current_version":"3.14.1"},{"name":"vale","installed_versions":["3.0.0"],"current_version":"3.1.0"},{"name":"gh","installed_versions":["2.0.0"],"current_version":"2.1.0","pinned":true}],"casks":[{"name":"slack","installed_versions":["4.1.0"],"current_version":"4.2.0"}]}\n' > "$stubState/brew-outdated.json"
printf '{"typescript":{"current":"1.0.0","latest":"1.2.0"},"npm":{"current":"11.0.0","latest":"11.1.0"}}\n' > "$stubState/npm-outdated.json"
printf '1.2.0\n' > "$stubState/npm-latest-version"
printf '[{"name":"ruff","version":"0.2.0","latest_version":"0.2.1"}]\n' > "$stubState/pip-outdated.json"
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null
upgradeHeldPath="$upgradeHome/.local/state/dotfiles/upgrades-held-packages"
upgradeFailedPath="$upgradeHome/.local/state/dotfiles/upgrades-failed-packages-pending"
check "same-major formula applies" logHas 'brew upgrade git'
check "same-major cask applies" logHas 'brew upgrade --cask slack'
check "the Node presence path applies same-major updates" logHas 'brew upgrade node'
check "the Python alias resolves the outdated formula" logHas 'brew upgrade python3'
check "brew outdated is memoized per topic" test "$(countLogLines '^brew outdated --json=v2$')" -eq 1
check "brew refreshes its index once before the outdated query" \
  test "$(grep -m1 -E '^brew (update|outdated)' "$commandLog")" = 'brew update' -a "$(countLogLines '^brew update$')" -eq 1
check "every brew upgrade skips auto-update and dependent upgrades" \
  test "$(countLogLines '^brew-upgrade-environment HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1$')" -eq "$(countLogLines '^brew upgrade ')"
check "pinned formula is never upgraded" logLacks 'brew upgrade gh'
check "pinned formula is never recorded" bash -c '! grep -qs "formula gh " "$1" "$2"' _ "$upgradeHeldPath" "$upgradeFailedPath"
check "npm latest is queried once" test "$(countLogLines '^npm outdated -g --json$')" -eq 1
check "unapproved same-major npm is never installed" logLacks 'npm install -g typescript'
check "unapproved same-major npm is recorded held" grep -qx 'npm typescript 1.0.0 1.2.0' "$upgradeHeldPath"
check "unowned brew packages remain untouched" logLacks 'brew upgrade vale'
check "unowned npm globals remain untouched" logLacks 'npm install -g npm@'
check "a 0.x patch pip update applies inside the venv" logHas 'pip install --quiet --no-input --upgrade ruff==0.2.1'
check "pip outdated is memoized" test "$(countLogLines 'pip list --outdated --format=json$')" -eq 1
printf '[{"name":"ruff","version":"0.1.0","latest_version":"0.2.0"}]\n' > "$stubState/pip-outdated.json"
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null
check "a 0.x minor pip update is held" logLacks '--upgrade ruff'
check "a 0.x minor pip update is recorded" grep -qx 'pip ruff 0.1.0 0.2.0' "$upgradeHeldPath"
printf '{"formulae":[{"name":"git","installed_versions":["2.1.0"],"current_version":"3.0.0"}],"casks":[{"name":"slack","installed_versions":["4.1.0"],"current_version":"5.0.0"}]}\n' > "$stubState/brew-outdated.json"
printf '{"typescript":{"current":"1.2.0","latest":"2.0.0"}}\n' > "$stubState/npm-outdated.json"
printf '[{"name":"ruff","version":"0.2.0","latest_version":"1.0.0"}]\n' > "$stubState/pip-outdated.json"
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null
check "major formula is held" logLacks 'brew upgrade git'
check "major cask is held" logLacks 'brew upgrade --cask slack'
check "major cask is recorded" grep -qx 'cask slack 4.1.0 5.0.0' "$upgradeHeldPath"
check "major formula is recorded" grep -qx 'formula git 2.1.0 3.0.0' "$upgradeHeldPath"
check "major npm is never installed" logLacks 'npm install -g typescript'
check "major npm is recorded" grep -qx 'npm typescript 1.0.0 2.0.0' "$upgradeHeldPath"
check "major pip is held" logLacks '--upgrade ruff'
check "major pip is recorded" grep -qx 'pip ruff 0.2.0 1.0.0' "$upgradeHeldPath"
: > "$commandLog"
DOTFILES_UPGRADE=all runUpgradeInstall > /dev/null
check "approval applies major formula" logHas 'brew upgrade git'
check "approval applies major cask" logHas 'brew upgrade --cask slack'
check "approval applies major npm through latest" logHas 'npm install -g typescript@latest'
check "approval applies major pip" logHas '--upgrade ruff==1.0.0'
check "approval clears the held record" test ! -e "$upgradeHeldPath"
printf '{"formulae":[{"name":"git","installed_versions":["2.1.0"],"current_version":"2.2.0"}],"casks":[]}\n' > "$stubState/brew-outdated.json"
printf '{}\n' > "$stubState/npm-outdated.json"
printf '[]\n' > "$stubState/pip-outdated.json"
touch "$stubState/brew-upgrade-fails"
failedUpgradeStatus=0
failedUpgradeOutput="$(DOTFILES_UPGRADE=1 runUpgradeInstall)" || failedUpgradeStatus=$?
check "failed upgrade warns and fails the topic" test "$failedUpgradeStatus" -eq 1
check "failed upgrade names the package" outputMatches "$failedUpgradeOutput" '\[warn\].*git.*upgrade failed'
check "failed upgrade leaves a pending record" grep -qx 'formula git 2.1.0 2.2.0' "$upgradeFailedPath"
: > "$commandLog"
runUpgradeInstall > /dev/null
check "plain converge preserves failed upgrades" test -s "$upgradeFailedPath"
check "plain converge still queries no outdated packages" logLacks outdated
rm -f "$stubState/brew-upgrade-fails"
printf '{"formulae":[],"casks":[]}\n' > "$stubState/brew-outdated.json"

printf '{"typescript":{"current":"1.2.0","latest":"1.3.0"}}\n' > "$stubState/npm-outdated.json"
touch "$stubState/npm-upgrade-fails"
failedNpmStatus=0
failedNpmOutput="$(DOTFILES_UPGRADE=all runUpgradeInstall)" || failedNpmStatus=$?
check "failed npm update fails the topic" test "$failedNpmStatus" -eq 1
check "failed npm update warns once" test "$(grep -cE '\[warn\].*typescript' <<< "$failedNpmOutput")" -eq 1
check "failed npm update is pending" grep -qx 'npm typescript 1.2.0 1.3.0' "$upgradeFailedPath"
rm -f "$stubState/npm-upgrade-fails"
printf '{}\n' > "$stubState/npm-outdated.json"
printf '[{"name":"ruff","version":"0.2.0","latest_version":"0.2.1"}]\n' > "$stubState/pip-outdated.json"
touch "$stubState/pip-upgrade-fails"
failedPipStatus=0
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null || failedPipStatus=$?
check "failed pip update fails the topic" test "$failedPipStatus" -eq 1
check "failed pip update is pending" grep -qx 'pip ruff 0.2.0 0.2.1' "$upgradeFailedPath"
rm -f "$stubState/pip-upgrade-fails"
: > "$commandLog"
runInStubbedSandbox "$upgradeHome" DOTFILES_PLATFORM=linux DOTFILES_UPGRADE=1 DOTFILES_UPGRADE_TOPIC=packages \
  NO_COLOR=1 bash -c 'source "$1/script/lib/packages.sh"; upgradePythonPackage python3 ruff; finishPackageUpgrades' _ "$repoRoot" > /dev/null
check "Linux pip upgrades only the user site" logHas 'pip list --outdated --format=json --user'
check "Linux pip applies through the user install path" logHas 'pip install --quiet --no-input --upgrade --user --break-system-packages ruff==0.2.1'
printf '[]\n' > "$stubState/pip-outdated.json"
printf '{"formulae":[{"name":"git","installed_versions":["2.1.0"],"current_version":"2.2.0"}],"casks":[]}\n' > "$stubState/brew-outdated.json"
touch "$stubState/brew-update-fails"
failedBrewRefreshStatus=0
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null || failedBrewRefreshStatus=$?
check "failed brew index refresh fails the topic" test "$failedBrewRefreshStatus" -eq 1
check "failed brew index refresh skips the outdated query" logLacks 'brew outdated'
check "failed brew index refresh upgrades nothing" logLacks 'brew upgrade'
check "failed brew index refresh records owned brew packages" grep -qx 'formula git unknown unknown' "$upgradeFailedPath"
rm -f "$stubState/brew-update-fails"
printf '{"formulae":[],"casks":[{"name":"slack","installed_versions":["release-a"],"current_version":"release-b"}]}\n' > "$stubState/brew-outdated.json"
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null
check "versions without leading numbers apply" logHas 'brew upgrade --cask slack'
printf '{"formulae":[],"casks":[]}\n' > "$stubState/brew-outdated.json"
: > "$commandLog"
DOTFILES_UPGRADE=1 runUpgradeInstall > /dev/null
check "a clean rerun issues no brew upgrade" logLacks 'brew upgrade'
check "a clean rerun issues no npm install" logLacks 'npm install -g'
check "a clean rerun issues no pip upgrade" logLacks '--upgrade'
check "a clean upgrade clears failed records" test ! -e "$upgradeFailedPath"
check "a clean upgrade clears held records" test ! -e "$upgradeHeldPath"
check "packages preserve another topic's held record" test -s "$upgradeHome/.local/state/dotfiles/upgrades-held-ai"
check "packages preserve another topic's failure record" test -s "$upgradeHome/.local/state/dotfiles/upgrades-failed-ai-pending"
rm -rf "$stubBin" "$stubState"
mv "$sandbox/stubs-before-upgrades" "$stubBin"
mv "$sandbox/state-before-upgrades" "$stubState"

firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"

check "git is installed through the package manager" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y git"
check "ripgrep is installed through the package manager" logHas "install -y ripgrep"
check "bash completion is installed through the package manager" logHas "install -y bash-completion"
check "the GitHub CLI is installed" logHas "install -y gh"
check "python arrives with pip" logHas "install -y python3 python3-pip"
check "every package manager call goes through sudo" \
  test "$(countLogLines '^sudo -n [^ ]*/apt-get ')" -eq "$(countLogLines '^apt-get ')"
check "the package index is refreshed once per repository change" \
  test "$(countLogLines '^apt-get .* update$')" -eq 2
check "a third party installer gets the dpkg lock first" logHas "apt-get -o DPkg::Lock::Timeout=180 check"
check "node comes from NodeSource" logHas "https://deb.nodesource.com/setup_22.x"
check "the NodeSource package is installed" logHas "install -y nodejs"
check "Claude Code runs its native installer" logHas "https://claude.ai/install.sh"
check "Claude Code landed in ~/.local/bin" test -x "$sandbox/.local/bin/claude"
for flatpakAppId in app.zen_browser.zen com.bitwarden.desktop com.discordapp.Discord \
  com.slack.Slack org.remmina.Remmina; do
  check "$flatpakAppId is installed from flathub" logHas "flatpak install --user -y flathub $flatpakAppId"
  check "$flatpakAppId reaches the desktop app list" \
    test -f "$sandbox/.local/share/applications/$flatpakAppId.desktop"
done
check "the desktop database is refreshed" logHas "update-desktop-database"

check "the npm prefix moves to the per account one" logHas "npm config set prefix $sandbox/.npm-global"
check "~/.bashrc keeps ~/.local/bin on PATH" grep -q '\.local/bin' "$sandbox/.bashrc"
check "~/.bashrc keeps the npm prefix on PATH" grep -q '\.npm-global/bin' "$sandbox/.bashrc"

for wantedNpmPackage in @ast-grep/napi @biomejs/biome @earendil-works/pi-coding-agent \
  @openai/codex postiz typescript typescript-language-server; do
  check "$wantedNpmPackage is installed globally" logHas "npm install -g $wantedNpmPackage"
done
check "a retired package that is present is uninstalled" logHas "npm uninstall -g oh-my-claude-sisyphus"
check "the retired Grok CLI is uninstalled" logHas "npm uninstall -g @xai-official/grok"
check "the retired Grok CLI login state is removed" test ! -e "$sandbox/.grok"
check "a retired package that is absent is left alone" logLacks "uninstall -g @vibe-kit/grok-cli"

check "ruff is installed with noninteractive pip" logHas "pip install --quiet --no-input ruff"
check "pyyaml first uses noninteractive pip" logHas "pip install --quiet --no-input pyyaml"
check "pyyaml retry uses noninteractive pip" \
  logHas "pip install --quiet --no-input --user --break-system-packages pyyaml"

check "no command was refused for reaching outside the stubs" logLacks "sudo refused"
check "systemd is never touched" logLacks "systemctl "
check "dpkg is never driven directly" logLacks "dpkg "

check "the real ~/.bashrc is untouched" test "$realBashrcBefore" = "$(realBashrcFingerprint)"

: > "$commandLog"
secondRunOutput="$(runInstall)"
check "second run reports no changes" reportsNoChanges "$secondRunOutput"
check "second run installs no system package" logLacks "install -y"
check "second run installs no npm package" logLacks "npm install -g"
check "second run uninstalls nothing" logLacks "npm uninstall"
check "second run installs no flatpak" logLacks "flatpak install"
check "second run installs no pip package" logLacks "pip install"
check "second run downloads no installer" logLacks "curl"
check "a current Claude Code runs no update" logLacks "claude update"

printf '@openai/codex\n0.158.0\n' > "$stubState/npm-installed/@openai%codex"
printf '2.1.283\n' > "$stubState/claude-version"
: > "$commandLog"
upgradeRunStatus=0
upgradeRunOutput="$(runInstall)" || upgradeRunStatus=$?
check "a converge with outdated tools exits clean" test "$upgradeRunStatus" -eq 0
check "an outdated Codex upgrades to latest" logHas "npm install -g @openai/codex@latest --loglevel=error"
check "the Codex upgrade reports its old version" outputHas "$upgradeRunOutput" "upgrading from 0.158.0"
check "the Codex upgrade records the required version" \
  test "$(sed -n '2p' "$stubState/npm-installed/@openai%codex")" = "0.159.0"
check "an outdated Claude Code runs its updater" logHas "claude update"
check "the Claude Code upgrade reports its old version" outputHas "$upgradeRunOutput" "upgrading from 2.1.283"
check "the Claude Code upgrade rechecks its version" test "$(countLogLines '^claude --version$')" -eq 2

: > "$commandLog"
afterUpgradeOutput="$(runInstall)"
check "the converge after upgrading reports no changes" reportsNoChanges "$afterUpgradeOutput"
check "Codex at its floor runs no npm install" logLacks "npm install -g"
check "the converge after upgrading runs no Claude Code update" logLacks "claude update"

printf '@openai/codex\n0.160.0\n' > "$stubState/npm-installed/@openai%codex"
printf '2.1.284\n' > "$stubState/claude-version"
: > "$commandLog"
currentToolsOutput="$(runInstall)"
check "tools at or above their floors report no changes" reportsNoChanges "$currentToolsOutput"
check "Codex above its floor runs no npm install" logLacks "npm install -g"
check "Claude Code at its floor runs no update" logLacks "claude update"
check "Claude Code at its floor reports already installed" \
  outputMatches "$currentToolsOutput" 'Claude Code.*already installed'

printf '@openai/codex\n0.158.9\n' > "$stubState/npm-installed/@openai%codex"
: > "$commandLog"
workUpgradeStatus=0
workUpgradeOutput="$(runInstall work)" || workUpgradeStatus=$?
check "the work profile upgrades outdated Codex cleanly" test "$workUpgradeStatus" -eq 0
check "the work profile upgrades Codex to latest" logHas "npm install -g @openai/codex@latest --loglevel=error"

printf '2.1.283\n' > "$stubState/claude-version"
touch "$stubState/claude-update-stays-old"
: > "$commandLog"
staleClaudeStatus=0
staleClaudeOutput="$(runInstall)" || staleClaudeStatus=$?
check "a Claude Code update that stays outdated exits with a warning" test "$staleClaudeStatus" -eq 1
check "a Claude Code update that stays outdated names the floor" \
  outputMatches "$staleClaudeOutput" '\[warn\].*Claude Code.*still older than 2.1.284'
rm -f "$stubState/claude-update-stays-old"

touch "$stubState/claude-update-fails"
failedClaudeStatus=0
failedClaudeOutput="$(runInstall)" || failedClaudeStatus=$?
check "a failed Claude Code update exits with a warning" test "$failedClaudeStatus" -eq 1
check "a failed Claude Code update reports the failure" \
  outputMatches "$failedClaudeOutput" '\[warn\].*Claude Code.*update failed: update unavailable'
rm -f "$stubState/claude-update-fails"
printf '2.1.285\n' > "$stubState/claude-version"

rm -f "$stubState/npm-installed/@biomejs%biome"
: > "$commandLog"
workRunStatus=0
workRunOutput="$(runInstall work)" || workRunStatus=$?
check "a profile that varies the groups exits clean" test "$workRunStatus" -eq 0
check "the work profile installs biome through npm-globals" logHas "npm install -g @biomejs/biome"
check "the work profile installs no system package" logLacks "install -y"
check "the work profile installs no flatpak" logLacks "flatpak install"
check "the work profile skips casks without warning on linux" \
  outputMatches "$workRunOutput" '\[ -- \].*casks.*skipped, requires macOS'
check "the work profile still installs its python tools" outputHas "$workRunOutput" "ruff"

writeStub dscl <<STUB
#!/usr/bin/env bash
printf 'dscl %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
printf 'NFSHomeDirectory: %s\n' "$realHome"
STUB
provideCommand brew
provideCommand dscl
for commandName in git rg gh node npm; do
  withdrawCommand "$commandName"
done
darwinHomebrewPrefix="$sandbox/homebrew"
darwinApplicationsDirectory="$sandbox/Applications"
mkdir -p "$darwinHomebrewPrefix/bin" "$darwinApplicationsDirectory/Slack.app/Contents/MacOS"
rm -f "$stubState/npm-installed/typescript" "$stubState/npm-installed/@openai%codex" \
  "$stubState/npm-installed/@earendil-works%pi-coding-agent"
rm -f "$stubState/python-modules/ruff" "$stubState/python-modules/yaml" \
  "$sandbox/.local/bin/claude"
rm -rf "$sandbox/.local/share/dotfiles/python-tools"
: > "$commandLog"
darwinRunStatus=0
darwinRunOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh")" || darwinRunStatus=$?
check "the work profile converges through Homebrew on darwin" test "$darwinRunStatus" -eq 0
for brewPackage in git ripgrep bash-completion@2 gh python3 node; do
  check "darwin installs $brewPackage through Homebrew" logHas "brew install $brewPackage"
done
check "darwin chooses Homebrew even while apt-get is visible" logLacks 'apt-get '
check "darwin never runs Homebrew through sudo" logLacks 'sudo '
check "darwin takes the non-NodeSource Node path" logLacks 'nodesource.com'
check "darwin installs typescript after Homebrew provides npm" \
  logHas "npm install -g typescript"
check "the work profile installs Codex through npm-globals" logHas "npm install -g @openai/codex"
for forbiddenNpmPackage in @earendil-works/pi-coding-agent; do
  check "the work profile installs no $forbiddenNpmPackage" \
    logLacks "npm install -g $forbiddenNpmPackage"
done
check "darwin installs Claude Code from the work profile" logHas 'https://claude.ai/install.sh'
check "darwin reports a cask whose app was installed by hand as present" \
  outputMatches "$darwinRunOutput" '\[ -- \].*slack.*already installed'
check "darwin does not install a cask over an app someone installed by hand" \
  logLacks 'brew install --cask slack'
check "darwin creates Python tools with Homebrew Python" \
  logHas "python3 -m venv --clear $sandbox/.local/share/dotfiles/python-tools"
check "darwin installs ruff inside the Python tools environment" \
  test -x "$sandbox/.local/share/dotfiles/python-tools/bin/ruff"
check "darwin installs the work profile's Python tools" outputHas "$darwinRunOutput" 'ruff'
check "darwin never breaks Homebrew's externally managed Python" logLacks '--break-system-packages'
check "darwin builds the Python tools on the Homebrew interpreter" \
  grep -qx "$darwinHomebrewPrefix/Cellar/python/3.14" \
  "$sandbox/.local/share/dotfiles/python-tools/bin/base-prefix"

rm -rf "$darwinApplicationsDirectory/Slack.app"
rm -f "$stubState/cask-installed/slack"
: > "$commandLog"
missingSlackRunStatus=0
missingSlackRunOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh")" || missingSlackRunStatus=$?
check "a missing Slack cask converges through Homebrew on darwin" \
  test "$missingSlackRunStatus" -eq 0
check "darwin installs Slack when neither the app bundle nor a brew record exists" \
  logHas 'brew install --cask slack'
check "darwin reports Slack installed after Homebrew installs it" \
  outputMatches "$missingSlackRunOutput" '\[ \+\+ \].*slack.*installed'

touch "$stubState/cask-installed/slack"
: > "$commandLog"
brewRecordedSlackRunStatus=0
brewRecordedSlackRunOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh")" || brewRecordedSlackRunStatus=$?
check "a brew-recorded Slack cask converges through Homebrew on darwin" \
  test "$brewRecordedSlackRunStatus" -eq 0
check "darwin reports a Slack cask recorded by Homebrew as present" \
  outputMatches "$brewRecordedSlackRunOutput" '\[ -- \].*slack.*already installed'
check "darwin does not reinstall Slack when Homebrew records it without an app bundle" \
  logLacks 'brew install --cask slack'

pythonToolsEnvironment="$sandbox/.local/share/dotfiles/python-tools"
rm -rf "$pythonToolsEnvironment"
mkdir -p "$pythonToolsEnvironment/bin"
cp "$stubBin/python3" "$pythonToolsEnvironment/bin/python3"
printf '/usr\n' > "$pythonToolsEnvironment/bin/base-prefix"
: > "$pythonToolsEnvironment/bin/left-by-the-apple-python"
rm -f "$stubState/python-modules/ruff" "$stubState/python-modules/yaml"
: > "$commandLog"
appleVenvRunStatus=0
runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh" > /dev/null || appleVenvRunStatus=$?
check "a converge over an Apple-built Python environment exits clean" test "$appleVenvRunStatus" -eq 0
check "an Apple-built Python environment is rebuilt on the Homebrew interpreter" \
  grep -qx "$darwinHomebrewPrefix/Cellar/python/3.14" "$pythonToolsEnvironment/bin/base-prefix"
check "the rebuild clears what the Apple-built environment left behind" \
  test ! -e "$pythonToolsEnvironment/bin/left-by-the-apple-python"
check "the rebuilt environment gets the profile's Python tools back" \
  test -x "$pythonToolsEnvironment/bin/ruff"

: > "$commandLog"
runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh" > /dev/null || true
check "a Homebrew-built Python environment is left alone" logLacks 'python3 -m venv'

rm -rf "$pythonToolsEnvironment"
mkdir -p "$pythonToolsEnvironment/bin"
cp "$stubBin/python3" "$pythonToolsEnvironment/bin/python3"
printf '/usr\n' > "$pythonToolsEnvironment/bin/base-prefix"
: > "$commandLog"
leadingVenvRunStatus=0
leadingVenvRunOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" \
  PATH="$pythonToolsEnvironment/bin:$darwinHomebrewPrefix/bin:$stubBin:$coreBin" DOTFILES_PLATFORM=darwin \
  DOTFILES_PROFILE=work DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_TEST_BASH_COMPLETION_PATH="$stubBin/bash_completion" NO_COLOR=1 \
  bash "$topicDir/install.sh")" || leadingVenvRunStatus=$?
check "a stale environment leading PATH still reports Homebrew Python present" \
  outputMatches "$leadingVenvRunOutput" 'Python.*already installed'
check "a stale environment leading PATH reinstalls no Python" logLacks 'brew install python3'
check "a stale environment leading PATH never blames the session PATH" \
  outputLacks "$leadingVenvRunOutput" 'open a new shell for PATH'
check "a converge behind a stale environment on PATH exits clean" test "$leadingVenvRunStatus" -eq 0

touch "$stubState/gh-unauthed"
unauthedRunStatus=0
unauthedRunOutput="$(runInstall)" || unauthedRunStatus=$?
check "a missing GitHub login warns" outputMatches "$unauthedRunOutput" '\[warn\].*GitHub auth'
check "a warning makes the topic exit non-zero" test "$unauthedRunStatus" -eq 1
rm -f "$stubState/gh-unauthed"

profilelessRunStatus=0
profilelessRunOutput="$(runInstall "nosuchprofile")" || profilelessRunStatus=$?
check "a profile with no package list warns" outputMatches "$profilelessRunOutput" '\[warn\].*package groups'
check "a profile with no package list installs nothing" \
  reportsNoChanges "$profilelessRunOutput"
check "a profile with no package list exits non-zero" test "$profilelessRunStatus" -eq 1

source "$repoRoot/script/lib/context.sh"
source "$repoRoot/script/lib/packages.sh"
source "$topicDir/flatpak.sh"

check "a scoped floor entry resolves its package name" \
  test "$(npmPackageName '@openai/codex>=0.159.0')" = '@openai/codex'
check "a scoped floor entry resolves to latest" \
  test "$(npmPackageSource '@openai/codex>=0.159.0')" = '@openai/codex@latest'
check "a scoped floor entry resolves its minimum version" \
  test "$(npmPackageMinimumVersion '@openai/codex>=0.159.0')" = '0.159.0'
check "a source entry preserves its package name" \
  test "$(npmPackageName 'example=github:example/repository#main')" = 'example'
check "a source entry preserves its source" \
  test "$(npmPackageSource 'example=github:example/repository#main')" = 'github:example/repository#main'
check "a source entry has no implicit minimum version" \
  test -z "$(npmPackageMinimumVersion 'example=github:example/repository#main')"
check "an unversioned entry preserves its install source" test "$(npmPackageSource typescript)" = 'typescript'
check "an unversioned entry has no minimum version" test -z "$(npmPackageMinimumVersion typescript)"
check "version comparison accepts an exact floor" isVersionAtLeast 0.159.0 0.159.0
check "version comparison accepts a newer major version" isVersionAtLeast 3.0.0 2.1.284
check "version comparison accepts a newer minor version with a lower patch" isVersionAtLeast 2.2.0 2.1.284
check "version comparison compares numeric components" isVersionAtLeast 0.159.0 0.99.0
check "version comparison treats leading zeros as decimal" isVersionAtLeast 02.01.0284 2.1.284
check "version comparison treats omitted components as zero" isVersionAtLeast 2.1 2.1.0

versionIsBelowFloor() {
  ! isVersionAtLeast "$1" "$2"
}

check "version comparison rejects an older patch" versionIsBelowFloor 2.1.283 2.1.284
check "version comparison rejects an older minor with a higher patch" versionIsBelowFloor 0.158.999 0.159.0
check "version comparison rejects an unreadable version" versionIsBelowFloor unknown 2.1.284
check "version comparison rejects an empty version" versionIsBelowFloor '' 2.1.284

exportRoot="$sandbox/exports"
mkdir -p "$exportRoot"
printf 'the launcher the export produced\n' > "$exportRoot/source.desktop"
printf 'the launcher the export produced\n' > "$exportRoot/outside.desktop"
ln -s "$exportRoot/outside.desktop" "$exportRoot/destination.desktop"

matchingSymlinkIsRefused() {
  NO_COLOR=1 copyExportedAsset "probe launcher" "$exportRoot/source.desktop" \
    "$exportRoot/destination.desktop"
}

destinationIsNotAPlainFile() {
  ! pathIsPlainFileOrAbsent "$exportRoot/destination.desktop"
}

check "a destination symlinked away is never treated as a plain file" destinationIsNotAPlainFile
symlinkExportOutput="$(matchingSymlinkIsRefused 2>&1)" || true
check "a symlinked launcher with identical bytes is still refused" \
  outputHas "$symlinkExportOutput" 'not a regular file, leaving it alone'
check "the file the symlink pointed at is untouched" \
  grep -qx 'the launcher the export produced' "$exportRoot/outside.desktop"
check "the symlink is left where it was" test -L "$exportRoot/destination.desktop"

updateRoot="$sandbox/updates"
mkdir -p "$updateRoot"
exportedLauncher="$updateRoot/app.desktop"
exportSource="$updateRoot/source.desktop"

exportOnce() {
  printf '%s\n' "$1" > "$exportSource"
  NO_COLOR=1 copyExportedAsset "probe launcher" "$exportSource" "$exportedLauncher" > /dev/null
}

countExportBackups() {
  local backupPath
  local backupCount=0
  for backupPath in "$exportedLauncher"*.pre-dotfiles.bak*; do
    if [[ -e "$backupPath" ]]; then
      backupCount=$((backupCount + 1))
    fi
  done
  printf '%s\n' "$backupCount"
}

exportOnce "the launcher the first export produced"
exportOnce "the launcher the second export produced"
exportOnce "the launcher the third export produced"
check "a flatpak update never backs up the engine's own prior copy" \
  test "$(countExportBackups)" -eq 0
check "the launcher holds what the last export produced" \
  grep -qx 'the launcher the third export produced' "$exportedLauncher"

printf 'a launcher line someone added by hand\n' > "$exportedLauncher"
exportOnce "the launcher a later export produced"
check "a hand edited launcher is backed up" test "$(countExportBackups)" -eq 1
check "the backup keeps the hand edit" \
  bash -c 'grep -qx "a launcher line someone added by hand" "$1".pre-dotfiles.bak' _ "$exportedLauncher"

exportOnce "the launcher an even later export produced"
check "a later update earns no second backup" test "$(countExportBackups)" -eq 1

fastPathAppId="com.example.FastPath"
fastPathSource="$sandbox/.local/share/flatpak/exports/share/applications/$fastPathAppId.desktop"
fastPathDestination="$sandbox/.local/share/applications/$fastPathAppId.desktop"
mkdir -p "$(dirname -- "$fastPathSource")" "$(dirname -- "$fastPathDestination")"
printf 'matching exported launcher\n' > "$fastPathSource"
cp "$fastPathSource" "$fastPathDestination"
HOME="$sandbox" NO_COLOR=1 exportFlatpakLauncherAssets "fast path" "$fastPathAppId" > /dev/null
check "an identical exported launcher records its rendered baseline" \
  test -f "$fastPathDestination.pre-dotfiles.rendered"
printf 'updated exported launcher\n' > "$fastPathSource"
HOME="$sandbox" NO_COLOR=1 exportFlatpakLauncherAssets "fast path" "$fastPathAppId" > /dev/null
check "an update after the identical fast path creates no backup" \
  bash -c '! compgen -G "$1.pre-dotfiles.bak*" > /dev/null' _ "$fastPathDestination"
check "the update after the identical fast path reaches the destination" \
  grep -qx 'updated exported launcher' "$fastPathDestination"

reportTopicResults "packages"
