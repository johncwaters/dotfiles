#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"
# shellcheck source=./flatpak.sh
source "$dotfilesRepo/packages/flatpak.sh"

packagesDirectory="$dotfilesRepo/packages"
nodeSourceMajor=22
enabledPackageGroups=()
installedNpmPackages=()
# A group this file never asks about installs nothing, so a typo has to be named out loud.
knownPackageGroups=(
  system-tools
  node
  claude-code
  zed
  flatpaks
  npm-globals
  biome
  python-tools
)

packageGroupIsKnown() {
  local candidateGroup="$1"
  local knownGroup
  for knownGroup in "${knownPackageGroups[@]}"; do
    if [[ "$knownGroup" == "$candidateGroup" ]]; then
      return 0
    fi
  done
  return 1
}

readEnabledPackageGroups() {
  if [[ -z "${profileName:-}" ]]; then
    noteWarned "package groups" "no profile resolved, nothing installed"
    return 1
  fi
  local groupsPath="$dotfilesRepo/profiles/$profileName/packages.txt"
  if [[ ! -f "$groupsPath" ]]; then
    noteWarned "package groups" "no profiles/$profileName/packages.txt, nothing installed"
    return 1
  fi
  mapfile -t enabledPackageGroups < <(readPackageList "$groupsPath")
  if ((${#enabledPackageGroups[@]} == 0)); then
    noteWarned "package groups" "profiles/$profileName/packages.txt lists none"
    return 1
  fi
  local listedGroup
  for listedGroup in "${enabledPackageGroups[@]}"; do
    if ! packageGroupIsKnown "$listedGroup"; then
      noteWarned "package groups" "no such group in this topic: $listedGroup"
    fi
  done
  noteDetail "package groups" "${enabledPackageGroups[*]}"
}

packageGroupEnabled() {
  local wantedGroup="$1"
  local enabledGroup
  for enabledGroup in ${enabledPackageGroups[@]+"${enabledPackageGroups[@]}"}; do
    if [[ "$enabledGroup" == "$wantedGroup" ]]; then
      return 0
    fi
  done
  return 1
}

reportGithubAuthStatus() {
  refreshSessionPath
  if ! command -v gh >/dev/null 2>&1; then
    return 0
  fi
  if gh auth status >/dev/null 2>&1; then
    notePresent "GitHub auth" "logged in"
    return 0
  fi
  noteWarned "GitHub auth" "run gh auth login"
}

nodeSourceSetupUrl() {
  local manager="$1"
  if [[ "$manager" == "dnf" ]]; then
    printf 'https://rpm.nodesource.com/setup_%s.x\n' "$nodeSourceMajor"
    return 0
  fi
  printf 'https://deb.nodesource.com/setup_%s.x\n' "$nodeSourceMajor"
}

# The NodeSource nodejs package conflicts with the distro npm and apt will not resolve it.
installNodeSourcePackage() {
  local manager="$1"
  local logPath="$2"
  if installSystemPackages "$manager" nodejs; then
    return 0
  fi
  if [[ "$manager" != "apt-get" ]]; then
    return 1
  fi
  if ! grep -qi 'conflict' "$logPath"; then
    return 1
  fi
  printf 'retrying without the distro npm package\n' >> "$logPath"
  if ! removeAptPackageWithoutDependents npm "$logPath"; then
    return 1
  fi
  installSystemPackages "$manager" nodejs
}

installNodeJs() {
  local manager
  local setupLog
  refreshSessionPath
  if nodeIsCurrentEnough; then
    notePresent "Node.js" "already installed"
    return 0
  fi
  if ! manager="$(detectPackageManager)"; then
    noteWarned "Node.js" "no supported package manager, install manually"
    return 0
  fi
  if [[ "$manager" != "apt-get" && "$manager" != "dnf" ]]; then
    installPackageTool "Node.js" "node" "node"
    return 0
  fi
  if ! canInstallSystemPackages; then
    noteWarned "Node.js" "$manager needs root or sudo, install manually"
    return 0
  fi
  noteStarting "Node.js" "installing Node $nodeSourceMajor from NodeSource"
  setupLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-nodesource.XXXXXX")"
  waitForPackageManagerLock
  if ! installFromVendorScript "Node.js" bash "$(nodeSourceSetupUrl "$manager")" "$setupLog" 1; then
    rm -f -- "$setupLog"
    return 0
  fi
  forgetPackageIndexRefresh
  if ! withPackageInstallLog "$setupLog" installNodeSourcePackage "$manager" "$setupLog"; then
    noteWarned "Node.js" "NodeSource install failed: $(lastLogLine "$setupLog")"
    rm -f -- "$setupLog"
    return 0
  fi
  rm -f -- "$setupLog"
  refreshSessionPath
  if nodeIsCurrentEnough; then
    noteInstalled "Node.js" "Node $(nodeMajorVersion) installed"
    return 0
  fi
  noteWarned "Node.js" "still older than Node $minimumNodeMajor.$minimumNodeMinor, upgrade manually"
}

installClaudeCode() {
  refreshSessionPath
  persistUserLocalBinOnPath
  if command -v claude >/dev/null 2>&1; then
    notePresent "Claude Code" "already installed"
    return 0
  fi
  noteStarting "Claude Code" "running native installer"
  local installerLog
  installerLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-claude-install.XXXXXX")"
  if ! installFromVendorScript "Claude Code" bash https://claude.ai/install.sh "$installerLog"; then
    rm -f -- "$installerLog"
    return 0
  fi
  rm -f -- "$installerLog"
  refreshSessionPath
  if command -v claude >/dev/null 2>&1; then
    noteInstalled "Claude Code" "installed"
    return 0
  fi
  noteWarned "Claude Code" "not on PATH yet, open a new shell"
}

zedIsInstalled() {
  if command -v zed >/dev/null 2>&1; then
    return 0
  fi
  [[ -x "$HOME/.local/bin/zed" ]]
}

installZed() {
  refreshSessionPath
  persistUserLocalBinOnPath
  if zedIsInstalled; then
    notePresent "Zed" "already installed"
    return 0
  fi
  noteStarting "Zed" "running official installer"
  local installerLog
  installerLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-zed-install.XXXXXX")"
  if ! installFromVendorScript "Zed" sh https://zed.dev/install.sh "$installerLog"; then
    rm -f -- "$installerLog"
    return 0
  fi
  rm -f -- "$installerLog"
  refreshSessionPath
  if zedIsInstalled; then
    noteInstalled "Zed" "installed"
    return 0
  fi
  noteWarned "Zed" "installed, but not on PATH yet"
}

installProfileFlatpaks() {
  local appId
  local label
  while read -r appId label; do
    if [[ -z "$appId" || -z "$label" ]]; then
      continue
    fi
    installFlatpakApp "$label" "$appId"
  done < <(readPackageList "$packagesDirectory/flatpaks.txt")
}

npmToolingIsReady() {
  refreshSessionPath
  if ! command -v npm >/dev/null 2>&1; then
    noteWarned "npm" "not on PATH, skipping packages"
    return 1
  fi
  ensureUserNpmPrefix
  return 0
}

refreshInstalledNpmPackages() {
  installedNpmPackages=()
  mapfile -t installedNpmPackages < <(listGlobalNpmPackages)
}

npmPackageIsInstalled() {
  local wantedName="$1"
  local installedName
  for installedName in ${installedNpmPackages[@]+"${installedNpmPackages[@]}"}; do
    if [[ "$installedName" == "$wantedName" ]]; then
      return 0
    fi
  done
  return 1
}

installNpmGlobalEntry() {
  local packageEntry="$1"
  local packageName
  local packageSource
  local installLog
  local failureReason
  packageName="$(npmPackageName "$packageEntry")"
  packageSource="$(npmPackageSource "$packageEntry")"
  noteStarting "$packageName" "npm install -g $packageSource"
  installLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-npm-install.XXXXXX")"
  if installGlobalNpmPackage "$packageSource" > "$installLog" 2>&1; then
    rm -f -- "$installLog"
    noteInstalled "$packageName" "installed"
    return 0
  fi
  # A package published for one platform only is a fact about the package, not a failure.
  if grep -q "EBADPLATFORM" "$installLog"; then
    rm -f -- "$installLog"
    notePresent "$packageName" "not published for this platform"
    return 0
  fi
  failureReason="$(npmFailureReason "$installLog")"
  rm -f -- "$installLog"
  noteWarned "$packageName" "npm install failed: $failureReason"
}

ensureNpmGlobals() {
  local summaryLabel="$1"
  shift
  local wantedEntries=("$@")
  local missingEntries=()
  local packageEntry
  if ((${#wantedEntries[@]} == 0)); then
    noteWarned "$summaryLabel" "no packages listed"
    return 0
  fi
  refreshInstalledNpmPackages
  for packageEntry in "${wantedEntries[@]}"; do
    if npmPackageIsInstalled "$(npmPackageName "$packageEntry")"; then
      continue
    fi
    missingEntries+=("$packageEntry")
  done
  if ((${#missingEntries[@]} == 0)); then
    notePresent "$summaryLabel" "all ${#wantedEntries[@]} present"
    return 0
  fi
  for packageEntry in "${missingEntries[@]}"; do
    installNpmGlobalEntry "$packageEntry"
  done
}

installWantedNpmGlobals() {
  local wantedEntries=()
  mapfile -t wantedEntries < <(readPackageList "$packagesDirectory/npm-globals.txt")
  ensureNpmGlobals "packages" ${wantedEntries[@]+"${wantedEntries[@]}"}
}

removeRetiredNpmGlobals() {
  local retiredNames=()
  local presentNames=()
  local packageName
  mapfile -t retiredNames < <(readPackageList "$packagesDirectory/npm-globals-remove.txt")
  refreshInstalledNpmPackages
  for packageName in ${retiredNames[@]+"${retiredNames[@]}"}; do
    if npmPackageIsInstalled "$packageName"; then
      presentNames+=("$packageName")
    fi
  done
  if ((${#presentNames[@]} == 0)); then
    notePresent "npm removals" "none present"
    return 0
  fi
  for packageName in "${presentNames[@]}"; do
    noteStarting "$packageName" "npm uninstall -g"
    if npm uninstall -g "$packageName" --loglevel=error >/dev/null 2>&1; then
      noteApplied "$packageName" "removed"
      continue
    fi
    noteWarned "$packageName" "npm uninstall failed"
  done
}

# PEP 668 marks many distro Python installs as externally managed, so retry in the user site.
ensurePythonPackage() {
  local pythonCommand="$1"
  local moduleName="$2"
  local packageName="$3"
  if "$pythonCommand" -c "import $moduleName" >/dev/null 2>&1; then
    notePresent "$packageName" "already installed"
    return 0
  fi
  noteStarting "$packageName" "pip install"
  if "$pythonCommand" -m pip install --quiet --no-input "$packageName" </dev/null >/dev/null 2>&1; then
    noteInstalled "$packageName" "installed"
    return 0
  fi
  if "$pythonCommand" -m pip install --quiet --no-input --user --break-system-packages \
    "$packageName" </dev/null >/dev/null 2>&1; then
    noteInstalled "$packageName" "installed"
    return 0
  fi
  noteWarned "$packageName" "pip install failed"
}

installPythonTools() {
  local pythonCommand
  local moduleName
  local packageName
  if ! pythonCommand="$(pythonCommandName)"; then
    noteWarned "python" "not on PATH, skipping pip tools"
    return 0
  fi
  while read -r moduleName packageName; do
    if [[ -z "$moduleName" || -z "$packageName" ]]; then
      continue
    fi
    ensurePythonPackage "$pythonCommand" "$moduleName" "$packageName"
  done < <(readPackageList "$packagesDirectory/python-tools.txt")
}

if ! readEnabledPackageGroups; then
  finishTopic
fi

if packageGroupEnabled "system-tools"; then
  writeSection "Tools"
  installPackageTool "git" "git" "git"
  installPackageTool "GitHub CLI" "gh" "gh" "https://cli.github.com"
  installPackageTool "Python" "python3" "python"
  reportGithubAuthStatus
fi

if packageGroupEnabled "node"; then
  installNodeJs
fi

if packageGroupEnabled "claude-code"; then
  installClaudeCode
fi

if packageGroupEnabled "zed"; then
  installZed
fi

if packageGroupEnabled "flatpaks"; then
  writeSection "Desktop apps"
  installProfileFlatpaks
fi

if packageGroupEnabled "npm-globals"; then
  writeSection "npm globals"
  if npmToolingIsReady; then
    installWantedNpmGlobals
    removeRetiredNpmGlobals
  fi
fi

if packageGroupEnabled "biome"; then
  writeSection "Hook deps"
  if npmToolingIsReady; then
    ensureNpmGlobals "biome" "@biomejs/biome"
  fi
fi

if packageGroupEnabled "python-tools"; then
  writeSection "Python tools"
  installPythonTools
fi

finishTopic
