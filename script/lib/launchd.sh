# shellcheck shell=bash

launchAgentPendingStateName() {
  printf 'launchd-%s-pending\n' "$1"
}

launchAgentIsLoaded() {
  local domain="$1"
  local label="$2"
  launchctl print "$domain/$label" >/dev/null 2>&1
}

# The converge topic runs inside this agent, so booting it out here kills the run before it can bootstrap it again.
runningInsideLaunchAgent() {
  local agentLabel="$1"
  if [[ "${DOTFILES_CONVERGE_AGENT:-}" == "1" ]]; then
    return 0
  fi
  [[ "${XPC_SERVICE_NAME:-}" == "$agentLabel" ]]
}

installLaunchAgent() {
  local noteLabel="$1"
  local agentLabel="$2"
  local plistPath="$3"
  local plistChanged="$4"
  local domain
  local pendingState
  local wasLoaded=0
  domain="gui/$(id -u)"
  pendingState="$(launchAgentPendingStateName "$agentLabel")"
  if launchAgentIsLoaded "$domain" "$agentLabel"; then
    wasLoaded=1
  fi
  if dotfilesStateIsPending "$pendingState"; then
    plistChanged=1
  fi
  if ((plistChanged == 1 || wasLoaded == 0)); then
    markDotfilesStatePending "$pendingState"
  fi
  if ((plistChanged == 0 && wasLoaded == 1)); then
    clearDotfilesState "$pendingState"
    notePresent "$noteLabel" "loaded"
    return 0
  fi
  if runningInsideLaunchAgent "$agentLabel"; then
    noteWarned "$noteLabel" "reload owed, run dot by hand to reload it"
    return 1
  fi
  if ((wasLoaded == 1)) && ! launchctl bootout "$domain" "$plistPath" >/dev/null 2>&1; then
    noteWarned "$noteLabel" "launchctl bootout failed"
    return 1
  fi
  if ! launchctl bootstrap "$domain" "$plistPath" >/dev/null 2>&1; then
    noteWarned "$noteLabel" "launchctl bootstrap failed"
    return 1
  fi
  clearDotfilesState "$pendingState"
  if ((wasLoaded == 1)); then
    noteApplied "$noteLabel" "reloaded"
    return 0
  fi
  noteApplied "$noteLabel" "loaded"
}
