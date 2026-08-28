#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"
# shellcheck source=../script/lib/systemd.sh
source "$dotfilesRepo/script/lib/systemd.sh"

installYdotooldService() {
  local label="ydotoold service"
  local serviceDestination="$HOME/.config/systemd/user/ydotoold.service"
  local serviceUnitChanged=0
  local serviceLinkOutcome=""
  linkEntry "$label" "dictation/ydotoold.service" "$serviceDestination" serviceLinkOutcome
  if [[ "$serviceLinkOutcome" == "changed" ]]; then
    serviceUnitChanged=1
  fi
  if linkedUnitContentChanged "$serviceDestination"; then
    serviceUnitChanged=1
  fi
  if ! userServiceManagerIsReachable; then
    noteWarned "$label" "unit linked, systemctl --user unavailable"
    return 0
  fi
  if ! enableUserService "$label" "ydotoold" "$serviceUnitChanged"; then
    return 0
  fi
  recordLinkedUnitContent "$serviceDestination"
}

installInputGroupMembership() {
  local accountName
  accountName="$(id -un)"
  if id -nG "$accountName" 2>/dev/null | tr ' ' '\n' | grep -qx input; then
    notePresent "input group" "already present"
    return 0
  fi
  if ! canInstallSystemPackages; then
    noteWarned "input group" "run: sudo usermod -aG input $accountName, then log out and back in"
    return 0
  fi
  if runPackageManagerCommand usermod -aG input "$accountName" >/dev/null 2>&1; then
    noteApplied "input group" "added, log out and back in"
    return 0
  fi
  noteWarned "input group" "run: sudo usermod -aG input $accountName, then log out and back in"
}

installPackageTool "ydotool" "ydotool" "ydotool"
installPackageTool "wl-clipboard" "wl-copy" "wl-clipboard"
installPackageTool "ydotoold" "ydotoold" "ydotoold"
installYdotooldService
installInputGroupMembership

finishTopic
