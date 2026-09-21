#!/usr/bin/env bash
# The timer is the one converge that runs outside glimmervoid's cgroup, so it is what pays a restart a hosted run left owed.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

escapeXmlText() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Zero rendered it, one found it already rendered, two could not render it at all.
renderLaunchAgent() {
  local templatePath="$dotfilesRepo/converge/dotfiles-converge.plist.template"
  local destination="$HOME/Library/LaunchAgents/dev.dotfiles.converge.plist"
  local stagedPath
  local renderedLine
  local escapedHome
  local escapedBash
  local escapedBrew
  local escapedState
  escapedHome="$(escapeXmlText "$HOME")"
  escapedBrew="$(escapeXmlText "$(homebrewPrefix)")"
  escapedBash="$escapedBrew/bin/bash"
  dotfilesStateDirectory || return 2
  escapedState="$(escapeXmlText "$dotfilesStateDirectoryPath")"
  mkdir -p -- "$(dirname -- "$destination")"
  clearDestinationIfNotPlainFile "converge launch agent" "$destination" || return 2
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-launch-agent.XXXXXX")"
  while IFS= read -r renderedLine || [[ -n "$renderedLine" ]]; do
    renderedLine="${renderedLine//\{\{HOME\}\}/$escapedHome}"
    renderedLine="${renderedLine//\{\{BASH\}\}/$escapedBash}"
    renderedLine="${renderedLine//\{\{BREW\}\}/$escapedBrew}"
    renderedLine="${renderedLine//\{\{STATE\}\}/$escapedState}"
    printf '%s\n' "$renderedLine"
  done < "$templatePath" > "$stagedPath"
  if commitRenderedFile "converge launch agent" "$stagedPath" "$destination"; then
    chmod 600 "$destination"
    noteApplied "converge launch agent" "rendered"
    return 0
  fi
  chmod 600 "$destination"
  notePresent "converge launch agent" "rendered"
  return 1
}

installDarwinConvergeAgent() {
  local plistPath="$HOME/Library/LaunchAgents/dev.dotfiles.converge.plist"
  local plistChanged=0
  local renderStatus=0
  renderLaunchAgent || renderStatus=$?
  if ((renderStatus == 2)); then
    return 1
  fi
  if ((renderStatus == 0)); then
    plistChanged=1
  fi
  installLaunchAgent "converge launch agent" "dev.dotfiles.converge" "$plistPath" "$plistChanged"
}

# shellcheck source=../script/lib/launchd.sh
source "$dotfilesRepo/script/lib/launchd.sh"

if isDarwin; then
  installDarwinConvergeAgent
  finishTopic
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
