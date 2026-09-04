#!/usr/bin/env bash
# The timer is the one converge that runs outside glissa's cgroup, so it is what pays a restart a hosted run left owed.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/systemd.sh
source "$dotfilesRepo/script/lib/systemd.sh"

systemdUserDirectory="$HOME/.config/systemd/user"

linkConvergeUnitAndReportChange() {
  local unitFileName="$1"
  local unitDestination="$systemdUserDirectory/$unitFileName"
  local linkOutcome=""
  linkEntry "$unitFileName" "converge/$unitFileName" "$unitDestination" linkOutcome
  if [[ "$linkOutcome" == "changed" ]]; then
    return 0
  fi
  if linkedUnitContentChanged "$unitDestination"; then
    return 0
  fi
  return 1
}

installConvergeTimer() {
  local label="converge timer"
  local unitChanged=0
  if linkConvergeUnitAndReportChange "dotfiles-converge.service"; then
    unitChanged=1
  fi
  if linkConvergeUnitAndReportChange "dotfiles-converge.timer"; then
    unitChanged=1
  fi
  if ! userServiceManagerIsReachable; then
    noteWarned "$label" "units linked, systemctl --user unavailable"
    return 0
  fi
  if ! enableUserService "$label" "dotfiles-converge.timer" "$unitChanged"; then
    return 0
  fi
  recordLinkedUnitContent "$systemdUserDirectory/dotfiles-converge.service"
  recordLinkedUnitContent "$systemdUserDirectory/dotfiles-converge.timer"
}

installConvergeTimer

finishTopic
