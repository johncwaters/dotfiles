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
  local templatePath="$dotfilesRepo/devbox/dotfiles-devbox-ensure.plist.template"
  local destination="$HOME/Library/LaunchAgents/dev.dotfiles.devbox.ensure.plist"
  local stagedPath renderedLine escapedHome escapedBrew escapedState
  escapedHome="$(escapeDevboxXmlText "$HOME")"
  escapedBrew="$(escapeDevboxXmlText "$(homebrewPrefix)")"
  dotfilesStateDirectory || return 2
  escapedState="$(escapeDevboxXmlText "$dotfilesStateDirectoryPath")"
  mkdir -p -- "$(dirname -- "$destination")" || return 2
  clearDestinationIfNotPlainFile "devbox launch agent" "$destination" || return 2
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-devbox-agent.XXXXXX")" || return 2
  while IFS= read -r renderedLine || [[ -n "$renderedLine" ]]; do
    renderedLine="${renderedLine//\{\{HOME\}\}/$escapedHome}"
    renderedLine="${renderedLine//\{\{BASH\}\}/$escapedBrew/bin/bash}"
    renderedLine="${renderedLine//\{\{BREW\}\}/$escapedBrew}"
    renderedLine="${renderedLine//\{\{STATE\}\}/$escapedState}"
    printf '%s\n' "$renderedLine"
  done < "$templatePath" > "$stagedPath" || return 2
  if commitRenderedFile "devbox launch agent" "$stagedPath" "$destination"; then
    chmod 600 "$destination"
    noteApplied "devbox launch agent" "rendered"
    return 0
  fi
  chmod 600 "$destination"
  notePresent "devbox launch agent" "rendered"
  return 1
}

installDarwinDevboxAgent() {
  local plistPath="$HOME/Library/LaunchAgents/dev.dotfiles.devbox.ensure.plist"
  local plistChanged=0
  local renderStatus=0
  renderDevboxLaunchAgent || renderStatus=$?
  if ((renderStatus == 2)); then
    return 1
  fi
  if ((renderStatus == 0)); then
    plistChanged=1
  fi
  installLaunchAgent "devbox launch agent" "dev.dotfiles.devbox.ensure" "$plistPath" "$plistChanged"
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
  local warningsBeforeAgent
  warningsBeforeAgent="$(warningCountSoFar)"
  if installDarwinDevboxAgent; then
    return 0
  fi
  if (($(warningCountSoFar) == warningsBeforeAgent)); then
    noteWarned "devbox launch agent" "install failed; rerun dot to retry"
  fi
}

if ! readDevboxProfile; then
  notePresent "devbox" "no profile deployment configured"
  finishTopic
fi
installDevbox
if isDarwin; then
  installDarwinDevboxAgentWithoutStoppingTheTopic
fi
finishTopic
