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

escapeLaunchAgentXmlText() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

renderLaunchAgent() {
  local noteLabel="$1"
  local templatePath="$2"
  local destination="$3"
  local stagedPath renderedLine escapedHome escapedBrew escapedState
  escapedHome="$(escapeLaunchAgentXmlText "$HOME")"
  escapedBrew="$(escapeLaunchAgentXmlText "$(homebrewPrefix)")"
  dotfilesStateDirectory || return 2
  escapedState="$(escapeLaunchAgentXmlText "$dotfilesStateDirectoryPath")"
  mkdir -p -- "$(dirname -- "$destination")" || return 2
  clearDestinationIfNotPlainFile "$noteLabel" "$destination" || return 2
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-launch-agent.XXXXXX")" || return 2
  while IFS= read -r renderedLine || [[ -n "$renderedLine" ]]; do
    renderedLine="${renderedLine//\{\{HOME\}\}/$escapedHome}"
    renderedLine="${renderedLine//\{\{BASH\}\}/$escapedBrew/bin/bash}"
    renderedLine="${renderedLine//\{\{BREW\}\}/$escapedBrew}"
    renderedLine="${renderedLine//\{\{STATE\}\}/$escapedState}"
    printf '%s\n' "$renderedLine"
  done < "$templatePath" > "$stagedPath" || return 2
  if commitRenderedFile "$noteLabel" "$stagedPath" "$destination"; then
    chmod 600 "$destination"
    noteApplied "$noteLabel" "rendered"
    return 0
  fi
  chmod 600 "$destination"
  notePresent "$noteLabel" "rendered"
  return 1
}

installDarwinLaunchAgent() {
  local noteLabel="$1"
  local agentLabel="$2"
  local templatePath="$3"
  local plistPath="$HOME/Library/LaunchAgents/$agentLabel.plist"
  local plistChanged=0
  local renderStatus=0
  renderLaunchAgent "$noteLabel" "$templatePath" "$plistPath" || renderStatus=$?
  if ((renderStatus == 2)); then
    return 1
  fi
  if ((renderStatus == 0)); then
    plistChanged=1
  fi
  installLaunchAgent "$noteLabel" "$agentLabel" "$plistPath" "$plistChanged"
}
