#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

installLinearMouseCask() {
  local brewCommand
  if [[ -d "$(applicationsDirectory)/LinearMouse.app" ]]; then
    notePresent "LinearMouse" "already installed"
    return 0
  fi
  brewCommand="$(brewCommandPath || true)"
  if [[ -z "$brewCommand" ]]; then
    noteWarned "LinearMouse" "Homebrew not on PATH, install manually"
    return 0
  fi
  if "$brewCommand" list --cask linearmouse >/dev/null 2>&1; then
    notePresent "LinearMouse" "already installed"
    return 0
  fi
  noteStarting "LinearMouse" "installing via Homebrew"
  if installSystemPackages brew --cask linearmouse; then
    noteInstalled "LinearMouse" "installed"
    return 0
  fi
  noteWarned "LinearMouse" "Homebrew install failed"
}

renderLinearMouseLaunchAgent() {
  local destination="$HOME/Library/LaunchAgents/dev.dotfiles.linearmouse.plist"
  local stagedPath
  mkdir -p -- "$(dirname -- "$destination")"
  clearDestinationIfNotPlainFile "LinearMouse launch agent" "$destination" || return 2
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-launch-agent.XXXXXX")"
  cat -- "$dotfilesRepo/peripherals/dev.dotfiles.linearmouse.plist" > "$stagedPath"
  if commitRenderedFile "LinearMouse launch agent" "$stagedPath" "$destination"; then
    chmod 600 "$destination"
    noteApplied "LinearMouse launch agent" "rendered"
    return 0
  fi
  chmod 600 "$destination"
  notePresent "LinearMouse launch agent" "rendered"
  return 1
}

installDarwinLinearMouse() {
  local plistPath="$HOME/Library/LaunchAgents/dev.dotfiles.linearmouse.plist"
  local renderStatus=0
  local plistChanged=0
  installLinearMouseCask
  linkEntry "LinearMouse config" "peripherals/linearmouse.json" \
    "$HOME/.config/linearmouse/linearmouse.json"
  renderLinearMouseLaunchAgent || renderStatus=$?
  if ((renderStatus == 2)); then
    return 1
  fi
  if ((renderStatus == 0)); then
    plistChanged=1
  fi
  installLaunchAgent "LinearMouse launch agent" "dev.dotfiles.linearmouse" \
    "$plistPath" "$plistChanged"
}

if isDarwin; then
  # shellcheck source=../script/lib/launchd.sh
  source "$dotfilesRepo/script/lib/launchd.sh"
  installDarwinLinearMouse
  finishTopic
fi

headsetControlTag="4.1.0"
headsetControlCommit="a6e15cc8bc701a9c4dab8ae4e33363f3040628e9"
# A root owned path this overwrites, so a test run inside a marked sandbox home points it elsewhere; outside one the redirect is ignored.
headsetControlRulesPath="$(sandboxRedirectedPath "${DOTFILES_HEADSET_RULES_PATH:-}" /etc/udev/rules.d/70-headset.rules)"
# The rule lands as root, so what is still owed on it is tracked in this account's state.
headsetRulesPendingState="peripherals-headset-udev-pending"

runStepOrWarn() {
  local label="$1"
  local reason="$2"
  local logPath="$3"
  shift 3
  if "$@" >>"$logPath" 2>&1; then
    return 0
  fi
  noteWarned "$label" "$reason: $(lastLogLine "$logPath")"
  return 1
}

installLogitechTools() {
  local solaarWasPresent=0
  if command -v solaar >/dev/null 2>&1; then
    solaarWasPresent=1
  fi
  installPackageTool "Solaar" "solaar" "solaar"
  if ((solaarWasPresent == 0)) && command -v solaar >/dev/null 2>&1; then
    noteDetail "Solaar" "replug the receiver, its udev rule fires only on device add"
  fi
  installPackageTool "ratbagd" "ratbagd" "ratbagd"
  installPackageTool "Piper" "piper" "piper"
}

installHeadsetControlBuildDeps() {
  local manager
  if ! manager="$(detectPackageManager)"; then
    noteWarned "headsetcontrol" "no supported package manager, install build deps manually"
    return 1
  fi
  if [[ "$manager" != "apt-get" ]]; then
    noteWarned "headsetcontrol" "build deps not mapped for $manager"
    return 1
  fi
  if ! canInstallSystemPackages; then
    noteWarned "headsetcontrol" "$manager needs root or sudo, install manually"
    return 1
  fi
  noteStarting "headsetcontrol" "installing build deps via $manager"
  if installSystemPackagesLogged "$manager" cmake libhidapi-dev pkg-config build-essential; then
    return 0
  fi
  noteWarned "headsetcontrol" "build deps failed: $lastPackageInstallFailure"
  return 1
}

# What gets built here is installed as root, so an unpinned HEAD is not good enough.
cloneHeadsetControlRelease() {
  local cloneDirectory="$1"
  local buildLog="$2"
  local clonedCommit
  if ! runStepOrWarn "headsetcontrol" "clone failed" "$buildLog" \
    runGitNetworkCommand clone --quiet --depth 1 --branch "$headsetControlTag" \
    https://github.com/Sapd/HeadsetControl.git "$cloneDirectory"; then
    return 1
  fi
  clonedCommit="$(git -C "$cloneDirectory" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$clonedCommit" == "$headsetControlCommit" ]]; then
    return 0
  fi
  noteWarned "headsetcontrol" \
    "$headsetControlTag is $clonedCommit, not the recorded $headsetControlCommit"
  return 1
}

# The rules path is root owned and caller named, so anything not a plain file is left alone and a differing one is copied aside first.
headsetRulesDestinationIsWritable() {
  pathIsPlainFileOrAbsent "$headsetControlRulesPath"
}

backupExistingHeadsetRules() {
  local rulesLog="$1"
  local backupPath
  if [[ ! -f "$headsetControlRulesPath" ]]; then
    return 0
  fi
  backupPath="$(nextBackupPath "$headsetControlRulesPath")"
  if ! runStepOrWarn "headsetcontrol udev" "rules backup failed" "$rulesLog" \
    runPackageManagerCommand cp -p -- "$headsetControlRulesPath" "$backupPath"; then
    return 1
  fi
  noteApplied "headsetcontrol udev backup" "saved $(basename -- "$backupPath")"
}

markHeadsetRulesPending() {
  markDotfilesStatePending "$headsetRulesPendingState"
}

clearHeadsetRulesPending() {
  clearDotfilesState "$headsetRulesPendingState"
}

# Matching bytes prove the file landed, never that udev was told about it.
headsetRulesReloadIsPending() {
  dotfilesStateIsPending "$headsetRulesPendingState"
}

reloadHeadsetRules() {
  local rulesLog="$1"
  if ! runStepOrWarn "headsetcontrol udev" "reload failed" "$rulesLog" \
    runPackageManagerCommand udevadm control --reload-rules; then
    return 1
  fi
  runStepOrWarn "headsetcontrol udev" "trigger failed" "$rulesLog" \
    runPackageManagerCommand udevadm trigger
}

# A first run can install the binary and still fail at the rule, so every run rechecks it.
# The generated rules are installed as root, so the generator is the packaged binary rather than whatever this account's PATH found first.
trustedHeadsetControlPath() {
  local candidateDirectory
  local candidatePath
  local candidateDirectories=(/usr/local/bin /usr/bin)
  local stubBinDirectory
  if stubBinDirectory="$(sandboxStubBinDirectory)"; then
    candidateDirectories=("$stubBinDirectory" "${candidateDirectories[@]}")
  fi
  for candidateDirectory in "${candidateDirectories[@]}"; do
    candidatePath="$candidateDirectory/headsetcontrol"
    if [[ -x "$candidatePath" ]]; then
      printf '%s\n' "$candidatePath"
      return 0
    fi
  done
  return 1
}

# A rule that runs a program turns any matching device event into root code execution; this generator emits none.
generatedRulesRunNothing() {
  ! grep -Eqw -- 'RUN|PROGRAM|IMPORT|OWNER|GROUP' "$1"
}

ensureHeadsetControlUdevRules() {
  local binaryPath
  local rulesFile
  local rulesLog
  if ! command -v udevadm >/dev/null 2>&1; then
    noteWarned "headsetcontrol udev" "udevadm not on PATH, skipping rules"
    return 0
  fi
  if ! binaryPath="$(trustedHeadsetControlPath)"; then
    noteWarned "headsetcontrol udev" \
      "no headsetcontrol in /usr/local/bin or /usr/bin, rules skipped"
    return 0
  fi
  rulesFile="$(mktemp "${TMPDIR:-/tmp}/dotfiles-headsetcontrol-rules.XXXXXX")"
  rulesLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-headsetcontrol-udev.XXXXXX")"
  if ! "$binaryPath" -u > "$rulesFile" 2> "$rulesLog" || [[ ! -s "$rulesFile" ]]; then
    noteWarned "headsetcontrol udev" "rules generation failed: $(lastLogLine "$rulesLog")"
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  if ! generatedRulesRunNothing "$rulesFile"; then
    noteWarned "headsetcontrol udev" \
      "generated rules name RUN, PROGRAM, IMPORT, OWNER or GROUP, refusing to install them"
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  if ! headsetRulesDestinationIsWritable; then
    noteWarned "headsetcontrol udev" \
      "not a regular file, leaving it alone: $headsetControlRulesPath"
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  if cmp -s -- "$rulesFile" "$headsetControlRulesPath" && ! headsetRulesReloadIsPending; then
    notePresent "headsetcontrol udev" "rules current"
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  if cmp -s -- "$rulesFile" "$headsetControlRulesPath"; then
    if reloadHeadsetRules "$rulesLog"; then
      clearHeadsetRulesPending
      noteApplied "headsetcontrol udev" "rules reloaded"
    fi
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  if ! backupExistingHeadsetRules "$rulesLog"; then
    rm -f -- "$rulesFile" "$rulesLog"
    return 0
  fi
  markHeadsetRulesPending
  if runStepOrWarn "headsetcontrol udev" "rules install failed" "$rulesLog" \
    runPackageManagerCommand install -m 0644 "$rulesFile" "$headsetControlRulesPath" \
    && reloadHeadsetRules "$rulesLog"; then
    clearHeadsetRulesPending
    noteApplied "headsetcontrol udev" "rules installed"
  fi
  rm -f -- "$rulesFile" "$rulesLog"
}

buildHeadsetControl() {
  local cloneDirectory
  local buildLog
  local builtHeadsetControl=0
  if ! command -v git >/dev/null 2>&1; then
    noteWarned "headsetcontrol" "git not on PATH, install manually"
    return 1
  fi
  if ! installHeadsetControlBuildDeps; then
    return 1
  fi
  refreshSessionPath
  if ! command -v cmake >/dev/null 2>&1; then
    noteWarned "headsetcontrol" "cmake not on PATH, install manually"
    return 1
  fi
  cloneDirectory="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-headsetcontrol.XXXXXX")"
  buildLog="$(mktemp "${TMPDIR:-/tmp}/dotfiles-headsetcontrol-build.XXXXXX")"
  noteStarting "headsetcontrol" "building $headsetControlTag from source"
  if cloneHeadsetControlRelease "$cloneDirectory" "$buildLog" \
    && runStepOrWarn "headsetcontrol" "configure failed" "$buildLog" \
      cmake -S "$cloneDirectory" -B "$cloneDirectory/build" -DCMAKE_BUILD_TYPE=Release \
    && runStepOrWarn "headsetcontrol" "build failed" "$buildLog" \
      cmake --build "$cloneDirectory/build" \
    && runStepOrWarn "headsetcontrol" "install failed" "$buildLog" \
      runPackageManagerCommand cmake --install "$cloneDirectory/build"; then
    builtHeadsetControl=1
  fi
  rm -rf -- "$cloneDirectory"
  rm -f -- "$buildLog"
  ((builtHeadsetControl == 1))
}

installHeadsetControl() {
  refreshSessionPath
  if command -v headsetcontrol >/dev/null 2>&1; then
    notePresent "headsetcontrol" "already installed"
    ensureHeadsetControlUdevRules
    return 0
  fi
  if ! buildHeadsetControl; then
    return 0
  fi
  refreshSessionPath
  if ! command -v headsetcontrol >/dev/null 2>&1; then
    noteWarned "headsetcontrol" "installed, but open a new shell for PATH"
    return 0
  fi
  noteInstalled "headsetcontrol" "installed"
  ensureHeadsetControlUdevRules
}

installLogitechTools
installHeadsetControl

finishTopic
