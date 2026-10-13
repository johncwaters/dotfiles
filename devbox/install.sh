#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
source "$dotfilesRepo/script/lib/packages.sh"
source "$dotfilesRepo/devbox/lib.sh"
source "$dotfilesRepo/script/lib/launchd.sh"

escapeDevboxXmlText() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

renderDevboxLaunchAgent() {
  local noteLabel="$1"
  local templatePath="$2"
  local destination="$3"
  local stagedPath renderedLine escapedHome escapedBrew escapedState
  escapedHome="$(escapeDevboxXmlText "$HOME")"
  escapedBrew="$(escapeDevboxXmlText "$(homebrewPrefix)")"
  dotfilesStateDirectory || return 2
  escapedState="$(escapeDevboxXmlText "$dotfilesStateDirectoryPath")"
  mkdir -p -- "$(dirname -- "$destination")" || return 2
  clearDestinationIfNotPlainFile "$noteLabel" "$destination" || return 2
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-devbox-agent.XXXXXX")" || return 2
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

installDarwinDevboxAgent() {
  local noteLabel="$1"
  local agentLabel="$2"
  local templateName="$3"
  local plistPath="$HOME/Library/LaunchAgents/$agentLabel.plist"
  local plistChanged=0
  local renderStatus=0
  renderDevboxLaunchAgent "$noteLabel" "$dotfilesRepo/devbox/$templateName" "$plistPath" || renderStatus=$?
  if ((renderStatus == 2)); then
    return 1
  fi
  if ((renderStatus == 0)); then
    plistChanged=1
  fi
  installLaunchAgent "$noteLabel" "$agentLabel" "$plistPath" "$plistChanged"
}

installDevbox() {
  local lookupStatus=0
  resolveDevboxWorkspace || lookupStatus=$?
  if ((lookupStatus == 1)); then
    notePresent "devbox" "skipped"
    noteDetail "devbox" "$devboxSkipReason"
    return 0
  fi
  if ((lookupStatus == devboxLookupUnauthenticated)); then
    noteWarned "devbox" "$devboxSkipReason"
    return 0
  fi
  if ((lookupStatus != 0)); then
    noteWarned "devbox" "workspace lookup failed"
    return 0
  fi
  if [[ "$devboxWorkspaceStatus" != running ]]; then
    notePresent "devbox" "skipped; $devboxWorkspaceName is $devboxWorkspaceStatus"
    noteDetail "devbox" "run devbox up when needed"
    return 0
  fi
  local provisionOutput
  if provisionOutput="$(provisionDevbox)"; then
    printf '%s\n' "$provisionOutput"
    if [[ "$provisionOutput" == *'[warned]'* ]]; then
      noteWarned "devbox" "$devboxWorkspaceName needs attention; see [warned] lines"
      return 0
    fi
    if [[ "$provisionOutput" == *'[installed]'* ]]; then
      noteInstalled "devbox" "$devboxWorkspaceName provisioned"
      return 0
    fi
    notePresent "devbox" "$devboxWorkspaceName provisioned"
    return 0
  fi
  printf '%s\n' "$provisionOutput"
  noteWarned "devbox" "$devboxWorkspaceName provisioning failed"
}

installDarwinDevboxAgentWithoutStoppingTheTopic() {
  local noteLabel="$1"
  local warningsBeforeAgent
  warningsBeforeAgent="$(warningCountSoFar)"
  if installDarwinDevboxAgent "$@"; then
    return 0
  fi
  if (($(warningCountSoFar) == warningsBeforeAgent)); then
    noteWarned "$noteLabel" "install failed; rerun dot to retry"
  fi
}

if ! readDevboxProfile; then
  notePresent "devbox" "no profile deployment configured"
  finishTopic
fi
installDevbox
if isDarwin; then
  installDarwinDevboxAgentWithoutStoppingTheTopic "devbox launch agent" dev.dotfiles.devbox.ensure dotfiles-devbox-ensure.plist.template
  installDarwinDevboxAgentWithoutStoppingTheTopic "devbox agent forward" dev.dotfiles.devbox.forward-agent dotfiles-devbox-forward-agent.plist.template
fi
finishTopic
