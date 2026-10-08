#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
source "$dotfilesRepo/script/lib/packages.sh"
source "$dotfilesRepo/devbox/lib.sh"

installDevbox() {
  local lookupStatus=0
  resolveDevboxWorkspace || lookupStatus=$?
  if ((lookupStatus == 1)); then
    notePresent "devbox" "skipped"
    noteDetail "devbox" "$devboxSkipReason"
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
  if provisionOutput="$(pushDevboxScript)"; then
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

installDevbox
finishTopic
