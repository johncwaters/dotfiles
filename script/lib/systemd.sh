# shellcheck shell=bash

userServiceManagerIsReachable() {
  systemctl --user show --property=Version >/dev/null 2>&1
}

# The unit is on disk before activation runs, so a failure leaves a marker or never retries.
userServicePendingStateName() {
  printf 'systemd-%s-pending\n' "$1"
}

markUserServicePending() {
  markDotfilesStatePending "$(userServicePendingStateName "$1")"
}

clearUserServicePending() {
  clearDotfilesState "$(userServicePendingStateName "$1")"
}

userServiceActivationIsPending() {
  dotfilesStateIsPending "$(userServicePendingStateName "$1")"
}

# A repo edit changes a symlinked unit's content without changing the link systemd was told about.
linkedUnitContentStateName() {
  printf 'systemd-%s-record\n' "$(basename -- "$1")"
}

# An unreadable unit is one this run cannot vouch for, so it counts as changed rather than aborting the topic.
unitContentIsReadable() {
  [[ -f "$1" && -r "$1" ]]
}

linkedUnitContentChanged() {
  local unitPath="$1"
  local recordedContent
  if ! unitContentIsReadable "$unitPath"; then
    return 0
  fi
  if ! recordedContent="$(readDotfilesState "$(linkedUnitContentStateName "$unitPath")")"; then
    return 0
  fi
  [[ "$recordedContent" != "$(< "$unitPath")" ]]
}

recordLinkedUnitContent() {
  local unitPath="$1"
  if ! unitContentIsReadable "$unitPath"; then
    return 0
  fi
  writeDotfilesState "$(linkedUnitContentStateName "$unitPath")" "$(< "$unitPath")"
}

# A restart issued from inside the unit's own cgroup kills the converge that issued it (KillMode=control-group), so it is handed to a detached transient unit that waits for the run to finish.
runningInsideUserService() {
  local unitName="$1"
  local cgroupFile="${DOTFILES_CGROUP_FILE:-/proc/self/cgroup}"
  [[ -r "$cgroupFile" ]] && grep -q -- "/$unitName.service" "$cgroupFile"
}

deferUserServiceRestart() {
  local unitName="$1"
  local waitForPid="${DOTFILES_BOOTSTRAP_PID:-$$}"
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemd-run --user --quiet --collect --unit "dotfiles-restart-$unitName" \
    bash -c 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; exec systemctl --user restart "$2"' \
    _ "$waitForPid" "$unitName" >/dev/null 2>&1
}

# is-enabled before is-active: a unit running but never enabled is one reboot from gone, and checking activity first would call it done.
enableUserService() {
  local label="$1"
  local unitName="$2"
  local unitChanged="$3"
  local wasEnabled=0
  local wasActive=0
  if userServiceActivationIsPending "$unitName"; then
    unitChanged=1
  fi
  if ((unitChanged == 1)); then
    markUserServicePending "$unitName"
  fi
  if ((unitChanged == 1)) && ! systemctl --user daemon-reload >/dev/null 2>&1; then
    noteWarned "$label" "systemctl --user daemon-reload failed"
    return 1
  fi
  if systemctl --user is-enabled "$unitName" >/dev/null 2>&1; then
    wasEnabled=1
  fi
  if systemctl --user is-active "$unitName" >/dev/null 2>&1; then
    wasActive=1
  fi
  if ((wasEnabled == 0)) && ! systemctl --user enable --now "$unitName" >/dev/null 2>&1; then
    noteWarned "$label" "run: systemctl --user enable --now $unitName"
    return 1
  fi
  # enable --now starts a dead unit off the current file but leaves a live one on the old one.
  if ((unitChanged == 1)) && ((wasActive == 1)); then
    if runningInsideUserService "$unitName"; then
      if ! deferUserServiceRestart "$unitName"; then
        noteWarned "$label" "this run is inside $unitName, deferred restart failed, run: systemctl --user restart $unitName"
        return 1
      fi
      clearUserServicePending "$unitName"
      noteApplied "$label" "restart deferred until this run exits (it hosts this run)"
      return 0
    fi
    if ! systemctl --user restart "$unitName" >/dev/null 2>&1; then
      noteWarned "$label" "restart failed, run: journalctl --user -u $unitName -n 20"
      return 1
    fi
    clearUserServicePending "$unitName"
    noteApplied "$label" "restarted"
    return 0
  fi
  if ((wasActive == 0)) && ((wasEnabled == 1)); then
    if ! systemctl --user start "$unitName" >/dev/null 2>&1; then
      noteWarned "$label" "start failed, run: journalctl --user -u $unitName -n 20"
      return 1
    fi
    clearUserServicePending "$unitName"
    noteApplied "$label" "started"
    return 0
  fi
  clearUserServicePending "$unitName"
  if ((wasEnabled == 0)); then
    noteApplied "$label" "enabled and started"
    return 0
  fi
  notePresent "$label" "enabled and started"
}
