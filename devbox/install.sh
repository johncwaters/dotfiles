#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
source "$dotfilesRepo/script/lib/packages.sh"
source "$dotfilesRepo/devbox/lib.sh"
source "$dotfilesRepo/script/lib/launchd.sh"

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
    noteWarned "devbox" "${devboxSkipReason:-workspace lookup failed}"
    return 0
  fi
  if [[ "$devboxWorkspaceIsOutdated" == 1 ]]; then
    noteDetail "devbox" "$devboxWorkspaceName runs an outdated Coder template; coder update $devboxWorkspaceName rebuilds it"
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
  if installDarwinLaunchAgent "$@"; then
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
  rm -f -- "$(dotfilesStateDirectoryLocation)"/devbox-{ensure,forward-agent}.{stdout,stderr}.log
  installDarwinDevboxAgentWithoutStoppingTheTopic "devbox launch agent" dev.dotfiles.devbox.ensure "$dotfilesRepo/devbox/dotfiles-devbox-ensure.plist.template"
  installDarwinDevboxAgentWithoutStoppingTheTopic "devbox agent forward" dev.dotfiles.devbox.forward-agent "$dotfilesRepo/devbox/dotfiles-devbox-forward-agent.plist.template"
fi
finishTopic
