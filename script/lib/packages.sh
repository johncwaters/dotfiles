# shellcheck shell=bash
# Requires context.sh and loads it when a topic has not already done so.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=./context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/context.sh"
fi

: "${detectedPackageManager:=}"
: "${aptUpdated:=0}"
: "${packageInstallLog:=}"
: "${dpkgLockWaitSeconds:=180}"
: "${minimumNodeMajor:=22}"
: "${minimumNodeMinor:=18}"
: "${userNpmPrefixEnsured:=0}"
: "${passwordlessSudoProbe:=unknown}"
: "${lastPackageInstallFailure:=}"

heldUpgrades=()
failedUpgrades=()
if [[ -n "${DOTFILES_UPGRADE:-}" ]]; then
  declare -A outdatedBrewVersions=()
  declare -A outdatedPythonVersions=()
fi
hasQueriedBrewUpgrades=0
hasQueriedPythonUpgrades=0
hasBrewUpgradeQueryFailed=0
hasPythonUpgradeQueryFailed=0

recordHeldUpgrade() {
  heldUpgrades+=("$1 $2 $3 $4")
}

recordFailedUpgradeAlreadyWarned() {
  failedUpgrades+=("$1 $2 $3 $4")
}

recordFailedUpgrade() {
  recordFailedUpgradeAlreadyWarned "$@"
  noteWarned "$2" "$1 upgrade failed ($3 -> $4)"
}

finishPackageUpgrades() {
  [[ -n "${DOTFILES_UPGRADE:-}" ]] || return 0
  local topicDirectory="${0%/*}"
  local upgradeTopic="${DOTFILES_UPGRADE_TOPIC:-${topicDirectory##*/}}"
  local recordName
  local recordLines
  for recordName in held failed; do
    recordLines=""
    case "$recordName" in
      held)
        if ((${#heldUpgrades[@]} > 0)); then
          printf -v recordLines '%s\n' "${heldUpgrades[@]}"
        fi
        recordName="upgrades-held-$upgradeTopic"
        ;;
      failed)
        if ((${#failedUpgrades[@]} > 0)); then
          printf -v recordLines '%s\n' "${failedUpgrades[@]}"
        fi
        recordName="upgrades-failed-$upgradeTopic-pending"
        ;;
    esac
    if [[ -n "$recordLines" ]]; then
      writeDotfilesState "$recordName" "${recordLines%$'\n'}"
      continue
    fi
    clearDotfilesState "$recordName"
  done
}

versionHasNewMajor() {
  [[ "$1" =~ ^([0-9]+)(\.([0-9]+)([^0-9A-Za-z]|$)|[^.0-9A-Za-z]|$) ]] || return 0
  local installedMajor="${BASH_REMATCH[1]}"
  local installedMinor="${BASH_REMATCH[3]:-0}"
  [[ "$2" =~ ^([0-9]+)(\.([0-9]+)([^0-9A-Za-z]|$)|[^.0-9A-Za-z]|$) ]] || return 0
  local availableMajor="${BASH_REMATCH[1]}"
  local availableMinor="${BASH_REMATCH[3]:-0}"
  ((10#$installedMajor == 10#$availableMajor)) || return 0
  ((10#$installedMajor == 0 && 10#$installedMinor != 10#$availableMinor))
}

versionIsNewer() {
  [[ "$1" != "$2" ]] || return 1
  local installedNumericVersion
  local availableNumericVersion
  [[ "$1" =~ ^([0-9]+(\.[0-9]+)*)(-[0-9A-Za-z.-]+)?$ ]] || return 0
  installedNumericVersion="${BASH_REMATCH[1]}"
  [[ "$2" =~ ^([0-9]+(\.[0-9]+)*)(-[0-9A-Za-z.-]+)?$ ]] || return 0
  availableNumericVersion="${BASH_REMATCH[1]}"
  if [[ "$installedNumericVersion" == "$availableNumericVersion" ]]; then
    [[ "$1" == *-* && "$2" != *-* ]]
    return $?
  fi
  ! isVersionAtLeast "$installedNumericVersion" "$availableNumericVersion"
}

areAllUpgradesApproved() {
  [[ "${DOTFILES_UPGRADE:-}" == all ]]
}

shouldHoldUpgrade() {
  ! areAllUpgradesApproved || return 1
  versionHasNewMajor "$1" "$2"
}

queryBrewUpgrades() {
  ((hasQueriedBrewUpgrades == 0)) || return 0
  hasQueriedBrewUpgrades=1
  local brewCommand
  local outdatedPackages
  local parsedPackages
  local packageKind
  local packageName
  local installedVersion
  local availableVersion
  brewCommand="$(brewCommandPath)" || { hasBrewUpgradeQueryFailed=1; return 0; }
  if ! "$brewCommand" update >/dev/null 2>&1; then
    hasBrewUpgradeQueryFailed=1
    return 0
  fi
  if ! outdatedPackages="$("$brewCommand" outdated --json=v2 2>/dev/null)"; then
    hasBrewUpgradeQueryFailed=1
    return 0
  fi
  if ! parsedPackages="$(node -e '
    const outdatedPackages = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    for (const [collectionName, packageKind] of [["formulae", "formula"], ["casks", "cask"]]) {
      for (const entry of outdatedPackages[collectionName]) {
        if (entry.pinned === true) continue;
        console.log([packageKind, entry.name, entry.installed_versions.at(-1), entry.current_version].join("\t"));
      }
    }
  ' <<< "$outdatedPackages")"; then
    hasBrewUpgradeQueryFailed=1
    return 0
  fi
  while IFS=$'\t' read -r packageKind packageName installedVersion availableVersion; do
    [[ -n "$packageName" ]] || continue
    outdatedBrewVersions["$packageKind:$packageName"]="$installedVersion $availableVersion"
  done <<< "$parsedPackages"
}

upgradeBrewPackage() {
  [[ -n "${DOTFILES_UPGRADE:-}" ]] || return 0
  local packageKind="$1"
  local packageName="$2"
  local lookupName="$packageName"
  local installedVersion
  local availableVersion
  local brewCommand
  local upgradeArguments=(upgrade)
  queryBrewUpgrades
  if ((hasBrewUpgradeQueryFailed == 1)); then
    recordFailedUpgrade "$packageKind" "$packageName" unknown unknown
    return 0
  fi
  local hasOutdatedPythonFormula=0
  local outdatedKey
  if [[ "$packageName" == python3 ]]; then
    for outdatedKey in "${!outdatedBrewVersions[@]}"; do
      [[ "$outdatedKey" == formula:python@* ]] || continue
      hasOutdatedPythonFormula=1
    done
  fi
  if [[ "$packageName" == python3 && -z "${outdatedBrewVersions[formula:python3]:-}" ]] && ((hasOutdatedPythonFormula == 1)); then
    brewCommand="$(brewCommandPath)"
    lookupName="$("$brewCommand" info --json=v2 python3 2>/dev/null | node -e '
      const formulae = JSON.parse(require("node:fs").readFileSync(0, "utf8")).formulae;
      console.log(formulae[0].name);
    ')" || { recordFailedUpgrade formula python3 unknown unknown; return 0; }
  fi
  [[ -n "${outdatedBrewVersions[$packageKind:$lookupName]:-}" ]] || return 0
  read -r installedVersion availableVersion <<< "${outdatedBrewVersions[$packageKind:$lookupName]}"
  if shouldHoldUpgrade "$installedVersion" "$availableVersion"; then
    recordHeldUpgrade "$packageKind" "$packageName" "$installedVersion" "$availableVersion"
    return 0
  fi
  [[ "$packageKind" != cask ]] || upgradeArguments+=(--cask)
  brewCommand="$(brewCommandPath)"
  if HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 "$brewCommand" "${upgradeArguments[@]}" "$packageName" >/dev/null 2>&1; then
    noteInstalled "$packageName" "upgraded from $installedVersion to $availableVersion"
    return 0
  fi
  recordFailedUpgrade "$packageKind" "$packageName" "$installedVersion" "$availableVersion"
}

upgradePythonPackage() {
  [[ -n "${DOTFILES_UPGRADE:-}" ]] || return 0
  local pythonCommand="$1"
  local packageName="$2"
  local outdatedPackages
  local parsedPackages
  local outdatedName
  local installedVersion
  local availableVersion
  local queryArguments=(list --outdated --format=json)
  local upgradeArguments=(install --quiet --no-input --upgrade)
  if ! isDarwin; then
    queryArguments+=(--user)
    upgradeArguments+=(--user --break-system-packages)
  fi
  if ((hasQueriedPythonUpgrades == 0)); then
    hasQueriedPythonUpgrades=1
    if ! outdatedPackages="$("$pythonCommand" -m pip "${queryArguments[@]}" 2>/dev/null)"; then
      hasPythonUpgradeQueryFailed=1
    fi
    if ((hasPythonUpgradeQueryFailed == 0)); then
      if ! parsedPackages="$(node -e '
        for (const entry of JSON.parse(require("node:fs").readFileSync(0, "utf8"))) {
          console.log([entry.name.toLowerCase().replace(/[-_.]+/g, "-"), entry.version, entry.latest_version].join("\t"));
        }
      ' <<< "$outdatedPackages")"; then
        hasPythonUpgradeQueryFailed=1
      fi
      while IFS=$'\t' read -r outdatedName installedVersion availableVersion; do
        [[ -n "$outdatedName" ]] || continue
        outdatedPythonVersions["$outdatedName"]="$installedVersion $availableVersion"
      done <<< "${parsedPackages:-}"
    fi
  fi
  if ((hasPythonUpgradeQueryFailed == 1)); then
    recordFailedUpgrade pip "$packageName" unknown unknown
    return 0
  fi
  local normalizedName="${packageName,,}"
  normalizedName="${normalizedName//_/-}"
  normalizedName="${normalizedName//./-}"
  [[ -n "${outdatedPythonVersions[$normalizedName]:-}" ]] || return 0
  read -r installedVersion availableVersion <<< "${outdatedPythonVersions[$normalizedName]}"
  if shouldHoldUpgrade "$installedVersion" "$availableVersion"; then
    recordHeldUpgrade pip "$packageName" "$installedVersion" "$availableVersion"
    return 0
  fi
  if "$pythonCommand" -m pip "${upgradeArguments[@]}" "$packageName==$availableVersion" </dev/null >/dev/null 2>&1; then
    noteInstalled "$packageName" "upgraded from $installedVersion to $availableVersion"
    return 0
  fi
  recordFailedUpgrade pip "$packageName" "$installedVersion" "$availableVersion"
}

userNpmPrefixDirectory() {
  printf '%s\n' "$HOME/.npm-global"
}

isRoot() {
  [[ "$EUID" -eq 0 ]]
}

# runPackageManagerCommand runs sudo -n, so probing for the binary alone turns a password-wanting sudo into "install failed" naming no cause.
passwordlessSudoWorks() {
  if [[ "$passwordlessSudoProbe" == "unknown" ]]; then
    passwordlessSudoProbe=refused
    if sudo -n true >/dev/null 2>&1; then
      passwordlessSudoProbe=granted
    fi
  fi
  [[ "$passwordlessSudoProbe" == "granted" ]]
}

canInstallSystemPackages() {
  if isRoot; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  if passwordlessSudoWorks; then
    return 0
  fi
  if [[ "$passwordlessSudoProbe" != "reported" ]]; then
    passwordlessSudoProbe=reported
    noteWarned "sudo" "sudo needs a password, run sudo -v first"
  fi
  return 1
}

forgetPackageIndexRefresh() {
  aptUpdated=0
}

sandboxStubBinDirectory() {
  trustedPlatformTestPath "${DOTFILES_TEST_STUB_BIN:-}"
}

# A caller-supplied path that redirects a root write opens the same seam the stubs do, so it is honoured only inside the home the harness marked.
sandboxRedirectedPath() {
  local redirectedPath="$1"
  local productionPath="$2"
  if [[ -n "$redirectedPath" ]] && sandboxStubBinDirectory >/dev/null; then
    printf '%s\n' "$redirectedPath"
    return 0
  fi
  printf '%s\n' "$productionPath"
}

# sudo resolves a bare name against a PATH this account controls, so what runs as root is named by absolute path.
systemCommandSearchPath() {
  local stubBinDirectory
  local homebrewRoot
  local systemPath="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  stubBinDirectory="$(sandboxStubBinDirectory || true)"
  if isDarwin; then
    homebrewRoot="$(homebrewPrefix)"
    systemPath="$homebrewRoot/bin:$homebrewRoot/sbin:$systemPath"
  fi
  printf '%s\n' "${stubBinDirectory:+$stubBinDirectory:}$systemPath"
}

resolveSystemCommand() {
  (
    PATH="$(systemCommandSearchPath)"
    hash -r 2>/dev/null || true
    type -P "$1" 2>/dev/null
  )
}

# sudo -n, so an unattended converge fails into a caller's warning instead of a prompt.
runPackageManagerCommand() {
  local commandPath
  commandPath="$(resolveSystemCommand "$1")"
  if [[ -z "$commandPath" ]]; then
    return 127
  fi
  shift
  if isRoot; then
    "$commandPath" "$@"
    return $?
  fi
  sudo -n "$commandPath" "$@"
}

# An unattended converge must not sit on a credential prompt no carbon unit will answer, and ssh has prompts of its own that GIT_TERMINAL_PROMPT does not reach.
runBatchNetworkCommand() {
  local batchSshCommand="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  GIT_TERMINAL_PROMPT=0 \
    GIT_SSH_COMMAND="$batchSshCommand" \
    "$@" < /dev/null
}

runGitNetworkCommand() {
  runBatchNetworkCommand git "$@"
}

brewCommandPath() {
  local pathCommand
  pathCommand="$(command -v brew 2>/dev/null || true)"
  if [[ -n "$pathCommand" ]]; then
    printf '%s\n' "$pathCommand"
    return 0
  fi
  if ! isDarwin; then
    return 1
  fi
  pathCommand="$(homebrewPrefix)/bin/brew"
  if [[ ! -x "$pathCommand" ]]; then
    return 1
  fi
  printf '%s\n' "$pathCommand"
}

detectPackageManager() {
  if [[ -n "$detectedPackageManager" ]]; then
    printf '%s\n' "$detectedPackageManager"
    return 0
  fi
  local candidateManager
  if isDarwin && brewCommandPath >/dev/null; then
    detectedPackageManager="brew"
    printf '%s\n' "$detectedPackageManager"
    return 0
  fi
  for candidateManager in apt-get dnf pacman zypper brew; do
    if command -v "$candidateManager" >/dev/null 2>&1; then
      detectedPackageManager="$candidateManager"
      printf '%s\n' "$detectedPackageManager"
      return 0
    fi
  done
  return 1
}

# packagekitd and unattended-upgrades hold the dpkg lock for minutes; apt fails rather than wait.
installSystemPackages() {
  local manager="$1"
  shift
  local outputSink="${packageInstallLog:-/dev/null}"
  case "$manager" in
    apt-get)
      if ((aptUpdated == 0)); then
        if ! runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" update >>"$outputSink" 2>&1; then
          return 1
        fi
        aptUpdated=1
      fi
      runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" install -y "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    dnf)
      runPackageManagerCommand dnf install -y "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    pacman)
      runPackageManagerCommand pacman -S --noconfirm --needed "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    zypper)
      runPackageManagerCommand zypper --non-interactive install "$@" >>"$outputSink" 2>&1
      return $?
      ;;
    brew)
      local brewCommand
      brewCommand="$(brewCommandPath || true)"
      if [[ -z "$brewCommand" ]]; then
        return 1
      fi
      "$brewCommand" install "$@" >>"$outputSink" 2>&1
      return $?
      ;;
  esac
  return 1
}

withPackageInstallLog() {
  local packageInstallLog="$1"
  shift
  local commandStatus=0
  "$@" || commandStatus=$?
  return "$commandStatus"
}

installSystemPackagesLogged() {
  local manager="$1"
  shift
  local scopedInstallLog
  local installStatus=0
  scopedInstallLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-install-log.XXXXXX")"
  withPackageInstallLog "$scopedInstallLog" installSystemPackages "$manager" "$@" \
    || installStatus=$?
  if ((installStatus != 0)); then
    lastPackageInstallFailure="$(lastLogLine "$scopedInstallLog")"
  fi
  rm -f -- "$scopedInstallLog"
  return "$installStatus"
}

removeAptPackageWithoutDependents() {
  local packageName="$1"
  local logPath="$2"
  local additionalRemovalPackages=()
  local removalPlan
  if ! removalPlan="$(runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" -s remove "$packageName" 2>&1)"; then
    printf '%s\n' "$removalPlan" >> "$logPath"
    return 1
  fi
  printf '%s\n' "$removalPlan" >> "$logPath"
  mapfile -t additionalRemovalPackages < <(
    awk -v wantedPackage="$packageName" \
      '$1 == "Remv" { split($2, packageParts, ":"); if (packageParts[1] != wantedPackage) print $2 }' \
      <<< "$removalPlan"
  )
  if ((${#additionalRemovalPackages[@]} > 0)); then
    printf 'refusing to remove %s because apt would also remove: %s\n' \
      "$packageName" "${additionalRemovalPackages[*]}" >> "$logPath"
    return 1
  fi
  runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" \
    remove -y "$packageName" >> "$logPath" 2>&1
}

# The lock timeout cannot reach a third-party installer's own apt-get, so block for it first.
waitForPackageManagerLock() {
  local manager
  if ! manager="$(detectPackageManager)"; then
    return 0
  fi
  if [[ "$manager" != "apt-get" ]]; then
    return 0
  fi
  if ! canInstallSystemPackages; then
    return 0
  fi
  runPackageManagerCommand apt-get -o DPkg::Lock::Timeout="$dpkgLockWaitSeconds" check >/dev/null 2>&1 || true
}

lastLogLine() {
  local logPath="$1"
  grep -v '^[[:space:]]*$' "$logPath" 2>/dev/null | tail -n 1 | cut -c1-100
}

refreshSessionPath() {
  local homebrewBin
  local homebrewSbin
  local userLocalBin="$HOME/.local/bin"
  local npmGlobalBin
  npmGlobalBin="$(userNpmPrefixDirectory)/bin"
  if isDarwin; then
    homebrewBin="$(homebrewPrefix)/bin"
    homebrewSbin="$(homebrewPrefix)/sbin"
    if [[ -d "$homebrewSbin" && ":$PATH:" != *":$homebrewSbin:"* ]]; then
      PATH="$homebrewSbin:$PATH"
    fi
    if [[ -d "$homebrewBin" && ":$PATH:" != *":$homebrewBin:"* ]]; then
      PATH="$homebrewBin:$PATH"
    fi
  fi
  if [[ -d "$userLocalBin" && ":$PATH:" != *":$userLocalBin:"* ]]; then
    PATH="$userLocalBin:$PATH"
  fi
  if [[ -d "$npmGlobalBin" && ":$PATH:" != *":$npmGlobalBin:"* ]]; then
    PATH="$npmGlobalBin:$PATH"
  fi
  export PATH
  hash -r 2>/dev/null || true
}

# Appending to an unterminated last line splices the export onto it.
appendLineToBashrc() {
  local label="$1"
  local exportLine="$2"
  local bashrcPath="$HOME/.bashrc"
  local resolvedPath
  if [[ -L "$bashrcPath" ]]; then
    resolvedPath="$(readlink -f -- "$bashrcPath" 2>/dev/null || true)"
    if [[ "$resolvedPath" != "$HOME/"* ]]; then
      noteWarned "$label" "~/.bashrc resolves outside the home directory, add it by hand"
      return 1
    fi
  fi
  terminateFinalLine "$bashrcPath"
  printf '%s\n' "$exportLine" >> "$bashrcPath"
}

# Pop!_OS ~/.profile adds ~/.local/bin only if it existed at login; installers create it later.
persistUserLocalBinOnPath() {
  if [[ -f "$HOME/.bashrc" ]] && grep -q '\.local/bin' "$HOME/.bashrc"; then
    return 0
  fi
  if ! appendLineToBashrc "~/.bashrc PATH" 'export PATH="$HOME/.local/bin:$PATH"'; then
    return 0
  fi
  noteApplied "~/.bashrc PATH" "added ~/.local/bin"
}

packageNamesForTool() {
  local manager="$1"
  local toolKey="$2"
  case "$toolKey:$manager" in
    git:apt-get | git:dnf | git:pacman | git:zypper | git:brew)
      printf 'git\n'
      return 0
      ;;
    ripgrep:apt-get | ripgrep:dnf | ripgrep:pacman | ripgrep:zypper | ripgrep:brew)
      printf 'ripgrep\n'
      return 0
      ;;
    ffmpeg:apt-get | ffmpeg:pacman | ffmpeg:brew)
      printf 'ffmpeg\n'
      return 0
      ;;
    ffmpeg:dnf)
      printf 'ffmpeg-free\n'
      return 0
      ;;
    bash-completion:apt-get | bash-completion:dnf | bash-completion:pacman | bash-completion:zypper)
      printf 'bash-completion\n'
      return 0
      ;;
    bash-completion:brew)
      printf 'bash-completion@2\n'
      return 0
      ;;
    node:apt-get | node:dnf | node:pacman | node:zypper)
      printf 'nodejs\nnpm\n'
      return 0
      ;;
    node:brew)
      printf 'node\n'
      return 0
      ;;
    python:apt-get | python:dnf | python:zypper)
      printf 'python3\npython3-pip\n'
      return 0
      ;;
    python:pacman)
      printf 'python\npython-pip\n'
      return 0
      ;;
    python:brew)
      printf 'python3\n'
      return 0
      ;;
    gh:apt-get | gh:dnf)
      printf 'gh\n'
      return 0
      ;;
    gh:pacman)
      printf 'github-cli\n'
      return 0
      ;;
    gh:brew)
      printf 'gh\n'
      return 0
      ;;
    vscodium:brew | tailscale:brew | ghostty:brew)
      printf '%s\n' '--cask' "${toolKey/tailscale/tailscale-app}"
      return 0
      ;;
    solaar:apt-get)
      printf 'solaar\n'
      return 0
      ;;
    ratbagd:apt-get)
      printf 'ratbagd\n'
      return 0
      ;;
    piper:apt-get)
      printf 'piper\n'
      return 0
      ;;
    ghostty:apt-get | ghostty:pacman)
      printf 'ghostty\n'
      return 0
      ;;
    flameshot:apt-get | flameshot:dnf | flameshot:pacman | flameshot:zypper)
      printf 'flameshot\n'
      return 0
      ;;
    wl-clipboard:apt-get | wl-clipboard:dnf | wl-clipboard:pacman | wl-clipboard:zypper)
      printf 'wl-clipboard\n'
      return 0
      ;;
    ydotool:apt-get)
      printf 'ydotool\n'
      return 0
      ;;
    ydotoold:apt-get)
      printf 'ydotoold\n'
      return 0
      ;;
    ydotool:dnf | ydotool:pacman | ydotool:zypper | ydotoold:dnf | ydotoold:pacman | ydotoold:zypper)
      printf 'ydotool\n'
      return 0
      ;;
  esac
  return 1
}

pythonCommandName() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    local pythonSearchPath="/usr/local/bin:/usr/bin:/bin"
    if isDarwin; then
      pythonSearchPath="$(homebrewPrefix)/bin:$pythonSearchPath"
    fi
    (
      PATH="$pythonSearchPath"
      hash -r 2>/dev/null || true
      type -P python3 2>/dev/null
    )
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    printf 'python\n'
    return 0
  fi
  return 1
}

pythonHasPip() {
  local pythonCommand
  if ! pythonCommand="$(pythonCommandName)"; then
    return 1
  fi
  "$pythonCommand" -m pip --version >/dev/null 2>&1
}

pythonBasePrefixIsHomebrew() {
  local pythonCommand="$1"
  local pythonBasePrefix
  pythonBasePrefix="$("$pythonCommand" -c 'import sys; print(sys.base_prefix)' 2>/dev/null)" || return 1
  [[ "$pythonBasePrefix" == "$(homebrewPrefix)/"* ]]
}

homebrewPythonCommand() {
  local homebrewPython
  homebrewPython="$(homebrewPrefix)/bin/python3"
  if [[ ! -x "$homebrewPython" ]]; then
    return 1
  fi
  printf '%s\n' "$homebrewPython"
}

nodeMajorVersion() {
  local versionText
  if ! versionText="$(node -v 2>/dev/null)"; then
    return 1
  fi
  versionText="${versionText#v}"
  versionText="${versionText%%.*}"
  if [[ ! "$versionText" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$versionText"
}

isVersionAtLeast() {
  local installedVersion="$1"
  local minimumVersion="$2"
  if [[ ! "$installedVersion" =~ ^[0-9]+(\.[0-9]+)*$ || ! "$minimumVersion" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
    return 1
  fi
  local installedComponents=()
  local minimumComponents=()
  IFS=. read -r -a installedComponents <<< "$installedVersion"
  IFS=. read -r -a minimumComponents <<< "$minimumVersion"
  local componentIndex
  local installedComponent
  local minimumComponent
  for ((componentIndex = 0; componentIndex < ${#installedComponents[@]} || componentIndex < ${#minimumComponents[@]}; componentIndex++)); do
    installedComponent="${installedComponents[$componentIndex]:-0}"
    minimumComponent="${minimumComponents[$componentIndex]:-0}"
    if ((10#$installedComponent > 10#$minimumComponent)); then
      return 0
    fi
    if ((10#$installedComponent < 10#$minimumComponent)); then
      return 1
    fi
  done
  return 0
}

# The commit skill is TypeScript node runs by stripping types, stable only since 22.18.
nodeIsCurrentEnough() {
  local installedNodeVersion
  if ! installedNodeVersion="$(node -v 2>/dev/null)"; then
    return 1
  fi
  isVersionAtLeast "${installedNodeVersion#v}" "$minimumNodeMajor.$minimumNodeMinor"
}

# A python without pip cannot install ruff, which the validate-file hook needs, so pip counts.
toolIsPresent() {
  local toolKey="$1"
  local commandName="$2"
  if [[ "$toolKey" == "python" ]]; then
    if ! pythonHasPip; then
      return 1
    fi
    if ! isDarwin; then
      return 0
    fi
    local pythonCommand
    pythonCommand="$(homebrewPythonCommand)" || pythonCommand="$(pythonCommandName)" || return 1
    pythonBasePrefixIsHomebrew "$pythonCommand"
    return $?
  fi
  if [[ "$toolKey" == "bash-completion" ]]; then
    local completionScriptPath
    if isDarwin; then
      completionScriptPath="$(homebrewPrefix)/etc/profile.d/bash_completion.sh"
      [[ -f "$completionScriptPath" ]]
      return $?
    fi
    completionScriptPath="$(sandboxRedirectedPath "${DOTFILES_TEST_BASH_COMPLETION_PATH:-}" \
      /usr/share/bash-completion/bash_completion)"
    [[ -f "$completionScriptPath" ]]
    return $?
  fi
  if [[ "$toolKey" == "node" ]]; then
    nodeIsCurrentEnough
    return $?
  fi
  if [[ "$toolKey" == "vscodium" ]] && isDarwin; then
    if command -v "$commandName" >/dev/null 2>&1; then
      return 0
    fi
    [[ -x "$(codiumBundleBinDirectory)/codium" ]]
    return $?
  fi
  if [[ "$toolKey" == "tailscale" ]] && isDarwin; then
    [[ -x "$(tailscaleBundleCliPath)" ]]
    return $?
  fi
  if [[ "$toolKey" == "ghostty" ]] && isDarwin; then
    [[ -x "$(ghosttyBundleCliPath)" ]]
    return $?
  fi
  command -v "$commandName" >/dev/null 2>&1
}

installPackageTool() {
  local label="$1"
  local commandName="$2"
  local toolKey="$3"
  local manualSource="${4:-}"
  local manualHint="install manually"
  if [[ -n "$manualSource" ]]; then
    manualHint="install from $manualSource"
  fi
  local manager
  local packageNameArgs=()
  refreshSessionPath
  if toolIsPresent "$toolKey" "$commandName"; then
    notePresent "$label" "already installed"
    if [[ -n "${DOTFILES_UPGRADE:-}" ]] && manager="$(detectPackageManager)" && [[ "$manager" == brew ]]; then
      mapfile -t packageNameArgs < <(packageNamesForTool "$manager" "$toolKey" || true)
      if [[ "${packageNameArgs[0]:-}" == --cask ]]; then
        upgradeBrewPackage cask "${packageNameArgs[1]}"
        return 0
      fi
      local packageName
      for packageName in "${packageNameArgs[@]}"; do
        upgradeBrewPackage formula "$packageName"
      done
    fi
    return 0
  fi
  if ! manager="$(detectPackageManager)"; then
    noteWarned "$label" "no supported package manager, $manualHint"
    return 0
  fi
  mapfile -t packageNameArgs < <(packageNamesForTool "$manager" "$toolKey" || true)
  if ((${#packageNameArgs[@]} == 0)); then
    noteWarned "$label" "not available via $manager, $manualHint"
    return 0
  fi
  if [[ "$manager" != "brew" ]] && ! canInstallSystemPackages; then
    noteWarned "$label" "$manager needs root or sudo, $manualHint"
    return 0
  fi
  noteStarting "$label" "installing via $manager"
  if ! installSystemPackages "$manager" "${packageNameArgs[@]}"; then
    noteWarned "$label" "$manager install failed, $manualHint"
    return 0
  fi
  refreshSessionPath
  if toolIsPresent "$toolKey" "$commandName"; then
    noteInstalled "$label" "installed"
    return 0
  fi
  noteWarned "$label" "installed, but open a new shell for PATH"
}

# The script lands on disk first, so nothing pipes the network straight into a root shell.
installFromVendorScript() {
  local label="$1"
  local interpreterCommand="$2"
  local scriptUrl="$3"
  local outputLog="$4"
  local runPrivileged="${5:-0}"
  local scriptPath
  local runner=()
  if ! command -v curl >/dev/null 2>&1; then
    noteWarned "$label" "curl not on PATH, install manually"
    return 1
  fi
  if ((runPrivileged == 1)) && ! canInstallSystemPackages; then
    noteWarned "$label" "needs root or sudo, install manually"
    return 1
  fi
  scriptPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-vendor-install.XXXXXX")"
  if ! curl -fsSL "$scriptUrl" -o "$scriptPath" >>"$outputLog" 2>&1; then
    noteWarned "$label" "installer download failed: $(lastLogLine "$outputLog")"
    rm -f -- "$scriptPath"
    return 1
  fi
  runner=("$interpreterCommand" "$scriptPath")
  if ((runPrivileged == 1)); then
    runner=(runPackageManagerCommand "$interpreterCommand" "$scriptPath")
  fi
  if ! "${runner[@]}" >>"$outputLog" 2>&1; then
    noteWarned "$label" "installer failed: $(lastLogLine "$outputLog")"
    rm -f -- "$scriptPath"
    return 1
  fi
  rm -f -- "$scriptPath"
}

# Only a leading # opens a comment; a later one is a git ref in an npm spec.
readPackageList() {
  local listPath="$1"
  if [[ ! -f "$listPath" ]]; then
    return 0
  fi
  sed '1s/^\xEF\xBB\xBF//' "$listPath" | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'
}

npmPackageName() {
  local packageEntry="${1%%>=*}"
  if [[ "$packageEntry" == *=* ]]; then
    printf '%s\n' "${packageEntry%%=*}"
    return 0
  fi
  printf '%s\n' "$packageEntry"
}

npmPackageSource() {
  local packageEntry="${1%%>=*}"
  if [[ "$packageEntry" == *=* ]]; then
    printf '%s\n' "${packageEntry#*=}"
    return 0
  fi
  if [[ "$1" == *'>='* ]]; then
    printf '%s@latest\n' "$packageEntry"
    return 0
  fi
  printf '%s\n' "$packageEntry"
}

npmPackageMinimumVersion() {
  local packageEntry="$1"
  if [[ "$packageEntry" != *'>='* ]]; then
    return 0
  fi
  printf '%s\n' "${packageEntry##*>=}"
}

listGlobalNpmPackages() {
  # only lines the strip shortened: the first parseable line is the global root itself
  npm ls -g --depth=0 --parseable 2>/dev/null |
    awk '{ packagePath = $0; if (sub(/^.*node_modules[\\\/]/, "")) { gsub(/\\/, "/"); print $0 "\t" packagePath } }' |
    node -e '
      const filesystem = require("node:fs");
      const installedPackages = filesystem.readFileSync(0, "utf8").split("\n").filter(Boolean);
      for (const installedPackage of installedPackages) {
        const [packageName, packagePath] = installedPackage.split("\t");
        const manifestPath = `${packagePath}/package.json`;
        const manifest = filesystem.existsSync(manifestPath) ? JSON.parse(filesystem.readFileSync(manifestPath, "utf8")) : {};
        console.log(`${packageName}\t${manifest.version ?? ""}`);
      }
    '
}

npmGlobalRootWritable() {
  local npmGlobalRoot
  npmGlobalRoot="$(npm root -g 2>/dev/null || true)"
  if [[ -z "$npmGlobalRoot" ]]; then
    return 1
  fi
  if [[ -d "$npmGlobalRoot" ]]; then
    [[ -w "$npmGlobalRoot" ]]
    return $?
  fi
  local npmGlobalRootParent
  npmGlobalRootParent="$(dirname -- "$npmGlobalRoot")"
  [[ -d "$npmGlobalRootParent" && -w "$npmGlobalRootParent" ]]
}

currentNpmPrefix() {
  npm config get prefix 2>/dev/null | head -n 1 | tr -d '\r' || true
}

recordNpmPrefixOnLoginPath() {
  if [[ -f "$HOME/.bashrc" ]] && grep -q '\.npm-global/bin' "$HOME/.bashrc"; then
    return 0
  fi
  appendLineToBashrc "npm prefix PATH" 'export PATH="$HOME/.npm-global/bin:$PATH"' || true
}

# npm under sudo breaks native lifecycle builds (node-pty dies with uv_cwd ENOENT).
ensureUserNpmPrefix() {
  if ((userNpmPrefixEnsured == 1)); then
    return 0
  fi
  userNpmPrefixEnsured=1
  if isRoot; then
    return 0
  fi
  local wantedPrefix
  wantedPrefix="$(userNpmPrefixDirectory)"
  if [[ "$(currentNpmPrefix)" == "$wantedPrefix" ]]; then
    mkdir -p -- "$wantedPrefix/bin"
    recordNpmPrefixOnLoginPath
    refreshSessionPath
    return 0
  fi
  if npmGlobalRootWritable; then
    return 0
  fi
  if ! npm config set prefix "$wantedPrefix" >/dev/null 2>&1; then
    noteWarned "npm prefix" "npm config set prefix failed, global installs may hit EACCES"
    return 0
  fi
  mkdir -p -- "$wantedPrefix/bin"
  recordNpmPrefixOnLoginPath
  refreshSessionPath
  noteApplied "npm prefix" "global root not writable, using ~/.npm-global"
}

# A git spec runs its postinstall in a directory npm already moved (ENOENT uv_cwd), so pack first.
installGlobalNpmPackage() {
  local packageSource="$1"
  if [[ "$packageSource" != github:* && "$packageSource" != git+* && "$packageSource" != git:* ]]; then
    runBatchNetworkCommand npm install -g "$packageSource" --loglevel=error
    return $?
  fi
  local packDirectory
  local tarballPath
  local installStatus
  packDirectory="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-npm-pack.XXXXXX")"
  if ! (cd "$packDirectory" && runBatchNetworkCommand npm pack "$packageSource" --loglevel=error >/dev/null); then
    rm -rf -- "$packDirectory"
    return 1
  fi
  tarballPath="$(find "$packDirectory" -maxdepth 1 -name '*.tgz' | head -n 1)"
  if [[ -z "$tarballPath" ]]; then
    rm -rf -- "$packDirectory"
    return 1
  fi
  installStatus=0
  runBatchNetworkCommand npm install -g "$tarballPath" --loglevel=error || installStatus=$?
  rm -rf -- "$packDirectory"
  return $installStatus
}

npmFailureReason() {
  local npmLogPath="$1"
  local reason
  reason="$(grep -E -m1 'EACCES|EPERM|E404|ENOTFOUND|EAI_AGAIN|uv_cwd|code E' "$npmLogPath" 2>/dev/null || true)"
  if [[ -z "$reason" ]]; then
    reason="$(grep -v 'A complete log of this run' "$npmLogPath" 2>/dev/null | awk 'NF { line = $0 } END { print line }')"
  fi
  reason="$(sed -E 's/^npm (error|ERR!) //' <<< "$reason")"
  printf '%.120s\n' "$reason"
}
